import { strict as assert } from "node:assert";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DaemonQmapRunner, ensureDaemon } from "../src/daemon.ts";
import { filespecFor, buildListInvocation, buildGetInvocation, buildStoreInvocation } from "../src/qmap.ts";
import { parseBareRefs } from "../src/resolve.ts";
import { decodePayload, encodePayload } from "../src/payload.ts";
import { installSessionHooks, activeConversationTurn, type PiCtx } from "../src/hooks/events.ts";
import {
  makeConsolidateTool,
  runAutoConsolidation,
  runDeferredConsolidation,
} from "../src/tools/consolidate.ts";
import {
  readConsolidationJournal,
  writeConsolidationJournal,
} from "../src/tools/consolidation_journal.ts";
import {
  synthesizeL2ScopeKnowledge,
  synthesizeL3GeneralPrinciple,
} from "../src/synth/adapter.ts";
import type { L2SynthesisInput, L3SynthesisInput } from "../src/synth/types.ts";

const home = Deno.env.get("HOME") || "";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = "/usr/bin/corm";
const cormdBin = "/usr/bin/cormd";

Deno.test("genuine_synthesis: 1. Ordinary turn settlement does not scan full DB or invoke L2/L3 synthesis", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-synth-test1-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let totalGets = 0;
    let totalLists = 0;
    const shellExec = async (cmd: string, args: string[]) => {
      if (args[0] === "-g" && args[1] === ".") totalLists++;
      if (args[0] === "-r" && args[1] === "-g") totalGets++;
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    // Seed 25 background records in the database
    for (let i = 1; i <= 25; i++) {
      const payload = encodePayload("2026-10-18", {
        level: "L0",
        type: "note",
        lifecycle: "observed",
        summary: `Pre-existing background fact ${i}`,
      });
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, payload, axisPath, tmpDir));
    }

    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateBatchLimit: 5,
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-turn-1" };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-18T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-turn-1",
    }));

    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);
    totalGets = 0; // reset get counter before the turn
    totalLists = 0;

    // Run ordinary user turn
    activeConversationTurn.topicSubject = "compiler";
    await emit("before_agent_start", { messageType: "user", prompt: "Clang optimization level -O2 enabled for fast build." });
    await emit("message_end", { message: { role: "assistant", content: "Optimization -O2 enabled." } });
    await emit("agent_settled", null);

    // List operations must be strictly 0, and gets O(1)
    assert.strictEqual(totalLists, 0, `Expected 0 list calls during turn settlement, observed ${totalLists} list calls`);
    assert.ok(totalGets <= 3, `Expected at most 3 gets for newly captured turn, observed ${totalGets} gets`);

    // Verify L0 and L1 were captured, but zero L2 or L3 were created
    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const allRefs = parseBareRefs(listRes.stdout);
    for (const r of allRefs) {
      const g = await daemonRunner.run(buildGetInvocation(cormBin, fspec, r, axisPath, tmpDir));
      const { envelope } = decodePayload(g.stdout.trim());
      assert.notStrictEqual(envelope.level, "L2", "L2 must not be created during ordinary turn settlement");
      assert.notStrictEqual(envelope.level, "L3", "L3 must not be created during ordinary turn settlement");
    }

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("genuine_synthesis: 2. Per-turn and deferred work respect consolidateBatchLimit", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-synth-test2-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const batchLimit = 3;
    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateBatchLimit: batchLimit,
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-batch-limit" };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-18T13:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-batch-limit",
    };

    // Store 10 uncited L0 items
    const storedRefs: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const payload = encodePayload("2026-10-18", {
        level: "L0",
        type: "note",
        lifecycle: "observed",
        summary: `Unconsolidated statement ${i}`,
      });
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, payload, axisPath, tmpDir));
      storedRefs.push(i);
    }

    // Call runAutoConsolidation: should process at most batchLimit (3) items
    const res = await runAutoConsolidation(toolEnv, ctx);
    const details = res.details as { createdL1: number[]; totalCreated: number };
    assert.ok(details.createdL1.length <= batchLimit, `Created L1 count (${details.createdL1.length}) must not exceed batchLimit (${batchLimit})`);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("genuine_synthesis: 3. Genuine L2 synthesis from evidence vs template concatenation", async () => {
  let receivedPrompt = "";
  const mockFetch = (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    receivedPrompt = body.messages[1].content as string;
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "Acoustic audio recordings are standardized to 48kHz 24-bit FLAC for archival preservation.",
            explanation: "Derived from user specifications across pipeline setup sessions.",
            citedRefs: [1, 2],
          }),
        },
      }],
    }), { headers: { "Content-Type": "application/json" } }));
  };

  const input: L2SynthesisInput = {
    scope: "audio-pipeline",
    isConversational: false,
    evidence: [
      { ref: 1, level: "L1", summary: "Recording samplerate fixed at 48kHz", findings: ["48kHz chosen"] },
      { ref: 2, level: "L1", summary: "Bit depth set to 24-bit FLAC", findings: ["Lossless compression required"] },
    ],
  };

  const cfg = {
    ...DEFAULT_CONFIG,
    synthUrl: "http://mock-synth/v1/chat/completions",
    synthModel: "gpt-4o-mini",
  };

  const res = await synthesizeL2ScopeKnowledge(input, cfg, mockFetch);
  assert.strictEqual(res.status, "ok");
  assert.strictEqual(res.summary, "Acoustic audio recordings are standardized to 48kHz 24-bit FLAC for archival preservation.");
  assert.deepStrictEqual(res.citedRefs, [1, 2]);
  assert.ok(receivedPrompt.includes("audio-pipeline"));
  assert.ok(receivedPrompt.includes("[Ref 1]"));
  assert.ok(receivedPrompt.includes("[Ref 2]"));
});

