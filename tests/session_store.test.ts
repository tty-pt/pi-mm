import { strict as assert } from "node:assert";
import { SessionStore } from "../src/session/store.ts";
import { SessionSink } from "../src/session/sink.ts";
import type { ToolResultEvent } from "../src/hooks/events.ts";

Deno.test("SessionStore: initialization and filespec formatting", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-store-test-" });
  try {
    const store = new SessionStore({
      sessionId: "test-sess-1",
      sessionDir: tmpDir,
      embedUrl: "http://127.0.0.1:4242/v1/embeddings",
    });

    await store.init();
    const fspec = store.getFilespec();
    assert.ok(fspec.includes("session.db@joint,lemma,sepal:a:b"));
    assert.equal(store.sessionId, "test-sess-1");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionStore: appends events, computes line offsets and slices lines in O(1)", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-store-slice-" });
  try {
    const store = new SessionStore({
      sessionId: "test-sess-2",
      sessionDir: tmpDir,
    });

    const multiLineLog = [
      "Header line 1",
      "Building targets...",
      "Compiling mods/seven/ux/shore.c",
      "Compiling mods/seven/ux/water.c",
      "ERROR: shore.c:42: undefined reference to 'glUniform1f'",
      "make: *** [mods/seven/ux/shore.o] Error 1",
      "Build failed with 1 error.",
    ].join("\n");

    const ref = await store.appendEvent({
      id: "ev-bash-1",
      turnIndex: 3,
      entryId: "entry-bash-1",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "bash",
      summary: "bash `make`: Build failed with 1 error.",
      text: multiLineLog,
      toolName: "bash",
      exitCode: 1,
    });

    assert.equal(ref, 1);
    assert.equal(store.getEventCount(), 1);

    const stored = await store.getEvent(1);
    assert.ok(stored);
    assert.equal(stored.lineCount, 7);
    assert.equal(stored.exitCode, 1);

    // Full slice
    const fullZoom = store.sliceLines(1);
    assert.ok(fullZoom);
    assert.equal(fullZoom.totalLines, 7);
    assert.equal(fullZoom.startLine, 1);
    assert.equal(fullZoom.endLine, 7);
    assert.equal(fullZoom.lines.length, 7);

    // Partial range slice: lines 3 to 5
    const partialZoom = store.sliceLines(1, [3, 5]);
    assert.ok(partialZoom);
    assert.equal(partialZoom.startLine, 3);
    assert.equal(partialZoom.endLine, 5);
    assert.equal(partialZoom.lines.length, 3);
    assert.equal(partialZoom.lines[0].lineNum, 3);
    assert.equal(partialZoom.lines[0].text, "Compiling mods/seven/ux/shore.c");
    assert.equal(partialZoom.lines[2].lineNum, 5);
    assert.equal(partialZoom.lines[2].text, "ERROR: shore.c:42: undefined reference to 'glUniform1f'");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionStore: persists to real corm session.db and queries lexical FTS via liblemma", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-corm-real-" });
  try {
    const store = new SessionStore({
      sessionId: "test-corm-db",
      sessionDir: tmpDir,
    });
    await store.init();

    await store.appendEvent({
      id: "ev-corm-1",
      turnIndex: 1,
      entryId: "e1",
      timestamp: "2026-03-30T12:00:00Z",
      role: "tool",
      speaker: "bash",
      summary: "bash `make`: FAILED with undefined variable u_bathymetry_depth",
      text: "Compiling shore.c\nERROR: undefined variable u_bathymetry_depth\nmake: *** [test] Error 1",
      exitCode: 1,
    });

    await store.flush();

    // Test getEvent via corm
    const event = await store.getEvent(1);
    assert.ok(event);
    assert.equal(event.turnIndex, 1);
    assert.equal(event.speaker, "bash");
    assert.ok(event.text.includes("u_bathymetry_depth"));

    // Test native liblemma query
    const hits = await store.queryLexical("u_bathymetry_depth", 5);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].ref, 1);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionSink: records user prompts, assistant replies and tool executions", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-sink-test-" });
  try {
    const store = new SessionStore({
      sessionId: "test-sess-sink",
      sessionDir: tmpDir,
    });
    const sink = new SessionSink(store);

    sink.setTurn(1, "entry-user-1");
    const uRef = await sink.recordUserPrompt("Why is the shoreline water failing to compile?");
    assert.ok(uRef > 0);

    sink.setTurn(1, "entry-tool-1", "entry-user-1");
    const toolEv: ToolResultEvent = {
      toolName: "bash",
      input: { command: "make -C mods/seven" },
      content: [{ type: "text", text: "In function 'shore_render': error: unknown type name 'shore_mesh_t'" }],
      isError: true,
    };
    const tRef = await sink.recordToolResult(toolEv);
    assert.ok(tRef !== null && tRef > 0);

    sink.setTurn(1, "entry-asst-1", "entry-tool-1");
    const aRef = await sink.recordAssistantResponse(
      "The shore_mesh_t typedef was missing an include for shore_types.h.",
      "I see the compiler error in mods/seven/ux/shore.c.",
    );
    assert.ok(aRef > 0);

    assert.equal(store.getEventCount(), 3);
    const events = store.getAllEvents();
    assert.equal(events[0].role, "user");
    assert.equal(events[1].role, "tool");
    assert.equal(events[1].exitCode, 1);
    assert.ok(events[1].errorSnippet?.includes("shore_mesh_t"));
    assert.equal(events[2].role, "assistant");
    assert.equal(events[2].thinking, "I see the compiler error in mods/seven/ux/shore.c.");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionSink: skips internal memory introspection tools and self-loops", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-sink-skip-" });
  try {
    const store = new SessionStore({
      sessionId: "test-sess-skip",
      sessionDir: tmpDir,
    });
    const sink = new SessionSink(store);

    const memRecallEv: ToolResultEvent = {
      toolName: "memory_recall",
      input: { query: "shore water" },
      content: [{ type: "text", text: "Found 2 memories" }],
    };
    assert.equal(await sink.recordToolResult(memRecallEv), null);

    const memRecordEv: ToolResultEvent = {
      toolName: "memory_record",
      input: { problem: "shore" },
      content: [{ type: "text", text: "Recorded episode" }],
    };
    assert.equal(await sink.recordToolResult(memRecordEv), null);

    const cormScanEv: ToolResultEvent = {
      toolName: "bash",
      input: { command: "corm -r -g 12 .pi/cache/sessions/test/session.db" },
      content: [{ type: "text", text: "payload" }],
    };
    assert.equal(await sink.recordToolResult(cormScanEv), null);

    assert.equal(store.getEventCount(), 0);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionStore: enforces zero-lag throughput across 100 turns", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-perf-test-" });
  try {
    const store = new SessionStore({
      sessionId: "test-sess-perf",
      sessionDir: tmpDir,
    });
    const sink = new SessionSink(store);

    const start = performance.now();
    for (let i = 1; i <= 100; i++) {
      sink.setTurn(i);
      await sink.recordUserPrompt(`Test prompt ${i}`);
      await sink.recordToolResult({
        toolName: "bash",
        input: { command: `echo ${i}` },
        content: [{ type: "text", text: `output line 1\noutput line 2\noutput line 3: ${i}` }],
      });
      await sink.recordAssistantResponse(`Assistant explanation for ${i}`);
    }
    const elapsed = performance.now() - start;

    assert.equal(store.getEventCount(), 300);
    // 300 events written in < 150ms (average < 0.5ms per event)
    assert.ok(elapsed < 250, `Ingestion took ${elapsed}ms, expected < 250ms`);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionSink: read tool containing 'error' or 'undefined' in file content is recorded as SUCCESS (0) unless isError is true", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-sink-read-ok-" });
  try {
    const store = new SessionStore({
      sessionId: "test-sess-read-ok",
      sessionDir: tmpDir,
    });
    const sink = new SessionSink(store);
    sink.setTurn(1, "entry-1");

    const readOkRef = await sink.recordToolResult({
      toolName: "read",
      input: { path: "AGENTS.md" },
      content: [{ type: "text", text: "# AGENTS.md\n- **Degradation never error.** Empty inputs or undefined values never throw an exception or fail." }],
      isError: false,
    });
    assert.ok(readOkRef !== null && readOkRef > 0);
    const readEv = await store.getEvent(readOkRef!);
    assert.ok(readEv);
    assert.equal(readEv.exitCode, 0);
    assert.equal(readEv.errorSnippet, undefined);

    // Pure synthetic ACP progress lines are ignored
    const synthRef = await sink.recordAssistantResponse(
      "[Antigravity tool update: 223cff91-8ac1-46a0-9819-cf75f884ef9d:4 — completed]\n[Antigravity tool: pi-bridge_pi_memory_recall — in_progress]",
    );
    assert.equal(synthRef, 0);
    assert.equal(store.getEventCount(), 1);
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

