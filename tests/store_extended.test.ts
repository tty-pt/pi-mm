import assert from "node:assert";
import { join } from "node:path";
import { makeStoreTool } from "../src/tools/store.ts";
import { makeLifecycleTool } from "../src/tools/lifecycle.ts";
import { makeFeedbackTool } from "../src/tools/feedback.ts";
import { fakeRunner, runTool, okResult } from "./fake-corm.ts";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { decodePayload, encodePayload } from "../src/payload.ts";
import { give, type ToolEnv } from "../src/tools/index.ts";
import type { CormRunner } from "../src/corm.ts";

const CWD = await Deno.makeTempDir({ prefix: "mm-store-cwd-" });
const ctx = { cwd: CWD, hasUI: false, mode: "agent" };

function now(): Date {
  return new Date("2026-09-15T10:00:00");
}

function env(runner: CormRunner, cfg: Partial<MmConfig> = {}): ToolEnv {
  try { Deno.removeSync(join(CWD, ".ref_seq")); } catch { /* ignore */ }
  try { Deno.removeSync(join(CWD, ".pi", "mm", ".ref_seq")); } catch { /* ignore */ }
  return {
    cwd: CWD,
    runner,
    nowProvider: now,
    cfg: { ...DEFAULT_CONFIG, cormBin: "/usr/bin/corm", ...cfg },
  };
}

Deno.test("store: storing L0 episode sets level L0 and serializes envelope", async () => {
  const runner = fakeRunner([
    okResult(""),
    okResult("1"),
  ]);

  const tool = makeStoreTool(give(env(runner)));
  const res = await runTool(tool, {
    episode: {
      request: "Fix memory leak in stoma index",
      steps: ["ran valgrind", "identified unfreed node"],
      observations: ["24 bytes leaked per query"],
      outcome: "success",
    },
    context: {
      project: "site",
      subsystem: "libcorm",
      module: "liblemma",
    },
  }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.ref, 1);
  assert.strictEqual(details.level, "L0");
  assert.strictEqual(details.lifecycle, "observed");

  const storedPayload = runner.invocations[1].payloadBytes ?? runner.invocations[1].args[1];
  const rawToDecode = storedPayload instanceof Uint8Array ? storedPayload : storedPayload.slice(storedPayload.indexOf(":") + 1);
  const { envelope } = decodePayload(rawToDecode);
  assert.strictEqual(envelope.level, "L0");
  assert.strictEqual(envelope.lifecycle, "observed");
  assert.strictEqual(envelope.episode?.request, "Fix memory leak in stoma index");
  assert.strictEqual(envelope.context?.module, "liblemma");
});

Deno.test("store: supersedes updates the prior memory to superseded", async () => {
  const oldEnvelope = {
    level: "L2" as const,
    lifecycle: "supported" as const,
    summary: "Old theory about leak",
  };
  const runner = fakeRunner([
    okResult("1"),
    okResult(""),
    okResult(encodePayload("2026-09-14", oldEnvelope)),
    okResult(""),
  ]);

  const tool = makeStoreTool(give(env(runner)));
  await runTool(tool, {
    summary: "New verified conclusion",
    level: "L2",
    supersedes: 1,
  }, ctx);

  assert.strictEqual(runner.invocations.length, 4);
  const oldRefPayload = runner.invocations[3].payloadBytes ?? runner.invocations[3].args[1];
  const { envelope } = decodePayload(oldRefPayload instanceof Uint8Array ? oldRefPayload : oldRefPayload.slice(oldRefPayload.indexOf(":") + 1));
  assert.strictEqual(envelope.lifecycle, "superseded");
  assert.strictEqual(envelope.supersededBy, 2);
  assert.strictEqual(envelope.history?.[0].to, "superseded");
});

Deno.test("lifecycle: transition state updates envelope and appends history", async () => {
  const existing = {
    level: "L1" as const,
    lifecycle: "hypothesized" as const,
    summary: "Hypothesis: race condition on handle close",
  };
  const runner = fakeRunner([
    okResult(encodePayload("2026-09-15", existing)),
    okResult(""),
  ]);

  const tool = makeLifecycleTool(give(env(runner)));
  const res = await runTool(tool, {
    ref: 5,
    lifecycle: "tested",
    reason: "Reproduced under multithreaded test harness",
    evidenceRef: 4,
  }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.previousState, "hypothesized");
  assert.strictEqual(details.currentState, "tested");

  const updatedPayload = runner.invocations[1].payloadBytes ?? runner.invocations[1].args[1];
  const { envelope } = decodePayload(updatedPayload instanceof Uint8Array ? updatedPayload : updatedPayload.slice(updatedPayload.indexOf(":") + 1));
  assert.strictEqual(envelope.lifecycle, "tested");
  assert.strictEqual(envelope.history?.[0].from, "hypothesized");
  assert.strictEqual(envelope.history?.[0].to, "tested");
  assert.strictEqual(envelope.history?.[0].evidenceRef, 4);
});

Deno.test("feedback: records useful and increments counters", async () => {
  const existing = {
    level: "L2" as const,
    lifecycle: "supported" as const,
    summary: "Always check corm_open aliasing",
    utility: { usedCount: 2, irrelevantCount: 0, obsoleteCount: 0 },
  };
  const runner = fakeRunner([
    okResult(encodePayload("2026-09-15", existing)),
    okResult(""),
  ]);

  const tool = makeFeedbackTool(give(env(runner)));
  const res = await runTool(tool, {
    ref: 8,
    utility: "useful",
    note: "Helped prevent handle duplication bug",
  }, ctx);

  const details = res.details as Record<string, unknown>;
  const util = details.utility as Record<string, unknown>;
  assert.strictEqual(util.usedCount, 3);
  assert.strictEqual(util.lastOutcome, "useful");

  const updatedPayload = runner.invocations[1].payloadBytes ?? runner.invocations[1].args[1];
  const { envelope } = decodePayload(updatedPayload instanceof Uint8Array ? updatedPayload : updatedPayload.slice(updatedPayload.indexOf(":") + 1));
  assert.strictEqual(envelope.utility?.usedCount, 3);
  assert.strictEqual(envelope.utility?.lastOutcome, "useful");
});

Deno.test("lifecycle: rejects transition out of superseded terminal state", async () => {
  const existing = {
    level: "L2" as const,
    lifecycle: "superseded" as const,
    summary: "Old obsolete conclusion",
  };
  const runner = fakeRunner([
    okResult(encodePayload("2026-09-15", existing)),
  ]);

  const tool = makeLifecycleTool(give(env(runner)));
  const res = await runTool(tool, {
    ref: 10,
    lifecycle: "supported",
    reason: "Attempting to un-supersede",
  }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.error, "invalid transition from superseded to supported");
});

Deno.test("lifecycle: requires reason or evidenceRef when contradicting", async () => {
  const existing = {
    level: "L2" as const,
    lifecycle: "supported" as const,
    summary: "Currently supported invariant",
  };
  const runner = fakeRunner([
    okResult(encodePayload("2026-09-15", existing)),
  ]);

  const tool = makeLifecycleTool(give(env(runner)));
  const res = await runTool(tool, {
    ref: 11,
    lifecycle: "contradicted",
  }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.error, "transition to contradicted requires a reason or evidenceRef");
});
