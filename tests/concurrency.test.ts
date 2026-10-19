import assert from "node:assert";
import { makeStoreTool } from "../src/tools/store.ts";
import { makeConsolidateTool } from "../src/tools/consolidate.ts";
import { flushSessionBuffer, activeSessionBuffer } from "../src/hooks/events.ts";
import { withLock } from "../src/lock.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { give } from "../src/tools/index.ts";
import type { QmapRunner } from "../src/qmap.ts";
import type { PiExecResult } from "../src/hooks/events.ts";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";

class ThreadSafeFakeStore {
  public records = new Map<number, string>();
  public nextId = 1;
  public delayMs = 10;

  createRunner(): QmapRunner {
    return {
      run: async (inv): Promise<PiExecResult> => {
        const { args } = inv;
        // Simulate a small asynchronous I/O delay
        await new Promise((r) => setTimeout(r, this.delayMs));

        if (args[0] === "-g") {
          // List refs
          const lines = Array.from(this.records.keys()).map((k) => String(k)).join("\n");
          return { code: 0, stdout: lines, stderr: "" };
        }
        if (args[0] === "-p") {
          // Store ref:payload
          const refArg = args[1];
          const colonIdx = refArg.indexOf(":");
          const ref = Number(refArg.slice(0, colonIdx));
          const payload = refArg.slice(colonIdx + 1);

          if (this.records.has(ref)) {
            // Ref collision detection!
            return { code: 1, stdout: "", stderr: `Collision: ref ${ref} already exists!` };
          }
          this.records.set(ref, payload);
          return { code: 0, stdout: String(ref), stderr: "" };
        }
        if (args[0] === "-r" && args[1] === "-g") {
          // Get ref
          const ref = Number(args[2]);
          const payload = this.records.get(ref);
          if (payload) return { code: 0, stdout: payload, stderr: "" };
          return { code: 1, stdout: "", stderr: "not found" };
        }
        if (args[0] === "-q" || args[0] === "-k") {
          const ref = Number(args[1]);
          const payload = this.records.get(ref);
          if (payload) return { code: 0, stdout: payload, stderr: "" };
          return { code: 1, stdout: "", stderr: "not found" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
  }
}

Deno.test("concurrency: simultaneous manual stores receive unique refs without collision", async () => {
  const store = new ThreadSafeFakeStore();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-concurrency-test-" });
  const ctx = { cwd: tmpDir, hasUI: false, mode: "agent" };

  const envFn = give({
    cwd: tmpDir,
    runner: store.createRunner(),
    nowProvider: () => new Date("2026-10-15T10:00:00Z"),
    cfg: { ...DEFAULT_CONFIG, qmapBin: "/usr/bin/qmap", memDir: tmpDir },
  });

  const tool = makeStoreTool(envFn);

  // Launch 8 concurrent store operations
  const tasks = Array.from({ length: 8 }, (_, i) =>
    tool.execute(`call_${i}`, { summary: `Concurrent memory item ${i}` }, undefined, undefined, ctx)
  );

  const results = await Promise.all(tasks);

  // Collect all allocated refs
  const refs = results.map((r: { details?: unknown }) => (r.details as { ref: number }).ref);
  assert.strictEqual(refs.length, 8);

  // Ensure all 8 refs are strictly unique (no collision)
  const uniqueRefs = new Set(refs);
  assert.strictEqual(uniqueRefs.size, 8);
  assert.strictEqual(store.records.size, 8);
});

Deno.test("concurrency: simultaneous automatic episode flush vs manual store allocate distinct refs", async () => {
  const store = new ThreadSafeFakeStore();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-concurrency-flush-" });
  const ctx = { cwd: tmpDir, hasUI: false, mode: "agent" };

  const envFn = give({
    cwd: tmpDir,
    runner: store.createRunner(),
    nowProvider: () => new Date("2026-10-15T10:00:00Z"),
    cfg: { ...DEFAULT_CONFIG, qmapBin: "/usr/bin/qmap", memDir: tmpDir },
  });

  // Seed activeSessionBuffer with an event
  activeSessionBuffer.clear();
  activeSessionBuffer.record({
    id: "evt_concurrency_1",
    timestamp: "2026-10-15T10:00:00Z",
    toolName: "bash",
    summary: "cargo test: all 12 tests passed",
    isError: false,
    approach: "cargo test",
    outcome: "worked",
  });

  const storeTool = makeStoreTool(envFn);

  // Run auto-flush and manual store concurrently
  const [flushRef, storeRes] = await Promise.all([
    flushSessionBuffer(envFn, ctx),
    storeTool.execute("call_manual", { summary: "Manual store concurrent with flush" }, undefined, undefined, ctx),
  ]);

  const manualRef = (storeRes.details as { ref: number }).ref;
  assert.notStrictEqual(flushRef, null);
  assert.notStrictEqual(flushRef, manualRef);

  // Verify both exist in store
  assert.strictEqual(store.records.has(flushRef!), true);
  assert.strictEqual(store.records.has(manualRef), true);
  assert.strictEqual(store.records.size, 2);
});

Deno.test("concurrency: simultaneous consolidation attempts allocate unique refs without collision", async () => {
  const store = new ThreadSafeFakeStore();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-concurrency-consolidate-" });
  const ctx = { cwd: tmpDir, hasUI: false, mode: "agent" };

  const envFn = give({
    cwd: tmpDir,
    runner: store.createRunner(),
    nowProvider: () => new Date("2026-10-15T10:00:00Z"),
    cfg: { ...DEFAULT_CONFIG, qmapBin: "/usr/bin/qmap", memDir: tmpDir },
  });

  // Seed store with an L0 source episode at ref 1
  store.records.set(
    1,
    `2026-10-15:{"level":"L0","type":"episode","summary":"Source episode","lifecycle":"observed"}`
  );

  const consolidateTool = makeConsolidateTool(envFn);

  // Run two consolidation calls concurrently targeting different abstractions
  const [res1, res2] = await Promise.all([
    consolidateTool.execute("call_c1", {
      targetLevel: "L1",
      sourceRefs: [1],
      summary: "First concurrent investigation",
    }, undefined, undefined, ctx),
    consolidateTool.execute("call_c2", {
      targetLevel: "L1",
      sourceRefs: [1],
      summary: "Second distinct concurrent investigation",
    }, undefined, undefined, ctx),
  ]);

  const ref1 = (res1.details as { ref: number }).ref;
  const ref2 = (res2.details as { ref: number }).ref;

  assert.notStrictEqual(ref1, ref2);
  assert.strictEqual(store.records.has(ref1), true);
  assert.strictEqual(store.records.has(ref2), true);
  assert.strictEqual(store.records.size, 3);
});

Deno.test("concurrency: withLock fails safely on prolonged lock contention instead of bypassing", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-lock-timeout-" });
  const lockFile = join(tmpDir, ".mm.lock");

  // Create an artificial active lock file with an active alive PID (our own process)
  await writeFile(lockFile, JSON.stringify({ pid: Deno.pid, createdAt: Date.now() }));

  let executionAttempted = false;
  let caughtError: Error | null = null;

  try {
    // Attempt with small timeout (100ms)
    await withLock(
      tmpDir,
      () => {
        executionAttempted = true;
        return Promise.resolve();
      },
      { timeoutMs: 100, staleThresholdMs: 10000 },
    );
  } catch (err) {
    caughtError = err as Error;
  }

  // MUST throw lock contention error and MUST NEVER execute fn() unsafely
  assert.strictEqual(executionAttempted, false);
  assert.notStrictEqual(caughtError, null);
  assert.strictEqual(caughtError!.message.includes("lock contention"), true);
});

Deno.test("concurrency: withLock safely recovers stale lock older than threshold", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-lock-stale-" });
  const lockFile = join(tmpDir, ".mm.lock");

  // Create an artificial stale lock file with older timestamp
  await writeFile(lockFile, JSON.stringify({ pid: 12345, createdAt: Date.now() - 10000 }));
  // Modify mtime to be 10 seconds ago
  const oldTime = new Date(Date.now() - 10000);
  await Deno.utime(lockFile, oldTime, oldTime);

  let executed = false;
  await withLock(
    tmpDir,
    () => {
      executed = true;
      return Promise.resolve();
    },
    { timeoutMs: 500, staleThresholdMs: 2000 },
  );

  assert.strictEqual(executed, true);
});

Deno.test("concurrency: multiple separate OS processes synchronize safely via withLock", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-proc-lock-" });
  const counterFile = join(tmpDir, "counter.txt");
  await writeFile(counterFile, "0");

  const lockPath = new URL("../src/lock.ts", import.meta.url).pathname;

  const workerScript = `
    import { withLock } from "${lockPath}";
    import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";

    const dir = Deno.args[0];
    const file = join(dir, "counter.txt");

    await withLock(dir, async () => {
      const val = parseInt((await readFile(file, "utf-8")).trim(), 10) || 0;
      await new Promise(r => setTimeout(r, 20));
      await writeFile(file, String(val + 1));
    });
  `;

  const scriptPath = join(tmpDir, "worker.ts");
  await writeFile(scriptPath, workerScript);

  // Spawn 4 genuinely separate OS processes concurrently
  const commands = Array.from({ length: 4 }, () => {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--sloppy-imports", scriptPath, tmpDir],
      stdout: "piped",
      stderr: "piped",
    });
    return cmd.output();
  });