Deno.test("genuine_synthesis: 4. Genuine L3 cross-scope generalization across distinct scopes", async () => {
  let receivedPrompt = "";
  const mockFetch = (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    receivedPrompt = body.messages[1].content as string;
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "Fail-closed resource boundaries prevent silent corruption across distributed subsystems.",
            principle: "Subsystems must reject partial state transitions when underlying coordinator locks expire.",
            applicability: "Applicable to storage engines, network sockets, and consensus channels.",
            citedRefs: [10, 20],
          }),
        },
      }],
    }), { headers: { "Content-Type": "application/json" } }));
  };

  const input: L3SynthesisInput = {
    l2Items: [
      { ref: 10, scope: "corm-storage", summary: "Database mutation fails closed on lock contention", evidence: [1, 2] },
      { ref: 20, scope: "socket-net", summary: "Socket disconnect aborts pipeline instead of buffering", evidence: [3, 4] },
    ],
  };

  const cfg = {
    ...DEFAULT_CONFIG,
    synthUrl: "http://mock-synth/v1/chat/completions",
    synthModel: "gpt-4o-mini",
  };

  const res = await synthesizeL3GeneralPrinciple(input, cfg, mockFetch);
  assert.strictEqual(res.status, "ok");
  assert.strictEqual(res.summary, "Fail-closed resource boundaries prevent silent corruption across distributed subsystems.");
  assert.strictEqual(res.principle, "Subsystems must reject partial state transitions when underlying coordinator locks expire.");
  assert.deepStrictEqual(res.citedRefs, [10, 20]);
  assert.ok(receivedPrompt.includes("corm-storage"));
  assert.ok(receivedPrompt.includes("socket-net"));
});

