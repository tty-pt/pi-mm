import { strict as assert } from "node:assert";
import { getSessionInstances, closeSessionInstances, clearAllSessionInstances } from "../src/session/manager.ts";
import { makeRecallTool } from "../src/tools/recall.ts";
import { buildMipmapCompaction, type BranchEntryLike } from "../src/session/compaction.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { PiCtx } from "../src/hooks/events.ts";

function createMockEnv(): ToolEnv {
  return {
    cwd: Deno.cwd(),
    cfg: {
      cormBin: "/bin/true",
      memDir: ".pi/mm",
      axisLibs: null,
      scanLimit: 5,
    },
    nowProvider: () => new Date(),
    runner: {
      run: async () => ({ stdout: "", stderr: "", code: 0 }),
    },
  };
}

Deno.test("Session E2E: complete lifecycle from ingestion to progressive recall and compaction", async () => {
  clearAllSessionInstances();
  const sessionId = "e2e-session-lifecycle";
  const instances = getSessionInstances(sessionId);
  const sink = instances.sink;
  const tracker = instances.tracker;

  // 1. Ingestion: Turn 1 (User asks to implement shoreline shader)
  tracker.addEntry("e-user-1");
  sink.setTurn(1, "e-user-1");
  await sink.recordUserPrompt("Implement the shoreline bathymetry shader with continuous depth transitions.");

  // Turn 1: Assistant plans the approach
  tracker.addEntry("e-asst-1", "e-user-1");
  sink.setTurn(1, "e-asst-1", "e-user-1");
  await sink.recordAssistantResponse(
    "I will edit mods/seven/ux/shore_water.frag and compile with make.",
    "Checking whether to use a uniform for shoreline near-plane.",
  );

  // 2. Ingestion: Turn 2 (Tool execution fails)
  tracker.addEntry("e-tool-1", "e-asst-1");
  sink.setTurn(2, "e-tool-1", "e-asst-1");
  await sink.recordToolResult({
    toolName: "bash",
    input: { command: "make -C mods/seven test-mod" },
    content: [{
      type: "text",
      text: [
        "Compiling shore_water.c...",
        "Linking seven.so...",
        "ERROR: shore_water.frag:42: undefined variable 'u_bathymetry_depth'",
        "make: *** [mods/seven/ux/shore_water.o] Error 1",
      ].join("\n"),
    }],
    isError: true,
  });

  // Turn 2: Assistant diagnoses and fixes
  tracker.addEntry("e-asst-2", "e-tool-1");
  sink.setTurn(2, "e-asst-2", "e-tool-1");
  await sink.recordAssistantResponse(
    "Fixed variable declaration in shore_water.frag. Re-running test.",
  );

  // Turn 2: Tool execution succeeds
  tracker.addEntry("e-tool-2", "e-asst-2");
  sink.setTurn(2, "e-tool-2", "e-asst-2");
  await sink.recordToolResult({
    toolName: "bash",
    input: { command: "make -C mods/seven test-mod" },
    content: [{
      type: "text",
      text: "Compiling shore_water.c... OK\nAll 14 tests PASS",
    }],
    isError: false,
  });

  // Turn 3: User follows up
  tracker.addEntry("e-user-2", "e-tool-2");
  sink.setTurn(3, "e-user-2", "e-tool-2");
  await sink.recordUserPrompt("Verify that the shoreline renders without artifacts.");

  const envSource = async () => createMockEnv();
  const recallTool = makeRecallTool(envSource);
  const mockCtx: PiCtx = { cwd: Deno.cwd(), hasUI: false, mode: "agent", sessionId };

  // 3. Progressive Retrieval: Default View
  const defaultRecall = await recallTool.execute(
    "call-1",
    { query: "u_bathymetry_depth", scope: "session" },
    undefined,
    undefined,
    mockCtx,
  );
  assert.ok(defaultRecall.content[0]?.text);
  const defaultText = defaultRecall.content[0].text;
  assert.ok(defaultText.includes("=== Ephemeral Session Results (1 match in active lineage) ==="));
  assert.ok(defaultText.includes("FAILED (Exit 1)"));
  assert.ok(defaultText.includes("u_bathymetry_depth"));
  assert.ok(defaultText.includes("zoomTurn: 2"));

  // 4. Progressive Retrieval: Line-level Zoom
  const zoomRecall = await recallTool.execute(
    "call-2",
    { zoomTurn: 2, lineRange: [2, 4] },
    undefined,
    undefined,
    mockCtx,
  );
  assert.ok(zoomRecall.content[0]?.text);
  const zoomText = zoomRecall.content[0].text;
  assert.ok(zoomText.includes("=== Turn 2 · Tool: bash (Lines 2-4 of 4) ==="));
  assert.ok(zoomText.includes("2 | Linking seven.so..."));
  assert.ok(zoomText.includes("3 | ERROR: shore_water.frag:42: undefined variable 'u_bathymetry_depth'"));

  // 5. Unified Natural Recall (without explicit scope)
  const unifiedRes = await recallTool.execute(
    "call-3",
    { query: "continuous depth" },
    undefined,
    undefined,
    mockCtx,
  );
  assert.ok(unifiedRes.content[0]?.text);
  assert.ok(unifiedRes.content[0].text.includes("continuous depth transitions"));

  // 6. Mipmap Compaction
  const branchEntries: BranchEntryLike[] = [
    { id: "e-user-1", type: "message", message: { role: "user", content: "Implement the shoreline bathymetry shader" } },
    { id: "e-asst-1", type: "message", message: { role: "assistant", content: "I will edit the frag shader." } },
    { id: "e-tool-1", type: "message", message: { role: "toolResult", content: "ERROR: undefined variable" } },
    { id: "e-asst-2", type: "message", message: { role: "assistant", content: "Fixed declaration." } },
    { id: "e-tool-2", type: "message", message: { role: "toolResult", content: "All 14 tests PASS" } },
    { id: "e-user-2", type: "message", message: { role: "user", content: "Verify that the shoreline renders without artifacts." } },
  ];

  const compaction = buildMipmapCompaction({
    branchEntries,
    sessionStore: instances.store,
    directives: ["Don't use conditionals for 3D; always use the body of the if."],
  });

  assert.ok(compaction !== null);
  assert.equal(compaction.firstKeptEntryId, "e-user-2");
  assert.ok(compaction.summary.includes("[Session Goal]"));
  assert.ok(compaction.summary.includes("[Active Project Invariants & Directives]"));
  assert.ok(compaction.summary.includes("[Key Signal Timeline]"));
  assert.ok(compaction.summary.includes("[Key Diagnostic Signals]"));
  assert.ok(compaction.summary.includes("u_bathymetry_depth"));
  assert.ok(compaction.summary.includes("[Ephemeral Session Memory Anchor]"));
  assert.ok(!compaction.summary.includes("vcc_recall"));

  // 7. Cleanup & Lifecycle
  closeSessionInstances(sessionId);
});