  const outputs = await Promise.all(commands);
  for (const out of outputs) {
    assert.strictEqual(out.code, 0, new TextDecoder().decode(out.stderr));
  }

  const finalVal = parseInt((await Deno.readTextFile(counterFile)).trim(), 10);
  assert.strictEqual(finalVal, 4);
});

Deno.test("concurrency: active process lock is not pruned even if staleThreshold is exceeded", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-active-lock-" });
  const lockFile = join(tmpDir, ".mm.lock");

  // Write a lock file containing our own PID (which is definitely alive!)
  await writeFile(lockFile, JSON.stringify({ pid: Deno.pid, createdAt: Date.now() - 10000 }));
  const oldTime = new Date(Date.now() - 10000);
  await Deno.utime(lockFile, oldTime, oldTime);

  let executed = false;
  let caughtError: Error | null = null;
  try {
    // Attempt with small timeout (100ms) and short stale threshold (50ms)
    await withLock(
      tmpDir,
      () => {
        executed = true;
        return Promise.resolve();
      },
      { timeoutMs: 100, staleThresholdMs: 50 },
    );
  } catch (err) {
    caughtError = err as Error;
  }

  // Because PID is alive, withLock MUST NOT prune it, and must fail with timeout!
  assert.strictEqual(executed, false);
  assert.notStrictEqual(caughtError, null);
  assert.strictEqual(caughtError!.message.includes("lock contention"), true);
});

Deno.test("concurrency: withLock is strictly fail-closed on filesystem setup error", async () => {
  // A path under a regular file cannot have subdirectories created
  const tmpFile = await Deno.makeTempFile({ prefix: "mm-fail-closed-" });
  const badDir = join(tmpFile, "invalid_subdir");

  let executed = false;
  let caughtError: Error | null = null;
  try {
    await withLock(badDir, () => {
      executed = true;
      return Promise.resolve();
    });
  } catch (err) {
    caughtError = err as Error;
  }

  // MUST throw filesystem error and MUST NEVER execute fn()
  assert.strictEqual(executed, false);
  assert.notStrictEqual(caughtError, null);
});

Deno.test("concurrency: isPidAlive fails closed on ambiguous error (only ESRCH is dead)", async () => {
  const { isPidAlive } = await import("../src/lock.ts");

  // Current process is alive
  assert.strictEqual(isPidAlive(Deno.pid), true);

  // An impossible PID is dead (ESRCH)
  assert.strictEqual(isPidAlive(99999999), false);

  // Negative or zero PID is dead
  assert.strictEqual(isPidAlive(0), false);
  assert.strictEqual(isPidAlive(-1), false);
});

Deno.test("concurrency: replacement lock created during recovery is preserved and never clobbered", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-replacement-lock-" });
  const lockFile = join(tmpDir, ".mm.lock");

  // A live replacement lock exists
  const livePayload = { pid: Deno.pid, createdAt: Date.now() };
  await writeFile(lockFile, JSON.stringify(livePayload));

  // Running withLock from another call must NOT remove or overwrite this lock
  let executed = false;
  try {
    await withLock(tmpDir, () => {
      executed = true;
      return Promise.resolve();
    }, { timeoutMs: 80, staleThresholdMs: 30 });
  } catch {
    // Expected timeout contention
  }

  assert.strictEqual(executed, false);
  // Verify the lock file still exists and still belongs to the live PID!
  const remainingContent = JSON.parse(await readFile(lockFile, "utf-8"));
  assert.strictEqual(remainingContent.pid, Deno.pid);
});

Deno.test("concurrency: malformed lock file is treated as unknown ownership and never pruned", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-malformed-lock-" });
  const lockFile = join(tmpDir, ".mm.lock");

  // Write corrupt/malformed content and backdate mtime
  await writeFile(lockFile, "MALFORMED_NON_JSON_DATA{{{");
  const oldTime = new Date(Date.now() - 20000);
  await Deno.utime(lockFile, oldTime, oldTime);

  let executed = false;
  try {
    await withLock(tmpDir, () => {
      executed = true;
      return Promise.resolve();
    }, { timeoutMs: 80, staleThresholdMs: 30 });
  } catch {
    // Expected timeout
  }

  assert.strictEqual(executed, false);
  // Malformed lock MUST NOT be pruned!
  const remaining = await readFile(lockFile, "utf-8");
  assert.strictEqual(remaining, "MALFORMED_NON_JSON_DATA{{{");
});

Deno.test("concurrency: in-process queue releases mutex on filesystem setup failure", async () => {
  const tmpFile = await Deno.makeTempFile({ prefix: "mm-mutex-release-" });
  const badDir = join(tmpFile, "invalid_subdir");

  // First call fails at mkdir
  let firstFailed = false;
  try {
    await withLock(badDir, () => Promise.resolve());
  } catch {
    firstFailed = true;
  }
  assert.strictEqual(firstFailed, true);

  // Subsequent call on a valid directory MUST NOT hang or deadlock!
  const goodDir = await Deno.makeTempDir({ prefix: "mm-mutex-recovered-" });
  let secondSucceeded = false;
  await withLock(goodDir, () => {
    secondSucceeded = true;
    return Promise.resolve();
  });
  assert.strictEqual(secondSucceeded, true);
});

