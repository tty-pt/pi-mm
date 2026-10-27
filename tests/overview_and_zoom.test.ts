import assert from "node:assert";
import { makeRecallTool } from "../src/tools/recall.ts";
import { buildMemoryOverview } from "../src/tools/overview.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { CormRunner, Invocation } from "../src/corm.ts";
import type { PiExecResult, PiToolSpec } from "../src/hooks/events.ts";
import { isDirectMemoryQuestion, handleBeforeAgentStart } from "../src/hooks/auto_recall.ts";
import install from "../src/index.ts";

function fakeRunner(results: PiExecResult[]): { runner: CormRunner; invocations: Invocation[] } {
  let idx = 0;
  const invocations: Invocation[] = [];
  const runner: CormRunner = {
    run: (inv: Invocation): Promise<PiExecResult> => {
      invocations.push(inv);
      if (idx < results.length) {
        return Promise.resolve(results[idx++]);
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };
  return { runner, invocations };
}

function makeEnv(runner: CormRunner): ToolEnv {
  return {
    cwd: "/tmp/fake-mm",
    runner,
    nowProvider: () => new Date("2026-03-30T12:00:00"),
    cfg: { ...DEFAULT_CONFIG, cormBin: "/usr/bin/corm", memDir: ".pi/mm" },
  };
}

const ctx = { cwd: "/tmp/fake-mm", hasUI: false, mode: "headless" };

async function runTool(tool: PiToolSpec, params: Record<string, unknown>) {
  return await tool.execute("call-1", params, undefined, undefined, ctx);
}

// ---------------------------------------------------------------------------
// 1. buildMemoryOverview unit tests
// ---------------------------------------------------------------------------

Deno.test("overview: buildMemoryOverview handles empty database gracefully", async () => {
  const { runner } = fakeRunner([
    { stdout: "", stderr: "", code: 0 }, // list refs (empty)
  ]);

  const env = makeEnv(runner);
  const overview = await buildMemoryOverview(env);

  assert.strictEqual(overview.totalRecords, 0);
  assert.strictEqual(overview.scannedRecords, 0);
  assert.ok(overview.renderedOverview.includes("No stored memories found"));
});

Deno.test("overview: buildMemoryOverview collates L3, L2, L1 memories across epochs", async () => {
  const fakeL3 = JSON.stringify({
    level: "L3",
    type: "concept",
    lifecycle: "supported",
    summary: "Universal principle: Keep cross-boundary dependencies minimal and explicit",
    evidence: [20, 21],
  });

  const fakeL2 = JSON.stringify({
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "Invariant: Pure-C UX isomorphic dual compilation to native .so and WASM",
    context: { project: "site", subsystem: "ux" },
    evidence: [10],
  });

  const fakeL1 = JSON.stringify({
    level: "L1",
    type: "investigation",
    lifecycle: "tested",
    summary: "Investigation: Eliminated socket lease race condition in resident cormd",
    context: { project: "site", subsystem: "libcorm" },
    episode: {
      problem: "Concurrent startup caused race on cormd.sock",
      approaches: [
        { approach: "Sleep retry", outcome: "failed", reason: "Still timed out" },
        { approach: "Atomic coordinator lock", outcome: "worked", reason: "Zero collision" },
      ],
      diffs: ["+ coordinator lock acquisition"],
      outcome: "success",
    },
  });

  const fakePersona = JSON.stringify({
    level: "L1",
    type: "note",
    lifecycle: "supported",
    summary: "User prefers zero-dependency pure-C architecture",
    context: { project: "user", subsystem: "persona" },
  });

  const { runner } = fakeRunner([
    { stdout: "1\n2\n3\n4\n", stderr: "", code: 0 }, // list refs
    { stdout: `2026-03-10:${fakePersona}\n`, stderr: "", code: 0 }, // ref 1
    { stdout: `2026-03-15:${fakeL3}\n`, stderr: "", code: 0 },      // ref 2
    { stdout: `2026-03-20:${fakeL2}\n`, stderr: "", code: 0 },      // ref 3
    { stdout: `2026-03-25:${fakeL1}\n`, stderr: "", code: 0 },      // ref 4
  ]);

  const env = makeEnv(runner);
  const overview = await buildMemoryOverview(env);

  assert.strictEqual(overview.totalRecords, 4);
  assert.strictEqual(overview.scannedRecords, 4);
  assert.strictEqual(overview.activeSpan.earliestDate, "2026-03-10");
  assert.strictEqual(overview.activeSpan.latestDate, "2026-03-25");
  assert.strictEqual(overview.levelCounts.L3, 1);
  assert.strictEqual(overview.levelCounts.L2, 1);
  assert.strictEqual(overview.levelCounts.L1, 2);

  assert.strictEqual(overview.personaTenets.length, 1);
  assert.strictEqual(overview.principles.length, 1);
  assert.strictEqual(overview.invariantsAndDecisions.length, 1);
  assert.strictEqual(overview.recentMilestones.length, 1);

  // Verify markdown rendering
  const md = overview.renderedOverview;
  assert.ok(md.includes("# Memory System Overview"));
  assert.ok(md.includes("Universal Principles (L3)"));
  assert.ok(md.includes("Architectural Invariants & Decisions (L2)"));
  assert.ok(md.includes("User Persona & Core Tenets"));
  assert.ok(md.includes("Key Task Investigations & Milestones (L1)"));
  assert.ok(md.includes("Epoch 2026-03"));
  assert.ok(md.includes("memory_recall({ zoomRef: <ref> })"));
});

// ---------------------------------------------------------------------------
// 2. memory_recall - Overview mode tests
// ---------------------------------------------------------------------------

Deno.test("recall: overview mode is triggered via overview: true, omitted query, or query: 'overview'", async () => {
  const fakeL2 = JSON.stringify({
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "Audio pipeline must use 48kHz 24-bit FLAC",
    context: { project: "site", subsystem: "song" },
  });

  const getResults = () => [
    { stdout: "1\n", stderr: "", code: 0 },
    { stdout: `2026-03-30:${fakeL2}\n`, stderr: "", code: 0 },
  ];

  // 1. Explicit overview: true
  const { runner: r1 } = fakeRunner(getResults());
  const tool1 = makeRecallTool(() => Promise.resolve(makeEnv(r1)));
  const res1 = await runTool(tool1, { overview: true });
  assert.ok(res1.content[0].text?.includes("# Memory System Overview"));
  assert.ok(res1.content[0].text?.includes("Audio pipeline must use 48kHz 24-bit FLAC"));

  // 2. Omitted query
  const { runner: r2 } = fakeRunner(getResults());
  const tool2 = makeRecallTool(() => Promise.resolve(makeEnv(r2)));
  const res2 = await runTool(tool2, {});
  assert.ok(res2.content[0].text?.includes("# Memory System Overview"));

  // 3. query: "overview"
  const { runner: r3 } = fakeRunner(getResults());
  const tool3 = makeRecallTool(() => Promise.resolve(makeEnv(r3)));
  const res3 = await runTool(tool3, { query: "overview" });
  assert.ok(res3.content[0].text?.includes("# Memory System Overview"));

  // 4. query: "*"
  const { runner: r4 } = fakeRunner(getResults());
  const tool4 = makeRecallTool(() => Promise.resolve(makeEnv(r4)));
  const res4 = await runTool(tool4, { query: "*" });
  assert.ok(res4.content[0].text?.includes("# Memory System Overview"));
});

// ---------------------------------------------------------------------------
// 3. memory_recall - Zoom-In mode tests
// ---------------------------------------------------------------------------

Deno.test("recall: zoomRef fetches comprehensive multi-resolution details and evidence tree", async () => {
  const fakeL1 = JSON.stringify({
    level: "L1",
    type: "investigation",
    lifecycle: "supported",
    summary: "Resolved resident cormd socket leasing race condition",
    context: { project: "site", subsystem: "libcorm" },
    constraints: ["Never unlink socket while daemon lock is held"],
    episode: {
      problem: "Concurrent startup caused race on cormd.sock",
      approaches: [
        { approach: "Sleep backoff", outcome: "failed", reason: "Transient delay did not prevent collision" },
        { approach: "Atomic coordinator lock", outcome: "worked", reason: "Guaranteed single owner" },
      ],
      findings: ["Coordinator lock inode remained stable across owners"],
      diffs: ["src/daemon.ts: acquire coordinator lock before binding socket"],
      outcome: "success",
    },
    evidence: [2],
  });

  const fakeL0 = JSON.stringify({
    level: "L0",
    type: "episode",
    lifecycle: "supported",
    summary: "Raw verification: tests/cormd_hardening.test.ts passed",
  });

  const { runner } = fakeRunner([
    { stdout: `2026-03-30:${fakeL1}\n`, stderr: "", code: 0 }, // fetchEnvelope ref 5
    { stdout: `2026-03-30:${fakeL1}\n`, stderr: "", code: 0 }, // traverseDown root (5)
    { stdout: `2026-03-30:${fakeL0}\n`, stderr: "", code: 0 }, // traverseDown child (2)
  ]);

  const tool = makeRecallTool(() => Promise.resolve(makeEnv(runner)));
  const res = await runTool(tool, { zoomRef: 5 });

  const text = res.content[0].text ?? "";
  assert.ok(text.includes("=== Memory Zoom-In: Ref 5 ==="));
  assert.ok(text.includes("Level: L1 | Lifecycle: supported | Type: investigation [site/libcorm]"));
  assert.ok(text.includes("[RESTRICTION]: Never unlink socket while daemon lock is held"));
  assert.ok(text.includes("Problem Addressed:"));
  assert.ok(text.includes("Concurrent startup caused race on cormd.sock"));
  assert.ok(text.includes("[FAILED] Sleep backoff: Transient delay did not prevent collision"));
  assert.ok(text.includes("[WORKED] Atomic coordinator lock: Guaranteed single owner"));
  assert.ok(text.includes("src/daemon.ts: acquire coordinator lock"));
  assert.ok(text.includes("Evidence Hierarchy (Mipmap Lineage):"));
  assert.ok(text.includes("[L0] Ref 2: Raw verification"));
});

Deno.test("recall: zoomRef handles missing reference gracefully", async () => {
  const { runner } = fakeRunner([
    { stdout: "", stderr: "", code: 1 }, // fetchEnvelope ref 999 (not found)
  ]);

  const tool = makeRecallTool(() => Promise.resolve(makeEnv(runner)));
  const res = await runTool(tool, { zoomRef: 999 });

  assert.ok(res.content[0].text?.includes("Memory Ref 999 not found in database"));
  const d = res.details as { error?: string };
  assert.strictEqual(d.error, "not-found");
});

Deno.test("recall: inline zoom query like 'ref:42' or 'zoom:42' delegates to zoom-in", async () => {
  const fakeL2 = JSON.stringify({
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "Strict memory budgeting in all auto-recall hooks",
  });

  const { runner } = fakeRunner([
    { stdout: `2026-03-30:${fakeL2}\n`, stderr: "", code: 0 },
    { stdout: `2026-03-30:${fakeL2}\n`, stderr: "", code: 0 },
  ]);

  const tool = makeRecallTool(() => Promise.resolve(makeEnv(runner)));
  const res = await runTool(tool, { query: "ref:42" });

  assert.ok(res.content[0].text?.includes("=== Memory Zoom-In: Ref 42 ==="));
  assert.ok(res.content[0].text?.includes("Strict memory budgeting in all auto-recall hooks"));
});

// ---------------------------------------------------------------------------
// 4. Targeted Semantic and Lexical Search Preservation
// ---------------------------------------------------------------------------

Deno.test("recall: targeted query preserves hybrid search, ranking, and evidence attachment", async () => {
  const fakeHit = "7 0.92 2026-03-30:" + JSON.stringify({
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "FLAC 48kHz audio pipeline format",
    context: { project: "site", subsystem: "song" },
    evidence: [3],
  }) + "\n";

  const fakeL0 = JSON.stringify({
    level: "L0",
    type: "episode",
    lifecycle: "supported",
    summary: "Episode: Tested ffmpeg FLAC encoding",
  });

  const { runner } = fakeRunner([
    { stdout: fakeHit, stderr: "", code: 0 },                    // hybrid scan
    { stdout: `2026-03-30:${fakeHit.slice(7)}`, stderr: "", code: 0 }, // fetchEnvelope ref 7
    { stdout: `2026-03-30:${fakeL0}\n`, stderr: "", code: 0 },         // traverseDown child 3
  ]);

  const tool = makeRecallTool(() => Promise.resolve(makeEnv(runner)));
  const res = await runTool(tool, { query: "FLAC audio pipeline", includeEvidence: true });

  const text = res.content[0].text ?? "";
  assert.ok(text.includes("Found 1 relevant memory record(s) for \"FLAC audio pipeline\":"));
  assert.ok(text.includes("[Ref 7] (L2, supported [site/song]): FLAC 48kHz audio pipeline format"));
  assert.ok(text.includes("Supporting Evidence:"));
  assert.ok(text.includes("Tip: To zoom into any of these memories, call memory_recall({ zoomRef: <ref> })"));
});

// ---------------------------------------------------------------------------
// 5. Auto-Recall Introspection and Direct Memory Question Detection
// ---------------------------------------------------------------------------

Deno.test("auto_recall: isDirectMemoryQuestion accurately identifies open-ended memory questions", () => {
  // Should match open-ended memory overview questions across all time
  assert.strictEqual(isDirectMemoryQuestion("What do you remember?"), true);
  assert.strictEqual(isDirectMemoryQuestion("what do you remember"), true);
  assert.strictEqual(isDirectMemoryQuestion("What do you recall across all time?"), true);
  assert.strictEqual(isDirectMemoryQuestion("tell me what you remember"), true);
  assert.strictEqual(isDirectMemoryQuestion("what did i say earlier?"), true);
  assert.strictEqual(isDirectMemoryQuestion("give me an overview of all your memories"), true);
  assert.strictEqual(isDirectMemoryQuestion("Give me a summary of your memories."), true);
  assert.strictEqual(isDirectMemoryQuestion("What memories do you have?"), true);
  assert.strictEqual(isDirectMemoryQuestion("what have we worked on across all time?"), true);

  // Should NOT match targeted queries or coding tasks
  assert.strictEqual(isDirectMemoryQuestion("What do you remember about FLAC audio?"), false);
  assert.strictEqual(isDirectMemoryQuestion("Did we discuss corm_open handles?"), false);
  assert.strictEqual(isDirectMemoryQuestion("Can you fix this bug in Makefile?"), false);
  assert.strictEqual(isDirectMemoryQuestion("How does libsepal ANN search work?"), false);
  assert.strictEqual(isDirectMemoryQuestion("Hello there"), false);
});

Deno.test("auto_recall: handleBeforeAgentStart injects all-time overview on open-ended question", async () => {
  const fakeL2 = JSON.stringify({
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "Database keys are 64-bit LEB128 packed",
    context: { project: "libcorm", subsystem: "core" },
  });

  const { runner } = fakeRunner([
    { stdout: "10\n", stderr: "", code: 0 },                         // list refs
    { stdout: `2026-03-30:${fakeL2}\n`, stderr: "", code: 0 },       // fetch ref 10
  ]);

  const env = makeEnv(runner);
  const sysOpts: Record<string, unknown> = { sections: {} };

  const res = await handleBeforeAgentStart(
    { messageType: "user", prompt: "What do you remember across all time?", systemPromptOptions: sysOpts },
    ctx,
    () => Promise.resolve(env),
  );

  assert.ok(res !== null);
  assert.strictEqual(res.message?.role, "custom");
  assert.strictEqual(res.message?.customType, "memory_context");
  assert.ok(res.message?.content.includes("[Persistent Memory Overview Across All Time]"));
  assert.ok(res.message?.content.includes("Database keys are 64-bit LEB128 packed"));
  assert.ok(res.message?.content.includes("memory_recall(zoomRef=...)"));
});

// ---------------------------------------------------------------------------
// 6. CLI Command /mm overview and /mm timeline integration
// ---------------------------------------------------------------------------

Deno.test("cli: /mm overview and /mm timeline dispatch successfully to mm-report", async () => {
  const fakeL3 = JSON.stringify({
    level: "L3",
    type: "concept",
    lifecycle: "supported",
    summary: "Single-file purity for persistent storage",
  });

  const { runner } = fakeRunner([
    { stdout: "1\n", stderr: "", code: 0 },
    { stdout: `2026-03-30:${fakeL3}\n`, stderr: "", code: 0 },
  ]);

  const registeredCommands = new Map<string, { handler: (args: string, ctx: { cwd: string }) => Promise<void> }>();
  const appendedEntries: Array<{ type: string; data: unknown }> = [];

  const mockPi = {
    exec: (command: string, args: string[]) => runner.run({ command, args, env: {}, cwd: "/tmp/fake-mm" }),
    registerTool: () => {},
    on: () => {},
    registerCommand: (name: string, spec: { handler: (args: string, ctx: { cwd: string }) => Promise<void> }) => {
      registeredCommands.set(name, spec);
    },
    registerEntryRenderer: () => {},
    appendEntry: (type: string, data: unknown) => {
      appendedEntries.push({ type, data });
    },
  };

  install(mockPi as unknown as import("../src/hooks/events.ts").Pi);

  const mmCmd = registeredCommands.get("mm");
  assert.ok(mmCmd !== undefined, "Command /mm must be registered");

  // Run /mm overview
  await mmCmd.handler("overview", { cwd: "/tmp/fake-mm" });
  assert.ok(appendedEntries.length >= 1);
  const report1 = appendedEntries[0].data as { title: string; lines: string[] };
  assert.strictEqual(report1.title, "Pi-MM Memory Overview & Timeline");
  assert.ok(report1.lines.some((l) => l.includes("Total Records")));
  assert.ok(report1.lines.some((l) => l.includes("Zoom-In")));

  // Run /mm timeline
  await mmCmd.handler("timeline", { cwd: "/tmp/fake-mm" });
  assert.ok(appendedEntries.length >= 2);
  const report2 = appendedEntries[1].data as { title: string; lines: string[] };
  assert.strictEqual(report2.title, "Pi-MM Memory Overview & Timeline");
});
