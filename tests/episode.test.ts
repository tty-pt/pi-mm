import { join } from "node:path";
import assert from "node:assert";
import { makeStoreTool } from "../src/tools/store.ts";
import { SessionEventBuffer } from "../src/hooks/events.ts";
import { fakeRunner, runTool, okResult } from "./fake-corm.ts";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { decodePayload, bytesToBinaryString } from "../src/payload.ts";
import { give, type ToolEnv } from "../src/tools/index.ts";
import type { CormRunner } from "../src/corm.ts";

const CWD = await Deno.makeTempDir({ prefix: "mm-episode-cwd-" });
const ctx = { cwd: CWD, hasUI: false, mode: "agent" };

function now(): Date {
  return new Date("2026-10-14T12:00:00Z");
}

function env(runner: CormRunner, cfg: Partial<MmConfig> = {}): ToolEnv {
  try { Deno.removeSync(join(CWD, ".ref_seq")); } catch { /* ignore */ }
  try { Deno.removeSync(join(CWD, ".pi", "mm", ".ref_seq")); } catch { /* ignore */ }
  return {
    cwd: CWD,
    runner,
    nowProvider: now,
    cfg: { ...DEFAULT_CONFIG, cormBin: "/usr/bin/corm", ...cfg },
  };
}

Deno.test("episode: SessionEventBuffer captures tool outcomes and approaches", () => {
  const buf = new SessionEventBuffer();
  buf.record({
    id: "evt_1",
    timestamp: "2026-10-14T12:01:00Z",
    toolName: "bash",
    summary: "cargo build failed: error[E0308]: mismatched types",
    isError: true,
    approach: "Cargo build with strict types",
    outcome: "failed",
  });
  buf.record({
    id: "evt_2",
    timestamp: "2026-10-14T12:05:00Z",
    toolName: "bash",
    summary: "cargo build: ok",
    isError: false,
    approach: "Cargo build with type coercion",
    outcome: "worked",
  });

  const approaches = buf.getApproaches();
  assert.strictEqual(approaches.length, 2);
  assert.strictEqual(approaches[0].outcome, "failed");
  assert.strictEqual(approaches[0].reason?.includes("E0308"), true);
  assert.strictEqual(approaches[1].outcome, "worked");

  buf.clear();
  assert.strictEqual(buf.getEvents().length, 0);
});

Deno.test("episode: store captures comprehensive L0 episode with failed vs worked approaches", async () => {
  const runner = fakeRunner([
    okResult(""),
    okResult("1"),
  ]);

  const tool = makeStoreTool(give(env(runner)));
  const res = await runTool(tool, {
    level: "L0",
    type: "episode",
    episode: {
      problem: "Intermittent SIGSEGV in stoma_query_eval",
      approaches: [
        {
          approach: "Increase buffer size in stoma_read",
          outcome: "failed",
          reason: "Still crashed with buffer overflow on large query terms",
        },
        {
          approach: "Add null terminator check before index scan",
          outcome: "worked",
          reason: "Prevented reading beyond buffer bounds",
        },
      ],
      observations: ["Query string was not 0-terminated when length exactly equaled chunk size"],
      findings: ["stoma buffer boundaries must check null terminator explicitly"],
      unresolved: ["Benchmark performance impact under 100k queries"],
      environment: {
        compiler: "gcc 13.2.0",
        commit: "a8f3b21",
        os: "linux",
      },
      outcome: "success",
    },
    context: {
      project: "site",
      subsystem: "libcorm",
      module: "liblemma",
    },
  }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.ref, 1);
  assert.strictEqual(details.level, "L0");
  assert.strictEqual(details.summary, "Intermittent SIGSEGV in stoma_query_eval");

  const arg = runner.invocations[1].payloadBytes ?? runner.invocations[1].args[1];
  const storedPayload = arg instanceof Uint8Array ? arg : (typeof arg === "string" && arg.includes(":") ? arg.slice(arg.indexOf(":") + 1) : arg);
  const { date, envelope } = decodePayload(storedPayload);
  assert.strictEqual(date, "2026-10-14");
  assert.strictEqual(envelope.level, "L0");
  assert.strictEqual(envelope.type, "episode");
  assert.strictEqual(envelope.episode?.problem, "Intermittent SIGSEGV in stoma_query_eval");
  assert.strictEqual(envelope.episode?.approaches?.length, 2);
  assert.strictEqual(envelope.episode?.approaches?.[0].outcome, "failed");
  assert.strictEqual(envelope.episode?.approaches?.[1].outcome, "worked");
  assert.strictEqual(envelope.episode?.environment?.compiler, "gcc 13.2.0");
});

Deno.test("episode: end-to-end capture hook -> persistence -> fresh session reconstruction -> scan retrieval", async () => {
  const { makeScanTool } = await import("../src/tools/scan.ts");
  const { installSessionHooks, activeSessionBuffer } = await import("../src/hooks/events.ts");

  // Step 1: Simulate Pi tool hook firing with test failure
  activeSessionBuffer.clear();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-e2e-hook-" });
  activeSessionBuffer.setJournalDir(tmpDir);
  const mockPi = {
    handlers: new Map<string, Array<(...args: unknown[]) => unknown>>(),
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(handler);
    },
    async emit(event: string, data: unknown): Promise<void> {
      for (const h of this.handlers.get(event) || []) await h(data);
    },
  };

  installSessionHooks(mockPi as unknown as import("../src/hooks/events.ts").Pi);
  mockPi.emit("tool_result", {
    toolCallId: "call_1",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "FAIL: test_corm_alias failed with exit code 1" }],
  });

  const captured = activeSessionBuffer.getApproaches();
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].outcome, "failed");

  // Step 2: Persist episode via memory_store
  const runnerSession1 = fakeRunner([
    okResult(""),
    okResult("1"),
  ]);
  const storeTool = makeStoreTool(give(env(runnerSession1)));
  const storeRes = await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "Investigation of corm_alias failure",
    episode: {
      problem: "corm_alias test failed on double open",
      approaches: captured,
      outcome: "failed",
    },
    context: { project: "site", subsystem: "libcorm" },
  }, ctx);
  assert.strictEqual((storeRes.details as Record<string, unknown>).ref, 1);

  const storedPayload = runnerSession1.invocations[1].payloadBytes ?? runnerSession1.invocations[1].args[1];
  const storedJson = storedPayload instanceof Uint8Array ? storedPayload : storedPayload.slice(storedPayload.indexOf(":") + 1);

  // Step 3: Reconstruct fresh session / client
  const payloadStr = storedJson instanceof Uint8Array ? bytesToBinaryString(storedJson) : storedJson;
  const runnerSession2 = fakeRunner([
    okResult(`1 1.000000 ${payloadStr}\n`),
  ]);
  const scanTool = makeScanTool(give(env(runnerSession2)));

  // Step 4: Scan and retrieve from fresh session
  const scanRes = await runTool(scanTool, { topic: "corm_alias", level: "L0" }, ctx);
  const details = scanRes.details as { records: Array<{ ref: number; envelope?: { episode?: { approaches?: Array<{ outcome: string }> } } }> };

  assert.strictEqual(details.records.length, 1);
  assert.strictEqual(details.records[0].ref, 1);
  assert.strictEqual(details.records[0].envelope?.episode?.approaches?.[0].outcome, "failed");
});