Deno.test("genuine_synthesis: 5. Rejection of fabricated references, invalid schema, and unconfigured synthesis", async () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    synthUrl: "http://mock-synth/v1/chat/completions",
    synthModel: "gpt-4o-mini",
  };

  const input: L2SynthesisInput = {
    scope: "security",
    isConversational: false,
    evidence: [
      { ref: 1, level: "L1", summary: "TLS 1.3 enforced" },
      { ref: 2, level: "L1", summary: "Certificates rotated every 90 days" },
    ],
  };

  // Case A: Model hallucinates citedRefs [99, 100] (not in input [1, 2])
  const mockHallucinatedRefs = () => Promise.resolve(new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          summary: "TLS 1.3 is strictly enforced with 90-day cert rotation.",
          citedRefs: [99, 100], // Fabricated!
        }),
      },
    }],
  })));
  const resA = await synthesizeL2ScopeKnowledge(input, cfg, mockHallucinatedRefs);
  assert.strictEqual(resA.status, "validation_error");
  assert.ok(resA.reason?.includes("zero valid cited references"));

  // Case B: Model returns invalid non-JSON garbage
  const mockGarbage = () => Promise.resolve(new Response(JSON.stringify({
    choices: [{
      message: {
        content: "Here is the summary: I could not format it as JSON.",
      },
    }],
  })));
  const resB = await synthesizeL2ScopeKnowledge(input, cfg, mockGarbage);
  assert.strictEqual(resB.status, "validation_error");

  // Case C: Unconfigured synthesis returns typed unavailable status without making network call
  let networkCalled = false;
  const mockNeverCalled = () => {
    networkCalled = true;
    return Promise.resolve(new Response(""));
  };
  const unconfiguredCfg = { ...DEFAULT_CONFIG, synthUrl: undefined, synthModel: undefined };
  const resC = await synthesizeL2ScopeKnowledge(input, unconfiguredCfg, mockNeverCalled);
  assert.strictEqual(resC.status, "unavailable");
  assert.strictEqual(networkCalled, false);
});