Deno.test("concurrency: two OS contenders racing over a stale lock never overlap critical sections", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-stale-race-" });
  const lockFile = join(tmpDir, ".mm.lock");
  const logFile = join(tmpDir, "contender_timeline.log");

  // Create an initial stale lock owned by an impossible dead PID
  await writeFile(lockFile, JSON.stringify({ pid: 99999999, createdAt: Date.now() - 10000 }));
  const oldTime = new Date(Date.now() - 10000);
  await Deno.utime(lockFile, oldTime, oldTime);

  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  const contenderScript = `
    import { withLock } from "${lockModule}";
    import { appendFile } from "node:fs/promises";

    const [dir, logPath, id] = Deno.args;
    await withLock(dir, async () => {
      const start = Date.now();
      await appendFile(logPath, \`\${id}:ENTER:\${start}\\n\`);
      // Hold critical section
      await new Promise((r) => setTimeout(r, 60));
      const end = Date.now();
      await appendFile(logPath, \`\${id}:EXIT:\${end}\\n\`);
    }, { timeoutMs: 3000, staleThresholdMs: 50 });
  `;

  const scriptPath = join(tmpDir, "contender.ts");
  await writeFile(scriptPath, contenderScript);

  // Launch two child OS processes simultaneously to race over the stale lock
  const p1 = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", scriptPath, tmpDir, logFile, "P1"],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const p2 = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", scriptPath, tmpDir, logFile, "P2"],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.strictEqual(res1.code, 0, new TextDecoder().decode(res1.stderr));
  assert.strictEqual(res2.code, 0, new TextDecoder().decode(res2.stderr));

  // Parse timeline
  const timeline = (await readFile(logFile, "utf-8")).trim().split("\n");
  assert.strictEqual(timeline.length, 4);

  const events = timeline.map((line) => {
    const [proc, type, time] = line.split(":");
    return { proc, type, time: Number(time) };
  });

  // Verify that ENTER of the second contender happened at or after EXIT of the first
  const firstEnter = events[0];
  const firstExit = events[1];
  const secondEnter = events[2];
  const secondExit = events[3];

  assert.strictEqual(firstEnter.proc, firstExit.proc);
  assert.strictEqual(firstExit.type, "EXIT");
  assert.strictEqual(secondEnter.proc, secondExit.proc);
  assert.strictEqual(secondEnter.type, "ENTER");
  assert.notStrictEqual(firstEnter.proc, secondEnter.proc);
  assert.strictEqual(secondEnter.time >= firstExit.time, true);
});

Deno.test("concurrency: deterministic multi-process replacement lock survives stale recovery attempt", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-barrier-race-" });
  const lockFile = join(tmpDir, ".mm.lock");
  const logFile = join(tmpDir, "barrier_timeline.log");
  const barrier1 = join(tmpDir, "p1_inspected.barrier");
  const barrier2 = join(tmpDir, "p2_lock_created.barrier");

  // Create an initial stale lock owned by an impossible dead PID
  const stalePayload = { pid: 99999999, token: "stale-dead-token", createdAt: Date.now() - 20000 };
  await writeFile(lockFile, JSON.stringify(stalePayload));
  const oldTime = new Date(Date.now() - 20000);
  await Deno.utime(lockFile, oldTime, oldTime);

  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  // Contender 1: inspects stale lock, triggers barrier 1, waits at barrier 2 before recovery
  const c1Script = `
    import { withLock } from "${lockModule}";
    import { appendFile, writeFile, stat } from "node:fs/promises";

    const [dir, logPath, id, b1, b2] = Deno.args;
    await withLock(dir, async () => {
      const start = Date.now();
      await appendFile(logPath, \`\${id}:ENTER:\${start}\\n\`);
      await new Promise((r) => setTimeout(r, 50));
      const end = Date.now();
      await appendFile(logPath, \`\${id}:EXIT:\${end}\\n\`);
    }, {
      timeoutMs: 4000,
      staleThresholdMs: 50,
      onAfterStaleInspection: async () => {
        // Signal barrier 1: stale lock was inspected
        await writeFile(b1, "inspected");
        // Wait at barrier 2: until C2 acquires replacement lock
        while (true) {
          try {
            await stat(b2);
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        // Give C2 time to be actively running inside its critical section
        await new Promise((r) => setTimeout(r, 30));
      }
    });
  `;

  // Contender 2: waits for barrier 1, removes dead lock, creates replacement lock, signals barrier 2
  const c2Script = `
    import { withLock } from "${lockModule}";
    import { appendFile, writeFile, stat, readFile } from "node:fs/promises";

    const [dir, logPath, id, b1, b2] = Deno.args;

    // Wait until C1 has inspected the dead lock
    while (true) {
      try {
        await stat(b1);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    // Remove the stale lock so C2 acquires the replacement lock cleanly
    const lockPath = \`\${dir}/.mm.lock\`;
    try { await Deno.remove(lockPath); } catch {}

    await withLock(dir, async () => {
      const start = Date.now();
      await appendFile(logPath, \`\${id}:ENTER:\${start}\\n\`);

      // Signal barrier 2: C2 is now holding the replacement lock!
      await writeFile(b2, "replacement_active");

      // Hold critical section while C1 attempts recovery
      await new Promise((r) => setTimeout(r, 100));

      // Assert that C2's replacement lock survived C1's recovery attempt!
      const content = await readFile(lockPath, "utf-8");
      const info = JSON.parse(content);
      if (info.pid !== Deno.pid) {
        throw new Error(\`Replacement lock was clobbered! Expected PID \${Deno.pid}, found \${info.pid}\`);
      }

      const end = Date.now();
      await appendFile(logPath, \`\${id}:EXIT:\${end}\\n\`);
    }, { timeoutMs: 3000, staleThresholdMs: 50 });
  `;

  const c1Path = join(tmpDir, "c1.ts");
  const c2Path = join(tmpDir, "c2.ts");
  await writeFile(c1Path, c1Script);
  await writeFile(c2Path, c2Script);

  // Launch both child OS processes
  const p1 = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", c1Path, tmpDir, logFile, "C1", barrier1, barrier2],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const p2 = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", c2Path, tmpDir, logFile, "C2", barrier1, barrier2],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.strictEqual(res1.code, 0, "C1 failed: " + new TextDecoder().decode(res1.stderr));
  assert.strictEqual(res2.code, 0, "C2 failed: " + new TextDecoder().decode(res2.stderr));

  // Parse timeline
  const timeline = (await readFile(logFile, "utf-8")).trim().split("\n");
  assert.strictEqual(timeline.length, 4);

  const events = timeline.map((line) => {
    const [proc, type, time] = line.split(":");
    return { proc, type, time: Number(time) };
  });

  const c2Enter = events[0];
  const c2Exit = events[1];
  const c1Enter = events[2];
  const c1Exit = events[3];

  assert.strictEqual(c2Enter.proc, "C2");
  assert.strictEqual(c2Enter.type, "ENTER");
  assert.strictEqual(c2Exit.proc, "C2");
  assert.strictEqual(c2Exit.type, "EXIT");

  assert.strictEqual(c1Enter.proc, "C1");
  assert.strictEqual(c1Enter.type, "ENTER");
  assert.strictEqual(c1Exit.proc, "C1");
  assert.strictEqual(c1Exit.type, "EXIT");

  // Critical sections must never overlap: C1 enters after C2 exits
  assert.strictEqual(c1Enter.time >= c2Exit.time, true);
});

