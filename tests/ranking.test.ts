import assert from "node:assert";
import { makeScanTool } from "../src/tools/scan.ts";
import { fakeRunner, runTool, okResult } from "./fake-qmap.ts";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { encodePayload } from "../src/payload.ts";
import { give, type ToolEnv } from "../src/tools/index.ts";
import type { QmapRunner } from "../src/qmap.ts";

const CWD = await Deno.makeTempDir({ prefix: "mm-ranking-cwd-" });
const ctx = { cwd: CWD, hasUI: false, mode: "agent" };

function now(): Date {
  return new Date("2026-10-14T12:00:00Z");
}

function env(runner: QmapRunner, cfg: Partial<MmConfig> = {}): ToolEnv {
  return {
    cwd: CWD,
    runner,
    nowProvider: now,
    cfg: { ...DEFAULT_CONFIG, qmapBin: "/usr/bin/qmap", ...cfg },
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
    okResult(`1 1.000000 ${hypothesizedRecord}\n2 1.000000 ${contradictedRecord}\n3 1.000000 ${supportedRecord}\n`),
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
    okResult(`1 1.000000 ${otherProject}\n2 1.000000 ${matchingProject}\n`),
  ]);

  const tool = makeScanTool(give(env(runner)));
  const res = await runTool(tool, { topic: "auth", project: "site" }, ctx);

  const details = res.details as { records: Array<{ ref: number }> };
  // Ref 2 matches project: "site" so it passes filter and ranks first
  assert.strictEqual(details.records.length, 1);
  assert.strictEqual(details.records[0].ref, 2);
});
