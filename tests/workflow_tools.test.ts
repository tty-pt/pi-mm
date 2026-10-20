import assert from "node:assert";
import { makeRecallTool } from "../src/tools/recall.ts";
import { makeRecordTool } from "../src/tools/record.ts";
import { makeReviewTool } from "../src/tools/review.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { QmapRunner, Invocation } from "../src/qmap.ts";
import type { PiExecResult, PiToolSpec } from "../src/hooks/events.ts";

function fakeRunner(results: PiExecResult[]): { runner: QmapRunner; invocations: Invocation[] } {
  let idx = 0;
  const invocations: Invocation[] = [];
  const runner: QmapRunner = {
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

function makeEnv(runner: QmapRunner): ToolEnv {
  try { Deno.removeSync("/tmp/fake-mm/.pi/mm/.ref_seq"); } catch { /* ignore */ }
  try { Deno.removeSync("/tmp/fake-mm/.ref_seq"); } catch { /* ignore */ }
  return {
    cwd: "/tmp/fake-mm",
    runner,
    nowProvider: () => new Date("2026-03-30T12:00:00"),
    cfg: { ...DEFAULT_CONFIG, qmapBin: "/usr/bin/qmap", memDir: ".pi/mm" },
  };
}

const ctx = { cwd: "/tmp/fake-mm", hasUI: false, mode: "headless" };

async function runTool(tool: PiToolSpec, params: Record<string, unknown>) {
  return await tool.execute("call-1", params, undefined, undefined, ctx);
}

Deno.test("workflow_tools: memory_record validates required fields and stores L0 episode", async () => {
  const { runner, invocations } = fakeRunner([
    { stdout: "1\n2\n", stderr: "", code: 0 }, // list refs
    { stdout: "", stderr: "", code: 0 },       // store
  ]);

  const tool = makeRecordTool(() => Promise.resolve(makeEnv(runner)));

  // Missing problem
  const resBad = await runTool(tool, { problem: "", approaches: [] });
  assert.ok((resBad.content[0].text ?? "").includes("missing problem"));

  // Valid record
  const res = await runTool(tool, {
    problem: "Fix fd leak on duplicate corm_open",
    approaches: [
      { approach: "Increase ulimit", outcome: "failed", reason: "Masked symptom rather than fixing root cause" },
      { approach: "Add handle table alias check", outcome: "worked", reason: "Reuses handle on identical file" },
    ],
    findings: ["corm_open was allocating duplicate fd"],
    diffs: ["+ alias check"],
    outcome: "success",
    project: "site",
    subsystem: "libcorm",
  });

  assert.ok(invocations.length >= 2);
  const details = res.details as { ref?: number; outcome?: string };
  assert.strictEqual(details.ref, 3);
  assert.strictEqual(details.outcome, "success");
  assert.ok((res.content[0].text ?? "").includes("Recorded episode at Ref 3"));
});

Deno.test("workflow_tools: memory_recall searches hybrid candidates and returns compact summary", async () => {
  const fakeHit = "3 0.85 2026-03-30:" + JSON.stringify({
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "Invariant: corm_open must alias live handles",
    context: { project: "site", subsystem: "libcorm" },
  }) + "\n";

  const { runner } = fakeRunner([
    { stdout: fakeHit, stderr: "", code: 0 },
  ]);

  const tool = makeRecallTool(() => Promise.resolve(makeEnv(runner)));
  const res = await runTool(tool, { query: "corm_open handle leak" });

  assert.ok(res.content[0].text?.includes("Found 1 relevant memory record(s)"));
  assert.ok(res.content[0].text?.includes("[Ref 3] (L2, supported [site/libcorm])"));
  assert.ok(res.content[0].text?.includes("Invariant: corm_open must alias live handles"));
});

Deno.test("workflow_tools: memory_review inspects memory hierarchy and updates lifecycle", async () => {
  const fakeL2 = JSON.stringify({
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "Invariant: corm_open must alias live handles",
    evidence: [2],
  });
  const fakeL0 = JSON.stringify({
    level: "L0",
    type: "episode",
    lifecycle: "supported",
    summary: "Episode: Fixed corm_open leak",
    episode: {
      problem: "Fix corm_open leak",
      approaches: [{ approach: "alias check", outcome: "worked", reason: "reused handle" }],
    },
  });

  const { runner } = fakeRunner([
    { stdout: `2026-03-30:${fakeL2}\n`, stderr: "", code: 0 }, // fetchEnvelope ref 3
    { stdout: `2026-03-30:${fakeL2}\n`, stderr: "", code: 0 }, // traverseDown root
    { stdout: `2026-03-30:${fakeL0}\n`, stderr: "", code: 0 }, // traverseDown child 2
  ]);

  const tool = makeReviewTool(() => Promise.resolve(makeEnv(runner)));

  // 1. Inspect
  const resInspect = await runTool(tool, { ref: 3, action: "inspect" });
  assert.ok(resInspect.content[0].text?.includes("Review Inspection for Ref 3"));
  assert.ok(resInspect.content[0].text?.includes("Invariant: corm_open must alias live handles"));
  assert.ok(resInspect.content[0].text?.includes("Ref 2"));

  // 2. Update lifecycle
  const { runner: runner2 } = fakeRunner([
    { stdout: `2026-03-30:${fakeL2}\n`, stderr: "", code: 0 }, // get ref 3
    { stdout: "", stderr: "", code: 0 },                        // store updated ref 3
  ]);
  const tool2 = makeReviewTool(() => Promise.resolve(makeEnv(runner2)));
  const resUpdate = await runTool(tool2, {
    ref: 3,
    action: "update_lifecycle",
    lifecycle: "superseded",
    reason: "Replaced by ref 10 with enhanced locking",
    evidenceRef: 10,
  });

  const d = resUpdate.details as { previousState?: string; currentState?: string };
  assert.strictEqual(d.previousState, "supported");
  assert.strictEqual(d.currentState, "superseded");
});
