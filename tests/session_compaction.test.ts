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
