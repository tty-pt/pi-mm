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

Deno.test("MipmapCompaction: stores L2 compaction epochs across multiple compactions, supports modelSummarizer, and filters [Thinking] stubs", async () => {
  const { buildMipmapCompactionAsync, buildRecentInteractionsBlock } = await import("../src/session/compaction.ts");
  const { SessionLineageTracker } = await import("../src/session/lineage.ts");
  const { SessionRecallEngine, formatSessionCards } = await import("../src/session/recall.ts");

  const tmpDir = Deno.makeTempDirSync({ prefix: "compaction-mipmap-l2-" });
  try {
    const store = new SessionStore({ sessionId: "sess-mipmap-multi", sessionDir: tmpDir });
    const tracker = new SessionLineageTracker();
    const engine = new SessionRecallEngine(store, tracker);

    // Populate Epoch 1 (Turns 1..3), including a [Thinking] stub after a real assistant response in Turn 2
    for (const [t, u, a] of [
      [1, "Design a multi-level mipmap for session compactions", "We should store each compacted epoch at L2 in SessionStore."],
      [2, "What happens when a turn has a [Thinking] tool step?", "Substantive assistant text must never be overwritten by [Thinking] stubs."],
      [3, "Now wire the model summarizer into before_compact", "Calling ctx.modelRegistry.complete(ctx.model, ...) produces the L2 epoch summary."],
    ] as const) {
      await store.appendEvent({
        id: `u-${t}`,
        turnIndex: t,
        entryId: `eu-${t}`,
        timestamp: new Date().toISOString(),
        role: "user",
        speaker: "User",
        summary: u,
        text: u,
      });
      await store.appendEvent({
        id: `a-${t}`,
        turnIndex: t,
        entryId: `ea-${t}`,
        timestamp: new Date().toISOString(),
        role: "assistant",
        speaker: "Assistant",
        summary: a,
        text: a,
      });
      if (t === 2) {
        // Append trailing [Thinking] stub in the same turn to verify it does not overwrite `a-2`
        await store.appendEvent({
          id: `a-${t}-thinking`,
          turnIndex: t,
          entryId: `ea-${t}-thinking`,
          timestamp: new Date().toISOString(),
          role: "assistant",
          speaker: "Assistant",
          summary: "[Thinking] Inspecting files...",
          text: "[Thinking] Inspecting files...",
        });
      }
    }

    const branch1: BranchEntryLike[] = [
      { id: "eu-1", type: "message", message: { role: "user", content: "Design a multi-level mipmap for session compactions" } },
      { id: "ea-1", type: "message", message: { role: "assistant", content: "We should store each compacted epoch at L2 in SessionStore." } },
      { id: "eu-2", type: "message", message: { role: "user", content: "What happens when a turn has a [Thinking] tool step?" } },
      { id: "ea-2", type: "message", message: { role: "assistant", content: "Substantive assistant text must never be overwritten by [Thinking] stubs." } },
      { id: "eu-3", type: "message", message: { role: "user", content: "Now wire the model summarizer into before_compact" } },
      { id: "ea-3", type: "message", message: { role: "assistant", content: "Calling ctx.modelRegistry.complete(ctx.model, ...) produces the L2 epoch summary." } },
      { id: "eu-4", type: "message", message: { role: "user", content: "Start phase 2: test overview recall" } },
    ];

    let capturedPrompt = "";
    const res1 = await buildMipmapCompactionAsync({
      branchEntries: branch1,
      sessionStore: store,
      modelSummarizer: (prompt) => {
        capturedPrompt = prompt;
        return Promise.resolve(
          "## Goal\nImplement L2 session mipmap epochs.\n\n## Key Decisions & Findings\n- Store L2 epochs in SessionStore.\n- Prevent [Thinking] stubs from overwriting real responses.",
        );
      },
    });

    assert.ok(res1);
    assert.equal(res1.epochIndex, 1);
    assert.equal(res1.epochStartTurn, 1);
    assert.equal(res1.lastSummarizedTurn, 3);
    assert.ok(capturedPrompt.includes("Substantive assistant text must never be overwritten by [Thinking] stubs."));
    assert.ok(!capturedPrompt.includes("[Thinking] Inspecting files..."));
    assert.ok(res1.summary.includes("[L2 Epoch Summary (Epoch 1 · Turns 1–3)]"));
    assert.ok(res1.summary.includes("Implement L2 session mipmap epochs."));

    // Verify Epoch 1 is stored in SessionStore as L2 compaction event
    const epochsAfter1 = store.getCompactionEpochs();
    assert.equal(epochsAfter1.length, 1);
    assert.equal(epochsAfter1[0].role, "compaction");
    assert.equal(epochsAfter1[0].mipmapLevel, "L2");
    assert.deepEqual(epochsAfter1[0].turnRange, [1, 3]);
    assert.equal(epochsAfter1[0].epochIndex, 1);

    // Populate Epoch 2 (Turns 4..5) and run a second compaction (deterministic fallback)
    for (const [t, u, a] of [
      [4, "Start phase 2: test overview recall", "Added L2 epochs to SessionRecallEngine overview and query search."],
      [5, "Verify hydration from JSONL compaction entries", "SessionStore.hydrateFromRawEntries now indexes type === 'compaction' as L2."],
    ] as const) {
      await store.appendEvent({
        id: `u-${t}`,
        turnIndex: t,
        entryId: `eu-${t}`,
        timestamp: new Date().toISOString(),
        role: "user",
        speaker: "User",
        summary: u,
        text: u,
      });
      await store.appendEvent({
        id: `a-${t}`,
        turnIndex: t,
        entryId: `ea-${t}`,
        timestamp: new Date().toISOString(),
        role: "assistant",
        speaker: "Assistant",
        summary: a,
        text: a,
      });
    }

    const branch2: BranchEntryLike[] = [
      { id: "eu-4", type: "message", message: { role: "user", content: "Start phase 2: test overview recall" } },
      { id: "ea-4", type: "message", message: { role: "assistant", content: "Added L2 epochs to SessionRecallEngine overview and query search." } },
      { id: "eu-5", type: "message", message: { role: "user", content: "Verify hydration from JSONL compaction entries" } },
      { id: "ea-5", type: "message", message: { role: "assistant", content: "SessionStore.hydrateFromRawEntries now indexes type === 'compaction' as L2." } },
      { id: "eu-6", type: "message", message: { role: "user", content: "Run final verification suite" } },
    ];

    const res2 = await buildMipmapCompactionAsync({
      branchEntries: branch2,
      sessionStore: store,
    });
    assert.ok(res2);
    assert.equal(res2.epochIndex, 2);
    assert.equal(res2.epochStartTurn, 4);
    assert.equal(res2.lastSummarizedTurn, 5);
    assert.ok(res2.summary.includes("[L2 Epoch Summary (Epoch 2 · Turns 4–5)]"));
    assert.ok(res2.summary.includes("## Prior Epoch Context"));

    const epochsAfter2 = store.getCompactionEpochs();
    assert.equal(epochsAfter2.length, 2);
    assert.deepEqual(epochsAfter2[0].turnRange, [1, 3]);
    assert.deepEqual(epochsAfter2[1].turnRange, [4, 5]);

    // Verify overview recall surfaces both L2 epochs at the top of the mipmap
    const overviewRes = await engine.search({ query: "", limit: 5 });
    const compactionCards = overviewRes.cards.filter((c) => c.role === "compaction");
    assert.equal(compactionCards.length, 2);
    assert.equal(compactionCards[0].mipmapLevel, "L2");
    assert.deepEqual(compactionCards[0].turnRange, [1, 3]);
    assert.deepEqual(compactionCards[1].turnRange, [4, 5]);

    const formatted = formatSessionCards(overviewRes.cards);
    assert.ok(formatted.includes("[L2 Epoch 1 (Turns 1–3) · Compaction]"));
    assert.ok(formatted.includes("[L2 Epoch 2 (Turns 4–5) · Compaction]"));

    // Verify buildRecentInteractionsBlock includes [L2 Session Mipmap — Compacted Epoch Context]
    const recentBlock = buildRecentInteractionsBlock({
      sessionStore: store,
      postCompaction: true,
    });
    assert.ok(recentBlock);
    assert.ok(recentBlock.includes("[L2 Session Mipmap — Compacted Epoch Context]"));
    assert.ok(recentBlock.includes("[L2 Epoch 1 · Turns 1–3]"));
    assert.ok(recentBlock.includes("Latest Compacted Epoch (Turns 4–5):"));
    assert.ok(!recentBlock.includes("[Thinking] Inspecting files..."));
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("SessionStore: hydrates type === 'compaction' entries from rawEntries as L2 mipmap epochs", () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "compaction-hydrate-" });
  try {
    const store = new SessionStore({ sessionId: "sess-hydrate-compaction", sessionDir: tmpDir });
    store.hydrateFromRawEntries([
      { id: "m1", type: "message", message: { role: "user", content: "First user turn" } },
      { id: "m2", type: "message", parentId: "m1", message: { role: "assistant", content: "First assistant reply" } },
      { id: "m3", type: "message", parentId: "m2", message: { role: "user", content: "Second user turn" } },
      { id: "m4", type: "message", parentId: "m3", message: { role: "assistant", content: "Second assistant reply" } },
      {
        id: "comp-1",
        type: "compaction",
        parentId: "m4",
        summary: "## Goal\nHydrate compaction entries from JSONL into L2 mipmap.",
        details: { modifiedFiles: ["src/session/store.ts"] },
      },
    ]);

    const epochs = store.getCompactionEpochs();
    assert.equal(epochs.length, 1);
    assert.equal(epochs[0].entryId, "comp-1");
    assert.equal(epochs[0].role, "compaction");
    assert.equal(epochs[0].mipmapLevel, "L2");
    assert.deepEqual(epochs[0].turnRange, [1, 2]);
    assert.equal(epochs[0].epochIndex, 1);
    assert.deepEqual(epochs[0].filesTouched, ["src/session/store.ts"]);
    assert.ok(epochs[0].text.includes("Hydrate compaction entries from JSONL into L2 mipmap."));

    // Backfill test: when turns 1..4 already exist in the store without the compaction entries,
    // hydrating the full rawEntries replay must assign [1, 2] and [3, 4] (not [1, 4] and [4, 4]).
    const storeBackfill = new SessionStore({ sessionId: "sess-backfill-compaction", sessionDir: tmpDir + "-bf" });
    try {
      const msgOnlyEntries = [
        { id: "m1", type: "message" as const, message: { role: "user", content: "Turn 1 user" } },
        { id: "m2", type: "message" as const, parentId: "m1", message: { role: "assistant", content: "Turn 1 reply" } },
        { id: "m3", type: "message" as const, parentId: "m2", message: { role: "user", content: "Turn 2 user" } },
        { id: "m4", type: "message" as const, parentId: "m3", message: { role: "assistant", content: "Turn 2 reply" } },
        { id: "m5", type: "message" as const, parentId: "m4", message: { role: "user", content: "Turn 3 user" } },
        { id: "m6", type: "message" as const, parentId: "m5", message: { role: "assistant", content: "Turn 3 reply" } },
        { id: "m7", type: "message" as const, parentId: "m6", message: { role: "user", content: "Turn 4 user" } },
        { id: "m8", type: "message" as const, parentId: "m7", message: { role: "assistant", content: "Turn 4 reply" } },
      ];
      storeBackfill.hydrateFromRawEntries(msgOnlyEntries);
      assert.equal(storeBackfill.getMaxTurnIndex(), 4);

      storeBackfill.hydrateFromRawEntries([
        msgOnlyEntries[0],
        msgOnlyEntries[1],
        msgOnlyEntries[2],
        msgOnlyEntries[3],
        { id: "comp-e1", type: "compaction", parentId: "m4", summary: "## Goal\nEpoch 1 summary" },
        msgOnlyEntries[4],
        msgOnlyEntries[5],
        msgOnlyEntries[6],
        msgOnlyEntries[7],
        { id: "comp-e2", type: "compaction", parentId: "m8", summary: "## Goal\nEpoch 2 summary" },
      ]);

      const bfEpochs = storeBackfill.getCompactionEpochs();
      assert.equal(bfEpochs.length, 2);
      assert.deepEqual(bfEpochs[0].turnRange, [1, 2]);
      assert.equal(bfEpochs[0].epochIndex, 1);
      assert.deepEqual(bfEpochs[1].turnRange, [3, 4]);
      assert.equal(bfEpochs[1].epochIndex, 2);
    } finally {
      Deno.removeSync(tmpDir + "-bf", { recursive: true });
    }
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