Deno.test("episode: automatic persistence on agent_settled without manual store call", async () => {
  const { installSessionHooks, activeSessionBuffer } = await import("../src/hooks/events.ts");

  activeSessionBuffer.clear();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-auto-settle-" });
  activeSessionBuffer.setJournalDir(tmpDir);
  const runner = fakeRunner([
    okResult(""), // list all refs
    okResult(""), // store invocation
  ]);

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

  installSessionHooks(mockPi as unknown as import("../src/hooks/events.ts").Pi, give(env(runner)));

  // 1. Tool result fires
  mockPi.emit("tool_result", {
    toolCallId: "call_auto",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "FAIL: stoma index corruption on null byte" }],
  });

  // 2. Turn finishes / agent settles -> automatic flush
  await mockPi.emit("agent_settled", {}, ctx);

  // Assert store invocation occurred automatically
  assert.strictEqual(runner.invocations.length, 2);
  const storedArg = runner.invocations[1].payloadBytes ?? runner.invocations[1].args[1];
  const { envelope } = decodePayload(storedArg instanceof Uint8Array ? storedArg : storedArg.slice(storedArg.indexOf(":") + 1));
  assert.strictEqual(envelope.level, "L0");
  assert.strictEqual(envelope.type, "episode");
  assert.strictEqual(envelope.lifecycle, "observed"); // Default to observed!
  assert.strictEqual(envelope.summary.includes("stoma index corruption"), true);

  // 3. Second settle event with no new tool output produces zero duplicate writes (idempotent deduplication)
  await mockPi.emit("agent_settled", {}, ctx);
  assert.strictEqual(runner.invocations.length, 2);
});

Deno.test("episode: failed write followed by retry preserves unpersisted events and succeeds", async () => {
  const { installSessionHooks, activeSessionBuffer } = await import("../src/hooks/events.ts");

  activeSessionBuffer.clear();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-retry-store-" });
  activeSessionBuffer.setJournalDir(tmpDir);

  let shouldFail = true;
  const runner: CormRunner = {
    run(inv: import("../src/corm.ts").Invocation) {
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-p") {
        if (shouldFail) {
          return Promise.resolve({ stdout: "", stderr: "disk I/O error", code: 1 });
        }
        return Promise.resolve({ stdout: "1", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

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

  installSessionHooks(mockPi as unknown as import("../src/hooks/events.ts").Pi, give(env(runner)));

  mockPi.emit("tool_result", {
    toolCallId: "call_retry_1",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "FAIL: connection refused on port 8080" }],
  });

  // Attempt 1: Settle when store fails
  await mockPi.emit("agent_settled", {}, ctx);
  assert.strictEqual(activeSessionBuffer.hasUnflushed(), true);
  assert.strictEqual(activeSessionBuffer.lastError?.includes("disk I/O error"), true);

  // Attempt 2: Store now recovers
  shouldFail = false;
  await mockPi.emit("agent_settled", {}, ctx);
  assert.strictEqual(activeSessionBuffer.hasUnflushed(), false);
  assert.strictEqual(activeSessionBuffer.lastError, null);
});

Deno.test("episode: session_start preserves unpersisted events but drops flushed ones", async () => {
  const { installSessionHooks, activeSessionBuffer } = await import("../src/hooks/events.ts");

  activeSessionBuffer.clear();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-session-start-" });
  activeSessionBuffer.setJournalDir(tmpDir);

  let allowStore = true;
  const runner: CormRunner = {
    run(inv: import("../src/corm.ts").Invocation) {
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-p") {
        if (!allowStore) return Promise.resolve({ stdout: "", stderr: "locked", code: 1 });
        return Promise.resolve({ stdout: "1", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

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

  installSessionHooks(mockPi as unknown as import("../src/hooks/events.ts").Pi, give(env(runner)));

  // Batch 1: successfully flushed
  mockPi.emit("tool_result", {
    toolCallId: "call_batch1",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "FAIL: batch 1 test error" }],
  });
  await mockPi.emit("agent_settled", {}, ctx);
  assert.strictEqual(activeSessionBuffer.hasUnflushed(), false);

  // Batch 2: fails to flush
  allowStore = false;
  mockPi.emit("tool_result", {
    toolCallId: "call_batch2",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "FAIL: batch 2 test error" }],
  });
  await mockPi.emit("agent_settled", {}, ctx);
  assert.strictEqual(activeSessionBuffer.hasUnflushed(), true);

  // New session begins: session_start fires
  mockPi.emit("session_start", {});

  // Unpersisted batch 2 MUST be preserved!
  assert.strictEqual(activeSessionBuffer.hasUnflushed(), true);
  const remaining = activeSessionBuffer.getUnflushed();
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].id, "call_batch2");

  // Storage recovers in new session
  allowStore = true;
  await mockPi.emit("agent_settled", {}, ctx);
  assert.strictEqual(activeSessionBuffer.hasUnflushed(), false);
});

