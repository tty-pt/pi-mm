import { strict as assert } from "node:assert";
import { makeRecallTool } from "../src/tools/recall.ts";
import { getSessionInstances, clearAllSessionInstances } from "../src/session/manager.ts";
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

Deno.test("Recall Integration: memory_recall with scope:'session' queries session store", async () => {
  clearAllSessionInstances();
  const sessionId = "sess-tool-rec";
  const instances = getSessionInstances(sessionId);

  instances.tracker.addEntry("e1");
  await instances.store.appendEvent({
    id: "ev1",
    turnIndex: 1,
    entryId: "e1",
    timestamp: new Date().toISOString(),
    role: "tool",
    speaker: "bash",
    summary: "bash `make test-fast`: 14 passed | 0 failed",
    text: "Running unit checks...\nAll 14 assertions OK\n0 failed",
    toolName: "bash",
    exitCode: 0,
  });

  const envSource = async () => createMockEnv();
  const recallTool = makeRecallTool(envSource);

  const mockCtx: PiCtx = {
    cwd: Deno.cwd(),
    hasUI: false,
    mode: "agent",
    sessionId,
  };

  const res = await recallTool.execute("c1", { query: "assertions", scope: "session" }, undefined, undefined, mockCtx);
  assert.ok(res.content[0]?.text);
  assert.ok(res.content[0].text.includes("=== Ephemeral Session Results (1 match in active lineage) ==="));
  assert.ok(res.content[0].text.includes("SUCCESS (0)"));
  assert.ok(res.content[0].text.includes("make test-fast"));
});

Deno.test("Recall Integration: memory_recall zoomTurn slices exact line range", async () => {
  clearAllSessionInstances();
  const sessionId = "sess-tool-zoom";
  const instances = getSessionInstances(sessionId);

  instances.tracker.addEntry("e1");
  await instances.store.appendEvent({
    id: "ev-zoom",
    turnIndex: 7,
    entryId: "e1",
    timestamp: new Date().toISOString(),
    role: "tool",
    speaker: "bash",
    summary: "bash `scripts/build.sh`",
    text: "Line 1: init\nLine 2: setup\nLine 3: compile\nLine 4: link\nLine 5: done",
    toolName: "bash",
  });

  const envSource = async () => createMockEnv();
  const recallTool = makeRecallTool(envSource);
  const mockCtx: PiCtx = { cwd: Deno.cwd(), hasUI: false, mode: "agent", sessionId };

  const res = await recallTool.execute("c2", { zoomTurn: 7, lineRange: [2, 4] }, undefined, undefined, mockCtx);
  assert.ok(res.content[0]?.text);
  assert.ok(res.content[0].text.includes("=== Turn 7 · Tool: bash (Lines 2-4 of 5) ==="));
  assert.ok(res.content[0].text.includes("2 | Line 2: setup"));
  assert.ok(res.content[0].text.includes("3 | Line 3: compile"));
  assert.ok(res.content[0].text.includes("4 | Line 4: link"));
  assert.ok(!res.content[0].text.includes("1 | Line 1: init"));
});

Deno.test("Recall Integration: unified memory_recall without explicit scope surfaces active session hits", async () => {
  clearAllSessionInstances();
  const sessionId = "sess-tool-unified";
  const instances = getSessionInstances(sessionId);

  instances.tracker.addEntry("e1");
  await instances.store.appendEvent({
    id: "ev-unified",
    turnIndex: 4,
    entryId: "e1",
    timestamp: new Date().toISOString(),
    role: "assistant",
    speaker: "Assistant",
    summary: "Fixed bathymetry depth inversion in fragment shader",
    text: "Adjusted shore_water.frag lines 42-50 to invert depth clamp.",
  });

  const envSource = async () => createMockEnv();
  const recallTool = makeRecallTool(envSource);
  const mockCtx: PiCtx = { cwd: Deno.cwd(), hasUI: false, mode: "agent", sessionId };

  // Natural query without scope parameter automatically surfaces session card
  const resQuery = await recallTool.execute("c3", { query: "bathymetry inversion" }, undefined, undefined, mockCtx);
  assert.ok(resQuery.content[0]?.text);
  assert.ok(resQuery.content[0].text.includes("Fixed bathymetry depth inversion"));
  assert.ok(resQuery.content[0].text.includes("zoomTurn: 4"));

  // Direct zoomTurn inspection
  const resZoom = await recallTool.execute("c4", { zoomTurn: 4 }, undefined, undefined, mockCtx);
  assert.ok(resZoom.content[0]?.text);
  assert.ok(resZoom.content[0].text.includes("=== Turn 4"));
  assert.ok(resZoom.content[0].text.includes("Adjusted shore_water.frag lines 42-50"));
});