Deno.test("concurrency: deterministic recovery coordinator replacement survives stale recovery attempt", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-coord-race-" });
  const lockFile = join(tmpDir, ".mm.lock");
  const coordFile = join(tmpDir, ".mm.lock.recovery.lock");
  const logFile = join(tmpDir, "coord_timeline.log");
  const barrier1 = join(tmpDir, "c1_coord_inspected.barrier");

  // Create an initial stale main lock
  const staleMain = { pid: 99999999, token: "stale-main-token", createdAt: Date.now() - 20000 };
  await writeFile(lockFile, JSON.stringify(staleMain));
  const oldTime = new Date(Date.now() - 20000);
  await Deno.utime(lockFile, oldTime, oldTime);

  // Create an initial stale coordinator lock
  const staleCoord = { pid: 99999998, token: "stale-coord-token", createdAt: Date.now() - 10000 };
  await writeFile(coordFile, JSON.stringify(staleCoord));
  const oldCoordTime = new Date(Date.now() - 10000);
  await Deno.utime(coordFile, oldCoordTime, oldCoordTime);

  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  // Contender 1: starts first, acquires lock and coordinator, signals barrier 1, holds critical section, exits
  const c1Script = `
    import { withLock } from "${lockModule}";
    import { appendFile, writeFile } from "node:fs/promises";

    const [dir, logPath, id, b1] = Deno.args;
    await withLock(dir, async () => {
      const start = Date.now();
      await appendFile(logPath, \`\${id}:ENTER:\${start}\\n\`);
      await writeFile(b1, "coord_active");
      await new Promise((r) => setTimeout(r, 60));
      const end = Date.now();
      await appendFile(logPath, \`\${id}:EXIT:\${end}\\n\`);
    }, { timeoutMs: 4000, staleThresholdMs: 50 });
  `;

  // Contender 2: waits for barrier 1 (C1 active), contends for coordinator, fails closed, enters after C1
  const c2Script = `
    import { withLock } from "${lockModule}";
    import { appendFile, stat } from "node:fs/promises";

    const [dir, logPath, id, b1] = Deno.args;

    // Wait until C1 is actively holding the lock and coordinator
    while (true) {
      try {
        await stat(b1);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    await withLock(dir, async () => {
      const start = Date.now();
      await appendFile(logPath, \`\${id}:ENTER:\${start}\\n\`);
      await new Promise((r) => setTimeout(r, 40));
      const end = Date.now();
      await appendFile(logPath, \`\${id}:EXIT:\${end}\\n\`);
    }, { timeoutMs: 4000, staleThresholdMs: 50 });
  `;

  const c1Path = join(tmpDir, "c1_coord.ts");
  const c2Path = join(tmpDir, "c2_coord.ts");
  await writeFile(c1Path, c1Script);
  await writeFile(c2Path, c2Script);

  // Launch both child OS processes
  const p1 = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", c1Path, tmpDir, logFile, "C1", barrier1],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const p2 = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", c2Path, tmpDir, logFile, "C2", barrier1],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.strictEqual(res1.code, 0, "C1 failed: " + new TextDecoder().decode(res1.stderr));
  assert.strictEqual(res2.code, 0, "C2 failed: " + new TextDecoder().decode(res2.stderr));

  // Parse timeline
  const timeline = (await readFile(logFile, "utf-8")).trim().split("\n");
  assert.strictEqual(timeline.length, 4);

  const events = timeline.map((line) => {
    const [proc, type, time] = line.split(":");
    return { proc, type, time: Number(time) };
  });

  const c1Enter = events[0];
  const c1Exit = events[1];
  const c2Enter = events[2];
  const c2Exit = events[3];

  assert.strictEqual(c1Enter.proc, "C1");
  assert.strictEqual(c1Enter.type, "ENTER");
  assert.strictEqual(c1Exit.proc, "C1");
  assert.strictEqual(c1Exit.type, "EXIT");

  assert.strictEqual(c2Enter.proc, "C2");
  assert.strictEqual(c2Enter.type, "ENTER");
  assert.strictEqual(c2Exit.proc, "C2");
  assert.strictEqual(c2Exit.type, "EXIT");

  // Critical sections must never overlap: C2 enters after C1 exits
  assert.strictEqual(c2Enter.time >= c1Exit.time, true);
});

Deno.test("concurrency: deterministic recovery coordinator replacement survives stale recovery in critical interval", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-coord-interval-" });
  const lockFile = join(tmpDir, ".mm.lock");
  const coordFile = join(tmpDir, ".mm.lock.recovery.lock");
  const logFile = join(tmpDir, "coord_interval_timeline.log");
  const barrier1 = join(tmpDir, "c1_holding.barrier");

  // Create an initial stale main lock
  const staleMain = { pid: 99999999, token: "stale-main-token", createdAt: Date.now() - 20000 };
  await writeFile(lockFile, JSON.stringify(staleMain));
  const oldTime = new Date(Date.now() - 20000);
  await Deno.utime(lockFile, oldTime, oldTime);

  // Create an initial stale coordinator lock
  const staleCoord = { pid: 99999998, token: "stale-coord-token", createdAt: Date.now() - 10000 };
  await writeFile(coordFile, JSON.stringify(staleCoord));
  const oldCoordTime = new Date(Date.now() - 10000);
  await Deno.utime(coordFile, oldCoordTime, oldCoordTime);

  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  // Contender 1: acquires coordinator lease, signals barrier 1, holds critical section, exits
  const c1Script = `
    import { withLock } from "${lockModule}";
    import { appendFile, writeFile } from "node:fs/promises";

    const [dir, logPath, id, b1] = Deno.args;
    await withLock(dir, async () => {
      const start = Date.now();
      await appendFile(logPath, \`\${id}:ENTER:\${start}\\n\`);
      await writeFile(b1, "c1_active");
      await new Promise((r) => setTimeout(r, 60));
      const end = Date.now();
      await appendFile(logPath, \`\${id}:EXIT:\${end}\\n\`);
    }, { timeoutMs: 4000, staleThresholdMs: 50 });
  `;

  // Contender 2: waits for barrier 1, attempts recovery with hook, fails closed on coordinator, enters after C1
  const c2Script = `
    import { withLock } from "${lockModule}";
    import { appendFile, stat } from "node:fs/promises";

    const [dir, logPath, id, b1] = Deno.args;

    while (true) {
      try {
        await stat(b1);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    await withLock(dir, async () => {
      const start = Date.now();
      await appendFile(logPath, \`\${id}:ENTER:\${start}\\n\`);
      await new Promise((r) => setTimeout(r, 40));
      const end = Date.now();
      await appendFile(logPath, \`\${id}:EXIT:\${end}\\n\`);
    }, { timeoutMs: 4000, staleThresholdMs: 50 });
  `;

  const c1Path = join(tmpDir, "c1_interval.ts");
  const c2Path = join(tmpDir, "c2_interval.ts");
  await writeFile(c1Path, c1Script);
  await writeFile(c2Path, c2Script);

  const p1 = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", c1Path, tmpDir, logFile, "C1", barrier1],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const p2 = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", c2Path, tmpDir, logFile, "C2", barrier1],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.strictEqual(res1.code, 0, "C1 failed: " + new TextDecoder().decode(res1.stderr));
  assert.strictEqual(res2.code, 0, "C2 failed: " + new TextDecoder().decode(res2.stderr));

  const timeline = (await readFile(logFile, "utf-8")).trim().split("\n");
  assert.strictEqual(timeline.length, 4);

  const events = timeline.map((line) => {
    const [proc, type, time] = line.split(":");
    return { proc, type, time: Number(time) };
  });

  const c1Enter = events[0];
  const c1Exit = events[1];
  const c2Enter = events[2];
  const c2Exit = events[3];

  assert.strictEqual(c1Enter.proc, "C1");
  assert.strictEqual(c1Enter.type, "ENTER");
  assert.strictEqual(c1Exit.proc, "C1");
  assert.strictEqual(c1Exit.type, "EXIT");

  assert.strictEqual(c2Enter.proc, "C2");
  assert.strictEqual(c2Enter.type, "ENTER");
  assert.strictEqual(c2Exit.proc, "C2");
  assert.strictEqual(c2Exit.type, "EXIT");

  // Critical sections must never overlap: C2 enters after C1 exits
  assert.strictEqual(c2Enter.time >= c1Exit.time, true);
});