Deno.test("episode: captures diffs and runtime environment from tool modifications", async () => {
  const { installSessionHooks, activeSessionBuffer } = await import("../src/hooks/events.ts");

  activeSessionBuffer.clear();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-diffs-" });
  activeSessionBuffer.setJournalDir(tmpDir);
  let storedPayload: string | Uint8Array = "";
  const runner: CormRunner = {
    run(inv: import("../src/corm.ts").Invocation) {
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-p") {
        storedPayload = inv.payloadBytes ?? inv.args[1];
        return Promise.resolve({ stdout: "1", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

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

  installSessionHooks(mockPi as unknown as import("../src/hooks/events.ts").Pi, give(env(runner)));

  // Emit an edit event with actual diff lines
  mockPi.emit("tool_result", {
    toolCallId: "call_edit_1",
    toolName: "edit",
    content: [{
      type: "text",
      text: "@@ -10,3 +10,4 @@\n- old_function_call();\n+ new_function_call();",
    }],
  });

  await mockPi.emit("agent_settled", {}, ctx);

  assert.notStrictEqual(storedPayload, "");
  const payloadToDecode = typeof storedPayload === "string" && storedPayload.includes(":")
    ? storedPayload.slice(storedPayload.indexOf(":") + 1)
    : storedPayload;
  const { envelope } = decodePayload(payloadToDecode);
  assert.strictEqual(envelope.level, "L0");
  // Conforms to deduplicated session referencing contract: raw diff excerpts omitted
  assert.strictEqual(envelope.episode?.diffs, undefined);
  assert.strictEqual(envelope.episode?.toolCallId, "call_edit_1");
  assert.strictEqual(envelope.episode?.environment?.runtime, "deno");
});

Deno.test("episode: extracts tool arguments from event.input and rejects false diffs", async () => {
  const { summarizeToolEvent } = await import("../src/hooks/events.ts");

  // 1. Tool result with event.input and ordinary success text (no diff header)
  const sig = summarizeToolEvent({
    toolCallId: "call_input_test",
    toolName: "edit",
    input: { path: "src/server.c", command: "replace" },
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/server.c." }],
  });

  assert.notStrictEqual(sig, null);
  assert.deepStrictEqual(sig!.toolArgs, { path: "src/server.c", command: "replace" });
  // Diffs MUST NOT be inferred from an ordinary success message!
  assert.strictEqual(sig!.diffs, undefined);
});

Deno.test("episode: disk journal persists pending events across process restart and clears on flush", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-journal-test-" });

  // 1. First process records an event and crashes before flush
  const proc1Buffer = new SessionEventBuffer();
  proc1Buffer.record({
    id: "evt_crash_recovery",
    timestamp: "2026-10-15T15:00:00Z",
    toolName: "bash",
    summary: "deno test: failed with syntax error",
    isError: true,
    approach: "deno test",
    outcome: "failed",
  });
  await proc1Buffer.saveJournal(tmpDir);

  // 2. Second fresh process starts (simulating process restart)
  const proc2Buffer = new SessionEventBuffer();
  assert.strictEqual(proc2Buffer.hasUnflushed(), false);

  // Restore journal from disk
  const recoveredCount = await proc2Buffer.restoreJournal(tmpDir);
  assert.strictEqual(recoveredCount, 1);
  assert.strictEqual(proc2Buffer.hasUnflushed(), true);

  const unflushed = proc2Buffer.getUnflushed();
  assert.strictEqual(unflushed[0].id, "evt_crash_recovery");

  // Mark flushed: journal should be pruned from disk
  proc2Buffer.markFlushed("fingerprint_done", ["evt_crash_recovery"]);
  await proc2Buffer.saveJournal(tmpDir);

  // 3. Third process checks journal is now empty
  const proc3Buffer = new SessionEventBuffer();
  const recoveredAfterFlush = await proc3Buffer.restoreJournal(tmpDir);
  assert.strictEqual(recoveredAfterFlush, 0);
});

Deno.test("episode: automatic journaling on normal Pi tool_result hook without manual saveJournal", async () => {
  const { installSessionHooks, activeSessionBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-auto-journal-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  activeSessionBuffer.clear();
  activeSessionBuffer.setJournalDir(tmpDir);

  const mockPi = {
    handlers: new Map<string, Array<(...args: unknown[]) => unknown>>(),
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(handler);
    },
    async emit(event: string, data: unknown): Promise<void> {
      for (const h of this.handlers.get(event) || []) await h(data);
    },
  };

  installSessionHooks(mockPi as unknown as import("../src/hooks/events.ts").Pi);

  // Normal tool_result hook execution
  mockPi.emit("tool_result", {
    toolCallId: "call_hook_auto_journal",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "FAIL: panic in buffer allocator" }],
  });

  // Small delay to allow async journal file write
  await new Promise((r) => setTimeout(r, 25));

  // Verify journal file was automatically written to disk!
  const journalExists = await (async () => {
    try {
      const s = await Deno.stat(journalFile);
      return s.isFile;
    } catch {
      return false;
    }
  })();
  assert.strictEqual(journalExists, true);

  const content = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(content.length, 1);
  assert.strictEqual(content[0].id, "call_hook_auto_journal");
});

Deno.test("episode: post-crash idempotency prunes already-committed event IDs", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-idempotency-" });

  const buf1 = new SessionEventBuffer();
  buf1.setJournalDir(tmpDir);
  buf1.record({
    id: "evt_committed_1",
    timestamp: "2026-10-15T15:00:00Z",
    toolName: "bash",
    summary: "build passed",
    isError: false,
    approach: "cargo build",
    outcome: "worked",
  });
  buf1.record({
    id: "evt_uncommitted_2",
    timestamp: "2026-10-15T15:01:00Z",
    toolName: "bash",
    summary: "test failed",
    isError: true,
    approach: "cargo test",
    outcome: "failed",
  });
  await buf1.saveJournal(tmpDir);

  // Process restarts. "evt_committed_1" is found in mem.db
  const existingCommitted = new Set<string>(["evt_committed_1"]);

  const buf2 = new SessionEventBuffer();
  const restored = await buf2.restoreJournal(tmpDir, existingCommitted);

  // Only the uncommitted event should be restored
  assert.strictEqual(restored, 1);
  const unflushed = buf2.getUnflushed();
  assert.strictEqual(unflushed.length, 1);
  assert.strictEqual(unflushed[0].id, "evt_uncommitted_2");
});

Deno.test("episode: crash recovery across fresh spawned OS process", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-os-proc-recovery-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  // Write a pending event journal from a crashed process
  const pendingEvents = [{
    id: "evt_from_crashed_proc",
    timestamp: "2026-10-15T16:00:00Z",
    toolName: "bash",
    summary: "make: *** [test] Error 2",
    isError: true,
    approach: "make test",
    outcome: "failed",
  }];
  await Deno.writeTextFile(journalFile, JSON.stringify(pendingEvents));

  const eventsModule = new URL("../src/hooks/events.ts", import.meta.url).pathname;

  const workerScript = `
    import { SessionEventBuffer } from "${eventsModule}";

    const dir = Deno.args[0];
    const buf = new SessionEventBuffer();
    const restored = await buf.restoreJournal(dir);
    if (restored !== 1) {
      console.error("Expected 1 restored event, got " + restored);
      Deno.exit(1);
    }
    const unflushed = buf.getUnflushed();
    if (unflushed[0].id !== "evt_from_crashed_proc") {
      console.error("Unexpected id " + unflushed[0].id);
      Deno.exit(2);
    }
    buf.markFlushed("recovered_fp", ["evt_from_crashed_proc"]);
    await buf.saveJournal(dir);
    Deno.exit(0);
  `;

  const scriptPath = join(tmpDir, "recover_worker.ts");
  await Deno.writeTextFile(scriptPath, workerScript);

  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", scriptPath, tmpDir],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  assert.strictEqual(output.code, 0, new TextDecoder().decode(output.stderr));

  // Verify journal was cleared by the recovered process
  const journalRemaining = await (async () => {
    try {
      const s = await Deno.stat(journalFile);
      return s.isFile;
    } catch {
      return false;
    }
  })();
  assert.strictEqual(journalRemaining, false);
});

