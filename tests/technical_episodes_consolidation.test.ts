import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";
import { filespecFor, buildListInvocation, buildGetInvocation, buildStoreInvocation } from "../src/corm.ts";
import { parseBareRefs } from "../src/resolve.ts";
import { decodePayload } from "../src/payload.ts";
import {
  installSessionHooks,
  type PiCtx,
} from "../src/hooks/events.ts";
import {
  readConsolidationJournal,
  writeConsolidationJournal,
} from "../src/tools/consolidation_journal.ts";
import { runAutoConsolidation } from "../src/tools/consolidate.ts";
import { executeHybridScan } from "../src/tools/scan.ts";
import { makeTraverseTool } from "../src/tools/traverse.ts";
import { advanceRefSeq } from "../src/tools/ref_allocator.ts";

const home = Deno.env.get("HOME") || "";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

Deno.test("technical_episodes: 1. Multi-turn flushes across turn_end boundaries are promoted to L1 at agent_settled", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-multiturn-" });
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

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateL2Threshold: 3,
      consolidateL3Threshold: 2,
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-tech-1",
      sessionManager: { getSessionId: () => "sess-tech-1", getSessionFile: () => "/tmp/sess.jsonl", getLeafId: () => "m1" },
    };
    (ctx as unknown as Record<string, unknown>).context = { project: "audio-engine" };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-20T10:00:00Z"), cwd: tmpDir, sessionId: "sess-tech-1" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);

    // Agent run starts with a task prompt
    await emit("before_agent_start", { messageType: "user", prompt: "Fix buffer overflow in FLAC decoder", runId: "run-audio-1" });

    // Turn 1: tool modification (edit)
    await emit("tool_result", {
      toolName: "edit",
      toolCallId: "call-1",
      input: { path: "src/decoder.c" },
      content: [{ type: "text", text: "Successfully edited src/decoder.c: bound input buffer check" }],
    });
    // Turn 1 boundary
    await emit("turn_end", null);

    // Verify turn 1 flushed L0 into database and queued into journal
    let journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 1, "Turn 1 must queue flushed L0 reference");
    const turn1L0Ref = journal.pendingL0Refs[0];

    // Turn 2: tool verification (test pass)
    await emit("tool_result", {
      toolName: "bash",
      toolCallId: "call-2",
      input: { command: "make test" },
      content: [{ type: "text", text: "All 15 tests passed (0 failed). Flac buffer bounds verified." }],
    });
    // Turn 2 boundary
    await emit("turn_end", null);

    // Verify turn 2 flushed second L0 into database and queued into journal
    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 2, "Turn 2 must queue second L0 reference");
    const turn2L0Ref = journal.pendingL0Refs[1];

    // Assistant concludes run
    await emit("message_end", { message: { role: "assistant", content: "Fixed buffer overflow by adding size bounds check." } });
    await emit("agent_settled", null);

    // Verify: agent_settled promoted the multi-turn L0 episodes into a coherent L1 investigation!
    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "All pending L0 references must be pruned after successful L1 creation");

    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const allRefs = parseBareRefs(listRes.stdout);
    // 2 L0 records + 1 conversational L0 (from prompt) + 1 L1 conversational + 1 L1 technical investigation
    assert.ok(allRefs.length >= 3, `Expected at least 3 records in DB, got ${allRefs.length}`);

    // Verify the created L1 technical investigation
    const l1Items: import("../src/types.ts").MemoryEnvelope[] = [];
    for (const r of allRefs) {
      const getRes = await daemonRunner.run(buildGetInvocation(cormBin, fspec, r, axisPath, tmpDir));
      if (getRes.code === 0 && getRes.stdout.trim()) {
        const { envelope } = decodePayload(getRes.stdout.trim());
        if (envelope.level === "L1" && envelope.type === "investigation") {
          l1Items.push(envelope);
        }
      }
    }

    assert.strictEqual(l1Items.length, 1, "Must create exactly 1 coherent L1 technical investigation");
    const techL1 = l1Items[0];
    assert.strictEqual(techL1.lifecycle, "tested", "Verified approach yields tested lifecycle");
    assert.ok(techL1.evidence?.includes(turn1L0Ref), "L1 must link turn 1 L0 reference as evidence");
    assert.ok(techL1.evidence?.includes(turn2L0Ref), "L1 must link turn 2 L0 reference as evidence");
    assert.ok(techL1.summary.includes("Fix buffer overflow"), "Summary preserves problem/task");
    assert.strictEqual(techL1.episode?.runId, "run-audio-1", "Preserves explicit runId");
    assert.strictEqual(techL1.context?.project, "audio-engine", "Preserves reliable project scope");

    // Verify registered in dirtyScopes
    assert.ok(journal.dirtyScopes["audio-engine"], "Must register audio-engine in dirtyScopes");
    assert.ok(journal.dirtyScopes["audio-engine"].l1Refs.length >= 1, "Must contain at least 1 L1 reference");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 2. Conversational judge skip does NOT bypass already-persisted technical L0 consolidation", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-judgeskip-" });
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

    // Mock Jev judge that always returns SKIP
    const judgeServer = Deno.serve({ port: 0 }, (_req) => {
      return new Response(JSON.stringify({
        answer: "no",
        reason: "User prompt is a simple greeting or non-memorable command",
        score: 0.1,
      }), { headers: { "Content-Type": "application/json" } });
    });

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "judge" as const,
      judgeUrl: `http://127.0.0.1:${judgeServer.addr.port}/api/v1/systemone/`,
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-tech-judge",
      sessionManager: { getSessionId: () => "sess-tech-judge" },
    };
    (ctx as unknown as Record<string, unknown>).context = { project: "indexer" };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-20T11:00:00Z"), cwd: tmpDir, sessionId: "sess-tech-judge" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);

    // User prompt that judge will skip
    await emit("before_agent_start", { messageType: "user", prompt: "hello, run tests please" });

    // Technical tool event executes during turn
    await emit("tool_result", {
      toolName: "bash",
      toolCallId: "call-bench",
      input: { command: "cargo bench" },
      content: [{ type: "text", text: "Benchmarking indexer: passed with 10k ops/sec" }],
    });
    await emit("turn_end", null);

    // Assistant response
    await emit("message_end", { message: { role: "assistant", content: "Done." } });

    // Settle agent: Judge will evaluate user prompt "hello, run tests please" -> decision 'skip'
    await emit("agent_settled", null);

    // Despite judge skip on conversational memory, the technical episode MUST be consolidated to L1!
    const journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "Technical L0 must be consolidated and drained from queue");

    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const allRefs = parseBareRefs(listRes.stdout);

    let foundTechL1 = false;
    for (const r of allRefs) {
      const getRes = await daemonRunner.run(buildGetInvocation(cormBin, fspec, r, axisPath, tmpDir));
      if (getRes.code === 0 && getRes.stdout.trim()) {
        const { envelope } = decodePayload(getRes.stdout.trim());
        if (envelope.level === "L1" && envelope.type === "investigation") {
          foundTechL1 = true;
          assert.ok(envelope.summary.includes("cargo bench") || envelope.summary.includes("hello, run tests"), "Investigation preserves summary");
        }
      }
    }
    assert.ok(foundTechL1, "Must find technical L1 investigation in database despite judge skip");

    await judgeServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 3. Unprocessed references survive batch limits and remain pending in journal", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-batch-" });
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

    // Store 4 technical L0 records in CORM
    for (let i = 1; i <= 4; i++) {
      const payload = decodePayload; // import check
      void payload;
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, `2026-10-20:${JSON.stringify({
        level: "L0",
        type: "episode",
        lifecycle: "observed",
        summary: `Tool episode ${i}`,
        context: { project: "parser" },
        episode: { problem: `Task ${i}`, outcome: "success", sessionId: "sess-batch" },
      })}`, axisPath, tmpDir));
    }

    // Queue 4 refs into journal
    const initialJournal = await readConsolidationJournal(tmpDir);
    initialJournal.pendingL0Refs = [1, 2, 3, 4];
    await writeConsolidationJournal(tmpDir, initialJournal);

    const BATCH_LIMIT = 2;
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      consolidateBatchLimit: BATCH_LIMIT,
    };

    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-20T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-batch",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-batch" };

    // Run 1: Processes only 2 records due to batchLimit
    const res1 = await runAutoConsolidation(toolEnv, ctx);
    const details1 = res1.details as { createdL1: number[] };
    assert.strictEqual(details1.createdL1.length, 2, "Run 1 must create 2 L1 records");

    let journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 2, "Remaining 2 references must remain pending in journal");
    assert.deepStrictEqual(journal.pendingL0Refs, [3, 4]);

    // Run 2: Processes remaining 2 records
    const res2 = await runAutoConsolidation(toolEnv, ctx);
    const details2 = res2.details as { createdL1: number[] };
    assert.strictEqual(details2.createdL1.length, 2, "Run 2 must create remaining 2 L1 records");

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "All references drained after second run");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 4. Process restart restores pendingL0Refs from journal without full database scan", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-restart-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let listCount = 0;
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (inv.args[0] === "-g" && inv.args[1] === ".") listCount++;
        return await daemonRunner.run(inv);
      },
    };

    // Store 50 dummy records in DB to prove work is bounded O(1)
    for (let i = 1; i <= 50; i++) {
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, `2026-10-20:${JSON.stringify({
        level: "L0", type: "note", lifecycle: "observed", summary: `Dummy item ${i}`,
      })}`, axisPath, tmpDir));
    }

    // Add 1 pending L0 reference into journal (simulating an interrupted run)
    const journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [50];
    await writeConsolidationJournal(tmpDir, journal);
    await advanceRefSeq(tmpDir, 51);

    listCount = 0;

    // Simulate fresh process start
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-20T13:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-fresh",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-fresh" };

    const res = await runAutoConsolidation(toolEnv, ctx);
    const details = res.details as { createdL1: number[] };
    assert.strictEqual(details.createdL1.length, 1, "Must consolidate pending reference from journal");

    // Must perform ZERO list operations on normal path!
    assert.strictEqual(listCount, 0, "Normal incremental consolidation must perform ZERO roster listings");

    const updatedJournal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(updatedJournal.pendingL0Refs?.length, 0, "Queue drained");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 5. Settlement idempotency: repeated lifecycle events do not create duplicate L1s", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-idemp-" });
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

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-idemp",
      sessionManager: { getSessionId: () => "sess-idemp" },
    };
    (ctx as unknown as Record<string, unknown>).context = { project: "auth" };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-20T14:00:00Z"), cwd: tmpDir, sessionId: "sess-idemp" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);
    await emit("before_agent_start", { messageType: "user", prompt: "Validate JWT signature algorithm" });
    await emit("tool_result", {
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "JWT validation tests passed (0 failed)" }],
    });
    await emit("turn_end", null);

    // Settlement 1
    await emit("agent_settled", null);

    const listRes1 = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const countAfterSettlement1 = parseBareRefs(listRes1.stdout).length;

    // Settlement 2 (duplicate/retry event)
    await emit("agent_settled", null);

    const listRes2 = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const countAfterSettlement2 = parseBareRefs(listRes2.stdout).length;

    assert.strictEqual(countAfterSettlement2, countAfterSettlement1, "Repeated settlement must not create duplicate records");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 6. Technical L1 memories can be found through normal recall in a fresh session", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-recall-" });
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

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
    };

    const ctxSessionA: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-A",
      sessionManager: { getSessionId: () => "sess-A" },
    };
    (ctxSessionA as unknown as Record<string, unknown>).context = { project: "compiler" };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-20T15:00:00Z"), cwd: tmpDir, sessionId: "sess-A" }));
    const emit = async (ev: string, data: unknown, c: PiCtx) => {
      for (const h of listeners[ev] || []) await h(data, c);
    };

    // SESSION A
    await emit("session_start", null, ctxSessionA);
    await emit("before_agent_start", { messageType: "user", prompt: "Optimize register allocation for RISC-V targets" }, ctxSessionA);
    await emit("tool_result", {
      toolName: "bash",
      input: { command: "make bench" },
      content: [{ type: "text", text: "RISC-V linear scan register allocator verified: 0 failed" }],
    }, ctxSessionA);
    await emit("turn_end", null, ctxSessionA);
    await emit("agent_settled", null, ctxSessionA);

    // SESSION B: Fresh session in same project
    const toolEnvSessionB = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-20T16:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-B",
    };

    // Hybrid recall for "register allocation"
    const scanRes = await executeHybridScan(toolEnvSessionB, { topic: "register allocation", limit: 5 });
    assert.ok(scanRes.records.length > 0, "Recall must find records");

    // Verify L1 is retrieved (normal recall prefers L1 over raw L0)
    const l1Match = scanRes.records.find((r) => (r.envelope?.level ?? r.level) === "L1");
    assert.ok(l1Match, "Must retrieve L1 technical memory");
    assert.ok(l1Match.envelope?.summary.includes("register allocator") || l1Match.envelope?.summary.includes("register allocation"));

    // Traverse evidence tree down from L1 to recover supporting L0
    const traverseTool = makeTraverseTool(() => Promise.resolve(toolEnvSessionB));
    const travRes = await traverseTool.execute("call-trav", { ref: l1Match.ref, direction: "down" }, undefined, undefined, ctxSessionA);
    const travDetails = travRes.details as { tree?: { children?: Array<{ level: string }> } };
    assert.ok(travDetails.tree, "Must return traversal tree");
    assert.ok(travDetails.tree.children?.some((c) => c.level === "L0"), "Must recover supporting L0 evidence via traversal");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 7. Scoped technical L1 enters dirtyScopes; unscoped records remain available at L1 without fabricated abstractions", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-scope-" });
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

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-20T17:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-scope",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-scope" };

    // 1. Store an unscoped technical L0 (in tmpDir with no explicit project context)
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, `2026-10-20:${JSON.stringify({
      level: "L0",
      type: "episode",
      lifecycle: "observed",
      summary: "Anonymous investigation without project context",
      episode: { problem: "Transient script run", outcome: "success" },
    })}`, axisPath, tmpDir));

    // 2. Store a scoped technical L0
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 2, `2026-10-20:${JSON.stringify({
      level: "L0",
      type: "episode",
      lifecycle: "observed",
      summary: "Scoped storage engine investigation",
      context: { project: "storage" },
      episode: { problem: "Storage compaction", outcome: "success" },
    })}`, axisPath, tmpDir));

    const initialJournal = await readConsolidationJournal(tmpDir);
    initialJournal.pendingL0Refs = [1, 2];
    await writeConsolidationJournal(tmpDir, initialJournal);

    const res = await runAutoConsolidation(toolEnv, ctx);
    const details = res.details as { createdL1: number[]; unscopedL1Count?: number; note?: string };

    assert.strictEqual(details.createdL1.length, 2, "Must consolidate both L0 records to L1");
    assert.strictEqual(details.unscopedL1Count, 1, "Must report 1 unscoped L1");
    assert.strictEqual(details.note, "higher-level consolidation waiting for scope information");

    const journal = await readConsolidationJournal(tmpDir);
    // Scoped one entered dirtyScopes
    assert.ok(journal.dirtyScopes["storage"], "Scoped record must enter dirtyScopes['storage']");
    assert.strictEqual(journal.dirtyScopes["storage"].l1Refs.length, 1);

    // Unscoped record did NOT create an artificial or fabricated scope
    assert.strictEqual(Object.keys(journal.dirtyScopes).length, 1, "Only legitimate scoped records enter dirtyScopes");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 8. Original defect reproduction - early turn_end flush missing from final flush is promoted", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-defect-" });
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

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-defect",
      sessionManager: { getSessionId: () => "sess-defect" },
    };
    (ctx as unknown as Record<string, unknown>).context = { project: "network" };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-20T18:00:00Z"), cwd: tmpDir, sessionId: "sess-defect" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);
    await emit("before_agent_start", { messageType: "user", prompt: "Fix socket timeout bug in TCP listener" });

    // Turn 1: has tool operation -> flushed at turn_end
    await emit("tool_result", {
      toolName: "edit",
      input: { path: "src/listener.c" },
      content: [{ type: "text", text: "Added non-blocking socket timeout handler" }],
    });
    await emit("turn_end", null);

    // Turn 2: conversational only (no tool calls!)
    await emit("message_end", { message: { role: "assistant", content: "The timeout handler has been applied." } });

    // Agent settles. Final flushSessionBuffer() returns null (nothing in buffer)
    await emit("agent_settled", null);

    // VERIFY: The L0 stored during Turn 1 was NOT discarded, and has been promoted to L1!
    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const allRefs = parseBareRefs(listRes.stdout);

    let foundTechL1 = false;
    for (const r of allRefs) {
      const getRes = await daemonRunner.run(buildGetInvocation(cormBin, fspec, r, axisPath, tmpDir));
      if (getRes.code === 0 && getRes.stdout.trim()) {
        const { envelope } = decodePayload(getRes.stdout.trim());
        if (envelope.level === "L1" && envelope.type === "investigation") {
          foundTechL1 = true;
          assert.ok(envelope.evidence && envelope.evidence.length > 0, "Must cite Turn 1 L0 as evidence");
        }
      }
    }

    assert.ok(foundTechL1, "Defect resolved: Turn 1 tool episode MUST be promoted to L1 even when final flush returns null");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 9. Event-level regression: zero list operations across actual agent_settled hook on no-op turns", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-noop-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let listCount = 0;
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (inv.args[0] === "-g" && inv.args[1] === ".") listCount++;
        return await daemonRunner.run(inv);
      },
    };

    // Populate 20 existing records in DB to prove work would scan if not prevented
    for (let i = 1; i <= 20; i++) {
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, `2026-10-20:${JSON.stringify({
        level: "L0", type: "note", lifecycle: "observed", summary: `Existing item ${i}`,
      })}`, axisPath, tmpDir));
    }
    await advanceRefSeq(tmpDir, 21);

    // Mock Jev judge returning skip
    const judgeServer = Deno.serve({ port: 0 }, (_req) => {
      return new Response(JSON.stringify({
        answer: "no",
        reason: "Casual non-memorable greeting",
        score: 0.05,
      }), { headers: { "Content-Type": "application/json" } });
    });

    const cfg: import("../src/config.ts").MmConfig = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "judge",
      judgeUrl: `http://127.0.0.1:${judgeServer.addr.port}/api/v1/systemone/`,
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-noop",
      sessionManager: { getSessionId: () => "sess-noop" },
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: instrumentedRunner, nowProvider: () => new Date("2026-10-20T19:00:00Z"), cwd: tmpDir, sessionId: "sess-noop" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);

    // 1. Turn with conversational prompt skipped by judge, 0 tool events, empty pending queue
    listCount = 0;
    await emit("before_agent_start", { messageType: "user", prompt: "Hello, what time is it?" });
    await emit("message_end", { message: { role: "assistant", content: "It is 7:00 PM." } });
    await emit("agent_settled", null);

    // Assert strictly 0 list operations across the actual agent_settled hook!
    assert.strictEqual(listCount, 0, "No-op settlement with judge skip must execute ZERO roster list operations");

    // 2. Second turn with captureMode off, 0 tool events
    cfg.captureMode = "off" as const;
    listCount = 0;
    await emit("before_agent_start", { messageType: "user", prompt: "Another turn in off mode" });
    await emit("message_end", { message: { role: "assistant", content: "Acknowledged." } });
    await emit("agent_settled", null);

    assert.strictEqual(listCount, 0, "No-op settlement in off mode must execute ZERO roster list operations");

    await judgeServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 10. Multi-batch progression: preserves coherent evolving investigations with reciprocal successor links", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-multibatch-" });
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

    const RUN_ID = "run-multi-batch-task-1";
    // Seed 7 technical L0 records in CORM for the same agent run
    for (let i = 1; i <= 7; i++) {
      const worked = i >= 3;
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, `2026-10-20:${JSON.stringify({
        level: "L0",
        type: "episode",
        lifecycle: worked ? "tested" : "observed",
        summary: `Storage compaction step ${i}: ${worked ? "optimized lock acquisition" : "encountered lock contention"}`,
        context: { project: "storage" },
        episode: {
          request: "Resolve compaction stall in LSM storage engine",
          problem: "Compaction stall in LSM storage engine",
          findings: [`Finding from step ${i}`],
          approaches: [{
            approach: `Compaction tuning approach ${i}`,
            outcome: worked ? "worked" : "failed",
          }],
          diffs: [`storage/compaction_${i}.c`],
          outcome: worked ? "success" : "failure",
          runId: RUN_ID,
          sessionId: "sess-mb",
        },
      })}`, axisPath, tmpDir));
    }
    await advanceRefSeq(tmpDir, 8);

    // Queue all 7 references into the consolidation journal
    const initialJournal = await readConsolidationJournal(tmpDir);
    initialJournal.pendingL0Refs = [1, 2, 3, 4, 5, 6, 7];
    await writeConsolidationJournal(tmpDir, initialJournal);

    const BATCH_LIMIT = 3;
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      consolidateBatchLimit: BATCH_LIMIT,
    };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-20T20:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-mb",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-mb" };

    // --- BATCH 1 (Processes refs 1, 2, 3) ---
    const res1 = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details1 = res1.details as { createdL1: number[] };
    assert.strictEqual(details1.createdL1.length, 1, "Batch 1 must create 1 initial L1 investigation");
    const l1Ref1 = details1.createdL1[0];

    let journal = await readConsolidationJournal(tmpDir);
    assert.deepStrictEqual(journal.pendingL0Refs, [4, 5, 6, 7], "Batch 1 leaves remaining 4 references pending");
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], l1Ref1, "Journal tracks active L1 ref after Batch 1");

    // Inspect initial L1
    const l1Raw1 = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l1Ref1, axisPath, tmpDir));
    const { envelope: l1Env1 } = decodePayload(l1Raw1.stdout.trim());
    assert.strictEqual(l1Env1.level, "L1");
    assert.strictEqual(l1Env1.lifecycle, "tested");
    assert.deepStrictEqual(l1Env1.evidence, [1, 2, 3]);

    // --- BATCH 2 (Processes refs 4, 5, 6) ---
    const res2 = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details2 = res2.details as { createdL1: number[] };
    assert.strictEqual(details2.createdL1.length, 1, "Batch 2 must create 1 successor L1 investigation");
    const l1Ref2 = details2.createdL1[0];
    assert.notStrictEqual(l1Ref2, l1Ref1, "Successor L1 has new reference");

    journal = await readConsolidationJournal(tmpDir);
    assert.deepStrictEqual(journal.pendingL0Refs, [7], "Batch 2 leaves remaining 1 reference pending");
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], l1Ref2, "Journal updates active L1 to successor after Batch 2");

    // Inspect Batch 2 successor L1 and verify reciprocal link with predecessor
    const l1Raw2 = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l1Ref2, axisPath, tmpDir));
    const { envelope: l1Env2 } = decodePayload(l1Raw2.stdout.trim());
    assert.strictEqual(l1Env2.supersedes, l1Ref1, "Batch 2 successor must point back to predecessor");
    assert.deepStrictEqual(l1Env2.evidence, [1, 2, 3, 4, 5, 6], "Batch 2 evidence must merge refs 1..6");

    const pred1Check = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l1Ref1, axisPath, tmpDir));
    const { envelope: pred1Env } = decodePayload(pred1Check.stdout.trim());
    assert.strictEqual(pred1Env.lifecycle, "superseded", "Predecessor 1 must be marked superseded");
    assert.strictEqual(pred1Env.supersededBy, l1Ref2, "Predecessor 1 must record reciprocal supersededBy link");

    // --- BATCH 3 (Processes final ref 7) ---
    const res3 = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details3 = res3.details as { createdL1: number[] };
    assert.strictEqual(details3.createdL1.length, 1, "Batch 3 must create final successor L1 investigation");
    const l1Ref3 = details3.createdL1[0];

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "All pending L0 references must be completely drained");
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], l1Ref3, "Journal tracks final active L1");

    // Inspect Batch 3 final successor L1
    const l1Raw3 = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l1Ref3, axisPath, tmpDir));
    const { envelope: l1Env3 } = decodePayload(l1Raw3.stdout.trim());
    assert.strictEqual(l1Env3.supersedes, l1Ref2, "Final successor points back to predecessor 2");
    assert.deepStrictEqual(l1Env3.evidence, [1, 2, 3, 4, 5, 6, 7], "Final evidence links all 7 L0 records across all batches");
    assert.strictEqual(l1Env3.episode?.findings?.length, 7, "All 7 findings preserved");
    assert.strictEqual(l1Env3.episode?.diffs?.length, 7, "All 7 diffs preserved");
    assert.strictEqual(l1Env3.episode?.approaches?.length, 7, "All 7 approaches preserved");
    assert.strictEqual(l1Env3.episode?.outcome, "success", "Outcome resolved monotonically to success");
    assert.strictEqual(l1Env3.lifecycle, "tested", "Lifecycle resolved monotonically to tested");

    const pred2Check = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l1Ref2, axisPath, tmpDir));
    const { envelope: pred2Env } = decodePayload(pred2Check.stdout.trim());
    assert.strictEqual(pred2Env.lifecycle, "superseded", "Predecessor 2 must be marked superseded");
    assert.strictEqual(pred2Env.supersededBy, l1Ref3, "Predecessor 2 must record reciprocal supersededBy link");

    // --- RETRY IDEMPOTENCY ---
    const resRetry = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const detailsRetry = resRetry.details as { createdL1: number[] };
    assert.strictEqual(detailsRetry.createdL1.length, 0, "Repeated consolidation produces 0 new records");

    // --- ORDINARY RECALL ---
    const scanRes = await executeHybridScan(toolEnv, { topic: "compaction stall", limit: 15 });
    // Hybrid recall filters out superseded records; only active L1 (ref 10) must be returned
    const activeL1Hit = scanRes.records.find((r) => (r.envelope?.level ?? r.level) === "L1");
    assert.ok(activeL1Hit, "Hybrid scan must retrieve active L1 investigation");
    assert.strictEqual(activeL1Hit.ref, l1Ref3, "Hybrid scan must prefer current active successor over superseded predecessors");

    // --- DOWNWARD TRAVERSAL ---
    const traverseTool = makeTraverseTool(() => Promise.resolve(toolEnv));
    const travRes = await traverseTool.execute("call-trav-mb", { ref: l1Ref3, direction: "down" }, undefined, undefined, ctx);
    const travDetails = travRes.details as { tree?: { children?: Array<{ ref: number }> } };
    assert.ok(travDetails.tree, "Must return traversal tree");
    const citedChildRefs = (travDetails.tree.children || []).map((c) => c.ref);
    for (let i = 1; i <= 7; i++) {
      assert.ok(citedChildRefs.includes(i), `Traversal must include constituent L0 ref ${i}`);
    }

    // --- DIRTY SCOPES INTEGRITY ---
    assert.ok(journal.dirtyScopes["storage"], "Storage scope exists in journal");
    assert.ok(journal.dirtyScopes["storage"].l1Refs.includes(l1Ref3), "dirtyScopes contains active successor L1");
    assert.strictEqual(journal.dirtyScopes["storage"].l1Refs.includes(l1Ref1), false, "dirtyScopes does not retain superseded predecessor 1");
    assert.strictEqual(journal.dirtyScopes["storage"].l1Refs.includes(l1Ref2), false, "dirtyScopes does not retain superseded predecessor 2");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 11. Outcome accuracy: decouples findings from success and derives accurate epistemic states", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-outcomes-" });
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
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-20T21:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-outcomes",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-outcomes" };

    // --- CASE A: All-failed attempts with findings ---
    // Ref 1: 2 failed approaches and 3 findings
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, `2026-10-20:${JSON.stringify({
      level: "L0",
      type: "episode",
      lifecycle: "observed",
      summary: "TCP connect failure analysis",
      episode: {
        request: "Diagnose TCP connect timeout to upstream service",
        problem: "TCP connect timeout to upstream service",
        findings: [
          "TCP connect hangs after SYN packet is transmitted",
          "Firewall drops SYN packets on target port 443",
          "Upstream route is completely unreachable",
        ],
        approaches: [
          { approach: "retry with exponential backoff", outcome: "failed" },
          { approach: "switch to alternate socket timeout", outcome: "failed" },
        ],
        outcome: "failure",
        runId: "run-outcome-failed",
      },
    })}`, axisPath, tmpDir));

    // --- CASE B: Exploratory observations without approaches ---
    // Ref 2: Observations only, 0 approaches
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 2, `2026-10-20:${JSON.stringify({
      level: "L0",
      type: "episode",
      lifecycle: "observed",
      summary: "L2 cache profiling observation",
      episode: {
        request: "Profile CPU cache efficiency during indexing",
        problem: "Profile CPU cache efficiency during indexing",
        findings: [
          "Observed high cache miss rate on L2 cache",
          "Profile shows branch mispredictions in hash loop",
        ],
        outcome: "observed",
        runId: "run-outcome-exploratory",
      },
    })}`, axisPath, tmpDir));

    // --- CASE C: Failed attempts followed by a verified successful fix ---
    // Ref 3: Initial failed approach
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 3, `2026-10-20:${JSON.stringify({
      level: "L0",
      type: "episode",
      lifecycle: "observed",
      summary: "Parser stack overflow: attempt 1",
      episode: {
        request: "Fix stack overflow crash during AST parsing",
        problem: "Stack overflow crash during AST parsing",
        approaches: [{ approach: "increase thread stack size", outcome: "failed" }],
        outcome: "failure",
        runId: "run-outcome-mixed",
      },
    })}`, axisPath, tmpDir));

    // Ref 4: Second approach worked
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 4, `2026-10-20:${JSON.stringify({
      level: "L0",
      type: "episode",
      lifecycle: "tested",
      summary: "Parser stack overflow: attempt 2",
      episode: {
        request: "Fix stack overflow crash during AST parsing",
        problem: "Stack overflow crash during AST parsing",
        approaches: [{ approach: "eliminate recursive descent in favor of explicit stack", outcome: "worked" }],
        diffs: ["src/parser.c"],
        outcome: "success",
        runId: "run-outcome-mixed",
      },
    })}`, axisPath, tmpDir));

    // --- CASE D: Tool success with explicit supporting evidence ---
    // Ref 5: Worked approach with supported lifecycle
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 5, `2026-10-20:${JSON.stringify({
      level: "L0",
      type: "episode",
      lifecycle: "supported",
      summary: "SIMD vectorization verified with benchmark data",
      episode: {
        request: "Accelerate vector dot product with AVX2",
        problem: "Accelerate vector dot product with AVX2",
        approaches: [{ approach: "apply AVX2 FMA intrinsics", outcome: "worked" }],
        outcome: "success",
        runId: "run-outcome-supported",
      },
    })}`, axisPath, tmpDir));

    await advanceRefSeq(tmpDir, 6);

    const initialJournal = await readConsolidationJournal(tmpDir);
    initialJournal.pendingL0Refs = [1, 2, 3, 4, 5];
    await writeConsolidationJournal(tmpDir, initialJournal);

    const res = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details = res.details as { createdL1: number[] };
    assert.strictEqual(details.createdL1.length, 4, "Must consolidate 4 distinct run groups into 4 L1 investigations");

    // Check Case A: All-failed with findings
    const l1FailedRef = details.createdL1[0];
    const l1FailedRaw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l1FailedRef, axisPath, tmpDir));
    const { envelope: l1FailedEnv } = decodePayload(l1FailedRaw.stdout.trim());
    assert.strictEqual(l1FailedEnv.episode?.outcome, "failure", "Case A must be classified as failure despite having 3 findings");
    assert.strictEqual(l1FailedEnv.lifecycle, "observed", "Case A must have observed lifecycle");
    assert.strictEqual(l1FailedEnv.episode?.approaches?.length, 2, "Both failed approaches preserved");
    assert.strictEqual(l1FailedEnv.episode?.findings?.length, 3, "All 3 findings preserved");
    assert.strictEqual(l1FailedEnv.summary.includes("verified"), false, "Summary must not claim verified fix");

    // Check Case B: Exploratory observation (no approaches)
    const l1ExploratoryRef = details.createdL1[1];
    const l1ExploratoryRaw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l1ExploratoryRef, axisPath, tmpDir));
    const { envelope: l1ExploratoryEnv } = decodePayload(l1ExploratoryRaw.stdout.trim());
    assert.strictEqual(l1ExploratoryEnv.episode?.outcome, "observed", "Case B must have observed outcome");
    assert.strictEqual(l1ExploratoryEnv.lifecycle, "observed", "Case B must have observed lifecycle");
    assert.strictEqual(l1ExploratoryEnv.episode?.findings?.length, 2, "Exploratory findings preserved");

    // Check Case C: Mixed failed + worked
    const l1MixedRef = details.createdL1[2];
    const l1MixedRaw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l1MixedRef, axisPath, tmpDir));
    const { envelope: l1MixedEnv } = decodePayload(l1MixedRaw.stdout.trim());
    assert.strictEqual(l1MixedEnv.episode?.outcome, "success", "Case C must resolve to success due to worked approach");
    assert.strictEqual(l1MixedEnv.lifecycle, "tested", "Case C has tested lifecycle (no external supporting evidence)");
    assert.strictEqual(l1MixedEnv.episode?.approaches?.length, 2, "Both failed approach and worked approach preserved");
    assert.ok(l1MixedEnv.episode?.approaches?.some((a) => a.outcome === "failed"), "Failed approach retained");
    assert.ok(l1MixedEnv.episode?.approaches?.some((a) => a.outcome === "worked"), "Worked approach retained");
    assert.ok(l1MixedEnv.summary.includes("verified: eliminate recursive descent"), "Summary cites verified approach");

    // Check Case D: Supported lifecycle
    const l1SupportedRef = details.createdL1[3];
    const l1SupportedRaw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l1SupportedRef, axisPath, tmpDir));
    const { envelope: l1SupportedEnv } = decodePayload(l1SupportedRaw.stdout.trim());
    assert.strictEqual(l1SupportedEnv.episode?.outcome, "success");
    assert.strictEqual(l1SupportedEnv.lifecycle, "supported", "Case D preserves supported lifecycle from verified evidence");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 12. Crash-window recovery across interrupted stages converges without duplicates or stranded L0s", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-tech-crash-" });
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
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-20T22:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-crash",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-crash" };

    // =========================================================================
    // CRASH WINDOW 1: Initial L1 persisted to CORM, but active-run metadata
    // not yet saved and pending queue not yet pruned.
    // =========================================================================
    // Seed L0 refs 1, 2, 3
    for (let i = 1; i <= 3; i++) {
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, `2026-10-20:${JSON.stringify({
        level: "L0", type: "episode", lifecycle: "tested", summary: `Step ${i}`,
        episode: { request: "Task 1", problem: "Task 1", outcome: "success", runId: "run-win-1" },
      })}`, axisPath, tmpDir));
    }
    // Seed initial L1 (ref 4) citing [1, 2, 3] directly into CORM
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 4, `2026-10-20:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Investigation: Task 1",
      evidence: [1, 2, 3],
      episode: { request: "Task 1", problem: "Task 1", outcome: "success", runId: "run-win-1" },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 5);

    // Simulate crash state: transition recorded, but activeL1ByRunId empty and pendingL0Refs still has [1, 2, 3]
    let journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [1, 2, 3];
    journal.activeL1ByRunId = {};
    journal.pendingL1Transitions = {
      "run-win-1": {
        runId: "run-win-1",
        successorRef: 4,
        sourceL0Refs: [1, 2, 3],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    // Trigger reconciliation via auto-consolidation retry
    const res1 = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details1 = res1.details as { createdL1: number[] };
    assert.strictEqual(details1.createdL1.length, 0, "Window 1 retry must NOT create a duplicate L1");

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.activeL1ByRunId?.["run-win-1"], 4, "Window 1: activeL1ByRunId reconciled to ref 4");
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "Window 1: pendingL0Refs pruned completely");
    assert.strictEqual(Object.keys(journal.pendingL1Transitions || {}).length, 0, "Window 1: transition cleared");

    // =========================================================================
    // CRASH WINDOW 2: Successor L1 persisted, but predecessor update not completed.
    // =========================================================================
    // Add L0 ref 5 for the same run
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 5, `2026-10-20:${JSON.stringify({
      level: "L0", type: "episode", lifecycle: "tested", summary: "Step 5",
      episode: { request: "Task 1", problem: "Task 1", outcome: "success", runId: "run-win-1" },
    })}`, axisPath, tmpDir));
    // Store successor L1 (ref 6) citing [1, 2, 3, 5] with supersedes: 4
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 6, `2026-10-20:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Investigation: Task 1 - evolved",
      supersedes: 4,
      evidence: [1, 2, 3, 5],
      episode: { request: "Task 1", problem: "Task 1", outcome: "success", runId: "run-win-1" },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 7);

    // Simulate crash before ref 4 was marked superseded
    journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [5];
    journal.pendingL1Transitions = {
      "run-win-1": {
        runId: "run-win-1",
        predecessorRef: 4,
        successorRef: 6,
        sourceL0Refs: [5],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    // Trigger reconciliation
    const res2 = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details2 = res2.details as { createdL1: number[] };
    assert.strictEqual(details2.createdL1.length, 0, "Window 2 retry must reconcile without creating duplicate L1");

    // Verify predecessor 4 is now marked superseded with reciprocal link
    const pred4Raw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 4, axisPath, tmpDir));
    const { envelope: pred4Env } = decodePayload(pred4Raw.stdout.trim());
    assert.strictEqual(pred4Env.lifecycle, "superseded", "Predecessor 4 updated to superseded");
    assert.strictEqual(pred4Env.supersededBy, 6, "Predecessor 4 reciprocal supersededBy points to 6");

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.activeL1ByRunId?.["run-win-1"], 6, "Window 2: activeL1ByRunId updated to successor 6");
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "Window 2: pendingL0Refs pruned");

    // =========================================================================
    // CRASH WINDOW 3: Active-run pointer updated, but pending queue not pruned
    // (recognizing pending L0s already represented by an existing active L1).
    // =========================================================================
    // Seed L0 refs 7, 8 for run-win-3
    for (let i = 7; i <= 8; i++) {
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, `2026-10-20:${JSON.stringify({
        level: "L0", type: "episode", lifecycle: "tested", summary: `Step ${i}`,
        episode: { request: "Task 3", problem: "Task 3", outcome: "success", runId: "run-win-3" },
      })}`, axisPath, tmpDir));
    }
    // Store L1 ref 9 citing [7, 8]
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 9, `2026-10-20:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Investigation: Task 3",
      evidence: [7, 8],
      episode: { request: "Task 3", problem: "Task 3", outcome: "success", runId: "run-win-3" },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 10);

    journal = await readConsolidationJournal(tmpDir);
    journal.activeL1ByRunId = journal.activeL1ByRunId || {};
    journal.activeL1ByRunId["run-win-3"] = 9;
    // Stranded pending references!
    journal.pendingL0Refs = [7, 8];
    delete journal.pendingL1Transitions;
    await writeConsolidationJournal(tmpDir, journal);

    // Trigger consolidation: must recognize [7, 8] are already represented by active L1 (ref 9)
    const res3 = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details3 = res3.details as { createdL1: number[] };
    assert.strictEqual(details3.createdL1.length, 0, "Window 3 retry must NOT create a duplicate L1");

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "Window 3: stranded pending L0 references pruned successfully");

    // =========================================================================
    // CRASH WINDOW 4: Crash immediately after ref allocation before CORM write.
    // =========================================================================
    // Seed L0 ref 10
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 10, `2026-10-20:${JSON.stringify({
      level: "L0", type: "episode", lifecycle: "tested", summary: "Step 10",
      episode: { request: "Task 4", problem: "Task 4", outcome: "success", runId: "run-win-4" },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 11);

    journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [10];
    journal.pendingL1Transitions = {
      "run-win-4": {
        runId: "run-win-4",
        successorRef: 999, // Allocated ref that was NEVER written to CORM
        sourceL0Refs: [10],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    // Trigger consolidation: must detect 999 does not exist, clear the transition, and consolidate ref 10
    const res4 = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details4 = res4.details as { createdL1: number[] };
    assert.strictEqual(details4.createdL1.length, 1, "Window 4: creates 1 new L1 for uncommitted L0 ref 10");
    const freshL1Ref = details4.createdL1[0];
    assert.notStrictEqual(freshL1Ref, 999, "Allocates valid reference");

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "Window 4: queue drained");
    assert.strictEqual(journal.activeL1ByRunId?.["run-win-4"], freshL1Ref, "Window 4: active L1 recorded");
    assert.strictEqual(Object.keys(journal.pendingL1Transitions || {}).length, 0, "Window 4: transition cleared");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 13. Fault injection: predecessor store failure during normal successor creation in autoL0ToL1", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-fault-store1-" });
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

    let failStoreRef: number | null = null;
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (failStoreRef !== null && inv.args[0] === "-p" && typeof inv.args[1] === "string" && inv.args[1].startsWith(`${failStoreRef}:`)) {
          return { code: 1, stdout: "", stderr: "Injected disk write failure on predecessor update" };
        }
        return await daemonRunner.run(inv);
      },
    };

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-20T23:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-fault1",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-fault1" };

    const RUN_ID = "run-fault-store-1";
    // 1. Initial turn: Seed L0 ref 1 and create initial L1 (ref 2)
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, `2026-10-20:${JSON.stringify({
      level: "L0", type: "episode", lifecycle: "tested", summary: "Initial attempt",
      episode: { request: "Fix TCP race", problem: "Fix TCP race", outcome: "failure", runId: RUN_ID },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 2);

    let journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [1];
    await writeConsolidationJournal(tmpDir, journal);

    const res1 = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details1 = res1.details as { createdL1: number[] };
    assert.strictEqual(details1.createdL1.length, 1, "Creates initial L1");
    const predRef = details1.createdL1[0];

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], predRef, "Initial L1 tracked in activeL1ByRunId");
    assert.strictEqual(journal.pendingL0Refs?.length, 0);

    // 2. Next turn: Add L0 ref 3 and trigger successor creation with INJECTED FAILURE on predecessor store!
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 3, `2026-10-20:${JSON.stringify({
      level: "L0", type: "episode", lifecycle: "tested", summary: "Second attempt",
      episode: { request: "Fix TCP race", problem: "Fix TCP race", approaches: [{ approach: "mutex lock", outcome: "worked" }], outcome: "success", runId: RUN_ID },
    })}`, axisPath, tmpDir));

    journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [3];
    await writeConsolidationJournal(tmpDir, journal);

    // Inject failure specifically when updating predecessor ref (predRef)
    failStoreRef = predRef;

    const res2 = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details2 = res2.details as { createdL1: number[] };
    // Failure detected: autoL0ToL1 does not report successor creation as completed
    assert.strictEqual(details2.createdL1.length, 0, "Failed predecessor update must not report success");

    // Predecessor in CORM must NOT be falsely marked superseded
    const predCheckRaw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, predRef, axisPath, tmpDir));
    const { envelope: predCheckEnv } = decodePayload(predCheckRaw.stdout.trim());
    assert.notStrictEqual(predCheckEnv.lifecycle, "superseded", "Predecessor must NOT be marked superseded on failed write");

    journal = await readConsolidationJournal(tmpDir);
    // Transition and source L0 references must remain pending!
    assert.ok(journal.pendingL1Transitions?.[RUN_ID], "Transition must remain pending in journal");
    assert.deepStrictEqual(journal.pendingL0Refs, [3], "Source L0 reference 3 must remain pending in queue");
    // Active L1 pointer must NOT be advanced while predecessor is unresolved
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], predRef, "activeL1ByRunId must remain predecessor");

    // 3. Remove fault injection and retry consolidation
    failStoreRef = null;

    const res3 = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details3 = res3.details as { createdL1: number[] };
    assert.strictEqual(details3.createdL1.length, 0, "Retry reconciles existing successor without creating duplicate");

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "Source L0 queue completely drained after reconciliation");
    assert.strictEqual(Object.keys(journal.pendingL1Transitions || {}).length, 0, "Transition cleared after reconciliation");
    const activeL1Ref = journal.activeL1ByRunId?.[RUN_ID];
    assert.ok(activeL1Ref && activeL1Ref !== predRef, "activeL1ByRunId updated to successor");

    // Verify reciprocal links in CORM
    const finalPredRaw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, predRef, axisPath, tmpDir));
    const { envelope: finalPredEnv } = decodePayload(finalPredRaw.stdout.trim());
    assert.strictEqual(finalPredEnv.lifecycle, "superseded", "Predecessor is now superseded");
    assert.strictEqual(finalPredEnv.supersededBy, activeL1Ref, "Predecessor points to successor");

    const finalSuccRaw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, activeL1Ref, axisPath, tmpDir));
    const { envelope: finalSuccEnv } = decodePayload(finalSuccRaw.stdout.trim());
    assert.strictEqual(finalSuccEnv.supersedes, predRef, "Successor points back to predecessor");
    assert.deepStrictEqual(finalSuccEnv.evidence, [1, 3], "Successor merges all constituent evidence");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 14. Fault injection: predecessor store failure during reconcilePendingL1Transitions", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-fault-store2-" });
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

    let failStoreRef: number | null = null;
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (failStoreRef !== null && inv.args[0] === "-p" && typeof inv.args[1] === "string" && inv.args[1].startsWith(`${failStoreRef}:`)) {
          return { code: 1, stdout: "", stderr: "Injected disk write failure during reconcile store" };
        }
        return await daemonRunner.run(inv);
      },
    };

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-20T23:30:00Z"),
      cwd: tmpDir,
      sessionId: "sess-fault2",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-fault2" };

    const RUN_ID = "run-fault-store-2";
    // Seed predecessor ref 1 and successor ref 2
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, `2026-10-20:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Pred 1",
      evidence: [10],
      episode: { request: "Task 2", problem: "Task 2", outcome: "failure", runId: RUN_ID },
    })}`, axisPath, tmpDir));

    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 2, `2026-10-20:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Succ 2",
      supersedes: 1,
      evidence: [10, 20],
      episode: { request: "Task 2", problem: "Task 2", outcome: "success", runId: RUN_ID },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 3);

    let journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [20];
    journal.activeL1ByRunId = { [RUN_ID]: 1 };
    journal.pendingL1Transitions = {
      [RUN_ID]: {
        runId: RUN_ID,
        predecessorRef: 1,
        successorRef: 2,
        sourceL0Refs: [20],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    // Inject store failure on predecessor ref 1
    failStoreRef = 1;

    // Trigger auto-consolidation (which invokes reconcilePendingL1Transitions)
    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.pendingL1Transitions?.[RUN_ID], "Transition must remain pending when store fails in reconciliation");
    assert.deepStrictEqual(journal.pendingL0Refs, [20], "Pending L0 refs must not be pruned");
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], 1, "activeL1ByRunId must remain predecessor");

    // Remove fault and retry
    failStoreRef = null;
    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "Pending L0 pruned on successful retry");
    assert.strictEqual(Object.keys(journal.pendingL1Transitions || {}).length, 0, "Transition cleared");
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], 2, "activeL1ByRunId updated to successor");

    const predCheckRaw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 1, axisPath, tmpDir));
    const { envelope: predCheckEnv } = decodePayload(predCheckRaw.stdout.trim());
    assert.strictEqual(predCheckEnv.lifecycle, "superseded");
    assert.strictEqual(predCheckEnv.supersededBy, 2);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 15. Fault injection: predecessor read failure during reconcilePendingL1Transitions", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-fault-read-" });
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

    let failGetRef: number | null = null;
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (failGetRef !== null && inv.args[0] === "-r" && inv.args[1] === "-g" && inv.args[2] === String(failGetRef)) {
          return { code: 1, stdout: "", stderr: "Injected network timeout on predecessor get" };
        }
        return await daemonRunner.run(inv);
      },
    };

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-20T23:45:00Z"),
      cwd: tmpDir,
      sessionId: "sess-fault3",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-fault3" };

    const RUN_ID = "run-fault-read-3";
    // Seed predecessor ref 5 and successor ref 7
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 5, `2026-10-20:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Pred 5",
      evidence: [50],
      episode: { request: "Task 5", problem: "Task 5", outcome: "failure", runId: RUN_ID },
    })}`, axisPath, tmpDir));

    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 7, `2026-10-20:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Succ 7",
      supersedes: 5,
      evidence: [50, 60],
      episode: { request: "Task 5", problem: "Task 5", outcome: "success", runId: RUN_ID },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 8);

    let journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [60];
    journal.activeL1ByRunId = { [RUN_ID]: 5 };
    journal.pendingL1Transitions = {
      [RUN_ID]: {
        runId: RUN_ID,
        predecessorRef: 5,
        successorRef: 7,
        sourceL0Refs: [60],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    // Inject read failure on predecessor ref 5
    failGetRef = 5;

    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.pendingL1Transitions?.[RUN_ID], "Transition must remain pending when predecessor get fails");
    assert.deepStrictEqual(journal.pendingL0Refs, [60], "Pending L0 references must remain");
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], 5, "activeL1ByRunId must remain predecessor");

    // Remove fault and retry
    failGetRef = null;
    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "Pending queue drained");
    assert.strictEqual(Object.keys(journal.pendingL1Transitions || {}).length, 0, "Transition cleared");
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], 7, "activeL1ByRunId updated to successor 7");

    const predCheckRaw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 5, axisPath, tmpDir));
    const { envelope: predCheckEnv } = decodePayload(predCheckRaw.stdout.trim());
    assert.strictEqual(predCheckEnv.lifecycle, "superseded");
    assert.strictEqual(predCheckEnv.supersededBy, 7);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 16. Fault injection: transient nonzero successor get error preserves transition until retry", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-fault-succ-get-" });
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

    let failSuccRef: number | null = null;
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (failSuccRef !== null && inv.args[0] === "-r" && inv.args[1] === "-g" && inv.args[2] === String(failSuccRef)) {
          return { code: 1, stdout: "", stderr: "Injected network timeout on successor get" };
        }
        return await daemonRunner.run(inv);
      },
    };

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-21T00:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-succ-err",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-succ-err" };

    const RUN_ID = "run-succ-err";
    // Seed predecessor ref 1 and successor ref 2
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Pred 1",
      evidence: [100],
      episode: { request: "Task S", problem: "Task S", outcome: "failure", runId: RUN_ID },
    })}`, axisPath, tmpDir));

    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 2, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Succ 2",
      supersedes: 1,
      evidence: [100, 200],
      episode: { request: "Task S", problem: "Task S", outcome: "success", runId: RUN_ID },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 3);

    let journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [200];
    journal.activeL1ByRunId = { [RUN_ID]: 1 };
    journal.pendingL1Transitions = {
      [RUN_ID]: {
        runId: RUN_ID,
        predecessorRef: 1,
        successorRef: 2,
        sourceL0Refs: [200],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    // Inject transient get error on successor ref 2
    failSuccRef = 2;

    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    // Transition must NOT be cleared on transient read error!
    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.pendingL1Transitions?.[RUN_ID], "Transition must be preserved on transient successor read error");
    assert.deepStrictEqual(journal.pendingL0Refs, [200], "Pending L0 references must remain");
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], 1, "activeL1ByRunId must remain predecessor");

    // Remove fault and retry: reconciliation must complete using existing successor ref 2
    failSuccRef = null;
    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "Pending queue drained");
    assert.strictEqual(Object.keys(journal.pendingL1Transitions || {}).length, 0, "Transition cleared");
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], 2, "activeL1ByRunId updated to successor 2");

    const predCheckRaw = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 1, axisPath, tmpDir));
    const { envelope: predCheckEnv } = decodePayload(predCheckRaw.stdout.trim());
    assert.strictEqual(predCheckEnv.lifecycle, "superseded");
    assert.strictEqual(predCheckEnv.supersededBy, 2);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 17. Fault injection: empty or inconclusive successor read response preserves transition", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-fault-succ-empty-" });
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

    let returnEmptySucc: number | null = null;
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (returnEmptySucc !== null && inv.args[0] === "-r" && inv.args[1] === "-g" && inv.args[2] === String(returnEmptySucc)) {
          return { code: 0, stdout: "", stderr: "" }; // Empty stdout (inconclusive)
        }
        return await daemonRunner.run(inv);
      },
    };

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-21T00:15:00Z"),
      cwd: tmpDir,
      sessionId: "sess-succ-empty",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-succ-empty" };

    const RUN_ID = "run-succ-empty";
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 10, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Pred 10",
      evidence: [1000],
      episode: { request: "Task E", problem: "Task E", outcome: "failure", runId: RUN_ID },
    })}`, axisPath, tmpDir));

    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 20, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Succ 20",
      supersedes: 10,
      evidence: [1000, 2000],
      episode: { request: "Task E", problem: "Task E", outcome: "success", runId: RUN_ID },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 21);

    let journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [2000];
    journal.activeL1ByRunId = { [RUN_ID]: 10 };
    journal.pendingL1Transitions = {
      [RUN_ID]: {
        runId: RUN_ID,
        predecessorRef: 10,
        successorRef: 20,
        sourceL0Refs: [2000],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    returnEmptySucc = 20;

    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.pendingL1Transitions?.[RUN_ID], "Transition must be preserved on empty successor read");
    assert.deepStrictEqual(journal.pendingL0Refs, [2000]);

    returnEmptySucc = null;
    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0);
    assert.strictEqual(Object.keys(journal.pendingL1Transitions || {}).length, 0);
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], 20);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 18. Confirmed absent successor (-1 sentinel) clears aborted transition and enables fresh L1 creation", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-fault-succ-missing-" });
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

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-21T00:30:00Z"),
      cwd: tmpDir,
      sessionId: "sess-succ-missing",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-succ-missing" };

    const RUN_ID = "run-succ-missing";
    // Seed L0 ref 1 in CORM
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, `2026-10-21:${JSON.stringify({
      level: "L0", type: "episode", lifecycle: "tested", summary: "L0 task M",
      episode: { request: "Task M", problem: "Task M", approaches: [{ approach: "fix", outcome: "worked" }], outcome: "success", runId: RUN_ID },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 2);

    // Ref 99 was NEVER written to CORM (it genuinely returns -1 sentinel)
    let journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [1];
    journal.pendingL1Transitions = {
      [RUN_ID]: {
        runId: RUN_ID,
        successorRef: 99, // Absent
        sourceL0Refs: [1],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    // Reconcile: must detect 99 is confirmed absent, delete the aborted transition, and consolidate L0 ref 1
    const res = await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });
    const details = res.details as { createdL1: number[] };
    assert.strictEqual(details.createdL1.length, 1, "Creates fresh valid L1 from pending source evidence");
    const freshRef = details.createdL1[0];
    assert.notStrictEqual(freshRef, 99, "Allocated fresh valid reference");

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL0Refs?.length, 0, "Queue drained");
    assert.strictEqual(journal.activeL1ByRunId?.[RUN_ID], freshRef);
    assert.strictEqual(Object.keys(journal.pendingL1Transitions || {}).length, 0);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 19. Successor record identity/evidence inconsistency preserves pending transition", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-fault-succ-inconsistent-" });
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

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
    };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-21T00:45:00Z"),
      cwd: tmpDir,
      sessionId: "sess-succ-inconsistent",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-succ-inconsistent" };

    // --- CASE A: Mismatched level/type (record at successorRef is an L0 note) ---
    const RUN_A = "run-inconsistent-A";
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 100, `2026-10-21:${JSON.stringify({
      level: "L0", type: "note", lifecycle: "observed", summary: "Wrong level record",
    })}`, axisPath, tmpDir));

    let journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [10];
    journal.pendingL1Transitions = {
      [RUN_A]: {
        runId: RUN_A,
        successorRef: 100,
        sourceL0Refs: [10],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.pendingL1Transitions?.[RUN_A], "Case A: transition preserved due to level/type mismatch");
    assert.deepStrictEqual(journal.pendingL0Refs, [10], "Source L0 not pruned");

    // --- CASE B: Mismatched runId ---
    const RUN_B = "run-inconsistent-B";
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 200, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Mismatched runId",
      evidence: [20],
      episode: { request: "Req", problem: "Prob", outcome: "success", runId: "different-run" },
    })}`, axisPath, tmpDir));

    journal.pendingL0Refs = [20];
    journal.pendingL1Transitions = {
      [RUN_B]: {
        runId: RUN_B,
        successorRef: 200,
        sourceL0Refs: [20],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.pendingL1Transitions?.[RUN_B], "Case B: transition preserved due to runId mismatch");
    assert.deepStrictEqual(journal.pendingL0Refs, [20]);

    // --- CASE C: Mismatched predecessor ---
    const RUN_C = "run-inconsistent-C";
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 300, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Mismatched predecessor",
      supersedes: 777, // Expected predecessor is 888
      evidence: [30],
      episode: { request: "Req", problem: "Prob", outcome: "success", runId: RUN_C },
    })}`, axisPath, tmpDir));

    journal.pendingL0Refs = [30];
    journal.pendingL1Transitions = {
      [RUN_C]: {
        runId: RUN_C,
        predecessorRef: 888, // Mismatched
        successorRef: 300,
        sourceL0Refs: [30],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.pendingL1Transitions?.[RUN_C], "Case C: transition preserved due to predecessor mismatch");
    assert.deepStrictEqual(journal.pendingL0Refs, [30]);

    // --- CASE D: Missing source evidence references ---
    const RUN_D = "run-inconsistent-D";
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 400, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Incomplete evidence",
      evidence: [40], // Missing 41!
      episode: { request: "Req", problem: "Prob", outcome: "success", runId: RUN_D },
    })}`, axisPath, tmpDir));

    journal.pendingL0Refs = [40, 41];
    journal.pendingL1Transitions = {
      [RUN_D]: {
        runId: RUN_D,
        successorRef: 400,
        sourceL0Refs: [40, 41],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.pendingL1Transitions?.[RUN_D], "Case D: transition preserved due to missing evidence ref");
    assert.deepStrictEqual(journal.pendingL0Refs, [40, 41]);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("technical_episodes: 20. Restore dirty-scope registration during L1 transition recovery", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-scope-recovery-" });
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

    let failStoreRef: number | null = null;
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (failStoreRef !== null && inv.args[0] === "-p" && typeof inv.args[1] === "string" && inv.args[1].startsWith(`${failStoreRef}:`)) {
          return { code: 1, stdout: "", stderr: "Injected disk write failure" };
        }
        return await daemonRunner.run(inv);
      },
    };

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      consolidateL2Threshold: 3,
    };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-21T01:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-scope-rec",
    };
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-scope-rec" };

    // --- TEST 1: Scoped initial L1 recovery ---
    // Seed L0 ref 1 and initial scoped L1 ref 2 in project "networking"
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, `2026-10-21:${JSON.stringify({
      level: "L0", type: "episode", lifecycle: "tested", summary: "L0 net 1",
      context: { project: "networking" },
      episode: { request: "Net 1", problem: "Net 1", outcome: "success", runId: "run-scope-1" },
    })}`, axisPath, tmpDir));

    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 2, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "L1 Net 1",
      context: { project: "networking" },
      evidence: [1],
      episode: { request: "Net 1", problem: "Net 1", outcome: "success", runId: "run-scope-1" },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 3);

    // Simulate crash after CORM store but before dirtyScopes registration
    let journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [1];
    journal.dirtyScopes = {};
    journal.pendingL2Scopes = [];
    journal.pendingL1Transitions = {
      "run-scope-1": {
        runId: "run-scope-1",
        successorRef: 2,
        sourceL0Refs: [1],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    // Reconcile
    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.dirtyScopes["networking"], "Dirty scope 'networking' must be restored");
    assert.deepStrictEqual(journal.dirtyScopes["networking"].l1Refs, [2], "Successor ref 2 registered in dirty scope");
    assert.strictEqual(journal.dirtyScopes["networking"].count, 1);
    assert.strictEqual(journal.pendingL2Scopes.includes("networking"), false, "Threshold 3 not yet reached");

    // --- TEST 2: L2 threshold eligibility once threshold is met ---
    // Add L1 ref 3 and ref 4 to "networking" via transitions
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 3, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "L1 Net 2",
      context: { project: "networking" },
      evidence: [11],
      episode: { request: "Net 2", problem: "Net 2", outcome: "success", runId: "run-scope-2" },
    })}`, axisPath, tmpDir));

    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 4, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "L1 Net 3",
      context: { project: "networking" },
      evidence: [12],
      episode: { request: "Net 3", problem: "Net 3", outcome: "success", runId: "run-scope-3" },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 5);

    journal = await readConsolidationJournal(tmpDir);
    journal.pendingL1Transitions = {
      "run-scope-2": { runId: "run-scope-2", successorRef: 3, sourceL0Refs: [11], timestamp: new Date().toISOString() },
      "run-scope-3": { runId: "run-scope-3", successorRef: 4, sourceL0Refs: [12], timestamp: new Date().toISOString() },
    };
    await writeConsolidationJournal(tmpDir, journal);

    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.dirtyScopes["networking"].count, 3, "Dirty scope count reached 3");
    assert.deepStrictEqual(journal.dirtyScopes["networking"].l1Refs, [2, 3, 4]);
    assert.ok(journal.pendingL2Scopes.includes("networking"), "Threshold 3 met: 'networking' marked pending for L2 consolidation");

    // --- TEST 3: Scoped successor L1 recovery with predecessor replacement ---
    // Successor ref 5 supersedes predecessor ref 2
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 5, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "L1 Net 1 - evolved",
      context: { project: "networking" },
      supersedes: 2,
      evidence: [1, 13],
      episode: { request: "Net 1", problem: "Net 1", outcome: "success", runId: "run-scope-1" },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 6);

    journal = await readConsolidationJournal(tmpDir);
    journal.pendingL1Transitions = {
      "run-scope-1": {
        runId: "run-scope-1",
        predecessorRef: 2,
        successorRef: 5,
        sourceL0Refs: [13],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.dirtyScopes["networking"].l1Refs.includes(2), false, "Predecessor ref 2 removed from dirtyScopes");
    assert.ok(journal.dirtyScopes["networking"].l1Refs.includes(5), "Successor ref 5 registered in dirtyScopes");
    assert.deepStrictEqual(journal.dirtyScopes["networking"].l1Refs, [3, 4, 5]);
    assert.strictEqual(journal.dirtyScopes["networking"].count, 3);

    // --- TEST 4: Repeated reconciliation idempotency ---
    // Reconcile again without new state
    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    const journalIdempotent = await readConsolidationJournal(tmpDir);
    assert.deepStrictEqual(journalIdempotent.dirtyScopes["networking"].l1Refs, [3, 4, 5], "l1Refs unchanged on repeated reconciliation");
    assert.strictEqual(journalIdempotent.dirtyScopes["networking"].count, 3, "Count unchanged");

    // --- TEST 5: Unscoped recovered L1 creates zero artificial scopes ---
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 6, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Unscoped L1",
      evidence: [14],
      episode: { request: "Unscoped", problem: "Unscoped", outcome: "success", runId: "run-unscoped" },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 7);

    journal = await readConsolidationJournal(tmpDir);
    journal.pendingL1Transitions = {
      "run-unscoped": { runId: "run-unscoped", successorRef: 6, sourceL0Refs: [14], timestamp: new Date().toISOString() },
    };
    await writeConsolidationJournal(tmpDir, journal);

    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    const scopeKeys = Object.keys(journal.dirtyScopes);
    assert.deepStrictEqual(scopeKeys, ["networking"], "Zero artificial scopes created for unscoped L1");

    // --- TEST 6: Failed predecessor update does NOT commit dirtyScopes ---
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 8, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Pred Storage",
      context: { project: "storage" },
      evidence: [15],
      episode: { request: "Storage", problem: "Storage", outcome: "failure", runId: "run-scope-storage" },
    })}`, axisPath, tmpDir));

    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 9, `2026-10-21:${JSON.stringify({
      level: "L1", type: "investigation", lifecycle: "tested", summary: "Succ Storage",
      context: { project: "storage" },
      supersedes: 8,
      evidence: [15, 16],
      episode: { request: "Storage", problem: "Storage", outcome: "success", runId: "run-scope-storage" },
    })}`, axisPath, tmpDir));
    await advanceRefSeq(tmpDir, 10);

    journal = await readConsolidationJournal(tmpDir);
    journal.pendingL0Refs = [16];
    journal.pendingL1Transitions = {
      "run-scope-storage": {
        runId: "run-scope-storage",
        predecessorRef: 8,
        successorRef: 9,
        sourceL0Refs: [16],
        timestamp: new Date().toISOString(),
      },
    };
    await writeConsolidationJournal(tmpDir, journal);

    // Inject store failure on predecessor ref 8
    failStoreRef = 8;
    await runAutoConsolidation(toolEnv, ctx, { incrementalOnly: true });

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.dirtyScopes["storage"], undefined, "Dirty scope 'storage' must NOT be committed when predecessor update fails");
    assert.ok(journal.pendingL1Transitions?.["run-scope-storage"], "Transition must remain pending");
    assert.deepStrictEqual(journal.pendingL0Refs, [16], "Source L0 references must remain pending");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