Deno.test("concurrency: coordinator pathname remains stable inode across consecutive owners without inode splitting", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-coord-inode-" });
  const lockFile = join(tmpDir, ".mm.lock");
  const coordFile = join(tmpDir, ".mm.lock.recovery.lock");
  const logFile = join(tmpDir, "coord_inode_timeline.log");
  const barrier1 = join(tmpDir, "c1_done.barrier");

  // Create an initial stale main lock
  const staleMain = { pid: 99999999, token: "stale-token", createdAt: Date.now() - 20000 };
  await writeFile(lockFile, JSON.stringify(staleMain));
  const oldTime = new Date(Date.now() - 20000);
  await Deno.utime(lockFile, oldTime, oldTime);

  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  // C1 recovers stale lock, seeds a second stale lock for C2, and logs inode + enter/exit
  const c1Script = `
    import { withLock } from "${lockModule}";
    import { appendFile, writeFile } from "node:fs/promises";
    const [dir, logPath, b1, coordPath, mainLock] = Deno.args;
    await withLock(dir, async () => {
      const st = await Deno.stat(coordPath);
      await appendFile(logPath, "C1:INO:" + st.ino + "\\n");
      await appendFile(logPath, "C1:ENTER:" + Date.now() + "\\n");
      await writeFile(b1, "c1_active");
      await new Promise((r) => setTimeout(r, 60));
      await appendFile(logPath, "C1:EXIT:" + Date.now() + "\\n");
    }, { timeoutMs: 4000, staleThresholdMs: 50 });

    const stale2 = { pid: 99999997, token: "stale2", createdAt: Date.now() - 20000 };
    await writeFile(mainLock, JSON.stringify(stale2));
    const oldT = new Date(Date.now() - 20000);
    await Deno.utime(mainLock, oldT, oldT);
    await writeFile(b1 + ".ready", "c2_can_start");
  `;

  // C2 waits for C1's signal, contends under C1's release, recovers stale lock 2, logs inode + enter/exit
  const c2Script = `
    import { withLock } from "${lockModule}";
    import { appendFile, stat } from "node:fs/promises";
    const [dir, logPath, b1, coordPath] = Deno.args;
    while (true) {
      try {
        await stat(b1 + ".ready");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    await withLock(dir, async () => {
      const st = await Deno.stat(coordPath);
      await appendFile(logPath, "C2:INO:" + st.ino + "\\n");
      await appendFile(logPath, "C2:ENTER:" + Date.now() + "\\n");
      await new Promise((r) => setTimeout(r, 40));
      await appendFile(logPath, "C2:EXIT:" + Date.now() + "\\n");
    }, { timeoutMs: 4000, staleThresholdMs: 50 });
  `;

  const c1Path = join(tmpDir, "c1_inode.ts");
  const c2Path = join(tmpDir, "c2_inode.ts");
  await writeFile(c1Path, c1Script);
  await writeFile(c2Path, c2Script);

  const p1 = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", c1Path, tmpDir, logFile, barrier1, coordFile, lockFile],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const p2 = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", c2Path, tmpDir, logFile, barrier1, coordFile, lockFile],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.strictEqual(res1.code, 0, "C1 failed: " + new TextDecoder().decode(res1.stderr));
  assert.strictEqual(res2.code, 0, "C2 failed: " + new TextDecoder().decode(res2.stderr));

  const lines = (await readFile(logFile, "utf-8")).trim().split("\n");
  assert.strictEqual(lines.length, 6);

  let c1Ino = "";
  let c2Ino = "";
  let c1ExitTime = 0;
  let c2EnterTime = 0;

  for (const line of lines) {
    const [proc, key, val] = line.split(":");
    if (proc === "C1" && key === "INO") c1Ino = val;
    if (proc === "C2" && key === "INO") c2Ino = val;
    if (proc === "C1" && key === "EXIT") c1ExitTime = Number(val);
    if (proc === "C2" && key === "ENTER") c2EnterTime = Number(val);
  }

  assert.strictEqual(c1Ino !== "" && c1Ino !== "0" && c1Ino !== "undefined", true);
  assert.strictEqual(c1Ino, c2Ino, "Coordinator inode must remain identical across consecutive owners");
  assert.strictEqual(c2EnterTime >= c1ExitTime, true, "Critical sections must never overlap");
});

Deno.test("concurrency: Deno coordinator acquisition releases handle on metadata write error without leaking descriptor", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "deno-leak-test-" });
  const lockFile = join(tmpDir, ".mm.lock");

  // Create stale lock
  const stale = { pid: 99999999, token: "stale", createdAt: Date.now() - 20000 };
  await writeFile(lockFile, JSON.stringify(stale));
  const oldT = new Date(Date.now() - 20000);
  await Deno.utime(lockFile, oldT, oldT);

  let failOnce = true;
  let entered = false;

  // Attempt with failure on metadata write hook
  await withLock(tmpDir, () => {
    entered = true;
    return Promise.resolve();
  }, {
    timeoutMs: 2000,
    staleThresholdMs: 50,
    onBeforeCoordinatorMetadataWrite: () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated metadata write failure");
      }
    },
  });

  assert.strictEqual(entered, true, "Must have recovered and entered on retry despite the initial write failure");
});