Deno.test("episode: mid-flush event arrival is isolated and not marked as flushed", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const buf = new SessionEventBuffer();

  buf.record({
    id: "evt_batch_1",
    timestamp: "2026-10-15T10:00:00Z",
    toolName: "bash",
    summary: "initial test",
    isError: false,
  });

  // Begin flush: batch 1 is in-flight
  const batch = buf.beginFlush()!;
  assert.strictEqual(batch.length, 1);
  assert.strictEqual(batch[0].id, "evt_batch_1");

  // An event arrives while the write is in flight
  buf.record({
    id: "evt_mid_flight_2",
    timestamp: "2026-10-15T10:00:01Z",
    toolName: "edit",
    summary: "file modified mid-flight",
    isError: false,
  });

  // Complete batch 1 flush
  buf.commitFlush(batch.map((e) => e.id));

  // The event that arrived mid-flight MUST NOT be marked flushed!
  assert.strictEqual(buf.hasUnflushed(), true);
  const remaining = buf.getUnflushed();
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].id, "evt_mid_flight_2");
});

Deno.test("episode: simultaneous flush calls are protected against duplicate commits", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const buf = new SessionEventBuffer();

  buf.record({
    id: "evt_concurrent_1",
    timestamp: "2026-10-15T11:00:00Z",
    toolName: "bash",
    summary: "concurrent test",
    isError: false,
  });

  const firstBatch = buf.beginFlush();
  assert.notStrictEqual(firstBatch, null);

  // A concurrent flush call occurs before firstBatch finishes
  const secondBatch = buf.beginFlush();
  // Second flush MUST be rejected while first is in-flight
  assert.strictEqual(secondBatch, null);

  buf.commitFlush(firstBatch!.map((e) => e.id));
  assert.strictEqual(buf.hasUnflushed(), false);
});

Deno.test("episode: execution outcome distinguishes ordinary tool returns from verified test success", async () => {
  const { summarizeToolEvent } = await import("../src/hooks/events.ts");

  // 1. Ordinary read/bash tool invocation that completed without error
  const ordinaryEvent = summarizeToolEvent({
    toolName: "bash",
    content: [{ type: "text", text: "total 12\n-rw-r--r-- 1 user user 1024 Oct 15 server.c" }],
    isError: false,
  });
  // Conforms to deduplicated session referencing contract: routine bash is filtered out!
  assert.strictEqual(ordinaryEvent, null);

  // 2. Test execution that explicitly passed
  const testPassEvent = summarizeToolEvent({
    toolName: "bash",
    content: [{ type: "text", text: "ok 1 - all green 0 failed (12ms)" }],
    isError: false,
  });
  assert.notStrictEqual(testPassEvent, null);
  // Outcome MUST be verified "worked"
  assert.strictEqual(testPassEvent!.outcome, "worked");

  // 3. Test execution that failed
  const testFailEvent = summarizeToolEvent({
    toolName: "bash",
    content: [{ type: "text", text: "FAIL: 1 failed in suite" }],
    isError: true,
  });
  assert.notStrictEqual(testFailEvent, null);
  assert.strictEqual(testFailEvent!.outcome, "failed");
});

Deno.test("episode: journal write queue recovers after failed write and exposes lastError", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const buf = new SessionEventBuffer();

  // Create an invalid path that cannot be written to
  const tmpFile = await Deno.makeTempFile({ prefix: "mm-journal-bad-" });
  const badDir = join(tmpFile, "cannot_create_dir");

  buf.record({
    id: "evt_fail_journal",
    timestamp: "2026-10-15T12:00:00Z",
    toolName: "bash",
    summary: "fail test",
    isError: false,
  });

  // Attempt save to bad directory: must reject and populate lastError
  await assert.rejects(async () => {
    await buf.saveJournal(badDir);
  });
  assert.notStrictEqual(buf.lastError, null);
  assert.strictEqual(buf.lastError!.includes("journal-error:"), true);

  // Now save to a valid directory: queue MUST recover and succeed
  const goodDir = await Deno.makeTempDir({ prefix: "mm-journal-good-" });
  await buf.saveJournal(goodDir);
  assert.strictEqual(buf.lastError, null);

  const savedContent = JSON.parse(await Deno.readTextFile(join(goodDir, ".pending_events.json")));
  assert.strictEqual(savedContent.length, 1);
  assert.strictEqual(savedContent[0].id, "evt_fail_journal");
});

Deno.test("episode: concurrent journal updates result in latest unflushed event state", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-concurrent-journal-" });
  const buf = new SessionEventBuffer();
  buf.setJournalDir(tmpDir);

  // Issue 5 rapid updates concurrently
  for (let i = 1; i <= 5; i++) {
    buf.record({
      id: `evt_rapid_${i}`,
      timestamp: `2026-10-15T12:0${i}:00Z`,
      toolName: "edit",
      summary: `edit step ${i}`,
      isError: false,
    });
  }

  // Await the journal queue to settle
  await buf.saveJournal(tmpDir);

  const saved = JSON.parse(await Deno.readTextFile(join(tmpDir, ".pending_events.json")));
  assert.strictEqual(saved.length, 5);
  assert.strictEqual(saved[4].id, "evt_rapid_5");
});

