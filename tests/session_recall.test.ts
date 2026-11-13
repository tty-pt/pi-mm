import { strict as assert } from "node:assert";
import { SessionStore } from "../src/session/store.ts";
import { SessionLineageTracker } from "../src/session/lineage.ts";
import {
  SessionRecallEngine,
  formatSessionCards,
  formatSessionZoom,
  formatUnifiedRecallOutput,
} from "../src/session/recall.ts";

Deno.test("SessionRecallEngine: progressive search returns narrative summary cards", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-recall-test-" });
  try {
    const store = new SessionStore({ sessionId: "sess-rec-1", sessionDir: tmpDir });
    const tracker = new SessionLineageTracker();
    const engine = new SessionRecallEngine(store, tracker);

    // Turn 1: user asks question
    tracker.addEntry("e1");
    await store.appendEvent({
      id: "ev1",
      turnIndex: 1,
      entryId: "e1",
      timestamp: new Date().toISOString(),
      role: "user",
      speaker: "User",
      summary: "Can you fix the shoreline bathymetry shader?",
      text: "Can you fix the shoreline bathymetry shader?",
    });

    // Turn 2: tool execution failure
    tracker.addEntry("e2", "e1");
    await store.appendEvent({
      id: "ev2",
      turnIndex: 2,
      entryId: "e2",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "bash",
      summary: "bash `make test-mod MOD=seven`: FAILED with boundary error",
      text: "Compiling mods/seven/ux/shore.c\nBoundary violation: illegal include <axil/http.h>\nmake: *** [test] Error 1",
      toolName: "bash",
      exitCode: 1,
      errorSnippet: "Boundary violation: illegal include <axil/http.h>",
      filesTouched: ["mods/seven/ux/shore.c"],
    });

    // Query for "boundary violation"
    const result = await engine.search({ query: "boundary violation" });
    assert.equal(result.cards.length, 1);
    assert.equal(result.cards[0].turnIndex, 2);
    assert.equal(result.cards[0].toolName, "bash");
    assert.equal(result.cards[0].exitCode, 1);
    assert.ok(result.cards[0].errorSnippet?.includes("Boundary violation"));

    // Check formatted text
    const textOutput = formatUnifiedRecallOutput(result, "boundary violation");
    assert.ok(textOutput.includes("=== Ephemeral Session Results (1 match in active lineage) ==="));
    assert.ok(textOutput.includes("FAILED (Exit 1)"));
    assert.ok(textOutput.includes("Boundary violation: illegal include <axil/http.h>"));
    assert.ok(textOutput.includes("zoomTurn: 2"));
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionRecallEngine: line-level zoom slices exact lines without guessing offsets", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-recall-zoom-" });
  try {
    const store = new SessionStore({ sessionId: "sess-rec-zoom", sessionDir: tmpDir });
    const tracker = new SessionLineageTracker();
    const engine = new SessionRecallEngine(store, tracker);

    const fullLog = [
      "Starting boundary check...",
      "Checking include rules for isomorphic UX...",
      "mods/seven/ux/shore.c:14: error: invalid include <axil/http.h>",
      "Forbidden in isomorphic code: axil_* symbols",
      "Check complete: 1 violation found.",
    ].join("\n");

    tracker.addEntry("e1");
    await store.appendEvent({
      id: "ev-tool",
      turnIndex: 5,
      entryId: "e1",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "bash",
      summary: "bash `sh scripts/check-module-boundaries.sh`",
      text: fullLog,
      toolName: "bash",
      exitCode: 1,
    });

    // Zoom into turn 5, lines 3-4
    const zoomResult = await engine.search({
      query: "",
      zoomTurn: 5,
      lineRange: [3, 4],
    });

    assert.ok(zoomResult.zoom);
    assert.equal(zoomResult.zoom.turnIndex, 5);
    assert.equal(zoomResult.zoom.startLine, 3);
    assert.equal(zoomResult.zoom.endLine, 4);
    assert.equal(zoomResult.zoom.lines.length, 2);
    assert.equal(zoomResult.zoom.lines[0].text, "mods/seven/ux/shore.c:14: error: invalid include <axil/http.h>");
    assert.equal(zoomResult.zoom.lines[1].text, "Forbidden in isomorphic code: axil_* symbols");

    const formatted = formatUnifiedRecallOutput(zoomResult);
    assert.ok(formatted.includes("=== Turn 5 · Tool: bash (Lines 3-4 of 5) ==="));
    assert.ok(formatted.includes("3 | mods/seven/ux/shore.c:14: error: invalid include <axil/http.h>"));
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionRecallEngine: lineage filtering excludes abandoned branches by default", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-recall-lineage-" });
  try {
    const store = new SessionStore({ sessionId: "sess-rec-lin", sessionDir: tmpDir });
    const tracker = new SessionLineageTracker();
    const engine = new SessionRecallEngine(store, tracker);

    // Root
    tracker.addEntry("root");
    await store.appendEvent({
      id: "r1",
      turnIndex: 1,
      entryId: "root",
      timestamp: new Date().toISOString(),
      role: "user",
      speaker: "User",
      summary: "Initial setup",
      text: "Initial setup",
    });

    // Abandoned branch: root -> abandoned
    tracker.addEntry("abandoned", "root");
    await store.appendEvent({
      id: "ab1",
      turnIndex: 2,
      entryId: "abandoned",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "bash",
      summary: "Tried deprecated OpenGL approach: failed",
      text: "Tried deprecated OpenGL approach: failed",
    });

    // Active fork: root -> activeLeaf
    tracker.addEntry("activeLeaf", "root");
    await store.appendEvent({
      id: "act1",
      turnIndex: 3,
      entryId: "activeLeaf",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "bash",
      summary: "Used pure-C CPU rasterizer approach: success",
      text: "Used pure-C CPU rasterizer approach: success",
    });

    // Default search (leafId = activeLeaf)
    const activeRes = await engine.search({ query: "approach", leafId: "activeLeaf", lineage: "active" });
    assert.equal(activeRes.cards.length, 1);
    assert.equal(activeRes.cards[0].turnIndex, 3);
    assert.ok(activeRes.cards[0].summary.includes("pure-C CPU rasterizer"));

    // All lineage search includes abandoned branch
    const allRes = await engine.search({ query: "approach", leafId: "activeLeaf", lineage: "all" });
    assert.equal(allRes.cards.length, 2);
    assert.ok(allRes.cards.some((c) => c.turnIndex === 2));
    assert.ok(allRes.cards.some((c) => c.turnIndex === 3));
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionRecallEngine: rehydrates from events.json and sessionManager branch after navigation or restart", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-recall-rehydrate-" });
  try {
    // 1. First store instance writes events to events.json
    const store1 = new SessionStore({ sessionId: "sess-rehydrate", sessionDir: tmpDir });
    await store1.appendEvent({
      id: "ev-persisted-1",
      turnIndex: 1,
      entryId: "branch-node-1",
      timestamp: new Date().toISOString(),
      role: "user",
      speaker: "User",
      summary: "Can we optimize the CodeStore incremental indexing?",
      text: "Can we optimize the CodeStore incremental indexing?",
    });

    // 2. Fresh store instance on same sessionDir automatically loads events.json
    const store2 = new SessionStore({ sessionId: "sess-rehydrate", sessionDir: tmpDir });
    const tracker2 = new SessionLineageTracker();
    const engine2 = new SessionRecallEngine(store2, tracker2);

    assert.equal(store2.getEventCount(), 1);

    // 3. Simulate navigating to a branch point where sessionManager also has an assistant question turn
    const mockSessionManager = {
      getBranch: () => [
        {
          id: "branch-node-1",
          type: "message",
          message: { role: "user", content: "Can we optimize the CodeStore incremental indexing?" },
        },
        {
          id: "branch-node-2",
          parentId: "branch-node-1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Would you like me to wire the cormd daemon socket into CodeStore as well?" }],
          },
        },
      ],
      getLeafId: () => "branch-node-2",
    };

    // Overview recall (empty query) on navigated session should return both turns instead of "No session events recorded."
    const overviewRes = await engine2.search({ query: "", limit: 5 }, mockSessionManager);
    assert.equal(overviewRes.cards.length, 2);
    assert.ok(overviewRes.cards.some((c) => c.speaker === "Assistant" && c.summary.includes("cormd daemon socket")));
    assert.ok(overviewRes.cards.some((c) => c.speaker === "User" && c.summary.includes("CodeStore incremental indexing")));
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionRecallEngine: deduplicates live SessionSink events against hydrateFromSessionManager and emits toolIndex for multi-tool turns", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "session-recall-dedup-" });
  try {
    const store = new SessionStore({ sessionId: "sess-dedup", sessionDir: tmpDir });
    const tracker = new SessionLineageTracker();
    const { SessionSink } = await import("../src/session/sink.ts");
    const sink = new SessionSink(store, tracker);
    const engine = new SessionRecallEngine(store, tracker);

    sink.setTurn(1);
    await sink.recordUserPrompt("Check git status and read AGENTS.md");
    await sink.recordToolResult({
      toolCallId: "tc-bash-1",
      toolName: "bash",
      input: { command: "git status -s" },
      content: [{ type: "text", text: "M src/session/store.ts" }],
    });
    await sink.recordToolResult({
      toolCallId: "tc-read-2",
      toolName: "read",
      input: { path: "AGENTS.md" },
      content: [{ type: "text", text: "# AGENTS.md — package guidelines\nDegradation never error." }],
    });
    await sink.recordAssistantResponse("Checked status and AGENTS.md.");

    // Now simulate sessionManager having UUID entries for those exact same messages
    const mockSessionManager = {
      getBranch: () => [
        {
          id: "uuid-user-1",
          type: "message",
          message: { role: "user", content: "Check git status and read AGENTS.md" },
        },
        {
          id: "uuid-tool-1",
          parentId: "uuid-user-1",
          type: "message",
          message: { role: "toolResult", toolName: "bash", toolCallId: "tc-bash-1", content: "M src/session/store.ts" },
        },
        {
          id: "uuid-tool-2",
          parentId: "uuid-tool-1",
          type: "message",
          message: { role: "toolResult", toolName: "read", toolCallId: "tc-read-2", content: "# AGENTS.md — package guidelines\nDegradation never error." },
        },
        {
          id: "uuid-asst-1",
          parentId: "uuid-tool-2",
          type: "message",
          message: { role: "assistant", content: "Checked status and AGENTS.md." },
        },
      ],
      getLeafId: () => "uuid-asst-1",
    };

    const res = await engine.search({ query: "AGENTS.md", limit: 5 }, mockSessionManager);
    // Should NOT duplicate into a Turn 2
    assert.equal(store.getEventCount(), 4);
    assert.ok(res.cards.every((c) => c.turnIndex === 1));

    const readCard = res.cards.find((c) => c.toolName === "read");
    assert.ok(readCard);
    assert.equal(readCard.exitCode, 0);
    assert.equal(readCard.toolIndex, 2);

    const rendered = formatUnifiedRecallOutput(res, "AGENTS.md");
    assert.ok(rendered.includes("toolIndex: 2"));

    // Zooming with toolIndex: 2 returns the read output, not the first bash tool
    const zoomRead = await engine.search({ query: "", zoomTurn: 1, toolIndex: 2, lineRange: [1, 2] }, mockSessionManager);
    assert.ok(zoomRead.zoom);
    assert.equal(zoomRead.zoom.toolName, "read");
    assert.ok(zoomRead.zoom.rawContent.includes("# AGENTS.md — package guidelines"));

    // Zooming without toolIndex returns the full Turn 1 transcript (User + Tools + Assistant)
    const zoomTurnFull = await engine.search({ query: "", zoomTurn: 1 }, mockSessionManager);
    assert.ok(zoomTurnFull.zoom);
    assert.ok(zoomTurnFull.zoom.rawContent.includes("[Turn 1 · User]"));
    assert.ok(zoomTurnFull.zoom.rawContent.includes("Check git status and read AGENTS.md"));
    assert.ok(zoomTurnFull.zoom.rawContent.includes("[Turn 1 · Tool (toolIndex: 1): bash"));
    assert.ok(zoomTurnFull.zoom.rawContent.includes("[Turn 1 · Tool (toolIndex: 2): read"));
    assert.ok(zoomTurnFull.zoom.rawContent.includes("[Turn 1 · Assistant]"));
    assert.ok(zoomTurnFull.zoom.rawContent.includes("Checked status and AGENTS.md."));
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