Deno.test("concurrency: Node production runtime multi-process contention serializes critical sections on identical inode", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "node-contend-test-" });
  const lockFile = join(tmpDir, ".mm.lock");
  const coordFile = join(tmpDir, ".mm.lock.recovery.lock");
  const logFile = join(tmpDir, "node_contend_timeline.log");
  const b1 = join(tmpDir, "c1_holding.barrier");

  // Create stale main lock
  await writeFile(lockFile, JSON.stringify({ pid: 99999999, token: "stale", createdAt: Date.now() - 20000 }));
  const oldT = new Date(Date.now() - 20000);
  await Deno.utime(lockFile, oldT, oldT);

  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  const c1Script = `
    const { createJiti } = require("jiti");
    const jiti = createJiti(process.cwd());
    const { withLock } = jiti("${lockModule}");
    const fs = require("node:fs");

    const [dir, logPath, b1Path, coordPath] = process.argv.slice(2);
    withLock(dir, async () => {
      const st = fs.statSync(coordPath);
      fs.appendFileSync(logPath, "C1:INO:" + st.ino + "\\n");
      fs.appendFileSync(logPath, "C1:ENTER:" + Date.now() + "\\n");
      fs.writeFileSync(b1Path, "c1_holding");
      await new Promise((r) => setTimeout(r, 60));
      fs.appendFileSync(logPath, "C1:EXIT:" + Date.now() + "\\n");
    }, { timeoutMs: 5000, staleThresholdMs: 50 });
  `;

  const c2Script = `
    const { createJiti } = require("jiti");
    const jiti = createJiti(process.cwd());
    const { withLock } = jiti("${lockModule}");
    const fs = require("node:fs");

    const [dir, logPath, b1Path, coordPath] = process.argv.slice(2);

    while (!fs.existsSync(b1Path)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }

    withLock(dir, async () => {
      const st = fs.statSync(coordPath);
      fs.appendFileSync(logPath, "C2:INO:" + st.ino + "\\n");
      fs.appendFileSync(logPath, "C2:ENTER:" + Date.now() + "\\n");
      await new Promise((r) => setTimeout(r, 40));
      fs.appendFileSync(logPath, "C2:EXIT:" + Date.now() + "\\n");
    }, { timeoutMs: 5000, staleThresholdMs: 50 });
  `;

  const c1File = join(tmpDir, "c1.cjs");
  const c2File = join(tmpDir, "c2.cjs");
  await writeFile(c1File, c1Script);
  await writeFile(c2File, c2Script);

  const homeDir = Deno.env.get("HOME") || "";
  const env = { ...Deno.env.toObject(), NODE_PATH: join(homeDir, ".pi/agent/install/releases/1.2.0/node_modules") };

  const p1 = new Deno.Command("node", {
    args: [c1File, tmpDir, logFile, b1, coordFile],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();

  const p2 = new Deno.Command("node", {
    args: [c2File, tmpDir, logFile, b1, coordFile],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.strictEqual(res1.code, 0, "Node C1 failed: " + new TextDecoder().decode(res1.stderr));
  assert.strictEqual(res2.code, 0, "Node C2 failed: " + new TextDecoder().decode(res2.stderr));

  const timeline = (await readFile(logFile, "utf-8")).trim().split("\n");
  assert.strictEqual(timeline.length, 6);

  let c1Ino = "";
  let c2Ino = "";
  let c1Exit = 0;
  let c2Enter = 0;

  for (const line of timeline) {
    const [proc, key, val] = line.split(":");
    if (proc === "C1" && key === "INO") c1Ino = val;
    if (proc === "C2" && key === "INO") c2Ino = val;
    if (proc === "C1" && key === "EXIT") c1Exit = Number(val);
    if (proc === "C2" && key === "ENTER") c2Enter = Number(val);
  }

  assert.strictEqual(c1Ino !== "" && c1Ino !== "0", true);
  assert.strictEqual(c1Ino, c2Ino, "Node coordinator inode must remain identical across contenders");
  assert.strictEqual(c2Enter >= c1Exit, true, "Node critical sections must never overlap under contention");
});

Deno.test("concurrency: Node production runtime automatically recovers coordinator lock after process SIGKILL", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "node-crash-test-" });
  const lockFile = join(tmpDir, ".mm.lock");
  const coordFile = join(tmpDir, ".mm.lock.recovery.lock");
  const logFile = join(tmpDir, "node_crash_timeline.log");
  const b1 = join(tmpDir, "c1_holding.barrier");

  // Create stale main lock
  await writeFile(lockFile, JSON.stringify({ pid: 99999999, token: "stale", createdAt: Date.now() - 20000 }));
  const oldT = new Date(Date.now() - 20000);
  await Deno.utime(lockFile, oldT, oldT);

  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  const c1Script = `
    const { createJiti } = require("jiti");
    const jiti = createJiti(process.cwd());
    const { withLock } = jiti("${lockModule}");
    const fs = require("node:fs");

    const [dir, logPath, b1Path, coordPath] = process.argv.slice(2);
    const _keepAlive = setInterval(() => {}, 1000);
    withLock(dir, async () => {
      const st = fs.statSync(coordPath);
      fs.appendFileSync(logPath, "C1:INO:" + st.ino + "\\n");
      fs.appendFileSync(logPath, "C1:ENTER:" + Date.now() + "\\n");
      fs.writeFileSync(b1Path, "c1_holding");
      await new Promise(() => {}); // Hold indefinitely until SIGKILL
    }, { timeoutMs: 5000, staleThresholdMs: 50 });
  `;

  const c2Script = `
    const { createJiti } = require("jiti");
    const jiti = createJiti(process.cwd());
    const { withLock } = jiti("${lockModule}");
    const fs = require("node:fs");

    const [dir, logPath, b1Path, coordPath] = process.argv.slice(2);

    while (!fs.existsSync(b1Path)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }

    withLock(dir, async () => {
      const st = fs.statSync(coordPath);
      fs.appendFileSync(logPath, "C2:INO:" + st.ino + "\\n");
      fs.appendFileSync(logPath, "C2:ENTER:" + Date.now() + "\\n");
      fs.appendFileSync(logPath, "C2:EXIT:" + Date.now() + "\\n");
    }, { timeoutMs: 8000, staleThresholdMs: 50 });
  `;

  const c1File = join(tmpDir, "c1.cjs");
  const c2File = join(tmpDir, "c2.cjs");
  await writeFile(c1File, c1Script);
  await writeFile(c2File, c2Script);

  const homeDir = Deno.env.get("HOME") || "";
  const env = { ...Deno.env.toObject(), NODE_PATH: join(homeDir, ".pi/agent/install/releases/1.2.0/node_modules") };

  const p1Cmd = new Deno.Command("node", {
    args: [c1File, tmpDir, logFile, b1, coordFile],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const p1Child = p1Cmd.spawn();

  const p2Cmd = new Deno.Command("node", {
    args: [c2File, tmpDir, logFile, b1, coordFile],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const p2Promise = p2Cmd.output();

  // Wait for C1 to hold the coordinator lock
  while (true) {
    try {
      await Deno.stat(b1);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  await new Promise((r) => setTimeout(r, 100));

  // Kill C1 with SIGKILL while it holds the coordinator lock
  p1Child.kill("SIGKILL");
  await p1Child.status;

  const res2 = await p2Promise;
  assert.strictEqual(res2.code, 0, "Node C2 failed after C1 crash: " + new TextDecoder().decode(res2.stderr));

  const timeline = (await readFile(logFile, "utf-8")).trim().split("\n");
  assert.strictEqual(timeline.length, 5);

  let c1Ino = "";
  let c2Ino = "";
  let c1Enter = 0;
  let c2Enter = 0;

  for (const line of timeline) {
    const [proc, key, val] = line.split(":");
    if (proc === "C1" && key === "INO") c1Ino = val;
    if (proc === "C2" && key === "INO") c2Ino = val;
    if (proc === "C1" && key === "ENTER") c1Enter = Number(val);
    if (proc === "C2" && key === "ENTER") c2Enter = Number(val);
  }

  assert.strictEqual(c1Ino !== "" && c1Ino !== "0", true);
  assert.strictEqual(c1Ino, c2Ino, "Coordinator inode must remain identical across crashed and recovered processes");
  assert.strictEqual(c2Enter > c1Enter, true, "Recovering process enters after initial process entered");
});

Deno.test("concurrency: main lock initialization write failure cleans up uninitialized lock without permanently bricking", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "write-fail-test-" });

  let failOnce = true;
  let entered = false;

  await withLock(tmpDir, () => {
    entered = true;
    return Promise.resolve();
  }, {
    timeoutMs: 2000,
    staleThresholdMs: 50,
    onBeforeMainLockMetadataWrite: () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated main lock metadata write failure");
      }
    },
  });

  assert.strictEqual(entered, true, "Must have cleaned up uninitialized lock and succeeded on retry");
});