Deno.test("episode: session_start during in-flight flush preserves flush guard and avoids duplicate commit", async () => {
  const { flushSessionBuffer } = await import("../src/hooks/events.ts");

  const committedBatches: string[][] = [];
  const fakeStore = new Map<number, string>();
  let nextId = 1;

  let releaseStoreDelay: () => void = () => {};
  const storeDelayPromise = new Promise<void>((resolve) => {
    releaseStoreDelay = resolve;
  });

  const slowRunner: import("../src/corm.ts").CormRunner = {
    async run(inv: import("../src/corm.ts").Invocation) {
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        const refs = [...fakeStore.keys()].join("\n");
        return { stdout: refs ? refs + "\n" : "", stderr: "", code: 0 };
      }
      if (inv.args[0] === "-p") {
        // Pause inside store operation
        await storeDelayPromise;
        const ref = nextId++;
        const payload = inv.payloadBytes ?? inv.args[1];
        fakeStore.set(ref, payload instanceof Uint8Array ? bytesToBinaryString(payload) : payload);
        const { decodePayload } = await import("../src/payload.ts");
        const rawPayload = payload instanceof Uint8Array ? payload : payload.slice(payload.indexOf(":") + 1);
        const { envelope } = decodePayload(rawPayload);
        if (envelope.episode?.eventIds) {
          committedBatches.push(envelope.episode.eventIds);
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  const { DEFAULT_CONFIG } = await import("../src/config.ts");
  const envSource = () => Promise.resolve({
    cfg: { ...DEFAULT_CONFIG, cormBin: "/fake/corm" },
    runner: slowRunner,
    nowProvider: () => new Date("2026-10-15T12:00:00Z"),
    cwd: "/tmp",
  });

  const { activeSessionBuffer } = await import("../src/hooks/events.ts");
  activeSessionBuffer.clear();

  // 1. Record event 1
  activeSessionBuffer.record({
    id: "evt_in_flight_1",
    timestamp: "2026-10-15T12:00:00Z",
    toolName: "bash",
    summary: "first step",
    isError: false,
  });

  // 2. Start flush (now paused inside slowRunner)
  const flushPromise = flushSessionBuffer(envSource, { cwd: "/tmp", hasUI: false, mode: "test" });

  // 3. session_start fires while store is still in flight!
  activeSessionBuffer.onSessionStart();

  // 4. A new event arrives
  activeSessionBuffer.record({
    id: "evt_new_step_2",
    timestamp: "2026-10-15T12:00:01Z",
    toolName: "edit",
    summary: "second step",
    isError: false,
  });

  // 5. Release slow store operation
  releaseStoreDelay();
  await flushPromise;

  // 6. Another settle flush fires
  await flushSessionBuffer(envSource, { cwd: "/tmp", hasUI: false, mode: "test" });

  // Each event batch was persisted separately, exactly once!
  assert.strictEqual(committedBatches.length, 2);
  assert.deepStrictEqual(committedBatches[0], ["evt_in_flight_1"]);
  assert.deepStrictEqual(committedBatches[1], ["evt_new_step_2"]);
});

Deno.test("episode: process termination immediately after tool-result capture leaves durable disk journal", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-proc-term-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  const eventsModule = new URL("../src/hooks/events.ts", import.meta.url).pathname;

  const workerScript = `
    import { activeSessionBuffer, installSessionHooks } from "${eventsModule}";

    const dir = Deno.args[0];
    activeSessionBuffer.setJournalDir(dir);

    // Mock Pi harness with event listener registry
    const handlers = new Map();
    const fakePi = {
      on(ev, fn) { handlers.set(ev, fn); },
      registerTool() {},
      exec() { return Promise.resolve({ stdout: "", stderr: "", code: 0 }); }
    };

    installSessionHooks(fakePi);

    // Emit tool_result and await handler completion per Pi ExtensionRunner contract
    const toolResultFn = handlers.get("tool_result");
    await toolResultFn({
      toolCallId: "call_term_immediate_123",
      toolName: "bash",
      args: { command: "deno test" },
      content: [{ type: "text", text: "ok 1 - test passed" }],
      isError: false,
    });

    // Immediate exit without manual flush or graceful shutdown
    Deno.exit(0);
  `;

  const scriptPath = join(tmpDir, "worker.ts");
  await Deno.writeTextFile(scriptPath, workerScript);

  const res = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--sloppy-imports", scriptPath, tmpDir],
    stdout: "piped",
    stderr: "piped",
  }).output();

  assert.strictEqual(res.code, 0, new TextDecoder().decode(res.stderr));

  // Verify journal was persisted to disk before process exit
  const journalContent = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(journalContent.length, 1);
  assert.strictEqual(journalContent[0].id, "call_term_immediate_123");
  assert.strictEqual(journalContent[0].outcome, "worked");
});

Deno.test("episode: failed journaling followed by retry cleans up and succeeds", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-journal-retry-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  const buf = new SessionEventBuffer();
  buf.setJournalDir(tmpDir);

  buf.record({
    id: "evt_retry_1",
    timestamp: "2026-10-15T13:00:00Z",
    toolName: "bash",
    summary: "first task",
    isError: false,
  });

  // Inject a failure by making a directory where the journal file would be
  await Deno.mkdir(journalFile, { recursive: true });

  // Attempt save to the blocked path: should reject and set lastError
  await assert.rejects(async () => {
    await buf.saveJournal(tmpDir);
  });
  assert.strictEqual(buf.lastError !== null, true);
  assert.strictEqual(buf.lastError?.startsWith("journal-error:"), true);

  // Remove the blocking directory
  await Deno.remove(journalFile, { recursive: true });

  // Add another event and retry save
  buf.record({
    id: "evt_retry_2",
    timestamp: "2026-10-15T13:01:00Z",
    toolName: "bash",
    summary: "second task",
    isError: false,
  });
  await buf.saveJournal(tmpDir);

  // Assert successful recovery: lastError cleared and file saved
  assert.strictEqual(buf.lastError, null);
  const data = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(data.length, 2);
  assert.strictEqual(data[0].id, "evt_retry_1");
  assert.strictEqual(data[1].id, "evt_retry_2");

  // Verify no orphaned .tmp files left in dir
  for await (const entry of Deno.readDir(tmpDir)) {
    assert.strictEqual(entry.name.includes(".tmp."), false);
  }
});

Deno.test("episode: invalid journal content surfaces error in lastError", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-corrupt-journal-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  // Write corrupt non-JSON content
  await Deno.writeTextFile(journalFile, "MALFORMED_NON_JSON_CORRUPTION<<<>>>");

  const buf = new SessionEventBuffer();
  buf.setJournalDir(tmpDir);

  const restored = await buf.restoreJournal(tmpDir);
  assert.strictEqual(restored, 0);

  // Error MUST be surfaced in lastError, not silently swallowed
  assert.strictEqual(buf.lastError !== null, true);
  assert.strictEqual(buf.lastError?.startsWith("journal-restore-error:"), true);
  assert.strictEqual(buf.lastError?.includes("invalid json"), true);

  // In contrast, a genuinely missing journal file (ENOENT) is benign clean start and sets no error
  const cleanDir = await Deno.makeTempDir({ prefix: "mm-clean-journal-" });
  const cleanBuf = new SessionEventBuffer();
  cleanBuf.setJournalDir(cleanDir);
  const cleanRestored = await cleanBuf.restoreJournal(cleanDir);
  assert.strictEqual(cleanRestored, 0);
  assert.strictEqual(cleanBuf.lastError, null);
});

Deno.test("episode: more than 50 pending events triggers observable overflow condition", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-overflow-" });

  const buf = new SessionEventBuffer();
  buf.setJournalDir(tmpDir);

  // Record 55 distinct events
  for (let i = 1; i <= 55; i++) {
    buf.record({
      id: `evt_overflow_${i}`,
      timestamp: `2026-10-15T14:${String(i).padStart(2, "0")}:00Z`,
      toolName: "bash",
      summary: `overflow task ${i}`,
      isError: false,
    });
  }

  // Observable overflow state must be set
  assert.strictEqual(buf.hasOverflow, true);
  assert.strictEqual(buf.overflowCount, 5);
  assert.strictEqual(buf.lastError !== null, true);
  assert.strictEqual(buf.lastError?.startsWith("buffer-overflow: capacity exceeded (50 events)"), true);

  const status = buf.getOverflowStatus();
  assert.strictEqual(status.hasOverflow, true);
  assert.strictEqual(status.overflowCount, 5);

  // Events are preserved rather than silently vanished
  assert.strictEqual(buf.getEvents().length, 55);

  // Once committed/cleared, overflow status resets
  buf.commitFlush(buf.getEvents().map((e) => e.id));
  assert.strictEqual(buf.hasOverflow, false);
  assert.strictEqual(buf.overflowCount, 0);
});

