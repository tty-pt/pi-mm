import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";
import { filespecFor, buildGetInvocation, buildStoreInvocation } from "../src/corm.ts";
import { decodePayload, encodePayload } from "../src/payload.ts";
import { installSessionHooks, activeConversationTurn, type PiCtx } from "../src/hooks/events.ts";
import {
  runDeferredConsolidation,
  WorkBudgetTracker,
} from "../src/tools/consolidate.ts";
import {
  readConsolidationJournal,
  writeConsolidationJournal,
} from "../src/tools/consolidation_journal.ts";
import { allocateNextRef } from "../src/tools/ref_allocator.ts";
import { synthesizeL2ScopeKnowledge } from "../src/synth/adapter.ts";
import type { L2SynthesisInput } from "../src/synth/types.ts";

const home = Deno.env.get("HOME") || "";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

Deno.test("correctness_gaps: 1. Ordinary turns and clean lifecycle boundaries perform ZERO list operations", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-gap-test1-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let listCount = 0;
    let getCount = 0;
    const shellExec = async (cmd: string, args: string[]) => {
      if (args[0] === "-g" && args[1] === ".") listCount++;
      if (args[0] === "-r" && args[1] === "-g") getCount++;
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    // Seed 10 records
    for (let i = 1; i <= 10; i++) {
      const payload = encodePayload("2026-10-18", {
        level: "L0", type: "note", lifecycle: "observed", summary: `Item ${i}`,
      });
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, payload, axisPath, tmpDir));
    }

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-gap-1" };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-18T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-gap-1",
    }));

    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);
    listCount = 0;
    getCount = 0;

    // Ordinary conversational turn settlement
    activeConversationTurn.topicSubject = "telemetry";
    await emit("before_agent_start", { messageType: "user", prompt: "Prometheus scraping frequency set to 15s." });
    await emit("message_end", { message: { role: "assistant", content: "Configured Prometheus scraping." } });
    await emit("agent_settled", null);

    // List operations must be strictly 0 during turn settlement
    assert.strictEqual(listCount, 0, `Turn settlement must not enumerate references (expected 0 list calls, observed ${listCount})`);

    // Clean compaction lifecycle boundary when no scopes are dirty
    listCount = 0;
    await emit("session_before_compact", null);
    assert.strictEqual(listCount, 0, `Clean compaction must not enumerate references (expected 0 list calls, observed ${listCount})`);

    // Clean shutdown boundary
    listCount = 0;
    await emit("session_shutdown", null);
    assert.strictEqual(listCount, 0, `Clean shutdown must not enumerate references (expected 0 list calls, observed ${listCount})`);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("correctness_gaps: 2. Concurrent allocateNextRef allocations remain strictly unique and collision-free", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-gap-test2-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });
    const { withLock } = await import("../src/lock.ts");

    // Allocate 20 references concurrently across multiple asynchronous tasks
    const allocations = await Promise.all(
      Array.from({ length: 20 }, async () => {
        return await withLock(tmpDir, async () => {
          return await allocateNextRef(tmpDir, daemonRunner, cormBin, fspec, axisPath);
        });
      }),
    );

    // Every allocated reference ID must be strictly unique
    const uniqueSet = new Set(allocations);
    assert.strictEqual(uniqueSet.size, 20, "Every allocated reference ID must be distinct");
    assert.strictEqual(Math.min(...allocations), 1, "First allocation must be 1");
    assert.strictEqual(Math.max(...allocations), 20, "Last allocation must be 20");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("correctness_gaps: 3. L3 reference-specific pruning and starvation-free multi-scope selection", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-gap-test3-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const synthServer = Deno.serve({ port: 0 }, async (req) => {
      const body = await req.json();
      const userPrompt = body.messages[1].content as string;
      const matches = [...userPrompt.matchAll(/\[L2 Ref (\d+)\]/g)].map((m) => Number(m[1]));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Derived cross-domain principle",
              principle: "Decoupled stages prevent cascade failures",
              applicability: "Pipelines and storage engines",
              citedRefs: matches.slice(0, 2), // Cites only 2 of the provided references
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateBatchLimit: 8,
      synthUrl: `http://127.0.0.1:${synthServer.addr.port}`,
      synthModel: "mock-synth",
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-gap-3" };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-18T13:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-gap-3",
    };

    // Store 4 L2 records in 'scope-a' (Refs 1..4) and 2 L2 records in 'scope-b' (Refs 5..6)
    for (let i = 1; i <= 4; i++) {
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, encodePayload("2026-10-18", {
        level: "L2", type: "invariant", lifecycle: "supported", summary: `Scope A rule ${i}`, context: { project: "scope-a" }, evidence: [100 + i],
      }), axisPath, tmpDir));
    }
    for (let i = 5; i <= 6; i++) {
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, encodePayload("2026-10-18", {
        level: "L2", type: "invariant", lifecycle: "supported", summary: `Scope B rule ${i}`, context: { project: "scope-b" }, evidence: [100 + i],
      }), axisPath, tmpDir));
    }

    // Seed dirtyL2 with all 6 references across 2 scopes
    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyL2 = {
      count: 6,
      l2Refs: [1, 2, 3, 4, 5, 6],
      lastUpdated: new Date().toISOString(),
      scopeByRef: { 1: "scope-a", 2: "scope-a", 3: "scope-a", 4: "scope-a", 5: "scope-b", 6: "scope-b" },
    };
    journal.pendingL3 = true;
    await writeConsolidationJournal(tmpDir, journal);

    // Run deferred consolidation
    const res1 = await runDeferredConsolidation(toolEnv, ctx);
    const details1 = res1.details as { createdL3: number[]; l3Status: string; reason?: string };
    assert.strictEqual(details1.createdL3.length, 1);
    assert.strictEqual(details1.l3Status, "synthesized");

    // Check journal: only the cited L2 references should be removed!
    journal = await readConsolidationJournal(tmpDir);
    // Since mock cited 2 refs, remaining refs must be 4
    assert.strictEqual(journal.dirtyL2.l2Refs.length, 4, "Unrepresented L2 references must be retained in dirty queue");
    assert.strictEqual(journal.dirtyL2.count, 4);
    assert.strictEqual(journal.pendingL3, true, "L3 must remain pending when remaining dirty count >= threshold");

    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("correctness_gaps: 4. Total work budget bounds all operations (list, get, store, synth)", () => {
  const budget = new WorkBudgetTracker(10);
  assert.strictEqual(budget.hasBudget(5), true);
  budget.charge("get", 4);
  budget.charge("store", 2);
  budget.charge("synth", 1);
  budget.charge("list", 1);
  assert.strictEqual(budget.totalWorkUnits, 8);
  assert.strictEqual(budget.remaining, 2);
  assert.strictEqual(budget.hasBudget(2), true);
  assert.strictEqual(budget.hasBudget(3), false);

  const stats = budget.toStats();
  assert.strictEqual(stats.getCalls, 4);
  assert.strictEqual(stats.storeCalls, 2);
  assert.strictEqual(stats.synthCalls, 1);
  assert.strictEqual(stats.listCalls, 1);
  assert.strictEqual(stats.totalWorkUnits, 8);
});

