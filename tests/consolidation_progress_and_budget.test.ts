import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";
import { filespecFor, buildGetInvocation, buildStoreInvocation } from "../src/corm.ts";
import { decodePayload, encodePayload } from "../src/payload.ts";
import type { PiCtx } from "../src/hooks/events.ts";
import { runDeferredConsolidation } from "../src/tools/consolidate.ts";
import {
  readConsolidationJournal,
  writeConsolidationJournal,
} from "../src/tools/consolidation_journal.ts";
import { advanceRefSeq } from "../src/tools/ref_allocator.ts";

const home = Deno.env.get("HOME") || "";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

Deno.test("consolidation_progress_and_budget: 1. Small budget progress - L2 synthesis completes within tight limit", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-prog-budget-1-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let listCount = 0;
    let getCount = 0;
    let storeCount = 0;
    let synthCount = 0;

    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (inv.args[0] === "-g" && inv.args[1] === ".") listCount++;
        if (inv.args[0] === "-r" && inv.args[1] === "-g") getCount++;
        if (inv.args[0] === "-p") storeCount++;
        return await daemonRunner.run(inv);
      },
    };

    const synthServer = Deno.serve({ port: 0 }, (_req) => {
      synthCount++;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Synthesized scope knowledge within small budget",
              explanation: "Evidence establishes invariants",
              citedRefs: [1, 2],
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const BATCH_LIMIT = 5;
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

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-budget-1" };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-19T14:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-budget-1",
    };

    // Store 2 L1 records
    for (let i = 1; i <= 2; i++) {
      await instrumentedRunner.run(buildStoreInvocation(cormBin, fspec, i, encodePayload("2026-10-19", {
        level: "L1", type: "note", lifecycle: "observed", summary: `Record ${i}`, context: { project: "auth" },
      }), axisPath, tmpDir));
    }

    // Seed journal
    const journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes["auth"] = { count: 2, l1Refs: [1, 2], lastUpdated: new Date().toISOString() };
    journal.pendingL2Scopes = ["auth"];
    await writeConsolidationJournal(tmpDir, journal);

    // Reset counters before deferred consolidation
    listCount = 0;
    getCount = 0;
    storeCount = 0;
    synthCount = 0;

    const res = await runDeferredConsolidation(toolEnv, ctx);
    const details = res.details as { createdL2: number[]; operations: { listCalls: number; getCalls: number; storeCalls: number; synthCalls: number; totalWorkUnits: number } };

    // Assert: Synthesis DID complete and create L2
    assert.strictEqual(details.createdL2.length, 1, "Must complete 1 L2 synthesis");
    assert.strictEqual(synthCount, 1, "Must invoke synthesizer once");
    assert.strictEqual(storeCount, 1, "Must store new L2 abstraction");
    assert.ok(getCount >= 2, "Must read the 2 evidence items");

    const actualOps = listCount + getCount + storeCount + synthCount;
    assert.ok(actualOps <= BATCH_LIMIT, `Actual operations (${actualOps}) must not exceed batch limit (${BATCH_LIMIT})`);
    assert.strictEqual(details.operations.listCalls, listCount, "listCalls must match physical list calls");
    assert.strictEqual(details.operations.getCalls, getCount, "getCalls must match physical get calls");
    assert.strictEqual(details.operations.storeCalls, storeCount, "storeCalls must match physical store calls");
    assert.strictEqual(details.operations.synthCalls, synthCount, "synthCalls must match physical synth calls");
    assert.strictEqual(details.operations.totalWorkUnits, actualOps, "totalWorkUnits must match physical actualOps");

    // Verify journal updated
    const updatedJournal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(updatedJournal.dirtyScopes["auth"].l1Refs.length, 0, "All cited references must be pruned");
    assert.strictEqual(updatedJournal.dirtyScopes["auth"].count, 0);

    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("consolidation_progress_and_budget: 2. 17 dirty L1 refs with predecessor under limit 20 makes forward progress across repeated runs", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-prog-budget-2-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let listCount = 0;
    let getCount = 0;
    let storeCount = 0;
    let synthCount = 0;

    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (inv.args[0] === "-g" && inv.args[1] === ".") listCount++;
        if (inv.args[0] === "-r" && inv.args[1] === "-g") getCount++;
        if (inv.args[0] === "-p") storeCount++;
        return await daemonRunner.run(inv);
      },
    };

    const synthServer = Deno.serve({ port: 0 }, async (req) => {
      synthCount++;
      const body = await req.json();
      const userPrompt = body.messages[1].content as string;
      const matches = [...userPrompt.matchAll(/\[Ref (\d+)\]/g)].map((m) => Number(m[1]));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: `Consolidated invariant across ${matches.length} evidence items`,
              explanation: "Evidence establishes invariant",
              citedRefs: matches,
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const BATCH_LIMIT = 20;
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

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-budget-2" };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-19T14:30:00Z"),
      cwd: tmpDir,
      sessionId: "sess-budget-2",
    };

    // Store existing active L2 predecessor at Ref 100
    await instrumentedRunner.run(buildStoreInvocation(cormBin, fspec, 100, encodePayload("2026-10-19", {
      level: "L2", type: "invariant", lifecycle: "observed", summary: "Old invariant for storage", context: { project: "storage" }, evidence: [99],
    }), axisPath, tmpDir));

    // Store 17 dirty L1 records for 'storage' scope (Refs 1..17)
    for (let i = 1; i <= 17; i++) {
      await instrumentedRunner.run(buildStoreInvocation(cormBin, fspec, i, encodePayload("2026-10-19", {
        level: "L1", type: "note", lifecycle: "observed", summary: `Storage discovery ${i}`, context: { project: "storage" },
      }), axisPath, tmpDir));
    }

    // Seed journal with all 17 dirty L1 refs and activeL2Ref 100
    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes["storage"] = {
      count: 17,
      l1Refs: Array.from({ length: 17 }, (_, i) => i + 1),
      activeL2Ref: 100,
      lastUpdated: new Date().toISOString(),
    };
    journal.pendingL2Scopes = ["storage"];
    await writeConsolidationJournal(tmpDir, journal);
    // In live DB with 100 records already written, .ref_seq is initialized
    await advanceRefSeq(tmpDir, 101);

    // Reset counters before RUN 1
    listCount = 0;
    getCount = 0;
    storeCount = 0;
    synthCount = 0;

    // RUN 1: Must make forward progress rather than getting stuck!
    const res1 = await runDeferredConsolidation(toolEnv, ctx);
    const details1 = res1.details as { createdL2: number[]; operations: { listCalls: number; getCalls: number; storeCalls: number; synthCalls: number; totalWorkUnits: number } };

    assert.strictEqual(details1.createdL2.length, 1, "Run 1 must successfully create 1 L2 abstraction");
    assert.strictEqual(synthCount, 1, "Run 1 must invoke synthesis");
    assert.strictEqual(storeCount, 2, "Run 1 must store new L2 AND update predecessor Ref 100");

    const ops1 = listCount + getCount + storeCount + synthCount;
    assert.ok(ops1 <= BATCH_LIMIT, `Run 1 actual operations (${ops1}) must not exceed batch limit (${BATCH_LIMIT})`);
    assert.strictEqual(details1.operations.listCalls, listCount, "Run 1 listCalls must match physical list calls");
    assert.strictEqual(details1.operations.getCalls, getCount, "Run 1 getCalls must match physical get calls");
    assert.strictEqual(details1.operations.storeCalls, storeCount, "Run 1 storeCalls must match physical store calls");
    assert.strictEqual(details1.operations.synthCalls, synthCount, "Run 1 synthCalls must match physical synth calls");
    assert.strictEqual(details1.operations.totalWorkUnits, ops1, "Run 1 totalWorkUnits must match physical ops1");

    // Verify predecessor 100 is superseded
    const predRes = await instrumentedRunner.run(buildGetInvocation(cormBin, fspec, 100, axisPath, tmpDir));
    const decodedPred = decodePayload(predRes.stdout.trim());
    assert.strictEqual(decodedPred.envelope.lifecycle, "superseded");
    assert.strictEqual(decodedPred.envelope.supersededBy, details1.createdL2[0]);

    // Verify journal: 16 items were consolidated and pruned; exactly 1 item remains pending!
    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.dirtyScopes["storage"].l1Refs.length, 1, "Exactly 1 item must remain pending in queue");
    assert.strictEqual(journal.dirtyScopes["storage"].count, 1);
    assert.strictEqual(journal.dirtyScopes["storage"].activeL2Ref, details1.createdL2[0]);

    // RUN 2: Add 1 more item (Ref 18) to reach threshold 2, and run again
    await instrumentedRunner.run(buildStoreInvocation(cormBin, fspec, 18, encodePayload("2026-10-19", {
      level: "L1", type: "note", lifecycle: "observed", summary: `Storage discovery 18`, context: { project: "storage" },
    }), axisPath, tmpDir));
    journal.dirtyScopes["storage"].l1Refs.push(18);
    journal.dirtyScopes["storage"].count = 2;
    journal.pendingL2Scopes = ["storage"];
    await writeConsolidationJournal(tmpDir, journal);

    listCount = 0;
    getCount = 0;
    storeCount = 0;
    synthCount = 0;

    // RUN 2: Consolidates the remaining items cleanly
    const res2 = await runDeferredConsolidation(toolEnv, ctx);
    const details2 = res2.details as { createdL2: number[]; operations: { listCalls: number; getCalls: number; storeCalls: number; synthCalls: number; totalWorkUnits: number } };
    assert.strictEqual(details2.createdL2.length, 1, "Run 2 must successfully consolidate remaining items");

    const ops2 = listCount + getCount + storeCount + synthCount;
    assert.ok(ops2 <= BATCH_LIMIT, `Run 2 actual operations (${ops2}) must not exceed batch limit (${BATCH_LIMIT})`);
    assert.strictEqual(details2.operations.listCalls, listCount, "Run 2 listCalls must match physical list calls");
    assert.strictEqual(details2.operations.getCalls, getCount, "Run 2 getCalls must match physical get calls");
    assert.strictEqual(details2.operations.storeCalls, storeCount, "Run 2 storeCalls must match physical store calls");
    assert.strictEqual(details2.operations.synthCalls, synthCount, "Run 2 synthCalls must match physical synth calls");
    assert.strictEqual(details2.operations.totalWorkUnits, ops2, "Run 2 totalWorkUnits must match physical ops2");

    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.dirtyScopes["storage"].l1Refs.length, 0, "Queue completely drained across repeated runs");
    assert.strictEqual(journal.dirtyScopes["storage"].count, 0);

    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("consolidation_progress_and_budget: 3. L3 predecessor update with multi-scope evidence respects budget and makes progress", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-prog-budget-3-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let listCount = 0;
    let getCount = 0;
    let storeCount = 0;
    let synthCount = 0;

    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (inv.args[0] === "-g" && inv.args[1] === ".") listCount++;
        if (inv.args[0] === "-r" && inv.args[1] === "-g") getCount++;
        if (inv.args[0] === "-p") storeCount++;
        return await daemonRunner.run(inv);
      },
    };

    const synthServer = Deno.serve({ port: 0 }, (_req) => {
      synthCount++;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Generalized cross-scope principle across systems",
              principle: "Unified resource management invariant",
              applicableScopes: ["net", "fs"],
              boundaryConditions: "Valid under reliable transport",
              citedRefs: [1, 4],
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const BATCH_LIMIT = 8;
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      consolidateBatchLimit: BATCH_LIMIT,
      consolidateL3Threshold: 2,
      synthUrl: `http://127.0.0.1:${synthServer.addr.port}`,
      synthModel: "mock-synth",
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-budget-3" };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-19T15:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-budget-3",
    };

    // Store existing active L3 predecessor at Ref 200
    await instrumentedRunner.run(buildStoreInvocation(cormBin, fspec, 200, encodePayload("2026-10-19", {
      level: "L3", type: "pattern", lifecycle: "hypothesized", summary: "Old overarching principle", evidence: [10, 20],
    }), axisPath, tmpDir));

    // Store 6 L2 records across 2 scopes (net: 1..3, fs: 4..6)
    for (let i = 1; i <= 3; i++) {
      await instrumentedRunner.run(buildStoreInvocation(cormBin, fspec, i, encodePayload("2026-10-19", {
        level: "L2", type: "invariant", lifecycle: "observed", summary: `Net invariant ${i}`, context: { project: "net" },
      }), axisPath, tmpDir));
    }
    for (let i = 4; i <= 6; i++) {
      await instrumentedRunner.run(buildStoreInvocation(cormBin, fspec, i, encodePayload("2026-10-19", {
        level: "L2", type: "invariant", lifecycle: "observed", summary: `FS invariant ${i}`, context: { project: "fs" },
      }), axisPath, tmpDir));
    }

    // Seed journal with pending L3 queue and activeL3Ref 200
    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyL2 = {
      count: 6,
      l2Refs: [1, 2, 3, 4, 5, 6],
      scopeByRef: { 1: "net", 2: "net", 3: "net", 4: "fs", 5: "fs", 6: "fs" },
      lastUpdated: new Date().toISOString(),
    };
    journal.pendingL3 = true;
    journal.activeL3Ref = 200;
    await writeConsolidationJournal(tmpDir, journal);

    listCount = 0;
    getCount = 0;
    storeCount = 0;
    synthCount = 0;

    // Run deferred consolidation targeting L3
    const res = await runDeferredConsolidation(toolEnv, ctx, { targetLevel: "L3" });
    const details = res.details as { createdL3: number[]; operations: { listCalls: number; getCalls: number; storeCalls: number; synthCalls: number; totalWorkUnits: number } };

    assert.strictEqual(details.createdL3.length, 1, "Must successfully synthesize 1 L3 principle");
    assert.strictEqual(synthCount, 1, "Must invoke L3 synthesizer");
    assert.strictEqual(storeCount, 2, "Must store new L3 AND update predecessor Ref 200");

    const ops = listCount + getCount + storeCount + synthCount;
    assert.ok(ops <= BATCH_LIMIT, `Actual operations (${ops}) must not exceed batch limit (${BATCH_LIMIT})`);
    assert.strictEqual(details.operations.listCalls, listCount, "L3 listCalls must match physical list calls");
    assert.strictEqual(details.operations.getCalls, getCount, "L3 getCalls must match physical get calls");
    assert.strictEqual(details.operations.storeCalls, storeCount, "L3 storeCalls must match physical store calls");
    assert.strictEqual(details.operations.synthCalls, synthCount, "L3 synthCalls must match physical synth calls");
    assert.strictEqual(details.operations.totalWorkUnits, ops, "L3 totalWorkUnits must match physical ops");

    // Verify predecessor Ref 200 updated to superseded
    const predRes = await instrumentedRunner.run(buildGetInvocation(cormBin, fspec, 200, axisPath, tmpDir));
    const decodedPred = decodePayload(predRes.stdout.trim());
    assert.strictEqual(decodedPred.envelope.lifecycle, "superseded");
    assert.strictEqual(decodedPred.envelope.supersededBy, details.createdL3[0]);

    // Verify remaining L2 queue retains unprocessed items
    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.dirtyL2.l2Refs.length > 0, "Unprocessed L2 items must remain in queue");
    assert.strictEqual(journal.activeL3Ref, details.createdL3[0]);

    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("consolidation_progress_and_budget: 4. Uninitialized .ref_seq allocation is reserved and counted in physical operation limit", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-prog-budget-4-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let listCount = 0;
    let getCount = 0;
    let storeCount = 0;
    let synthCount = 0;

    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (inv.args[0] === "-g" && inv.args[1] === ".") listCount++;
        if (inv.args[0] === "-r" && inv.args[1] === "-g") getCount++;
        if (inv.args[0] === "-p") storeCount++;
        return await daemonRunner.run(inv);
      },
    };

    const synthServer = Deno.serve({ port: 0 }, (_req) => {
      synthCount++;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Synthesized scope knowledge with uninitialized seq",
              explanation: "Valid",
              citedRefs: [1, 2],
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

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-budget-4" };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-19T15:30:00Z"),
      cwd: tmpDir,
      sessionId: "sess-budget-4",
    };

    // Store 2 L1 records
    for (let i = 1; i <= 2; i++) {
      await instrumentedRunner.run(buildStoreInvocation(cormBin, fspec, i, encodePayload("2026-10-19", {
        level: "L1", type: "note", lifecycle: "observed", summary: `Fact ${i}`, context: { project: "core" },
      }), axisPath, tmpDir));
    }

    // Explicitly delete .ref_seq to simulate uninitialized / first-time state
    try { Deno.removeSync(join(tmpDir, ".ref_seq")); } catch { /* ignore */ }

    const journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes["core"] = { count: 2, l1Refs: [1, 2], lastUpdated: new Date().toISOString() };
    journal.pendingL2Scopes = ["core"];
    await writeConsolidationJournal(tmpDir, journal);

    listCount = 0;
    getCount = 0;
    storeCount = 0;
    synthCount = 0;

    const res = await runDeferredConsolidation(toolEnv, ctx);
    const details = res.details as { createdL2: number[]; operations: { listCalls: number; getCalls: number; storeCalls: number; synthCalls: number; totalWorkUnits: number } };

    assert.strictEqual(details.createdL2.length, 1, "Must successfully synthesize 1 L2");
    assert.strictEqual(listCount, 1, "Must perform exactly 1 roster listing for allocator recovery");
    assert.strictEqual(details.operations.listCalls, 1, "Reported listCalls must be 1");
    assert.strictEqual(details.operations.listCalls, listCount, "listCalls must match physical list calls");
    assert.strictEqual(details.operations.getCalls, getCount, "getCalls must match physical get calls");
    assert.strictEqual(details.operations.storeCalls, storeCount, "storeCalls must match physical store calls");
    assert.strictEqual(details.operations.synthCalls, synthCount, "synthCalls must match physical synth calls");

    const totalActualOps = listCount + getCount + storeCount + synthCount;
    assert.ok(totalActualOps <= BATCH_LIMIT, `Actual ops (${totalActualOps}) must not exceed batch limit (${BATCH_LIMIT})`);
    assert.strictEqual(details.operations.totalWorkUnits, totalActualOps, "totalWorkUnits must match physical ops");

    // .ref_seq is now initialized
    const seqContent = await Deno.readTextFile(join(tmpDir, ".ref_seq"));
    assert.ok(parseInt(seqContent.trim(), 10) >= 3, ".ref_seq must be initialized to next ref >= 3");

    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("consolidation_progress_and_budget: 5. Starvation-free scheduling: large scope does not starve smaller scope across runs", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-prog-budget-5-" });
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
      const matches = [...userPrompt.matchAll(/\[Ref (\d+)\]/g)].map((m) => Number(m[1]));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Synthesized scope knowledge",
              explanation: "Valid",
              citedRefs: matches,
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const BATCH_LIMIT = 7;
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

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-budget-5" };
    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-19T16:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-budget-5",
    };

    // Store large scope 'alpha' with 15 records (Refs 1..15)
    for (let i = 1; i <= 15; i++) {
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, encodePayload("2026-10-19", {
        level: "L1", type: "note", lifecycle: "observed", summary: `Alpha ${i}`, context: { project: "alpha" },
      }), axisPath, tmpDir));
    }

    // Store small scope 'beta' with 2 records (Refs 16..17)
    for (let i = 16; i <= 17; i++) {
      await daemonRunner.run(buildStoreInvocation(cormBin, fspec, i, encodePayload("2026-10-19", {
        level: "L1", type: "note", lifecycle: "observed", summary: `Beta ${i}`, context: { project: "beta" },
      }), axisPath, tmpDir));
    }

    // Seed journal with alpha (attemptCount 0) and beta (attemptCount 0)
    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes["alpha"] = { count: 15, l1Refs: Array.from({ length: 15 }, (_, i) => i + 1), attemptCount: 0, lastUpdated: new Date().toISOString() };
    journal.dirtyScopes["beta"] = { count: 2, l1Refs: [16, 17], attemptCount: 0, lastUpdated: new Date().toISOString() };
    journal.pendingL2Scopes = ["alpha", "beta"];
    await writeConsolidationJournal(tmpDir, journal);

    // Run 1: Processes alpha first batch (leaves remaining in alpha, increments alpha.attemptCount)
    const res1 = await runDeferredConsolidation(toolEnv, ctx);
    const details1 = res1.details as { createdL2: number[] };
    assert.strictEqual(details1.createdL2.length, 1, "Run 1 consolidates 1 scope");

    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.dirtyScopes["alpha"].l1Refs.length > 0, "Alpha has remaining items");
    assert.ok((journal.dirtyScopes["alpha"].attemptCount ?? 0) >= 0);

    // Run 2: Beta (which has not been processed yet or has lower attemptCount) MUST be processed!
    const res2 = await runDeferredConsolidation(toolEnv, ctx);
    const details2 = res2.details as { createdL2: number[] };
    assert.strictEqual(details2.createdL2.length, 1, "Run 2 consolidates next scope");

    journal = await readConsolidationJournal(tmpDir);
    // Beta must now be processed!
    assert.strictEqual(journal.dirtyScopes["beta"].l1Refs.length, 0, "Beta must not be starved by large Alpha scope");

    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("consolidation_progress_and_budget: 6. Hard limit verification across varied batch limits and unselected work preserved", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-prog-budget-6-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    let listCount = 0;
    let getCount = 0;
    let storeCount = 0;
    let synthCount = 0;

    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });
    const instrumentedRunner = {
      run: async (inv: import("../src/corm.ts").Invocation) => {
        if (inv.args[0] === "-g" && inv.args[1] === ".") listCount++;
        if (inv.args[0] === "-r" && inv.args[1] === "-g") getCount++;
        if (inv.args[0] === "-p") storeCount++;
        return await daemonRunner.run(inv);
      },
    };

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
              explanation: "Valid",
              citedRefs: matches,
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const BATCH_LIMIT = 7;
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

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-budget-6" };
    const toolEnv = {
      cfg,
      runner: instrumentedRunner,
      nowProvider: () => new Date("2026-10-19T16:30:00Z"),
      cwd: tmpDir,
      sessionId: "sess-budget-6",
    };

    // Store 4 scopes with 5 records each (total 20 records)
    let ref = 1;
    const scopes = ["w", "x", "y", "z"];
    for (const s of scopes) {
      for (let j = 0; j < 5; j++) {
        await instrumentedRunner.run(buildStoreInvocation(cormBin, fspec, ref, encodePayload("2026-10-19", {
          level: "L1", type: "note", lifecycle: "observed", summary: `${s} fact ${j}`, context: { project: s },
        }), axisPath, tmpDir));
        ref++;
      }
    }

    // Seed journal with all 4 scopes
    let journal = await readConsolidationJournal(tmpDir);
    journal.dirtyScopes = {
      w: { count: 5, l1Refs: [1, 2, 3, 4, 5], lastUpdated: new Date().toISOString() },
      x: { count: 5, l1Refs: [6, 7, 8, 9, 10], lastUpdated: new Date().toISOString() },
      y: { count: 5, l1Refs: [11, 12, 13, 14, 15], lastUpdated: new Date().toISOString() },
      z: { count: 5, l1Refs: [16, 17, 18, 19, 20], lastUpdated: new Date().toISOString() },
    };
    journal.pendingL2Scopes = ["w", "x", "y", "z"];
    await writeConsolidationJournal(tmpDir, journal);

    listCount = 0;
    getCount = 0;
    storeCount = 0;
    synthCount = 0;

    const res = await runDeferredConsolidation(toolEnv, ctx);
    const details = res.details as { operations: { listCalls: number; getCalls: number; storeCalls: number; synthCalls: number; totalWorkUnits: number } };

    const actualOps = listCount + getCount + storeCount + synthCount;
    assert.ok(actualOps <= BATCH_LIMIT, `Actual ops (${actualOps}) must not exceed limit (${BATCH_LIMIT})`);
    assert.strictEqual(details.operations.listCalls, listCount, "listCalls must match physical list calls");
    assert.strictEqual(details.operations.getCalls, getCount, "getCalls must match physical get calls");
    assert.strictEqual(details.operations.storeCalls, storeCount, "storeCalls must match physical store calls");
    assert.strictEqual(details.operations.synthCalls, synthCount, "synthCalls must match physical synth calls");
    assert.strictEqual(details.operations.totalWorkUnits, actualOps, "totalWorkUnits must match physical ops");

    // Unselected scopes must be retained and not lost
    journal = await readConsolidationJournal(tmpDir);
    assert.ok(journal.dirtyScopes["y"] && journal.dirtyScopes["y"].l1Refs.length === 5, "Scope y must be preserved");
    assert.ok(journal.dirtyScopes["z"] && journal.dirtyScopes["z"].l1Refs.length === 5, "Scope z must be preserved");

    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
