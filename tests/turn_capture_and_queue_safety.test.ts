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
} from "../src/tools/consolidate.ts";
import {
  readConsolidationJournal,
  writeConsolidationJournal,
} from "../src/tools/consolidation_journal.ts";

const home = Deno.env.get("HOME") || "";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

Deno.test("turn_capture_queue_safety: 1. Ordinary conversational turn performs ZERO list calls and remains O(1) bounded as DB grows", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-turn-capture-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let listCount = 0;
    let getCount = 0;
    let storeCount = 0;

    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });
    const testRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (inv.args[0] === "-g" && inv.args[1] === ".") listCount++;
        if (inv.args[0] === "-r" && inv.args[1] === "-g") getCount++;
        if (inv.args[0] === "-p") storeCount++;
        return await daemonRunner.run(inv);
      },
    };

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      judgeUrl: undefined,
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-turn-bounds-1" };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({
      cfg,
      runner: testRunner,
      nowProvider: () => new Date("2026-10-19T10:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-turn-bounds-1",
    }));

    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    // Initialize session and warm up sequence
    await emit("session_start", null);

    // Initial warm-up turn (allocates ref 1)
    activeConversationTurn.topicSubject = "database";
    await emit("before_agent_start", { messageType: "user", prompt: "Postgres connection pooling enabled with PgBouncer." });
    await emit("message_end", { message: { role: "assistant", content: "PgBouncer configured." } });
    await emit("agent_settled", null);

    // Now seed 50 background records directly to grow the database significantly
    for (let i = 2; i <= 51; i++) {
      const payload = encodePayload("2026-10-19", {
        level: "L0", type: "note", lifecycle: "observed", summary: `Background fact ${i}`,
      });
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, payload, axisPath, tmpDir));
    }

    // Reset operational counters
    listCount = 0;
    getCount = 0;
    storeCount = 0;

    // Run user turn in a 50-item database
    activeConversationTurn.topicSubject = "networking";
    await emit("before_agent_start", { messageType: "user", prompt: "TLS 1.3 cipher suites enforced across all load balancers." });
    await emit("message_end", { message: { role: "assistant", content: "TLS 1.3 enforced." } });
    await emit("agent_settled", null);

    // Assert: List operations must be strictly 0; gets must be strictly O(1) (<= 5), NOT proportional to 50
    assert.strictEqual(listCount, 0, `Turn capture must not enumerate references (expected 0 list calls, observed ${listCount})`);
    assert.ok(getCount <= 5, `Turn capture get calls must be O(1) bounded (expected <= 5, observed ${getCount})`);
    assert.ok(storeCount >= 1, `Turn capture must store new record (observed ${storeCount})`);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("turn_capture_queue_safety: 2. L2 consolidation prunes only cited L1 evidence and retains uncited/unprocessed items", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-l2-pruning-" });
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

    // Mock synthesizer: receives evidence, but cites ONLY refs 1 and 2
    const synthServer = Deno.serve({ port: 0 }, (_req) => {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Synthesized scope knowledge from subset of evidence",
              explanation: "Evidence establishes core invariants",
              citedRefs: [1, 2], // Only represents refs 1 and 2!
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

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-l2-prune" };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-19T11:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-l2-prune",
    };

    // Store 5 L1 memories in 'cache' scope (Refs 1..5)
    for (let i = 1; i <= 5; i++) {
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, encodePayload("2026-10-19", {
        level: "L1", type: "note", lifecycle: "observed", summary: `Cache fact ${i}`, context: { project: "cache" },
      }), axisPath, tmpDir));
    }

    // Seed dirtyScopes with all 5 references
    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes["cache"] = {
      count: 5,
      l1Refs: [1, 2, 3, 4, 5],
      lastUpdated: new Date().toISOString(),
    };
    journal.pendingL2Scopes = ["cache"];
    await writeConsolidationJournal(tmpDir, journal);

    // Run deferred consolidation
    const res1 = await runDeferredConsolidation(toolEnv, ctx);
    const details1 = res1.details as { createdL2: number[] };
    assert.strictEqual(details1.createdL2.length, 1);

    // Verify journal: ONLY refs 1 and 2 should be pruned! Refs 3, 4, 5 must remain pending!
    journal = await readConsolidationJournal(tmpDir);
    assert.deepStrictEqual(journal.dirtyScopes["cache"].l1Refs, [3, 4, 5], "Unrepresented L1 references must be retained");
    assert.strictEqual(journal.dirtyScopes["cache"].count, 3);
    assert.strictEqual(journal.dirtyScopes["cache"].activeL2Ref, details1.createdL2[0]);
    assert.ok(journal.pendingL2Scopes.includes("cache"), "Scope must remain pending L2 when remaining count >= threshold");

    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("turn_capture_queue_safety: 3. L3 successor reconciliation repairs predecessor link without clearing dirty L2 queue", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-l3-reconcile-" });
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

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-l3-reconcile" };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-19T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-l3-reconcile",
    };

    // Store predecessor L3 at Ref 5
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 5, encodePayload("2026-10-19", {
      level: "L3", type: "pattern", lifecycle: "hypothesized", summary: "Old overarching principle", evidence: [1, 2],
    }), axisPath, tmpDir));

    // Store successor L3 at Ref 20
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 20, encodePayload("2026-10-19", {
      level: "L3", type: "pattern", lifecycle: "hypothesized", summary: "New overarching principle", evidence: [1, 2, 3], supersedes: 5,
    }), axisPath, tmpDir));

    // Seed journal with pending dirty L2 queue [10, 11, 12] and an interrupted L3 successor update
    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyL2 = {
      count: 3,
      l2Refs: [10, 11, 12],
      lastUpdated: new Date().toISOString(),
    };
    journal.pendingL3 = true;
    journal.interruptedSuccessors = [{
      level: "L3",
      predecessorRef: 5,
      successorRef: 20,
      timestamp: new Date().toISOString(),
    }];
    await writeConsolidationJournal(tmpDir, journal);

    // Run deferred consolidation (which executes reconcileInterruptedSuccessors)
    await runDeferredConsolidation(toolEnv, ctx);

    // Verify predecessor Ref 5 is now superseded by Ref 20
    const getPred = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 5, axisPath, tmpDir));
    const decodedPred = decodePayload(getPred.stdout.trim());
    assert.strictEqual(decodedPred.envelope.lifecycle, "superseded");
    assert.strictEqual(decodedPred.envelope.supersededBy, 20);

    // CRITICAL INVARIANT: The dirty L2 queue [10, 11, 12] MUST NOT be cleared by successor reconciliation!
    journal = await readConsolidationJournal(tmpDir);
    assert.deepStrictEqual(journal.dirtyL2.l2Refs, [10, 11, 12], "Successor reconciliation must never clear unrelated dirty L2 items");
    assert.strictEqual(journal.dirtyL2.count, 3);
    assert.strictEqual(journal.activeL3Ref, 20);
    assert.strictEqual(journal.interruptedSuccessors?.length ?? 0, 0);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("turn_capture_queue_safety: 4. Failed journal recovery writes recoveryRequired state and does not declare clean", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-corrupt-rec-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    // Failing runner that simulates roster listing failure (e.g. exit code 1)
    const failingRunner = {
      run: (inv: import("../src/corm.ts").Invocation) => {
        if (inv.args[0] === "-g" && inv.args[1] === ".") {
          return Promise.resolve({ code: 1, stdout: "", stderr: "Simulated roster list I/O failure" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    };

    // Corrupt the journal file
    const journalPath = join(tmpDir, ".consolidation.json");
    await Deno.writeTextFile(journalPath, "CORRUPTED_JSON_DATA{{{");

    // Read journal with failing recovery context
    const recovered = await readConsolidationJournal(tmpDir, {
      runner: failingRunner,
      cormBin: cormBin,
      fspec,
      axes: axisPath,
    });

    // Verify recoveryRequired is true and journal is NOT marked clean
    assert.strictEqual(recovered.recoveryRequired, true, "Failed recovery must record recoveryRequired = true");
    assert.ok(recovered.recoveryError?.includes("Roster list failed"), "Must describe recovery failure");

    // Read active journal from disk: it must persist recoveryRequired and not appear clean
    const onDisk = await readConsolidationJournal(tmpDir);
    assert.strictEqual(onDisk.recoveryRequired, true, "Active journal on disk must persist recoveryRequired state");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("turn_capture_queue_safety: 5. Actual execution-level operations never exceed configured consolidateBatchLimit", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-work-budget-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let listCount = 0;
    let getCount = 0;
    let storeCount = 0;
    let synthCount = 0;

    const shellExec = async (cmd: string, args: string[]) => {
      if (args[0] === "-g" && args[1] === ".") listCount++;
      if (args[0] === "-r" && args[1] === "-g") getCount++;
      if (args[0] === "-p") storeCount++;
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const synthServer = Deno.serve({ port: 0 }, async (req) => {
      synthCount++;
      const body = await req.json();
      const userPrompt = body.messages[1].content as string;
      const matches = [...userPrompt.matchAll(/\[Ref (\d+)\]/g)].map((m) => Number(m[1]));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Synthesized scope knowledge",
              explanation: "Valid synthesis",
              citedRefs: matches.slice(0, 2),
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const BATCH_LIMIT = 6;
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      consolidateBatchLimit: BATCH_LIMIT,
      consolidateL2Threshold: 2,
      synthUrl: `http://127.0.0.1:${synthServer.addr.port}`,
      synthModel: "mock-synth",
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-budget" };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-19T13:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-budget",
    };

    // Seed 3 distinct scopes, each with 4 L1 records (total 12 records)
    let refId = 1;
    const scopes = ["scope-one", "scope-two", "scope-three"];
    for (const sc of scopes) {
      for (let j = 0; j < 4; j++) {
        await daemonRunner.run(buildStoreInvocation(cormBin, fspec, refId, encodePayload("2026-10-19", {
          level: "L1", type: "note", lifecycle: "observed", summary: `${sc} fact ${j}`, context: { project: sc },
        }), axisPath, tmpDir));
        refId++;
      }
    }

    // Seed journal with all 3 dirty scopes
    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes = {
      "scope-one": { count: 4, l1Refs: [1, 2, 3, 4], lastUpdated: new Date().toISOString() },
      "scope-two": { count: 4, l1Refs: [5, 6, 7, 8], lastUpdated: new Date().toISOString() },
      "scope-three": { count: 4, l1Refs: [9, 10, 11, 12], lastUpdated: new Date().toISOString() },
    };
    journal.pendingL2Scopes = ["scope-one", "scope-two", "scope-three"];
    await writeConsolidationJournal(tmpDir, journal);

    // Reset counters before deferred consolidation run
    listCount = 0;
    getCount = 0;
    storeCount = 0;
    synthCount = 0;

    // Run deferred consolidation
    const res = await runDeferredConsolidation(toolEnv, ctx);
    const details = res.details as { operations: { totalWorkUnits: number; listCalls: number; getCalls: number; storeCalls: number; synthCalls: number } };

    // Total actual physical operations
    const totalActualOps = listCount + getCount + storeCount + synthCount;

    // Strict assertions: actual physical operations must never exceed BATCH_LIMIT
    assert.ok(
      totalActualOps <= BATCH_LIMIT,
      `Actual operations (${totalActualOps}) must not exceed batch limit (${BATCH_LIMIT}) [list=${listCount}, get=${getCount}, store=${storeCount}, synth=${synthCount}]`,
    );
    assert.ok(
      details.operations.totalWorkUnits <= BATCH_LIMIT,
      `Reported operations (${details.operations.totalWorkUnits}) must not exceed batch limit (${BATCH_LIMIT})`,
    );

    // Unprocessed scopes must remain in journal for subsequent passes
    journal = await readConsolidationJournal(tmpDir);
    assert.ok(
      journal.dirtyScopes["scope-two"] || journal.dirtyScopes["scope-three"],
      "Unprocessed scopes must be retained in journal",
    );

    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