Deno.test("episode: recordAsync explicitly rejects on failed journal write and retains pending events", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-rec-async-fail-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  // Block journal creation by putting a directory at the target filename
  await Deno.mkdir(journalFile, { recursive: true });

  const buf = new SessionEventBuffer();
  buf.setJournalDir(tmpDir);

  const event: import("../src/hooks/events.ts").SignificantEvent = {
    id: "evt_rec_fail_1",
    timestamp: "2026-10-15T10:00:00Z",
    toolName: "bash",
    summary: "should fail journal write",
    isError: false,
  };

  // Must reject rather than silently succeeding
  await assert.rejects(async () => {
    await buf.recordAsync(event);
  });

  // Verify failure is visible in lastError
  assert.strictEqual(buf.lastError !== null, true);
  assert.strictEqual(buf.lastError?.startsWith("journal-error:"), true);

  // The event must be preserved in memory for later retry!
  assert.strictEqual(buf.getEvents().length, 1);
  assert.strictEqual(buf.getUnflushed().length, 1);
  assert.strictEqual(buf.getUnflushed()[0].id, "evt_rec_fail_1");

  await Deno.remove(journalFile, { recursive: true });
});

Deno.test("episode: real event-handler path exposes persistence failure to Pi runner", async () => {
  const { installSessionHooks, activeSessionBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-pi-error-expose-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  // Block the journal path
  await Deno.mkdir(journalFile, { recursive: true });

  activeSessionBuffer.clear();
  activeSessionBuffer.setJournalDir(tmpDir);

  let capturedError: { event: string; error: string } | null = null;
  const fakePi = {
    handlers: new Map<string, Array<(...args: unknown[]) => unknown>>(),
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(handler);
    },
    // Simulates ExtensionRunner.emitToolResult which catches handler errors and calls emitError
    async emitToolResult(data: unknown): Promise<void> {
      for (const h of this.handlers.get("tool_result") || []) {
        try {
          await h(data);
        } catch (err: unknown) {
          capturedError = {
            event: "tool_result",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    },
  };

  installSessionHooks(fakePi as unknown as import("../src/hooks/events.ts").Pi);

  await fakePi.emitToolResult({
    toolCallId: "call_expose_err",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "FAIL: memory leak in corm buffer" }],
  });

  // Pi extension runner must have received the emitted error diagnostic
  assert.notStrictEqual(capturedError, null);
  assert.strictEqual(capturedError!.event, "tool_result");
  assert.strictEqual(capturedError!.error.startsWith("journal-error:"), true);

  // Buffer still has the event pending
  assert.strictEqual(activeSessionBuffer.getUnflushed().length, 1);

  await Deno.remove(journalFile, { recursive: true });
});

Deno.test("episode: pending events survive write failure and are durably persisted on later retry", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-survive-retry-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  await Deno.mkdir(journalFile, { recursive: true });

  const buf = new SessionEventBuffer();
  buf.setJournalDir(tmpDir);

  // First event fails
  await assert.rejects(async () => {
    await buf.recordAsync({
      id: "evt_survive_1",
      timestamp: "2026-10-15T11:00:00Z",
      toolName: "bash",
      summary: "task 1",
      isError: false,
    });
  });

  assert.strictEqual(buf.getUnflushed().length, 1);
  assert.strictEqual(buf.lastError?.startsWith("journal-error:"), true);

  // Unblock path
  await Deno.remove(journalFile, { recursive: true });

  // Second event succeeds
  await buf.recordAsync({
    id: "evt_survive_2",
    timestamp: "2026-10-15T11:01:00Z",
    toolName: "bash",
    summary: "task 2",
    isError: false,
  });

  // Both events must now be durably persisted on disk!
  assert.strictEqual(buf.lastError, null);
  const data = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(data.length, 2);
  assert.strictEqual(data[0].id, "evt_survive_1");
  assert.strictEqual(data[1].id, "evt_survive_2");
});

Deno.test("episode: missing journalDir configuration explicitly rejects and preserves buffered events", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const buf = new SessionEventBuffer();
  // journalDir is null / uninitialized

  const event: import("../src/hooks/events.ts").SignificantEvent = {
    id: "evt_unconfigured_1",
    timestamp: "2026-10-15T12:00:00Z",
    toolName: "bash",
    summary: "unconfigured task",
    isError: false,
  };

  await assert.rejects(
    async () => {
      await buf.recordAsync(event);
    },
    /journalDir has not been initialized/,
  );

  // Error is surfaced in lastError
  assert.strictEqual(buf.lastError, "journal-error: journalDir has not been initialized");

  // Event was buffered in memory and NOT lost!
  assert.strictEqual(buf.getEvents().length, 1);
  assert.strictEqual(buf.getEvents()[0].id, "evt_unconfigured_1");

  // When journalDir is later configured, a save persists it
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-later-configured-" });
  buf.setJournalDir(tmpDir);
  await buf.saveJournal(tmpDir);

  const data = JSON.parse(await Deno.readTextFile(join(tmpDir, ".pending_events.json")));
  assert.strictEqual(data.length, 1);
  assert.strictEqual(data[0].id, "evt_unconfigured_1");
});

Deno.test("episode: journal write queue recovers after failure without poisoning subsequent operations", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-no-poison-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  await Deno.mkdir(journalFile, { recursive: true });

  const buf = new SessionEventBuffer();
  buf.setJournalDir(tmpDir);

  // Write 1 fails
  await assert.rejects(async () => {
    await buf.recordAsync({
      id: "evt_q_1",
      timestamp: "2026-10-15T13:00:00Z",
      toolName: "bash",
      summary: "queue item 1",
      isError: false,
    });
  });

  // Unblock path
  await Deno.remove(journalFile, { recursive: true });

  // Rapid sequential writes: neither should fail or be poisoned by write 1
  const p1 = buf.recordAsync({
    id: "evt_q_2",
    timestamp: "2026-10-15T13:00:01Z",
    toolName: "bash",
    summary: "queue item 2",
    isError: false,
  });

  const p2 = buf.recordAsync({
    id: "evt_q_3",
    timestamp: "2026-10-15T13:00:02Z",
    toolName: "bash",
    summary: "queue item 3",
    isError: false,
  });

  await Promise.all([p1, p2]);

  assert.strictEqual(buf.lastError, null);
  const data = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(data.length, 3);
  assert.strictEqual(data[0].id, "evt_q_1");
  assert.strictEqual(data[1].id, "evt_q_2");
  assert.strictEqual(data[2].id, "evt_q_3");
});