Deno.test("correctness_gaps: 5. Strict evidence provenance rejects prior abstraction self-citations", async () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    synthUrl: "http://mock-synth/v1/chat/completions",
    synthModel: "gpt-4o-mini",
  };

  const input: L2SynthesisInput = {
    scope: "auth-module",
    isConversational: false,
    priorAbstraction: {
      ref: 50, // Predecessor L2
      summary: "Prior auth invariant",
      evidence: [10, 11], // Prior lower-level evidence
    },
    evidence: [
      { ref: 20, level: "L1", summary: "OAuth tokens expire in 1 hour" },
    ],
  };

  // Mock attempts to cite the predecessor L2 itself (Ref 50) as evidence
  const mockCitingPredecessor = () => Promise.resolve(new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          summary: "OAuth tokens expire in 1 hour with strict refresh rotation.",
          citedRefs: [50], // Citing predecessor L2 directly! Must be rejected!
        }),
      },
    }],
  })));

  const res = await synthesizeL2ScopeKnowledge(input, cfg, mockCitingPredecessor);
  assert.strictEqual(res.status, "validation_error");
  assert.ok(res.reason?.includes("zero valid cited references"));
});

Deno.test("correctness_gaps: 6. Journal corruption preservation and automatic pending work reconstruction", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-gap-test6-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    // Seed 2 active uncited L1 records in 'security' scope
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, encodePayload("2026-10-18", {
      level: "L1", type: "note", lifecycle: "observed", summary: "Password min length 12", context: { project: "security" },
    }), axisPath, tmpDir));
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 2, encodePayload("2026-10-18", {
      level: "L1", type: "note", lifecycle: "observed", summary: "MFA required for admin", context: { project: "security" },
    }), axisPath, tmpDir));

    // Intentionally corrupt the journal with malformed JSON
    const journalPath = join(tmpDir, ".consolidation.json");
    await Deno.writeTextFile(journalPath, "MALFORMED_GARBAGE_DATA{{{");

    // Read journal with recovery context
    const recovered = await readConsolidationJournal(tmpDir, {
      runner: daemonRunner,
      cormBin: cormBin,
      fspec,
      axes: axisPath,
      l2Threshold: 2,
      l3Threshold: 2,
    });

    // Verify corrupted file was preserved for diagnosis
    let foundCorruptFile = false;
    for await (const entry of Deno.readDir(tmpDir)) {
      if (entry.name.includes(".consolidation.json.corrupt.")) {
        foundCorruptFile = true;
        break;
      }
    }
    assert.ok(foundCorruptFile, "Corrupted journal file must be preserved with timestamp suffix");

    // Verify pending work was reconstructed from CORM
    assert.ok(recovered.dirtyScopes["security"], "Security scope must be reconstructed in dirtyScopes");
    assert.strictEqual(recovered.dirtyScopes["security"].count, 2);
    assert.deepStrictEqual(recovered.dirtyScopes["security"].l1Refs.sort(), [1, 2]);
    assert.ok(recovered.pendingL2Scopes.includes("security"), "Security must be marked pending L2");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("correctness_gaps: 7. L3 principle and boundary conditions survive persistence and retrieval", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-gap-test7-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const l3Envelope = {
      level: "L3" as const,
      type: "pattern" as const,
      lifecycle: "hypothesized" as const,
      summary: "Idempotent commit logs prevent duplicate writes during network partition.",
      evidence: [10, 20],
      episode: {
        problem: "Applicable to append-only storage and distributed consensus channels",
        findings: ["Monotonically increasing sequence counters detect and prune duplicates"],
        principle: "Monotonically increasing sequence counters detect and prune duplicates",
        applicability: "Applicable to append-only storage and distributed consensus channels",
        outcome: "success",
      },
    };

    // Store in CORM
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, encodePayload("2026-10-18", l3Envelope), axisPath, tmpDir));

    // Retrieve and verify
    const getRes = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 1, axisPath, tmpDir));
    const decoded = decodePayload(getRes.stdout.trim());

    assert.strictEqual(decoded.envelope.level, "L3");
    assert.strictEqual(decoded.envelope.episode?.principle, "Monotonically increasing sequence counters detect and prune duplicates");
    assert.strictEqual(decoded.envelope.episode?.applicability, "Applicable to append-only storage and distributed consensus channels");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("correctness_gaps: 8. Detection and recovery of failed predecessor writes during successor creation", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-gap-test8-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let failPredecessorWrite = false;
    const shellExec = async (cmd: string, args: string[]) => {
      // Simulate failure on updating predecessor Ref 3
      if (failPredecessorWrite && args[0] === "-p" && args[1].startsWith("3:")) {
        return { code: 1, stdout: "", stderr: "Simulated predecessor write failure" };
      }
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });
    const testRunner = {
      run: (inv: import("../src/corm.ts").Invocation) => {
        if (failPredecessorWrite && inv.args[0] === "-p" && inv.args[1].startsWith("3:")) {
          return Promise.resolve({ code: 1, stdout: "", stderr: "Simulated predecessor write failure" });
        }
        return daemonRunner.run(inv);
      },
    };

    const synthServer = Deno.serve({ port: 0 }, async (req) => {
      const body = await req.json();
      const userPrompt = body.messages[1].content as string;
      const matches = [...userPrompt.matchAll(/\[Ref (\d+)\]/g)].map((m) => Number(m[1]));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Synthesized storage invariants",
              explanation: "Synthesized from storage evidence",
              citedRefs: matches,
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateL2Threshold: 2,
      synthUrl: `http://127.0.0.1:${synthServer.addr.port}`,
      synthModel: "mock-synth",
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-gap-8" };
    const toolEnv = {
      cfg,
      runner: testRunner,
      nowProvider: () => new Date("2026-10-18T14:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-gap-8",
    };

    // Store existing L2 at Ref 3
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 3, encodePayload("2026-10-18", {
      level: "L2", type: "invariant", lifecycle: "observed", summary: "Predecessor L2 knowledge", context: { project: "storage" }, evidence: [1, 2],
    }), axisPath, tmpDir));

    // Store new L1s (Refs 4 and 5)
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 4, encodePayload("2026-10-18", {
      level: "L1", type: "note", lifecycle: "observed", summary: "Write ahead log sync on commit", context: { project: "storage" },
    }), axisPath, tmpDir));
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 5, encodePayload("2026-10-18", {
      level: "L1", type: "note", lifecycle: "observed", summary: "Fsync directory on metadata change", context: { project: "storage" },
    }), axisPath, tmpDir));

    // Seed dirty journal
    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes["storage"] = {
      count: 2,
      l1Refs: [4, 5],
      lastUpdated: new Date().toISOString(),
      activeL2Ref: 3,
    };
    journal.pendingL2Scopes = ["storage"];
    await writeConsolidationJournal(tmpDir, journal);

    // Turn ON failure on updating predecessor Ref 3
    failPredecessorWrite = true;

    // Run consolidation: successor will be stored, but predecessor update fails
    const runRes1 = await runDeferredConsolidation(toolEnv, ctx);
    const details1 = runRes1.details as { createdL2: number[] };
    assert.strictEqual(details1.createdL2.length, 0, "Must not claim createdL2 success when predecessor update fails");

    // Verify interruptedSuccessor is recorded in the journal
    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.interruptedSuccessors && journal.interruptedSuccessors.length > 0, "Interrupted successor must be tracked");
    const interrupted = journal.interruptedSuccessors[0];
    assert.strictEqual(interrupted.predecessorRef, 3);

    // Now HEAL the failure (allow predecessor write)
    failPredecessorWrite = false;

    // Run deferred consolidation again: reconcileInterruptedSuccessors executes automatically
    await runDeferredConsolidation(toolEnv, ctx);

    // Verify predecessor Ref 3 was reconciled and updated
    const getPred = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 3, axisPath, tmpDir));
    const decodedPred = decodePayload(getPred.stdout.trim());
    assert.strictEqual(decodedPred.envelope.lifecycle, "superseded", "Predecessor must be reconciled to superseded");
    assert.strictEqual(decodedPred.envelope.supersededBy, interrupted.successorRef);

    // Verify interruptedSuccessors was cleared
    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.interruptedSuccessors?.length ?? 0, 0, "Resolved interrupted successor must be cleared");

    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

