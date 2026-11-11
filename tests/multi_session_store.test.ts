import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SessionStore,
  resolveSharedSessionCacheRoot,
  extractWorkspaceLabel,
} from "../src/session/store.ts";
import {
  getSessionInstances,
  ensureSessionIndexed,
  discoverPeerSessions,
  resolveTargetSessions,
  clearAllSessionInstances,
} from "../src/session/manager.ts";
import { SessionLineageTracker } from "../src/session/lineage.ts";

Deno.test("Phase 1: resolveSharedSessionCacheRoot resolves worktree slots to primary repo .pi/cache/sessions", () => {
  const tmpRepo = Deno.makeTempDirSync({ prefix: "mm-shared-root-" });
  try {
    const slotDir = join(tmpRepo, ".pi", "scratch", "slot-6", "mods", "song");
    mkdirSync(slotDir, { recursive: true });

    const sharedRoot = resolveSharedSessionCacheRoot(slotDir);
    assert.equal(sharedRoot, join(tmpRepo, ".pi", "cache", "sessions"));
    assert.equal(extractWorkspaceLabel(slotDir), "slot-6");
    assert.equal(extractWorkspaceLabel(tmpRepo), tmpRepo.split("/").filter(Boolean).pop());
  } finally {
    Deno.removeSync(tmpRepo, { recursive: true });
  }
});