Deno.test("Session E2E: session_start skips synchronous full-db scan when directives file exists and no pending journal", async () => {
  const { installSessionHooks } = await import("../src/hooks/events.ts");
  const { resolveRuntimeCwd } = await import("../src/session/store.ts");
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-fast-start-" });
  try {
    const mmDir = `${tmpDir}/.pi/mm`;
    Deno.mkdirSync(mmDir, { recursive: true });
    Deno.writeTextFileSync(
      `${mmDir}/standing_directives.json`,
      JSON.stringify([{ ref: 1, summary: "Always verify boundaries" }]),
    );

    let listCalls = 0;
    let getCalls = 0;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const mockPi = {
      on: (ev: string, fn: (...args: unknown[]) => unknown) => handlers.set(ev, fn),
      registerTool: () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    };

    const envSource = async () => ({
      cwd: tmpDir,
      cfg: {
        cormBin: "/bin/true",
        memDir: ".pi/mm",
        axisLibs: null,
        scanLimit: 5,
        embedUrl: "http://127.0.0.1:4242/v1/embeddings",
        embedModel: "bge-base",
        semanticSearch: true,
        judgeMode: "off" as const,
      },
      nowProvider: () => new Date(),
      runner: {
        run: async (inv: { args: string[] }) => {
          if (inv.args.includes("-l")) {
            listCalls++;
            return { stdout: Array.from({ length: 5000 }, (_, i) => String(i + 1)).join("\n"), stderr: "", code: 0 };
          }
          if (inv.args.includes("-g")) {
            getCalls++;
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      },
    });

    installSessionHooks(mockPi, envSource);
    const startHandler = handlers.get("session_start");
    assert.ok(startHandler);

    const t0 = performance.now();
    await startHandler({}, { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "fast-start-sess" });
    const elapsedMs = performance.now() - t0;

    assert.equal(listCalls, 0, "Should not run corm -l when standing_directives.json exists and .pending_events.json is absent");
    assert.equal(getCalls, 0, "Should not run corm -g loop during fast session_start");
    assert.ok(elapsedMs < 200, `Expected fast session_start (<200ms), took ${elapsedMs}ms`);

    const inst = getSessionInstances("fast-start-sess");
    assert.ok(inst.store.getFilespec().includes("sepal"), "Expected session store to be configured with sepal axis from MmConfig");
    assert.equal(resolveRuntimeCwd(tmpDir), tmpDir);
    closeSessionInstances("fast-start-sess");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