Deno.test("genuine_synthesis: 6. Reciprocal successor links (supersedes/supersededBy) and retrieval filtering", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-synth-test6-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    let synthCount = 0;
    const synthServer = Deno.serve({ port: 0 }, async (req) => {
      synthCount++;
      const body = await req.json();
      const userPrompt = body.messages[1].content as string;
      const matches = [...userPrompt.matchAll(/\[Ref (\d+)\]/g)].map((m) => Number(m[1]));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: `Synthesized database knowledge version ${synthCount}`,
              explanation: "Reconciled with latest evidence",
              citedRefs: matches,
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateL2Threshold: 2,
      synthUrl: `http://127.0.0.1:${synthServer.addr.port}`,
      synthModel: "mock-synth-model",
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-succ-1" };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-18T15:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-succ-1",
    };

    // 1. Store initial 2 L1 records for scope 'database'
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, encodePayload("2026-10-18", {
      level: "L1", type: "note", lifecycle: "observed", summary: "PostgreSQL connection pool max_connections=50", context: { project: "database" },
    }), axisPath, tmpDir));
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 2, encodePayload("2026-10-18", {
      level: "L1", type: "note", lifecycle: "observed", summary: "Prepared statement cache size=256", context: { project: "database" },
    }), axisPath, tmpDir));

    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes["database"] = { count: 2, l1Refs: [1, 2], lastUpdated: new Date().toISOString() };
    journal.pendingL2Scopes = ["database"];
    await writeConsolidationJournal(tmpDir, journal);

    // Run first deferred consolidation -> creates initial L2 abstraction (Ref 3)
    const run1 = await runDeferredConsolidation(toolEnv, ctx);
    const details1 = run1.details as { createdL2: number[] };
    assert.strictEqual(details1.createdL2.length, 1);
    const l2Ref1 = details1.createdL2[0];

    const get1 = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l2Ref1, axisPath, tmpDir));
    const data1 = decodePayload(get1.stdout.trim());
    assert.strictEqual(data1.envelope.level, "L2");
    assert.strictEqual(data1.envelope.lifecycle, "observed");
    assert.strictEqual(data1.envelope.supersedes, undefined);

    // 2. Add new evidence to the same scope (Ref 4 and Ref 5)
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 4, encodePayload("2026-10-18", {
      level: "L1", type: "note", lifecycle: "observed", summary: "Query timeout set to 5000ms", context: { project: "database" },
    }), axisPath, tmpDir));
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 5, encodePayload("2026-10-18", {
      level: "L1", type: "note", lifecycle: "observed", summary: "SSL mode verify-full configured", context: { project: "database" },
    }), axisPath, tmpDir));

    journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes["database"] = {
      count: 2,
      l1Refs: [4, 5],
      lastUpdated: new Date().toISOString(),
      activeL2Ref: l2Ref1,
    };
    journal.pendingL2Scopes = ["database"];
    await writeConsolidationJournal(tmpDir, journal);

    // Run second deferred consolidation -> should produce SUCCESSOR L2 (Ref 6)
    const run2 = await runDeferredConsolidation(toolEnv, ctx);
    const details2 = run2.details as { createdL2: number[] };
    assert.strictEqual(details2.createdL2.length, 1);
    const l2Ref2 = details2.createdL2[0];
    assert.notStrictEqual(l2Ref1, l2Ref2);

    // Check successor L2 record (Ref 6)
    const getSuccessor = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l2Ref2, axisPath, tmpDir));
    const successorData = decodePayload(getSuccessor.stdout.trim());
    assert.strictEqual(successorData.envelope.level, "L2");
    assert.strictEqual(successorData.envelope.lifecycle, "observed");
    assert.strictEqual(successorData.envelope.supersedes, l2Ref1, "Successor must link 'supersedes' to predecessor");

    // Check predecessor L2 record (Ref 3)
    const getPredecessor = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l2Ref1, axisPath, tmpDir));
    const predecessorData = decodePayload(getPredecessor.stdout.trim());
    assert.strictEqual(predecessorData.envelope.lifecycle, "superseded", "Predecessor lifecycle must be marked 'superseded'");
    assert.strictEqual(predecessorData.envelope.supersededBy, l2Ref2, "Predecessor must have reciprocal 'supersededBy' link");

    // Clean up
    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("genuine_synthesis: 7. Failures, conflicts, and insufficient evidence preserve dirty state", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-synth-test7-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    // Server that always returns 500
    const failingServer = Deno.serve({ port: 0 }, () => new Response("Server error", { status: 500 }));

    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateL2Threshold: 2,
      synthUrl: `http://127.0.0.1:${failingServer.addr.port}`,
      synthModel: "mock-model",
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-fail-1" };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-18T16:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-fail-1",
    };

    // Store 2 L1 records
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, encodePayload("2026-10-18", {
      level: "L1", type: "note", lifecycle: "observed", summary: "Fact A", context: { project: "test-fail" },
    }), axisPath, tmpDir));
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 2, encodePayload("2026-10-18", {
      level: "L1", type: "note", lifecycle: "observed", summary: "Fact B", context: { project: "test-fail" },
    }), axisPath, tmpDir));

    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes["test-fail"] = { count: 2, l1Refs: [1, 2], lastUpdated: new Date().toISOString() };
    journal.pendingL2Scopes = ["test-fail"];
    await writeConsolidationJournal(tmpDir, journal);

    // Run deferred consolidation -> synthesis fails with 500
    const runRes = await runDeferredConsolidation(toolEnv, ctx);
    const details = runRes.details as { createdL2: number[] };
    assert.strictEqual(details.createdL2.length, 0);

    // Verify dirty state is STILL PRESERVED in the journal!
    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.dirtyScopes["test-fail"], "Dirty scope must NOT be cleared on failure");
    assert.strictEqual(journal.dirtyScopes["test-fail"].count, 2);
    assert.deepStrictEqual(journal.dirtyScopes["test-fail"].l1Refs, [1, 2]);
    assert.strictEqual(journal.dirtyScopes["test-fail"].lastStatus, "failed");
    assert.strictEqual(journal.dirtyScopes["test-fail"].attemptCount, 1);

    await failingServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("genuine_synthesis: 8. Status observability, force option, and threshold policy", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-synth-test8-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateL2Threshold: 4,
      consolidateL3Threshold: 3,
      consolidateBatchLimit: 15,
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-stat-test" };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-18T17:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-stat-test",
    };

    const tool = makeConsolidateTool(() => Promise.resolve(toolEnv));

    // Seed dirty journal
    const journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes["auth"] = { count: 2, l1Refs: [10, 11], lastUpdated: new Date().toISOString() };
    await writeConsolidationJournal(tmpDir, journal);

    // 1. Query status
    const statRes = await tool.execute("call_stat", { mode: "status" }, undefined, undefined, ctx);
    const statDetails = statRes.details as {
      status: string;
      thresholds: { l2: number; l3: number; batchLimit: number };
      dirtyScopes: Record<string, { count: number }>;
    };
    assert.strictEqual(statDetails.status, "ok");
    assert.strictEqual(statDetails.thresholds.l2, 4);
    assert.strictEqual(statDetails.thresholds.l3, 3);
    assert.strictEqual(statDetails.thresholds.batchLimit, 15);
    assert.strictEqual(statDetails.dirtyScopes["auth"]?.count, 2);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("genuine_synthesis: 9. Multi-process concurrent journal updates preserve pending work", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-synth-test9-" });
  try {
    const { recordNewL1InJournal } = await import("../src/tools/consolidation_journal.ts");
    const { withLock } = await import("../src/lock.ts");

    // Launch parallel updates synchronized via withLock across distinct scopes
    const scopes = ["scope-a", "scope-b", "scope-c", "scope-d", "scope-e"];
    await Promise.all(
      scopes.map(async (scope, idx) => {
        await withLock(tmpDir, async () => {
          await recordNewL1InJournal(tmpDir, scope, [idx * 10 + 1, idx * 10 + 2], 3);
        });
      }),
    );

    const journal = await readConsolidationJournal(tmpDir);
    for (const scope of scopes) {
      assert.ok(journal.dirtyScopes[scope], `Scope ${scope} must exist in journal`);
      assert.strictEqual(journal.dirtyScopes[scope].count, 2);
    }
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("genuine_synthesis: 10. Compaction and shutdown hooks do not perform whole-database work", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-synth-test10-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let totalGets = 0;
    const shellExec = async (cmd: string, args: string[]) => {
      if (args[0] === "-r" && args[1] === "-g") totalGets++;
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    // Seed 30 items
    for (let i = 1; i <= 30; i++) {
      const payload = encodePayload("2026-10-18", {
        level: "L0",
        type: "note",
        lifecycle: "observed",
        summary: `Item ${i}`,
      });
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, payload, axisPath, tmpDir));
    }

    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateBatchLimit: 5,
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-comp-1" };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-18T18:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-comp-1",
    }));

    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);
    totalGets = 0;

    // Trigger session_before_compact when no scopes are dirty:
    await emit("session_before_compact", null);

    // Because no scopes are dirty, gets must be 0 (no whole-database scan!)
    assert.strictEqual(totalGets, 0, `Expected 0 gets during clean compaction, observed ${totalGets}`);

    // Trigger session_shutdown:
    await emit("session_shutdown", null);
    assert.strictEqual(totalGets, 0, `Expected 0 gets during clean shutdown, observed ${totalGets}`);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