Deno.test("concurrency: live main lock initializer is protected against premature stale recovery", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "live-init-test-" });
  const lockFile = join(tmpDir, ".mm.lock");

  // Create empty 0-byte lock file representing in-flight initializer with fresh mtime
  await writeFile(lockFile, "");

  let timedOut = false;
  try {
    await withLock(tmpDir, () => Promise.resolve(), {
      timeoutMs: 100,
      staleThresholdMs: 5000,
    });
  } catch {
    timedOut = true;
  }

  assert.strictEqual(timedOut, true, "Must fail closed/time out while lock is under stale threshold");
  const st = await Deno.stat(lockFile);
  assert.strictEqual(st.size, 0, "Live 0-byte lock must remain untouched while within threshold");
});

Deno.test("concurrency: legacy empty lock with live creator paused beyond stale threshold fails closed and preserves file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "empty-live-" });
  const lockFile = join(tmpDir, ".mm.lock");
  const aCreated = join(tmpDir, "created.barrier");
  const aResume = join(tmpDir, "resume.barrier");

  const childScript = `
    import { writeFile, stat } from "node:fs/promises";
    const [lFile, cB, rB] = Deno.args;
    await writeFile(lFile, "");
    await writeFile(cB, "created");
    while (true) {
      try {
        await stat(rB);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  `;
  const childFile = join(tmpDir, "child.ts");
  await writeFile(childFile, childScript);

  const childCmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", childFile, lockFile, aCreated, aResume],
  });
  const child = childCmd.spawn();

  while (true) {
    try {
      await Deno.stat(aCreated);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // Advance past staleThresholdMs
  await new Promise((r) => setTimeout(r, 70));

  // Newer process attempts acquisition and must fail closed
  let timedOut = false;
  try {
    await withLock(tmpDir, () => Promise.resolve(), {
      timeoutMs: 100,
      staleThresholdMs: 50,
    });
  } catch {
    timedOut = true;
  }
  assert.strictEqual(timedOut, true, "Must fail closed on empty lock");

  const st = await Deno.stat(lockFile);
  assert.strictEqual(st.size, 0, "Empty lock must not be unlinked or replaced");

  // Resume child
  await writeFile(aResume, "resume");
  await child.status;

  const stAfter = await Deno.stat(lockFile);
  assert.strictEqual(stAfter.size, 0, "Creator file was untouched");
});

Deno.test("concurrency: legacy empty lock with terminated creator fails closed without automatic recovery", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "empty-term-" });
  const lockFile = join(tmpDir, ".mm.lock");
  await writeFile(lockFile, "");

  await new Promise((r) => setTimeout(r, 70));

  let timedOut = false;
  try {
    await withLock(tmpDir, () => Promise.resolve(), {
      timeoutMs: 100,
      staleThresholdMs: 50,
    });
  } catch {
    timedOut = true;
  }
  assert.strictEqual(timedOut, true, "Terminated empty lock must fail closed");

  const st = await Deno.stat(lockFile);
  assert.strictEqual(st.size, 0, "Terminated empty lock must not be automatically unlinked without ownership proof");
});

Deno.test("concurrency: live initializer paused beyond staleThresholdMs preserves single owner without eviction", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "pause-test-" });
  const b1 = join(tmpDir, "p1_holding.barrier");
  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  const p1Script = `
    import { withLock } from "${lockModule}";
    import { writeFile } from "node:fs/promises";
    const [dir, barrier] = Deno.args;
    await withLock(dir, async () => {
      await writeFile(barrier, "holding");
      await new Promise((r) => setTimeout(r, 300));
    }, { staleThresholdMs: 50 });
  `;
  const p1File = join(tmpDir, "p1.ts");
  await Deno.writeTextFile(p1File, p1Script);

  const p1Cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", p1File, tmpDir, b1],
    stdout: "piped",
    stderr: "piped",
  });
  const p1Child = p1Cmd.spawn();

  while (true) {
    try {
      await Deno.stat(b1);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // Wait 100ms: lock age is now 100ms, exceeding staleThresholdMs (50ms), but P1 is ALIVE
  await new Promise((r) => setTimeout(r, 100));

  let p2Entered = false;
  let p2TimedOut = false;
  try {
    await withLock(tmpDir, () => {
      p2Entered = true;
      return Promise.resolve();
    }, {
      timeoutMs: 100,
      staleThresholdMs: 50,
    });
  } catch {
    p2TimedOut = true;
  }

  assert.strictEqual(p2Entered, false, "Competitor must NEVER enter critical section while live owner holds lock");
  assert.strictEqual(p2TimedOut, true, "Competitor must time out instead of evicting live owner");

  await p1Child.status;
});

Deno.test("concurrency: initialization failure cleanup cannot delete competitor lock", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "cleanup-safety-" });
  const lockFile = join(tmpDir, ".mm.lock");

  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  const childScript = `
    import { withLock } from "${lockModule}";
    try {
      await withLock(Deno.args[0], async () => {}, {
        timeoutMs: 150,
        onBeforePublish: () => {
          throw new Error("simulated failure before publish");
        },
      });
    } catch {}
  `;
  const childFile = join(tmpDir, "child_fail.ts");
  await Deno.writeTextFile(childFile, childScript);

  await withLock(tmpDir, async () => {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--sloppy-imports", childFile, tmpDir],
      stdout: "piped",
      stderr: "piped",
    });
    await cmd.output();

    // Verify Process A lock is STILL on disk and intact
    const content = await readFile(lockFile, "utf-8");
    const parsed = JSON.parse(content);
    assert.strictEqual(typeof parsed.pid, "number");
    assert.strictEqual(typeof parsed.token, "string");
  });
});

Deno.test("concurrency: process killed before lock publication allows immediate subsequent acquisition", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "pre-pub-kill-" });
  const lockFile = join(tmpDir, ".mm.lock");
  const b1 = join(tmpDir, "pre_pub.barrier");
  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  const p1Script = `
    import { withLock } from "${lockModule}";
    import { writeFile } from "node:fs/promises";
    const [dir, barrier] = Deno.args;
    const _keepAlive = setInterval(() => {}, 1000);
    try {
      await withLock(dir, async () => {}, {
        onBeforePublish: async () => {
          await writeFile(barrier, "ready");
          await new Promise(() => {}); // pause until SIGKILL
        }
      });
    } catch {}
  `;
  const p1File = join(tmpDir, "p1.ts");
  await Deno.writeTextFile(p1File, p1Script);

  const p1Cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", p1File, tmpDir, b1],
    stdout: "piped",
    stderr: "piped",
  });
  const p1Child = p1Cmd.spawn();

  while (true) {
    try {
      await Deno.stat(b1);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // Verify .mm.lock does NOT exist before publication
  let lockExists = false;
  try {
    await Deno.stat(lockFile);
    lockExists = true;
  } catch {
    /* expected: file must not exist */
  }
  assert.strictEqual(lockExists, false, "Lock must not exist before link publication");

  // Kill child before publication
  p1Child.kill("SIGKILL");
  await p1Child.status;

  // Subsequent acquisition succeeds immediately without needing stale threshold wait
  let acquired = false;
  await withLock(tmpDir, () => {
    acquired = true;
    return Promise.resolve();
  }, {
    timeoutMs: 500,
    staleThresholdMs: 5000,
  });

  assert.strictEqual(acquired, true, "Subsequent acquisition succeeds immediately");
});