Deno.test("Phase 1: refreshFromDiskIfNeeded incrementally reloads events appended by a sibling process", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-incremental-reload-" });
  try {
    const sessionDir = join(tmpDir, "sess-shared-1");
    const writerStore = new SessionStore({
      sessionId: "sess-shared-1",
      sessionDir,
      cwd: "/repo/.pi/scratch/slot-4",
    });

    await writerStore.appendEvent({
      id: "ev-turn-1",
      turnIndex: 1,
      entryId: "e-1",
      timestamp: "2026-11-11T10:00:00.000Z",
      role: "user",
      speaker: "User",
      summary: "Investigate shoreline shader artifact",
      text: "Investigate shoreline shader artifact",
    });

    // Reader store opens the same manifest directory (simulating another process)
    const readerTracker = new SessionLineageTracker();
    const readerStore = new SessionStore({
      sessionId: "sess-shared-1",
      sessionDir,
    });
    readerStore.attachTracker(readerTracker);

    assert.equal(readerStore.getEventCount(), 1);
    assert.equal(readerStore.getMaxTurnIndex(), 1);
    assert.equal(readerStore.getMetadata().workspaceLabel, "slot-4");
    assert.equal(readerStore.getMetadata().shortId, "sess-sha");

    // Writer appends Turn 2 tool execution
    await writerStore.appendEvent({
      id: "ev-turn-2-tool",
      turnIndex: 2,
      entryId: "e-2",
      parentId: "e-1",
      timestamp: "2026-11-11T10:01:00.000Z",
      role: "tool",
      speaker: "bash",
      summary: "bash (exit 2): make -C mods/seven -> shoreline_foam.c:88: error",
      text: "Building mods/seven\nshoreline_foam.c:88: error: undeclared identifier 'u_foam_scale'\nmake: *** [Error 2]",
      toolName: "bash",
      exitCode: 2,
      errorSnippet: "shoreline_foam.c:88: error: undeclared identifier 'u_foam_scale'",
    });

    // Reader automatically sees Turn 2 without re-instantiating SessionStore
    assert.equal(readerStore.getEventCount(), 2);
    assert.equal(readerStore.getMaxTurnIndex(), 2);
    const turn2 = readerStore.getEventsByTurn(2);
    assert.equal(turn2.length, 1);
    assert.equal(turn2[0].event.toolName, "bash");
    assert.equal(turn2[0].event.exitCode, 2);

    const sliced = readerStore.sliceLines(turn2[0].ref, [2, 2]);
    assert.ok(sliced);
    assert.equal(sliced.lines[0].text, "shoreline_foam.c:88: error: undeclared identifier 'u_foam_scale'");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("Phase 2: hydrateFromJsonlFile reconstructs user, assistant, thinking, and toolResult with full fidelity", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-jsonl-hydrate-" });
  try {
    clearAllSessionInstances();
    const jsonlPath = join(tmpDir, "01a1c8f7-1111-2222-3333-444455556666.jsonl");
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "01a1c8f7-1111-2222-3333-444455556666",
        timestamp: "2026-11-11T12:00:00.000Z",
        cwd: join(tmpDir, ".pi", "scratch", "slot-6"),
      }),
      JSON.stringify({
        type: "message",
        id: "msg-u1",
        parentId: null,
        timestamp: "2026-11-11T12:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Run the lamina bridge unit test and check for failures." }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-a1",
        parentId: "msg-u1",
        timestamp: "2026-11-11T12:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I will run sh tests/unit/run-test-lamina-bridge.sh via bash." },
            { type: "text", text: "Executing the lamina bridge test suite now." },
            {
              type: "toolCall",
              id: "call-bash-99",
              name: "bash",
              arguments: { command: "sh tests/unit/run-test-lamina-bridge.sh", path: "tests/unit/run-test-lamina-bridge.sh" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-t1",
        parentId: "msg-a1",
        timestamp: "2026-11-11T12:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-bash-99",
          toolName: "bash",
          isError: true,
          content: [
            {
              type: "text",
              text: [
                "TAP version 13",
                "1..3",
                "ok 1 - init gl context",
                "not ok 2 - error: shader uniform u_horizon mismatch",
                "FAIL: 1 of 3 tests failed",
              ].join("\n"),
            },
          ],
        },
      }),
    ];
    writeFileSync(jsonlPath, lines.join("\n") + "\n", "utf-8");

    const indexed = await ensureSessionIndexed({
      sessionFile: jsonlPath,
      cwd: tmpDir,
      sourceRef: 42,
    });

    assert.ok(indexed);
    assert.equal(indexed.store.sessionId, "01a1c8f7-1111-2222-3333-444455556666");
    assert.equal(indexed.store.getEventCount(), 3);
    assert.equal(indexed.sourceMemoryRef, 42);

    const meta = indexed.store.getMetadata();
    assert.equal(meta.shortId, "01a1c8f7");
    assert.equal(meta.workspaceLabel, "slot-6");
    assert.equal(meta.turnCount, 1);
    assert.ok(meta.firstUserPrompt?.includes("Run the lamina bridge unit test"));

    const toolEv = indexed.store.getEventByEntryId("msg-t1");
    assert.ok(toolEv);
    assert.equal(toolEv.id, "call-bash-99");
    assert.equal(toolEv.role, "tool");
    assert.equal(toolEv.toolName, "bash");
    assert.equal(toolEv.exitCode, 1);
    assert.deepEqual(toolEv.filesTouched, ["tests/unit/run-test-lamina-bridge.sh"]);
    assert.ok(toolEv.summary.includes("sh tests/unit/run-test-lamina-bridge.sh"));
    assert.ok(toolEv.errorSnippet?.includes("u_horizon mismatch"));

    const turnEvents = indexed.store.getEventsByTurn(1);
    assert.equal(turnEvents.length, 3);
    const assistantEv = turnEvents.find((e) => e.event.role === "assistant")?.event;
    assert.ok(assistantEv);
    assert.equal(assistantEv.thinking, "I will run sh tests/unit/run-test-lamina-bridge.sh via bash.");

    const toolRef = turnEvents.find((e) => e.event.role === "tool")!.ref;
    const zoom = indexed.store.sliceLines(toolRef, [4, 5]);
    assert.ok(zoom);
    assert.equal(zoom.lines.length, 2);
    assert.equal(zoom.lines[0].lineNum, 4);
    assert.ok(zoom.lines[0].text.includes("u_horizon mismatch"));
  } finally {
    clearAllSessionInstances();
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("Phase 4: discoverPeerSessions and resolveTargetSessions find current, parallel, and persistent-ref sessions", async () => {
  const tmpRepo = Deno.makeTempDirSync({ prefix: "mm-peer-discovery-" });
  try {
    clearAllSessionInstances();
    mkdirSync(join(tmpRepo, ".pi"), { recursive: true });
    const slot4Cwd = join(tmpRepo, ".pi", "scratch", "slot-4");
    const slot6Cwd = join(tmpRepo, ".pi", "scratch", "slot-6");
    mkdirSync(slot4Cwd, { recursive: true });
    mkdirSync(slot6Cwd, { recursive: true });

    const currentInst = getSessionInstances("aaaa1111-0000-0000-0000-000000000001", { cwd: slot6Cwd });
    await currentInst.store.appendEvent({
      id: "ev-curr-1",
      turnIndex: 1,
      entryId: "e-c1",
      timestamp: new Date().toISOString(),
      role: "user",
      speaker: "User",
      summary: "Current session in slot-6",
      text: "Current session in slot-6",
    });

    const parallelInst = getSessionInstances("bbbb2222-0000-0000-0000-000000000002", { cwd: slot4Cwd });
    await parallelInst.store.appendEvent({
      id: "ev-par-1",
      turnIndex: 1,
      entryId: "e-p1",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "bash",
      summary: "Parallel session in slot-4 building libchaff",
      text: "Building libchaff in slot-4",
      toolName: "bash",
      exitCode: 0,
    });

    const peers = discoverPeerSessions({
      cwd: slot6Cwd,
      currentSessionId: "aaaa1111-0000-0000-0000-000000000001",
    });

    assert.equal(peers.length, 2);
    assert.equal(peers[0].origin, "current");
    assert.equal(peers[0].workspaceLabel, "slot-6");
    assert.equal(peers[1].origin, "parallel");
    assert.equal(peers[1].shortId, "bbbb2222");
    assert.equal(peers[1].workspaceLabel, "slot-4");

    // Resolve by shortId prefix
    const byPrefix = resolveTargetSessions("bbbb2222", {
      cwd: slot6Cwd,
      currentSessionId: "aaaa1111-0000-0000-0000-000000000001",
    });
    assert.equal(byPrefix.length, 1);
    assert.equal(byPrefix[0].sessionId, "bbbb2222-0000-0000-0000-000000000002");

    // Resolve by slot label
    const bySlot = resolveTargetSessions("slot-4", {
      cwd: slot6Cwd,
      currentSessionId: "aaaa1111-0000-0000-0000-000000000001",
    });
    assert.equal(bySlot.length, 1);
    assert.equal(bySlot[0].sessionId, "bbbb2222-0000-0000-0000-000000000002");
  } finally {
    clearAllSessionInstances();
    Deno.removeSync(tmpRepo, { recursive: true });
  }
});