const liveSynthUrl = Deno.env.get("PI_MM_SYNTH_URL") ?? Deno.env.get("MM_SYNTH_URL") ?? Deno.env.get("QLLM_URL");
const liveSynthModel = Deno.env.get("PI_MM_SYNTH_MODEL") ?? Deno.env.get("MM_SYNTH_MODEL") ?? Deno.env.get("QLLM_MODEL");

Deno.test({
  name: "genuine_synthesis: 11. Real live synthesis integration test (or truthful skip)",
  ignore: !liveSynthUrl || !liveSynthModel,
  fn: async () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      synthUrl: liveSynthUrl!,
      synthModel: liveSynthModel!,
      synthKey: Deno.env.get("PI_MM_SYNTH_KEY") ?? Deno.env.get("QLLM_KEY"),
    };

    const input: L2SynthesisInput = {
      scope: "network-tuning",
      isConversational: false,
      evidence: [
        { ref: 1, level: "L1", summary: "TCP receive window increased to 4MB for 10GbE link" },
        { ref: 2, level: "L1", summary: "BBR congestion control enabled on Linux 6.8 kernel" },
      ],
    };

    const res = await synthesizeL2ScopeKnowledge(input, cfg);
    assert.strictEqual(res.status, "ok", `Real live synthesis failed: ${res.reason}`);
    assert.ok(res.summary && res.summary.length > 10, "Real synthesis must produce substantive summary");
    assert.ok(res.citedRefs && res.citedRefs.length > 0, "Real synthesis must cite valid evidence refs");
    for (const ref of res.citedRefs) {
      assert.ok(ref === 1 || ref === 2, `Real synthesis cited invalid ref: ${ref}`);
    }
  },
});

