import { strict as assert } from "node:assert";
import { buildMipmapCompaction, type BranchEntryLike } from "../src/session/compaction.ts";
import { SessionStore } from "../src/session/store.ts";

Deno.test("MipmapCompaction: cuts context before last user turn and produces structured mipmap summary", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "compaction-test-" });
  try {
    const store = new SessionStore({ sessionId: "sess-compact-1", sessionDir: tmpDir });

    // Store historical tool and user events
    await store.appendEvent({
      id: "ev1",
      turnIndex: 1,
      entryId: "e1",
      timestamp: new Date().toISOString(),
      role: "user",
      speaker: "User",
      summary: "Refactor NeverDark seven shoreline rendering",
      text: "Refactor NeverDark seven shoreline rendering",
    });

    await store.appendEvent({
      id: "ev2",
      turnIndex: 2,
      entryId: "e2",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "edit",
      summary: "edit mods/seven/ux/shore.c",
      text: "Replaced 1 block",
      filesTouched: ["mods/seven/ux/shore.c"],
    });

    await store.appendEvent({
      id: "ev3",
      turnIndex: 2,
      entryId: "e3",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "bash",
      summary: "bash `make test-mod MOD=seven`: FAILED",
      text: "In function 'shore_calc': error: unknown type name",
      errorSnippet: "error: unknown type name",
      exitCode: 1,
    });

    const branchEntries: BranchEntryLike[] = [
      { id: "e1", type: "message", message: { role: "user", content: "Refactor NeverDark seven shoreline rendering" } },
      { id: "e2", type: "message", message: { role: "assistant", content: "I will edit the shore files." } },
      { id: "e3", type: "message", message: { role: "toolResult", content: "Error in shore_calc" } },
      { id: "e4", type: "message", message: { role: "assistant", content: "Fixing header include." } },
      // Last kept turn:
      { id: "e5", type: "message", message: { role: "user", content: "Now check if the tests pass." } },
    ];

    const directives = [
      "Don't use conditionals for 3D; always use the body of the if.",
      "Minimize and eliminate regex usage across the system.",
    ];

    const res = buildMipmapCompaction({
      branchEntries,
      sessionStore: store,
      directives,
      tokensBefore: 4500,
    });

    assert.ok(res !== null);
    assert.equal(res.firstKeptEntryId, "e5");
    assert.equal(res.summarizedCount, 4);
    assert.equal(res.keptCount, 1);
    assert.ok(res.reductionPct > 70);

    // Verify sections in summary
    assert.ok(res.summary.includes("[Session Goal]"));
    assert.ok(res.summary.includes("Refactor NeverDark seven shoreline rendering"));
    assert.ok(res.summary.includes("[Active Project Invariants & Directives]"));
    assert.ok(res.summary.includes("Don't use conditionals for 3D"));
    assert.ok(res.summary.includes("[Files And Touched Assets]"));
    assert.ok(res.summary.includes("mods/seven/ux/shore.c"));
    assert.ok(res.summary.includes("[Key Diagnostic Signals]"));
    assert.ok(res.summary.includes("error: unknown type name"));
    assert.ok(res.summary.includes("[Recent Conversational Thread]"));
    assert.ok(res.summary.includes("Turn 1 (User): \"Refactor NeverDark seven shoreline rendering\""));
    assert.ok(res.summary.includes("I will edit the shore files."));
    assert.ok(res.summary.includes("[Last Assistant Message Before Compaction (Turn 1)]"));
    assert.ok(res.summary.includes("💡 Hint: To recall the full verbatim interactions right before compaction"));
    assert.ok(res.summary.includes("memory_recall({ scope: \"session\", session: \"current\", zoomTurn: 1 })"));
    assert.ok(res.summary.includes("[Ephemeral Session Memory Anchor]"));
    assert.ok(res.summary.includes("memory_recall({ query: \"<topic>\", scope: \"session\" })"));
    assert.ok(res.summary.includes("memory_recall({ scope: \"session\", zoomTurn: <turn> })"));
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("MipmapCompaction: returns null on trivial or insufficient message branches", () => {
  const store = new SessionStore({ sessionId: "sess-trivial" });
  const res = buildMipmapCompaction({
    branchEntries: [
      { id: "1", type: "message", message: { role: "user", content: "hi" } },
    ],
    sessionStore: store,
  });
  assert.equal(res, null);
});

Deno.test("MipmapCompaction & Post-Compaction Hook: preserves last few User+Assistant interactions, last message, and recall hint after compaction", async () => {
  const { buildRecentInteractionsBlock } = await import("../src/session/compaction.ts");
  const { installSessionHooks } = await import("../src/hooks/events.ts");
  const { getSessionInstances, clearAllSessionInstances } = await import("../src/session/manager.ts");
  const { DEFAULT_CONFIG } = await import("../src/config.ts");

  clearAllSessionInstances();
  const sessionId = "sess-post-compact-continuity";
  const inst = getSessionInstances(sessionId);

  await inst.store.appendEvent({
    id: "u1",
    turnIndex: 1,
    entryId: "e1",
    timestamp: new Date().toISOString(),
    role: "user",
    speaker: "User",
    summary: "Investigate why cross-session recall confuses past sessions with the current one.",
    text: "Investigate why cross-session recall confuses past sessions with the current one.",
  });
  await inst.store.appendEvent({
    id: "a1",
    turnIndex: 1,
    entryId: "e2",
    timestamp: new Date().toISOString(),
    role: "assistant",
    speaker: "Assistant",
    summary: "Found that auto_recall and session cards lacked [Past Session] vs [Current Session] tags.",
    text: "Found that auto_recall and session cards lacked [Past Session] vs [Current Session] tags.",
  });
  await inst.store.appendEvent({
    id: "u2",
    turnIndex: 2,
    entryId: "e3",
    timestamp: new Date().toISOString(),
    role: "user",
    speaker: "User",
    summary: "Also make sure we can easily recall the last few interactions before compaction.",
    text: "Also make sure we can easily recall the last few interactions before compaction.",
  });
  await inst.store.appendEvent({
    id: "a2",
    turnIndex: 2,
    entryId: "e4",
    timestamp: new Date().toISOString(),
    role: "assistant",
    speaker: "Assistant",
    summary: "I will add the pre-compaction interaction thread and a zoomTurn recall hint right next to the last message.",
    text: "I will add the pre-compaction interaction thread and a zoomTurn recall hint right next to the last message.",
  });

  // 1. Direct unit test of buildRecentInteractionsBlock in postCompaction mode
  const block = buildRecentInteractionsBlock({
    sessionStore: inst.store,
    currentPrompt: "Continue with the implementation",
    maxTurns: 3,
    postCompaction: true,
  });
  assert.ok(block);
  assert.ok(block.includes("[Post-Compaction Session Continuity — Current Session (Turns 1–2)]"));
  assert.ok(block.includes("Turn 1 (User): \"Investigate why cross-session recall confuses past sessions"));
  assert.ok(block.includes("Turn 1 (Assistant): \"Found that auto_recall and session cards lacked"));
  assert.ok(block.includes("Turn 2 (User): \"Also make sure we can easily recall the last few interactions"));
  assert.ok(block.includes("Turn 2 (Assistant): \"I will add the pre-compaction interaction thread"));
  assert.ok(block.includes("Last Assistant Message (Turn 2): \"I will add the pre-compaction interaction thread"));
  assert.ok(block.includes("💡 Hint — Recalling Pre-Compaction Interactions in This Session:"));
  assert.ok(block.includes("memory_recall({ scope: \"session\", session: \"current\", zoomTurn: 2 })"));

  // 2. Hook integration test: session_compact -> next before_agent_start injects post-compaction block
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const fakePi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    registerTool() {},
    exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
  };

  installSessionHooks(fakePi, () =>
    Promise.resolve({
      cwd: "/tmp/fake-cwd",
      runner: { run: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }) },
      nowProvider: () => new Date(),
      cfg: { ...DEFAULT_CONFIG, cormBin: "/usr/bin/corm", overviewEmbed: "off", recallEmbed: "off" },
    })
  );

  // Trigger session_compact
  const compactHandler = handlers.get("session_compact");
  assert.ok(compactHandler, "session_compact handler must be registered");
  await compactHandler({});

  // Trigger next before_agent_start
  const beforeStartHandler = handlers.get("before_agent_start");
  assert.ok(beforeStartHandler);
  const startEvent = {
    messageType: "user" as const,
    prompt: "Proceed with the next step.",
    systemPromptOptions: { sections: {} as Record<string, string | null> },
  };
  await beforeStartHandler(startEvent, {
    cwd: "/tmp/fake-cwd",
    hasUI: false,
    mode: "headless",
    sessionId,
  });

  const injectedMemoryCtx = startEvent.systemPromptOptions.sections["memory_context"] || "";
  assert.ok(
    injectedMemoryCtx.includes("[Post-Compaction Session Continuity — Current Session (Turns 1–2)]"),
    "First turn after compaction must automatically inject recent interactions from current session",
  );
  assert.ok(
    injectedMemoryCtx.includes("Last Assistant Message (Turn 2):"),
    "First turn after compaction must highlight the last assistant message",
  );
  assert.ok(
    injectedMemoryCtx.includes("memory_recall({ scope: \"session\", session: \"current\", zoomTurn: 2 })"),
    "First turn after compaction must include the recall hint for pre-compaction turns",
  );
  clearAllSessionInstances();
});