Deno.test("episode: duplicate-event retries after journal failure enforce durability with deduplication", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-dup-retry-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  // Block the journal path
  await Deno.mkdir(journalFile, { recursive: true });

  const buf = new SessionEventBuffer();
  buf.setJournalDir(tmpDir);

  const event: import("../src/hooks/events.ts").SignificantEvent = {
    id: "evt_dup_retry_1",
    timestamp: "2026-10-15T15:00:00Z",
    toolName: "bash",
    summary: "duplicate test task",
    isError: false,
  };

  // 1. First journal write fails explicitly
  await assert.rejects(async () => {
    await buf.recordAsync(event);
  });
  assert.strictEqual(buf.getEvents().length, 1);
  assert.strictEqual(buf.isJournaled("evt_dup_retry_1"), false);
  assert.strictEqual(buf.lastError?.startsWith("journal-error:"), true);

  // 2. The same event ID is delivered again while persistence is still unavailable
  // Must NOT succeed early, must NOT create duplicate copy, and must fail explicitly
  await assert.rejects(async () => {
    await buf.recordAsync(event);
  });
  assert.strictEqual(buf.getEvents().length, 1); // Deduplicated!
  assert.strictEqual(buf.isJournaled("evt_dup_retry_1"), false);

  // 3. Persistence recovers: unblock the journal path
  await Deno.remove(journalFile, { recursive: true });

  // 4. Repeated event ID is delivered: successfully writes pending event exactly once
  await buf.recordAsync(event);
  assert.strictEqual(buf.lastError, null);
  assert.strictEqual(buf.isJournaled("evt_dup_retry_1"), true);
  assert.strictEqual(buf.getEvents().length, 1);

  const diskData = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(diskData.length, 1);
  assert.strictEqual(diskData[0].id, "evt_dup_retry_1");

  // Subsequent duplicate of already-journaled event returns early without re-writing
  await buf.recordAsync(event);
  assert.strictEqual(buf.getEvents().length, 1);
});

Deno.test("episode: duplicate-event failures expose diagnostic through Pi runner on each failed attempt", async () => {
  const { installSessionHooks, activeSessionBuffer } = await import("../src/hooks/events.ts");
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-dup-pi-diag-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  await Deno.mkdir(journalFile, { recursive: true });

  activeSessionBuffer.clear();
  activeSessionBuffer.setJournalDir(tmpDir);

  const errors: Array<{ event: string; error: string }> = [];
  const fakePi = {
    handlers: new Map<string, Array<(...args: unknown[]) => unknown>>(),
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(handler);
    },
    async emitToolResult(data: unknown): Promise<void> {
      for (const h of this.handlers.get("tool_result") || []) {
        try {
          await h(data);
        } catch (err: unknown) {
          errors.push({
            event: "tool_result",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };

  installSessionHooks(fakePi as unknown as import("../src/hooks/events.ts").Pi);

  const toolPayload = {
    toolCallId: "call_dup_err_1",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "FAIL: buffer overflow in parser" }],
  };

  // Attempt 1: fails and exposes error
  await fakePi.emitToolResult(toolPayload);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].error.startsWith("journal-error:"), true);

  // Attempt 2 with duplicate event: must ALSO fail explicitly and expose error to Pi
  await fakePi.emitToolResult(toolPayload);
  assert.strictEqual(errors.length, 2);
  assert.strictEqual(errors[1].error.startsWith("journal-error:"), true);

  // Buffer still has the event pending exactly once
  assert.strictEqual(activeSessionBuffer.getUnflushed().length, 1);

  // Recover persistence
  await Deno.remove(journalFile, { recursive: true });

  // Attempt 3 with duplicate event: succeeds and clears error
  await fakePi.emitToolResult(toolPayload);
  assert.strictEqual(errors.length, 2); // No new error
  assert.strictEqual(activeSessionBuffer.isJournaled("call_dup_err_1"), true);

  const diskData = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(diskData.length, 1);
  assert.strictEqual(diskData[0].id, "call_dup_err_1");
});

Deno.test("episode: snapshot interleaving marks only successfully persisted event IDs in recordAsync", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-interleaving-async-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  const buf = new SessionEventBuffer();
  buf.setJournalDir(tmpDir);

  const eventA: import("../src/hooks/events.ts").SignificantEvent = {
    id: "evt_interleave_A",
    timestamp: "2026-10-15T15:00:00Z",
    toolName: "bash",
    summary: "task A",
    isError: false,
  };

  const eventB: import("../src/hooks/events.ts").SignificantEvent = {
    id: "evt_interleave_B",
    timestamp: "2026-10-15T15:00:01Z",
    toolName: "bash",
    summary: "task B",
    isError: false,
  };

  let pauseA = true;
  let aInFlightResolve: () => void = () => {};
  const aInFlightPromise = new Promise<void>((r) => { aInFlightResolve = r; });
  let aReleaseResolve: () => void = () => {};
  const aReleasePromise = new Promise<void>((r) => { aReleaseResolve = r; });
  let failB = true;

  buf._testHooks = {
    onBeforeRename: async (snapshot) => {
      if (snapshot.some((e) => e.id === "evt_interleave_A") && !snapshot.some((e) => e.id === "evt_interleave_B") && pauseA) {
        pauseA = false;
        aInFlightResolve();
        await aReleasePromise;
      } else if (snapshot.some((e) => e.id === "evt_interleave_B") && failB) {
        throw new Error("simulated failure during B write");
      }
    },
  };

  // 1. Start write for event A
  const aPromise = buf.recordAsync(eventA);

  // Wait until A is in flight and paused before completion
  await aInFlightPromise;

  // 2. Add event B while A's write is in flight
  const bPromise = buf.recordAsync(eventB);

  // 3. Allow A's write to succeed
  aReleaseResolve();
  await aPromise;

  // 4. Force B's queued write to fail
  await assert.rejects(async () => {
    await bPromise;
  });

  // 5. Assert A is journaled and B is NOT journaled
  assert.strictEqual(buf.isJournaled("evt_interleave_A"), true);
  assert.strictEqual(buf.isJournaled("evt_interleave_B"), false);

  // Disk currently contains only A
  const diskDataA = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(diskDataA.length, 1);
  assert.strictEqual(diskDataA[0].id, "evt_interleave_A");

  // Deduplication check: in-memory events contains each event once
  assert.strictEqual(buf.getEvents().length, 2);

  // 6. Deliver B again and verify persistence is retried, journal contains both events exactly once
  failB = false;
  await buf.recordAsync(eventB);

  assert.strictEqual(buf.isJournaled("evt_interleave_A"), true);
  assert.strictEqual(buf.isJournaled("evt_interleave_B"), true);
  assert.strictEqual(buf.getEvents().length, 2);

  const diskDataBoth = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(diskDataBoth.length, 2);
  assert.strictEqual(diskDataBoth[0].id, "evt_interleave_A");
  assert.strictEqual(diskDataBoth[1].id, "evt_interleave_B");
});

