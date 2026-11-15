// L0 -> L1 queue fairness and bounded backlog drain (R2).
//
// Regression: the queue used to be processed oldest-first with a fixed batch, and refs that
// reached a terminal decision without being "represented" (missing, non-L0, memory-introspection
// skips) were never removed. On the live store this wedged the queue head forever: 23k pending refs,
// 0 L1 created per run, and the current turn's captures never reached L1.
import { existsSync, rmSync } from "node:fs";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";
import { buildStoreInvocation, filespecFor } from "../src/corm.ts";
import { readConsolidationJournal, writeConsolidationJournal } from "../src/tools/consolidation_journal.ts";
import { drainL0Backlog, orderPendingL0Refs, runAutoConsolidation } from "../src/tools/consolidate.ts";
import { advanceRefSeq } from "../src/tools/ref_allocator.ts";
import type { PiCtx } from "../src/hooks/events.ts";

const home = Deno.env.get("HOME") || "";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync(`${home}/.local/bin/corm`) ? `${home}/.local/bin/corm` : "/usr/bin/corm";
const cormdBin = existsSync(`${home}/.local/bin/cormd`) ? `${home}/.local/bin/cormd` : "/usr/bin/cormd";

Deno.test("orderPendingL0Refs: current-turn refs first, backlog newest-first, deduplicated", () => {
  assert.deepStrictEqual(orderPendingL0Refs([1, 2, 3, 9], [9, 7, 7]), [9, 7, 3, 2, 1]);
  assert.deepStrictEqual(orderPendingL0Refs([5, 1, 3]), [5, 3, 1]);
  assert.deepStrictEqual(orderPendingL0Refs([], []), []);
});

async function withStore(
  fn: (h: { tmpDir: string; runner: DaemonCormRunner; store: (ref: number, env: object) => Promise<void> }) => Promise<void>,
) {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-backlog-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);
  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const runner = new DaemonCormRunner(sockPath, {
      run: () => Promise.resolve({ code: 1, stdout: "", stderr: "daemon required" }),
    });
    const store = async (ref: number, env: object) => {
      const res = await runner.run(buildStoreInvocation(cormBin, fspec, ref, `2026-11-06:${JSON.stringify(env)}`, axisPath, tmpDir));
      assert.equal(res.code, 0, res.stderr);
    };
    await fn({ tmpDir, runner, store });
    const lock = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    try { Deno.kill(lock.pid, "SIGTERM"); } catch { /* gone */ }
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
}

function l0(i: number, runId: string, summary?: string) {
  return {
    level: "L0",
    type: "episode",
    lifecycle: "tested",
    summary: summary ?? `Backlog step ${i}: tuned water shader pass ${i}`,
    context: { project: "site" },
    episode: {
      problem: `Water shader task ${runId}`,
      approaches: [{ approach: `Executed edit: external/nd-world/water_${i}.c`, outcome: "worked" }],
      outcome: "success",
      runId,
      sessionId: "sess-backlog",
    },
  };
}

function toolEnv(tmpDir: string, runner: DaemonCormRunner, extra: Record<string, unknown> = {}) {
  return {
    cfg: { ...DEFAULT_CONFIG, cormBin, cormdBin, memDir: tmpDir, axisLibs: axisPath, consolidateBatchLimit: 5, ...extra },
    runner,
    nowProvider: () => new Date("2026-11-06T20:00:00Z"),
    cwd: tmpDir,
    sessionId: "sess-backlog",
  };
}

