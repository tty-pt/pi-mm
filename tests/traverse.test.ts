import assert from "node:assert";
import { makeTraverseTool } from "../src/tools/traverse.ts";
import { makeScanTool } from "../src/tools/scan.ts";
import { fakeRunner, runTool, okResult } from "./fake-qmap.ts";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { encodePayload } from "../src/payload.ts";
import { give, type ToolEnv } from "../src/tools/index.ts";
import type { QmapRunner } from "../src/qmap.ts";

const CWD = await Deno.makeTempDir({ prefix: "mm-traverse-cwd-" });
const ctx = { cwd: CWD, hasUI: false, mode: "agent" };

function now(): Date {
  return new Date("2026-09-15T10:00:00");
}

function env(runner: QmapRunner, cfg: Partial<MmConfig> = {}): ToolEnv {
  return {
    cwd: CWD,
    runner,
    nowProvider: now,
    cfg: { ...DEFAULT_CONFIG, qmapBin: "/usr/bin/qmap", ...cfg },
  };
}

Deno.test("traverse down: recursively gathers evidence tree", async () => {
  const l0 = {
    level: "L0" as const,
    lifecycle: "supported" as const,
    summary: "Observed cursor reset glitch",
  };
  const l1 = {
    level: "L1" as const,
    lifecycle: "tested" as const,
    summary: "Hypothesis: relative vs absolute VT100 moves",
    evidence: [1],
  };
  const l2 = {
    level: "L2" as const,
    lifecycle: "supported" as const,
    summary: "Invariant: view rendering must not use absolute reset",
    evidence: [2],
  };

  const runner = fakeRunner([
    okResult(encodePayload("2026-09-15", l2)), // get 3 (root)
    okResult(encodePayload("2026-09-14", l1)), // get 2
    okResult(encodePayload("2026-09-13", l0)), // get 1
  ]);

  const tool = makeTraverseTool(give(env(runner)));
  const res = await runTool(tool, { ref: 3, direction: "down" }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.root, 3);
  assert.strictEqual(details.direction, "down");
  assert.strictEqual(details.visitedCount, 3);

  const tree = details.tree as { ref: number; children: Array<{ ref: number; children: Array<{ ref: number }> }> };
  assert.strictEqual(tree.ref, 3);
  assert.strictEqual(tree.children[0].ref, 2);
  assert.strictEqual(tree.children[0].children[0].ref, 1);
});

Deno.test("traverse down: guards against circular evidence references", async () => {
  const nodeA = {
    level: "L1" as const,
    lifecycle: "supported" as const,
    summary: "Node A",
    evidence: [2],
  };
  const nodeB = {
    level: "L1" as const,
    lifecycle: "supported" as const,
    summary: "Node B",
    evidence: [1], // Circular reference back to 1
  };

  const runner = fakeRunner([
    okResult(encodePayload("2026-09-15", nodeA)), // get 1
    okResult(encodePayload("2026-09-15", nodeB)), // get 2
    // get 1 again would be circular and should NOT be called
  ]);

  const tool = makeTraverseTool(give(env(runner)));
  const res = await runTool(tool, { ref: 1, direction: "down" }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.visitedCount, 2);
});

Deno.test("traverse up: discovers higher abstractions citing this evidence", async () => {
  const l0 = {
    level: "L0" as const,
    lifecycle: "supported" as const,
    summary: "Raw episode 1",
  };
  const l1 = {
    level: "L1" as const,
    lifecycle: "tested" as const,
    summary: "Investigation citing episode 1",
    evidence: [1],
  };

  const runner = fakeRunner([
    okResult("1\n2\n"),                          // list all refs
    okResult(encodePayload("2026-09-13", l0)), // get 1 (root)
    okResult(encodePayload("2026-09-14", l1)), // get candidate 2
    okResult(encodePayload("2026-09-14", l1)), // get parent 2 for recursion
  ]);

  const tool = makeTraverseTool(give(env(runner)));
  const res = await runTool(tool, { ref: 1, direction: "up" }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.root, 1);
  assert.strictEqual(details.direction, "up");
  const tree = details.tree as { ref: number; parents: Array<{ ref: number }> };
  assert.strictEqual(tree.parents[0].ref, 2);
});

Deno.test("scan: filters records by mipmap level and lifecycle", async () => {
  const epL0 = encodePayload("2026-09-15", {
    level: "L0",
    lifecycle: "supported",
    summary: "Cursor debug session",
  });
  const invL2 = encodePayload("2026-09-15", {
    level: "L2",
    lifecycle: "supported",
    summary: "Cursor invariant rule",
  });
  const oldL2 = encodePayload("2026-09-14", {
    level: "L2",
    lifecycle: "superseded",
    summary: "Old cursor theory",
  });

  const runner = fakeRunner([
    okResult(`1 1.000000 ${epL0}\n2 0.900000 ${invL2}\n3 0.800000 ${oldL2}\n`),
  ]);

  const tool = makeScanTool(give(env(runner)));

  // Scan with level = L2 and lifecycle = supported: only ref 2 should pass
  const res = await runTool(tool, { topic: "cursor", level: "L2", lifecycle: "supported" }, ctx);
  const details = res.details as { records: Array<{ ref: number; level?: string; lifecycle?: string }> };

  assert.strictEqual(details.records.length, 1);
  assert.strictEqual(details.records[0].ref, 2);
  assert.strictEqual(details.records[0].level, "L2");
  assert.strictEqual(details.records[0].lifecycle, "supported");
});

Deno.test("traverse down: detects missing evidence references", async () => {
  const l2 = {
    level: "L2" as const,
    lifecycle: "supported" as const,
    summary: "Rule citing non-existent evidence 99",
    evidence: [99],
  };

  const runner = fakeRunner([
    okResult(encodePayload("2026-09-15", l2)), // get root
    okResult(""), // get 99 fails / not found
  ]);

  const tool = makeTraverseTool(give(env(runner)));
  const res = await runTool(tool, { ref: 1, direction: "down" }, ctx);

  const details = res.details as Record<string, unknown>;
  const tree = details.tree as { ref: number; missingEvidence?: number[] };
  assert.deepStrictEqual(tree.missingEvidence, [99]);
});
