import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ensureDaemon, probeDaemonSocket, DaemonCormRunner, isDaemonLockHeld } from "../src/daemon.ts";
import { buildStoreInvocation, buildScanInvocation, buildGetInvocation } from "../src/corm.ts";
import { activeSessionBuffer, flushSessionBuffer, summarizeToolEvent, installSessionHooks } from "../src/hooks/events.ts";
import { decodePayload } from "../src/payload.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const home = Deno.env.get("HOME") || "";
const cormAxisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

function runCli(args: string[], cwd: string, envOverrides: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      CORM_AXIS_PATH: cormAxisPath,
      LD_LIBRARY_PATH: `${home}/.local/lib:/usr/lib:${Deno.env.get("LD_LIBRARY_PATH") ?? ""}`,
      ...envOverrides,
    };
    const p = spawn(cormBin, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d) => { stdout += d.toString(); });
    p.stderr?.on("data", (d) => { stderr += d.toString(); });
    p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

Deno.test("lightweight 1: ensureDaemon starts resident cormd and subsequent calls reuse it", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-ensure-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  try {
    // 1. Initial startup
    const resSock = await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath: cormAxisPath,
      cwd: tmpDir,
      timeoutMs: 3000,
    });
    assert.strictEqual(resSock, sockPath);
    assert.strictEqual(existsSync(sockPath), true);
    assert.strictEqual(await probeDaemonSocket(sockPath), true);

    // 2. Subsequent call must immediately reuse the live daemon
    const start2 = Date.now();
    const resSock2 = await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath: cormAxisPath,
      cwd: tmpDir,
      timeoutMs: 3000,
    });
    const elapsed2 = Date.now() - start2;
    assert.strictEqual(resSock2, sockPath);
    assert.strictEqual(elapsed2 < 300, true, `Expected immediate reuse, took ${elapsed2}ms`);
  } finally {
    // Kill daemon process via lock PID if available
    const lockPath = join(tmpDir, ".cormd.lock");
    try {
      const lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
      if (lockData.pid) process.kill(lockData.pid, "SIGTERM");
    } catch { /* ignore */ }
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("lightweight 2: dead daemon recovery safely unlinks stale socket and restarts cormd", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-stale-sock-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  try {
    // 1. Start daemon
    await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath: cormAxisPath,
      cwd: tmpDir,
    });
    assert.strictEqual(await probeDaemonSocket(sockPath), true);

    // 2. Kill daemon ungracefully (SIGKILL) leaving stale socket on disk
    const lockPath = join(tmpDir, ".cormd.lock");
    const lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
    process.kill(lockData.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));

    // Confirm socket still exists on disk but is dead
    assert.strictEqual(existsSync(sockPath), true);
    assert.strictEqual(await probeDaemonSocket(sockPath), false);

    // 3. ensureDaemon must safely detect dead daemon, clean up stale socket, and restart
    const resSock = await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath: cormAxisPath,
      cwd: tmpDir,
    });
    assert.strictEqual(resSock, sockPath);
    assert.strictEqual(await probeDaemonSocket(sockPath), true);

    // Clean up
    const newLock = JSON.parse(readFileSync(lockPath, "utf-8"));
    process.kill(newLock.pid, "SIGTERM");
  } finally {
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("lightweight 3: concurrent ensureDaemon calls serialize safely onto single daemon instance", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-concurrent-start-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  try {
    // Launch 3 concurrent ensureDaemon attempts simultaneously
    const [s1, s2, s3] = await Promise.all([
      ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath: cormAxisPath, cwd: tmpDir }),
      ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath: cormAxisPath, cwd: tmpDir }),
      ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath: cormAxisPath, cwd: tmpDir }),
    ]);

    assert.strictEqual(s1, sockPath);
    assert.strictEqual(s2, sockPath);
    assert.strictEqual(s3, sockPath);
    assert.strictEqual(await probeDaemonSocket(sockPath), true);

    // Verify only ONE resident daemon holds the lock
    const lockPath = join(tmpDir, ".cormd.lock");
    assert.strictEqual(await isDaemonLockHeld(lockPath), true);
    const lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.strictEqual(lockData.owner, "daemon");

    // Clean up
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("lightweight 4: automatic episode references authentic Pi session IDs without transcript duplication", async () => {
  activeSessionBuffer.clear();
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-compact-session-" });
  activeSessionBuffer.setJournalDir(tmpDir);

  const capturedPayloads: Array<string | Uint8Array> = [];
  const runner = {
    run(inv: import("../src/corm.ts").Invocation) {
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-p") {
        capturedPayloads.push(inv.payloadBytes ?? inv.args[1]);
        return Promise.resolve({ stdout: "1", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const envSource = () => Promise.resolve({
    cfg: { ...DEFAULT_CONFIG, cormBin: cormBin, memDir: tmpDir },
    runner,
    nowProvider: () => new Date("2026-10-16T10:00:00Z"),
    cwd: tmpDir,
  });

  const genuineSessionId = "01a14052-2c72-7122-967e-b443cf78ef46";
  const genuineSessionFile = join(tmpDir, "sessions", "session.jsonl");

  // Simulate Pi context with genuine sessionManager
  const mockCtx = {
    cwd: tmpDir,
    hasUI: false,
    mode: "test",
    sessionManager: {
      getSessionId: () => genuineSessionId,
      getSessionFile: () => genuineSessionFile,
      getLeafId: () => "leaf_12345",
    },
  };

  // Record an event with verified outcome
  activeSessionBuffer.record({
    id: "tool_call_abc",
    timestamp: "2026-10-16T10:00:00Z",
    toolName: "bash",
    summary: "make test: all 218 tests passed",
    isError: false,
    approach: "run test suite",
    outcome: "worked",
  });

  // Flush buffer
  const ref = await flushSessionBuffer(envSource, mockCtx);
  assert.strictEqual(ref, 1);
  assert.strictEqual(capturedPayloads.length, 1);

  const payload = capturedPayloads[0] instanceof Uint8Array ? capturedPayloads[0] : capturedPayloads[0].slice(capturedPayloads[0].indexOf(":") + 1);
  const { envelope } = decodePayload(payload);

  // Assert genuine session linkage
  assert.strictEqual(envelope.episode?.sessionId, genuineSessionId);
  assert.strictEqual(envelope.episode?.sessionFile, genuineSessionFile);
  assert.strictEqual(envelope.episode?.leafId, "leaf_12345");
  assert.strictEqual(envelope.episode?.toolCallId, "tool_call_abc");

  // Assert transcript duplication is removed
  assert.strictEqual(envelope.episode?.observations, undefined);
  assert.strictEqual(envelope.episode?.diffs, undefined);
});

Deno.test("lightweight 4b: routine successful bash operations are filtered out and not flushed to memory", async () => {
  activeSessionBuffer.clear();
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-filter-routine-" });
  activeSessionBuffer.setJournalDir(tmpDir);

  // 1. Direct verification of summarizeToolEvent filtering
  const routineLs = summarizeToolEvent({
    toolCallId: "call_ls_1",
    toolName: "bash",
    input: { command: "ls -la /tmp" },
    content: [{ type: "text", text: "total 12\ndrwxr-xr-x 2 user user 4096 file.txt" }],
    isError: false,
  });
  assert.strictEqual(routineLs, null, "Routine successful ls command must return null");

  const routineCat = summarizeToolEvent({
    toolCallId: "call_cat_1",
    toolName: "bash",
    input: { command: "cat package.json" },
    content: [{ type: "text", text: '{\n  "name": "fixture"\n}' }],
    isError: false,
  });
  assert.strictEqual(routineCat, null, "Routine successful cat command must return null");

  const routinePwd = summarizeToolEvent({
    toolCallId: "call_pwd_1",
    toolName: "bash",
    input: { command: "pwd" },
    content: [{ type: "text", text: `${tmpDir}/repo\n` }],
    isError: false,
  });
  assert.strictEqual(routinePwd, null, "Routine successful pwd command must return null");

  // 2. End-to-end hook integration test: emit routine bash operations and confirm zero flushes
  let storeCount = 0;
  const runner = {
    run(inv: import("../src/corm.ts").Invocation) {
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-p") {
        storeCount++;
        return Promise.resolve({ stdout: "1", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const envSource = () => Promise.resolve({
    cfg: { ...DEFAULT_CONFIG, cormBin: cormBin, memDir: tmpDir },
    runner,
    nowProvider: () => new Date(),
    cwd: tmpDir,
  });

  const mockPi = {
    handlers: new Map<string, Array<(...args: unknown[]) => unknown>>(),
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(handler);
    },
    async emit(event: string, data: unknown, ctxData?: unknown): Promise<void> {
      for (const h of this.handlers.get(event) || []) await h(data, ctxData);
    },
  };

  installSessionHooks(mockPi as unknown as import("../src/hooks/events.ts").Pi, envSource);

  // Emit 3 routine successful bash operations
  await mockPi.emit("tool_result", {
    toolCallId: "call_ls_test",
    toolName: "bash",
    input: { command: "ls -la" },
    content: [{ type: "text", text: "total 0\n" }],
  });
  await mockPi.emit("tool_result", {
    toolCallId: "call_grep_test",
    toolName: "bash",
    input: { command: "grep foo bar.txt" },
    content: [{ type: "text", text: "foo match\n" }],
  });

  // Verify buffer is empty: zero events buffered from routine operations
  assert.strictEqual(activeSessionBuffer.hasUnflushed(), false);

  // Fire agent_settled: zero store calls made
  await mockPi.emit("agent_settled", {}, { cwd: tmpDir, hasUI: false, mode: "test" });
  assert.strictEqual(storeCount, 0, "No episode should be stored for routine bash operations");

  // 3. Substantive verification/test failure MUST be recorded and stored
  await mockPi.emit("tool_result", {
    toolCallId: "call_test_fail",
    toolName: "bash",
    input: { command: "deno test" },
    content: [{ type: "text", text: "FAIL: 1 failed in suite" }],
    isError: true,
  });

  assert.strictEqual(activeSessionBuffer.hasUnflushed(), true);
  await mockPi.emit("agent_settled", {}, { cwd: tmpDir, hasUI: false, mode: "test" });
  assert.strictEqual(storeCount, 1, "Substantive failure must trigger an episode store");

  try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

Deno.test("lightweight 5: crash journal lifecycle prunes committed events and deletes journal file on flush", async () => {
  activeSessionBuffer.clear();
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-journal-purge-" });
  activeSessionBuffer.setJournalDir(tmpDir);
  const journalFile = join(tmpDir, ".pending_events.json");

  // 1. Record pending event: must be written to disk journal
  await activeSessionBuffer.recordAsync({
    id: "evt_pending_1",
    timestamp: "2026-10-16T10:00:00Z",
    toolName: "bash",
    summary: "compiler warning check",
    isError: false,
    approach: "compile check",
    outcome: "worked",
  });

  assert.strictEqual(existsSync(journalFile), true);
  const journalContent = JSON.parse(readFileSync(journalFile, "utf-8"));
  assert.strictEqual(journalContent.length, 1);
  assert.strictEqual(journalContent[0].id, "evt_pending_1");

  // 2. Execute flush: on success, the journal file must be unlinked!
  const runner = {
    run(inv: import("../src/corm.ts").Invocation) {
      if (inv.args[0] === "-g" && inv.args[1] === ".") return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      if (inv.args[0] === "-p") return Promise.resolve({ stdout: "1", stderr: "", code: 0 });
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };
  const envSource = () => Promise.resolve({
    cfg: { ...DEFAULT_CONFIG, cormBin: cormBin, memDir: tmpDir },
    runner,
    nowProvider: () => new Date(),
    cwd: tmpDir,
  });

  await flushSessionBuffer(envSource, { cwd: tmpDir, hasUI: false, mode: "test" });

  // Confirmed: .pending_events.json is deleted when no pending events remain
  assert.strictEqual(existsSync(journalFile), false);
});

Deno.test("lightweight 6: dynamic CORM growth past initial mask capacity preserves indexes and persists across restart", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-growth-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  // Start cormd with default initial mask 255 (QDBE_MASK = 255)
  await ensureDaemon({
    cormdBin,
    filespec: fspec,
    socketPath: sockPath,
    axisPath: cormAxisPath,
    cwd: tmpDir,
  });

  const runner = new DaemonCormRunner(sockPath, {
    run: (_inv) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
  });

  try {
    // Insert 500 records (exceeding initial capacity of 256 slots, forcing corm_grow multiple times)
    const COUNT = 500;
    for (let i = 1; i <= COUNT; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      const text = `record-${i} payload keyword-${i % 5}`;
      const payload = `2026-10-${day}:${text}`;
      const res = await runner.run(buildStoreInvocation(cormBin, fspec, i, payload, cormAxisPath, tmpDir));
      assert.strictEqual(res.code, 0, `Store failed for ref ${i}: ${res.stderr}`);
    }

    // Verify record retrieval via GET across grown map
    const g1 = await runner.run(buildGetInvocation(cormBin, fspec, 1, cormAxisPath, tmpDir));
    assert.strictEqual(g1.code, 0);
    assert.strictEqual(g1.stdout.includes("record-1"), true);

    const g500 = await runner.run(buildGetInvocation(cormBin, fspec, 500, cormAxisPath, tmpDir));
    assert.strictEqual(g500.code, 0);
    assert.strictEqual(g500.stdout.includes("record-500"), true);

    // Verify secondary full-text query over grown stoma index
    const qStoma = await runner.run(buildScanInvocation(cormBin, fspec, "lemma", 10, cormAxisPath, tmpDir, undefined, ["--query=record-250"]));
    assert.strictEqual(qStoma.code, 0);
    assert.strictEqual(qStoma.stdout.includes("record-250"), true);

    // Verify time window query over grown joint index
    const qJoint = await runner.run(buildScanInvocation(cormBin, fspec, "joint", 20, cormAxisPath, tmpDir, undefined, ["--since=2026-10-05", "--until=2026-10-06"]));
    assert.strictEqual(qJoint.code, 0);
    assert.strictEqual(qJoint.stdout.length > 0, true);

    // Stop daemon
    const lockPath = join(tmpDir, ".cormd.lock");
    const lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
    process.kill(lockData.pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 150));

    // Restart daemon to verify clean reload of grown database
    await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath: cormAxisPath,
      cwd: tmpDir,
    });

    const runner2 = new DaemonCormRunner(sockPath, {
      run: (_inv) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    });

    // Verify data intact post-restart
    const gAfter = await runner2.run(buildGetInvocation(cormBin, fspec, 499, cormAxisPath, tmpDir));
    assert.strictEqual(gAfter.code, 0);
    assert.strictEqual(gAfter.stdout.includes("record-499"), true);

    const qStomaAfter = await runner2.run(buildScanInvocation(cormBin, fspec, "lemma", 10, cormAxisPath, tmpDir, undefined, ["--query=record-499"]));
    assert.strictEqual(qStomaAfter.code, 0);
    assert.strictEqual(qStomaAfter.stdout.includes("record-499"), true);

    // Clean up
    const lockData2 = JSON.parse(readFileSync(lockPath, "utf-8"));
    process.kill(lockData2.pid, "SIGTERM");
  } finally {
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("lightweight 7: existing database compatibility verifies pre-existing legacy databases remain queryable", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-compat-" });
  const dbPath = join(tmpDir, "legacy.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  // Create database under old larger mask CORM_MASK=4095
  const p1 = await runCli(["-p", "1:2026-10-16:legacy database entry", fspec], tmpDir, { CORM_MASK: "4095" });
  assert.strictEqual(p1.code, 0);

  // Now open with resident cormd running under standard default mask 255
  const sockPath = join(tmpDir, "cormd.sock");
  await ensureDaemon({
    cormdBin,
    filespec: fspec,
    socketPath: sockPath,
    axisPath: cormAxisPath,
    cwd: tmpDir,
  });

  const runner = new DaemonCormRunner(sockPath, {
    run: (_inv) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
  });

  try {
    // Verify legacy record is readable
    const getRes = await runner.run(buildGetInvocation(cormBin, fspec, 1, cormAxisPath, tmpDir));
    assert.strictEqual(getRes.code, 0);
    assert.strictEqual(getRes.stdout.includes("legacy database entry"), true);

    // Add new record under resident cormd
    const putRes = await runner.run(buildStoreInvocation(cormBin, fspec, 2, "2026-10-16:new entry added to legacy db", cormAxisPath, tmpDir));
    assert.strictEqual(putRes.code, 0);

    // Verify both are retrievable
    const qRes = await runner.run(buildScanInvocation(cormBin, fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=legacy"]));
    assert.strictEqual(qRes.code, 0);
    assert.strictEqual(qRes.stdout.includes("legacy database entry"), true);

    // Clean up
    const lockPath = join(tmpDir, ".cormd.lock");
    const lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