const ctx = (tmpDir: string): PiCtx => ({ cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-backlog" });

Deno.test("backlog: current-turn L0s reach L1 in the same run despite a large old backlog", async () => {
  await withStore(async ({ tmpDir, runner, store }) => {
    // 40 old backlog refs (each its own run) + 3 fresh refs from the live turn.
    for (let i = 1; i <= 40; i++) await store(i, l0(i, `old-run-${i}`));
    for (let i = 41; i <= 43; i++) await store(i, l0(i, "live-run"));
    await advanceRefSeq(tmpDir, 44);
    const j = await readConsolidationJournal(tmpDir);
    j.pendingL0Refs = Array.from({ length: 40 }, (_, k) => k + 1);
    await writeConsolidationJournal(tmpDir, j);

    const res = await runAutoConsolidation(toolEnv(tmpDir, runner), ctx(tmpDir), { newL0Refs: [41, 42, 43], incrementalOnly: true });
    const created = (res.details as { createdL1: number[] }).createdL1;
    assert.ok(created.length >= 1, "live turn must produce an L1");
    const after = { ...(await readConsolidationJournal(tmpDir)), pendingL0Refs: (await readConsolidationJournal(tmpDir)).pendingL0Refs ?? [] };
    for (const r of [41, 42, 43]) assert.ok(!after.pendingL0Refs.includes(r), `fresh ref ${r} must be consolidated`);
    assert.ok(after.activeL1ByRunId?.["live-run"], "live run must have an active L1");
    // Batch of 5 = 3 fresh + the 2 newest backlog refs; the oldest stay pending.
    assert.ok(!after.pendingL0Refs.includes(40) && !after.pendingL0Refs.includes(39), "newest backlog refs fill the remainder");
    assert.ok(after.pendingL0Refs.includes(1), "oldest backlog refs remain pending for the drain");
    assert.equal(after.pendingL0Refs.length, 38);
  });
});

Deno.test("backlog: terminal refs (missing, non-L0, memory-introspection skips) are disposed, not wedged", async () => {
  await withStore(async ({ tmpDir, runner, store }) => {
    // ref 1: missing (never stored); ref 2: an L1; ref 3: memory-recall introspection L0 (skipped).
    await store(2, { level: "L1", type: "note", lifecycle: "supported", summary: "already an L1" });
    await store(3, {
      ...l0(3, "recall-run", "Found 5 relevant memory record(s) for \"raw SQL\":"),
      episode: { problem: "Do you remember what we did about raw SQL?", request: "Do you remember what we did about raw SQL?", approaches: [{ approach: "Executed memory_recall", outcome: "worked" }], outcome: "success", runId: "recall-run" },
    });
    await advanceRefSeq(tmpDir, 4);
    const j = await readConsolidationJournal(tmpDir);
    j.pendingL0Refs = [1, 2, 3];
    await writeConsolidationJournal(tmpDir, j);

    const env = toolEnv(tmpDir, runner);
    await runAutoConsolidation(env, ctx(tmpDir), { incrementalOnly: true });
    const after = { ...(await readConsolidationJournal(tmpDir)), pendingL0Refs: (await readConsolidationJournal(tmpDir)).pendingL0Refs ?? [] };
    assert.deepStrictEqual(after.pendingL0Refs, [], `all terminal refs disposed; left ${JSON.stringify(after.pendingL0Refs)}`);
  });
});

Deno.test("backlog: drainL0Backlog respects maxRefs, time budget, and stops when empty", async () => {
  await withStore(async ({ tmpDir, runner, store }) => {
    for (let i = 1; i <= 23; i++) await store(i, l0(i, `drain-run-${i % 4}`));
    await advanceRefSeq(tmpDir, 24);
    const j = await readConsolidationJournal(tmpDir);
    j.pendingL0Refs = Array.from({ length: 23 }, (_, k) => k + 1);
    await writeConsolidationJournal(tmpDir, j);
    const env = toolEnv(tmpDir, runner);

    // Disabled budget does nothing.
    const off = await drainL0Backlog(env, ctx(tmpDir), { timeBudgetMs: 0 });
    assert.equal(off.stoppedBy, "disabled");
    assert.equal(off.remaining, 23);

    // maxRefs bounds the work (batches of 5).
    const capped = await drainL0Backlog(env, ctx(tmpDir), { timeBudgetMs: 60_000, maxRefs: 8 });
    assert.equal(capped.stoppedBy, "maxRefs");
    assert.equal(capped.batches, 2);
    assert.equal(capped.remaining, 13);

    // An exhausted clock stops before any batch.
    let t = 0;
    const clocked = await drainL0Backlog(env, ctx(tmpDir), { timeBudgetMs: 100, now: () => (t += 1000) });
    assert.equal(clocked.stoppedBy, "time");
    assert.equal(clocked.batches, 0);

    // Unbounded drain empties the queue and creates L1s.
    const full = await drainL0Backlog(env, ctx(tmpDir), { timeBudgetMs: 60_000 });
    assert.equal(full.stoppedBy, "empty");
    assert.equal(full.remaining, 0);
    assert.ok(full.createdL1.length > 0);
    assert.deepStrictEqual((await readConsolidationJournal(tmpDir)).pendingL0Refs, []);
  });
});