Deno.test("concurrency: process killed after lock publication is recovered once stale", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "post-pub-kill-" });
  const lockFile = join(tmpDir, ".mm.lock");
  const b1 = join(tmpDir, "holding.barrier");
  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  const p1Script = `
    import { withLock } from "${lockModule}";
    import { writeFile } from "node:fs/promises";
    const [dir, barrier] = Deno.args;
    const _keepAlive = setInterval(() => {}, 1000);
    try {
      await withLock(dir, async () => {
        await writeFile(barrier, "holding");
        await new Promise(() => {}); // pause until SIGKILL
      });
    } catch {}
  `;
  const p1File = join(tmpDir, "p1.ts");
  await Deno.writeTextFile(p1File, p1Script);

  const p1Cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", p1File, tmpDir, b1],
    stdout: "piped",
    stderr: "piped",
  });
  const p1Child = p1Cmd.spawn();

  while (true) {
    try {
      await Deno.stat(b1);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const content = await readFile(lockFile, "utf-8");
  const parsed = JSON.parse(content);
  assert.strictEqual(typeof parsed.pid, "number");
  assert.strictEqual(typeof parsed.token, "string");

  p1Child.kill("SIGKILL");
  await p1Child.status;

  await new Promise((r) => setTimeout(r, 70));

  let recovered = false;
  await withLock(tmpDir, () => {
    recovered = true;
    return Promise.resolve();
  }, {
    timeoutMs: 2000,
    staleThresholdMs: 50,
  });

  assert.strictEqual(recovered, true, "Subsequent process recovers published lock of dead process");
});

Deno.test("concurrency: multi-process execution enforces strictly at most one concurrent critical-section owner", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "concurrent-owner-test-" });
  const counterFile = join(tmpDir, "counter.txt");
  await Deno.writeTextFile(counterFile, "0");

  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  const workerScript = `
    import { withLock } from "${lockModule}";
    import { readFile, writeFile } from "node:fs/promises";
    const [dir, cPath, logPath] = Deno.args;

    for (let i = 0; i < 3; i++) {
      await withLock(dir, async () => {
        const c = parseInt(await readFile(cPath, "utf-8"), 10);
        const next = c + 1;
        await writeFile(cPath, String(next));
        if (next > 1) {
          throw new Error("MUTUAL EXCLUSION VIOLATION: concurrent owners = " + next);
        }
        await new Promise((r) => setTimeout(r, 20));
        await writeFile(cPath, String(next - 1));
        await Deno.writeTextFile(logPath, "ok\\n", { append: true });
      }, { timeoutMs: 5000, staleThresholdMs: 2000 });
    }
  `;
  const workerFile = join(tmpDir, "worker.ts");
  await Deno.writeTextFile(workerFile, workerScript);

  const logPath = join(tmpDir, "run.log");
  await Deno.writeTextFile(logPath, "");

  const p1 = new Deno.Command(Deno.execPath(), { args: ["run", "--allow-all", "--sloppy-imports", workerFile, tmpDir, counterFile, logPath] }).output();
  const p2 = new Deno.Command(Deno.execPath(), { args: ["run", "--allow-all", "--sloppy-imports", workerFile, tmpDir, counterFile, logPath] }).output();
  const p3 = new Deno.Command(Deno.execPath(), { args: ["run", "--allow-all", "--sloppy-imports", workerFile, tmpDir, counterFile, logPath] }).output();

  const results = await Promise.all([p1, p2, p3]);
  for (const res of results) {
    assert.strictEqual(res.code, 0, "Worker failed: " + new TextDecoder().decode(res.stderr));
  }

  const logLines = (await Deno.readTextFile(logPath)).trim().split("\n");
  assert.strictEqual(logLines.length, 9, "All 9 critical section executions succeeded");
});

Deno.test("concurrency: pre-publication barrier race prevents lock replacement and ensures clean single ownership", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "pre-pub-race-" });
  const lockFile = join(tmpDir, ".mm.lock");

  const aReady = join(tmpDir, "a_ready.barrier");
  const bHolding = join(tmpDir, "b_holding.barrier");
  const resumeA = join(tmpDir, "resume_a.barrier");
  const releaseB = join(tmpDir, "release_b.barrier");
  const logFile = join(tmpDir, "race.log");
  await writeFile(logFile, "");

  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname;

  const aScript = `
    import { withLock } from "${lockModule}";
    import { writeFile, stat } from "node:fs/promises";
    const [dir, aR, rA, logP] = Deno.args;
    let didPause = false;
    try {
      await withLock(dir, async () => {
        await Deno.writeTextFile(logP, "A_ENTER\\n", { append: true });
        await Deno.writeTextFile(logP, "A_EXIT\\n", { append: true });
      }, {
        timeoutMs: 4000,
        staleThresholdMs: 5000,
        onBeforePublish: async () => {
          if (!didPause) {
            didPause = true;
            await writeFile(aR, "ready");
            while (true) {
              try {
                await stat(rA);
                break;
              } catch {
                await new Promise((r) => setTimeout(r, 10));
              }
            }
          }
        }
      });
    } catch (err) {
      await Deno.writeTextFile(logP, "A_ERR:" + err.message + "\\n", { append: true });
    }
  `;
  const aFile = join(tmpDir, "proc_a.ts");
  await writeFile(aFile, aScript);

  const bScript = `
    import { withLock } from "${lockModule}";
    import { writeFile, stat } from "node:fs/promises";
    const [dir, bH, relB, logP] = Deno.args;
    await withLock(dir, async () => {
      await Deno.writeTextFile(logP, "B_ENTER\\n", { append: true });
      await writeFile(bH, "holding");
      while (true) {
        try {
          await stat(relB);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      await Deno.writeTextFile(logP, "B_EXIT\\n", { append: true });
    }, { timeoutMs: 2000, staleThresholdMs: 5000 });
  `;
  const bFile = join(tmpDir, "proc_b.ts");
  await writeFile(bFile, bScript);

  const aCmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", aFile, tmpDir, aReady, resumeA, logFile],
    stdout: "piped",
    stderr: "piped",
  });
  const aChild = aCmd.spawn();

  while (true) {
    try {
      await Deno.stat(aReady);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const bCmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", bFile, tmpDir, bHolding, releaseB, logFile],
    stdout: "piped",
    stderr: "piped",
  });
  const bChild = bCmd.spawn();

  while (true) {
    try {
      await Deno.stat(bHolding);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const bContent = await readFile(lockFile, "utf-8");
  const bParsed = JSON.parse(bContent);
  assert.strictEqual(typeof bParsed.pid, "number");

  await writeFile(resumeA, "resume");
  await new Promise((r) => setTimeout(r, 100));

  const bContentStill = await readFile(lockFile, "utf-8");
  const bParsedStill = JSON.parse(bContentStill);
  assert.strictEqual(bParsedStill.token, bParsed.token, "B lock must not be replaced by A");

  await writeFile(releaseB, "release");
  await bChild.status;
  await aChild.status;

  const log = await Deno.readTextFile(logFile);
  assert.strictEqual(log.includes("B_ENTER"), true);
  assert.strictEqual(log.includes("B_EXIT"), true);
  assert.strictEqual(log.includes("A_ENTER"), true);
  assert.strictEqual(log.includes("A_EXIT"), true);
  const bEnterIdx = log.indexOf("B_ENTER");
  const bExitIdx = log.indexOf("B_EXIT");
  const aEnterIdx = log.indexOf("A_ENTER");
  assert.strictEqual(bEnterIdx < bExitIdx, true);
  assert.strictEqual(bExitIdx < aEnterIdx, true, "A must only enter AFTER B exits");
});


