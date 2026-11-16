import assert from "node:assert";
import { makeScanTool } from "../src/tools/scan.ts";
import { fakeRunner, runTool, okResult } from "./fake-corm.ts";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { encodePayload, bytesToBinaryString as b2s } from "../src/payload.ts";
import { give, type ToolEnv } from "../src/tools/index.ts";
import type { CormRunner } from "../src/corm.ts";

const CWD = await Deno.makeTempDir({ prefix: "mm-ranking-cwd-" });
const ctx = { cwd: CWD, hasUI: false, mode: "agent" };

function now(): Date {
  return new Date("2026-10-14T12:00:00Z");
}

function env(runner: CormRunner, cfg: Partial<MmConfig> = {}): ToolEnv {
  return {
    cwd: CWD,
    runner,
    nowProvider: now,
    cfg: { ...DEFAULT_CONFIG, cormBin: "/usr/bin/corm", ...cfg },
  };
}

Deno.test("scan: ranking prefers supported over contradicted and hypothesized", async () => {
  const supportedRecord = encodePayload("2026-10-14", {
    level: "L2",
    lifecycle: "supported",
    summary: "Proven cache invalidation pattern",
    evidence: [1, 2],
  });
  const hypothesizedRecord = encodePayload("2026-10-14", {
    level: "L2",
    lifecycle: "hypothesized",
    summary: "Unverified cache hypothesis",
  });
  const contradictedRecord = encodePayload("2026-10-14", {
    level: "L2",
    lifecycle: "contradicted",
    summary: "Disproven cache hypothesis",
  });

  const runner = fakeRunner([
    // Return all three records with same base score
    okResult(`1 1.000000 ${b2s(hypothesizedRecord)}\n2 1.000000 ${b2s(contradictedRecord)}\n3 1.000000 ${b2s(supportedRecord)}\n`),
  ]);

  const tool = makeScanTool(give(env(runner)));
  const res = await runTool(tool, { topic: "cache" }, ctx);

  const details = res.details as { records: Array<{ ref: number; lifecycle?: string }> };
  assert.strictEqual(details.records.length, 3);
  // Supported record (ref 3) should rank 1st due to lifecycle weight + evidence bonus
  assert.strictEqual(details.records[0].ref, 3);
  assert.strictEqual(details.records[0].lifecycle, "supported");
  // Hypothesized (ref 1) should rank 2nd
  assert.strictEqual(details.records[1].ref, 1);
  assert.strictEqual(details.records[1].lifecycle, "hypothesized");
  // Contradicted (ref 2) should rank last
  assert.strictEqual(details.records[2].ref, 2);
  assert.strictEqual(details.records[2].lifecycle, "contradicted");
});

Deno.test("scan: ranking boosts records matching project scope", async () => {
  const matchingProject = encodePayload("2026-10-14", {
    level: "L2",
    lifecycle: "supported",
    summary: "Auth invariant for site",
    context: { project: "site" },
  });
  const otherProject = encodePayload("2026-10-14", {
    level: "L2",
    lifecycle: "supported",
    summary: "Auth invariant for client",
    context: { project: "other-client" },
  });

  const runner = fakeRunner([
    okResult(`1 1.000000 ${b2s(otherProject)}\n2 1.000000 ${b2s(matchingProject)}\n`),
  ]);

  const tool = makeScanTool(give(env(runner)));
  const res = await runTool(tool, { topic: "auth", project: "site" }, ctx);

  const details = res.details as { records: Array<{ ref: number }> };
  // Ref 2 matches project: "site" so it passes filter and ranks first
  assert.strictEqual(details.records.length, 1);
  assert.strictEqual(details.records[0].ref, 2);
});

Deno.test("scan: ranking preserves question-form L1 conversational memories and notes", async () => {
  const questionRecord = encodePayload("2026-10-22", {
    level: "L1",
    type: "note",
    lifecycle: "observed",
    summary: "Do you remember anything about grand dad?",
  });
  const statementRecord = encodePayload("2026-10-22", {
    level: "L1",
    type: "note",
    lifecycle: "observed",
    summary: "Recall if I said or asked something about my grandfather.",
  });

  const runner = fakeRunner([
    okResult(`1 1.000000 ${b2s(questionRecord)}\n2 0.950000 ${b2s(statementRecord)}\n`),
  ]);

  const tool = makeScanTool(give(env(runner)));
  const res = await runTool(tool, { topic: "grandfather" }, ctx);

  const details = res.details as { records: Array<{ ref: number; summary?: string }> };
  assert.strictEqual(details.records.length, 2);
  assert.strictEqual(details.records[0].ref, 1);
  assert.strictEqual(details.records[0].summary, "Do you remember anything about grand dad?");
  assert.strictEqual(details.records[1].ref, 2);
  assert.strictEqual(details.records[1].summary, "Recall if I said or asked something about my grandfather.");
});

Deno.test("recall: preserves rankingScore order (L2 > L1 > L0) instead of sorting by ascending ref and deduplicates redundant L0 evidence children", async () => {
  const { makeRecallTool } = await import("../src/tools/recall.ts");
  const rawL0 = encodePayload("2026-11-10", {
    level: "L0",
    type: "episode",
    lifecycle: "observed",
    summary: "Commit pi-mm",
  });
  const consolidatedL1 = encodePayload("2026-11-10", {
    level: "L1",
    type: "note",
    lifecycle: "observed",
    summary: "Commit pi-mm",
    evidence: [1],
  });
  const highRankL2 = encodePayload("2026-11-12", {
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "pi-mm must preserve relevance ranking order in executeTargetedHybridRecall",
    evidence: [10],
  });

  const runner = fakeRunner([
    okResult(`1 1.000000 ${b2s(rawL0)}\n20 1.000000 ${b2s(consolidatedL1)}\n50 1.000000 ${b2s(highRankL2)}\n`),
  ]);

  const recallTool = makeRecallTool(give(env(runner)));
  const res = await runTool(recallTool, { query: "pi-mm", scope: "persistent" }, ctx);
  const details = res.details as { results: Array<{ ref: number; level?: string }> };

  // 1. Ref 50 (L2 supported) must rank 1st even though its ref ID (50) is highest
  assert.strictEqual(details.results[0].ref, 50);
  // 2. Ref 20 (L1) must be kept while Ref 1 (redundant L0 child with identical summary cited in evidence: [1]) is deduplicated
  assert.strictEqual(details.results.length, 2);
  assert.strictEqual(details.results[1].ref, 20);
  assert.ok(!details.results.some((r) => r.ref === 1), "redundant L0 evidence child with identical summary must be collapsed");
});