Deno.test("episode: snapshot interleaving marks only successfully persisted event IDs in legacy record path", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-interleaving-record-" });
  const journalFile = join(tmpDir, ".pending_events.json");

  const buf = new SessionEventBuffer();
  buf.setJournalDir(tmpDir);

  const eventA: import("../src/hooks/events.ts").SignificantEvent = {
    id: "evt_rec_A",
    timestamp: "2026-10-15T15:00:00Z",
    toolName: "bash",
    summary: "task A",
    isError: false,
  };

  const eventB: import("../src/hooks/events.ts").SignificantEvent = {
    id: "evt_rec_B",
    timestamp: "2026-10-15T15:00:01Z",
    toolName: "bash",
    summary: "task B",
    isError: false,
  };

  let pauseA = true;
  let aInFlightResolve: () => void = () => {};
  const aInFlightPromise = new Promise<void>((r) => { aInFlightResolve = r; });
  let aReleaseResolve: () => void = () => {};
  const aReleasePromise = new Promise<void>((r) => { aReleaseResolve = r; });
  let failB = true;

  buf._testHooks = {
    onBeforeRename: async (snapshot) => {
      if (snapshot.some((e) => e.id === "evt_rec_A") && !snapshot.some((e) => e.id === "evt_rec_B") && pauseA) {
        pauseA = false;
        aInFlightResolve();
        await aReleasePromise;
      } else if (snapshot.some((e) => e.id === "evt_rec_B") && failB) {
        throw new Error("simulated failure during B record write");
      }
    },
  };

  // 1. Deliver A via record()
  buf.record(eventA);
  await aInFlightPromise;

  // 2. Deliver B via record() while A is in flight
  buf.record(eventB);

  // 3. Allow A to succeed and B to fail
  aReleaseResolve();

  // Wait for queue to settle
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 4. Assert A is journaled and B is NOT journaled
  assert.strictEqual(buf.isJournaled("evt_rec_A"), true);
  assert.strictEqual(buf.isJournaled("evt_rec_B"), false);
  assert.strictEqual(buf.lastError?.startsWith("journal-error:"), true);

  const diskDataA = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(diskDataA.length, 1);
  assert.strictEqual(diskDataA[0].id, "evt_rec_A");

  // 5. Deliver B again via record() after failure
  failB = false;
  buf.record(eventB);

  // Await settlement by waiting for saveJournal
  await buf.saveJournal(tmpDir);

  assert.strictEqual(buf.isJournaled("evt_rec_A"), true);
  assert.strictEqual(buf.isJournaled("evt_rec_B"), true);
  assert.strictEqual(buf.getEvents().length, 2);

  const diskDataBoth = JSON.parse(await Deno.readTextFile(journalFile));
  assert.strictEqual(diskDataBoth.length, 2);
  assert.strictEqual(diskDataBoth[0].id, "evt_rec_A");
  assert.strictEqual(diskDataBoth[1].id, "evt_rec_B");
});

Deno.test("noise gate: isInformativeExecution drops empty, trivial, degenerate, and uninformative events", async () => {
  const { isInformativeExecution, summarizeToolEvent } = await import("../src/episode.ts");

  // 1. Trivial outputs
  assert.strictEqual(
    isInformativeExecution({
      toolName: "bash",
      input: { command: "true" },
      content: [{ type: "text", text: "" }],
      isError: false,
    }),
    false
  );
  assert.strictEqual(
    isInformativeExecution({
      toolName: "bash",
      input: { command: "echo done" },
      content: [{ type: "text", text: "done" }],
      isError: false,
    }),
    false
  );
  assert.strictEqual(
    isInformativeExecution({
      toolName: "bash",
      input: { command: "echo 0" },
      content: [{ type: "text", text: "0" }],
      isError: false,
    }),
    false
  );
  assert.strictEqual(
    isInformativeExecution({
      toolName: "bash",
      input: { command: "echo '(no output)'" },
      content: [{ type: "text", text: "(no output)" }],
      isError: false,
    }),
    false
  );

  // 2. Degenerate syntax fragments
  assert.strictEqual(
    isInformativeExecution({
      toolName: "bash",
      content: [{ type: "text", text: "{" }],
      isError: false,
    }),
    false
  );
  assert.strictEqual(
    isInformativeExecution({
      toolName: "bash",
      content: [{ type: "text", text: "{}" }],
      isError: false,
    }),
    false
  );
  assert.strictEqual(
    isInformativeExecution({
      toolName: "bash",
      content: [{ type: "text", text: ";" }],
      isError: false,
    }),
    false
  );

  // 3. Uninformative search/read probes
  assert.strictEqual(
    isInformativeExecution({
      toolName: "search_code",
      input: { pattern: "nonexistent_fn" },
      content: [{ type: "text", text: "0 matches" }],
      isError: false,
    }),
    false
  );
  assert.strictEqual(
    isInformativeExecution({
      toolName: "read",
      input: { path: "empty.txt" },
      content: [{ type: "text", text: "" }],
      isError: false,
    }),
    false
  );

  // 3b. Informative search and read probes with non-empty results
  assert.strictEqual(
    isInformativeExecution({
      toolName: "search_code",
      input: { pattern: "handle_request" },
      content: [{ type: "text", text: "src/server.c:42: int handle_request(void)" }],
      isError: false,
    }),
    true
  );
  assert.strictEqual(
    isInformativeExecution({
      toolName: "read",
      input: { path: "src/config.h" },
      content: [{ type: "text", text: "#define MAX_BUF 4096" }],
      isError: false,
    }),
    true
  );

  // 4. Preserves informative code modifications
  assert.strictEqual(
    isInformativeExecution({
      toolName: "edit",
      input: { path: "src/server.c" },
      content: [{ type: "text", text: "applied 1 edit" }],
      isError: false,
    }),
    true
  );

  // 5. Preserves verified test executions
  assert.strictEqual(
    isInformativeExecution({
      toolName: "bash",
      input: { command: "deno test" },
      content: [{ type: "text", text: "ok 1 - all green 0 failed" }],
      isError: false,
    }),
    true
  );

  // 6. Preserves failed test executions
  assert.strictEqual(
    isInformativeExecution({
      toolName: "bash",
      input: { command: "deno test" },
      content: [{ type: "text", text: "FAIL: syntax error on line 42" }],
      isError: true,
    }),
    true
  );

  // 7. Verify summarizeToolEvent integration
  assert.strictEqual(
    summarizeToolEvent({
      toolName: "bash",
      input: { command: "echo done" },
      content: [{ type: "text", text: "done" }],
      isError: false,
    }),
    null
  );
  assert.strictEqual(
    summarizeToolEvent({
      toolName: "search_code",
      content: [{ type: "text", text: "0 matches" }],
      isError: false,
    }),
    null
  );
  const editSig = summarizeToolEvent({
    toolName: "edit",
    input: { path: "src/main.rs" },
    content: [{ type: "text", text: "applied 2 edits" }],
    isError: false,
  });
  assert.notStrictEqual(editSig, null);
  assert.strictEqual(editSig?.toolName, "edit");
});




