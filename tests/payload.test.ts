import assert from "node:assert";
import { encodePayload, decodePayload, splitRawPayload } from "../src/payload.ts";
import type { MemoryEnvelope } from "../src/types.ts";

Deno.test("splitRawPayload splits ISO dates and plain colons", () => {
  const r1 = splitRawPayload("2026-09-14:Beacon Harbor lights");
  assert.strictEqual(r1.date, "2026-09-14");
  assert.strictEqual(r1.text, "Beacon Harbor lights");

  const r2 = splitRawPayload("2026-09-14T12:00:00.000Z:test payload");
  assert.strictEqual(r2.date, "2026-09-14T12:00:00.000Z");
  assert.strictEqual(r2.text, "test payload");

  const r3 = splitRawPayload("plain string without date");
  assert.strictEqual(r3.date, "");
  assert.strictEqual(r3.text, "plain string without date");
});

Deno.test("encodePayload formats strictly as <DATE>:<JSON>", () => {
  const envelope: MemoryEnvelope = {
    level: "L0",
    type: "episode",
    lifecycle: "observed",
    summary: "Fixed cursor move issue",
    episode: {
      request: "Investigate cursor position",
      steps: ["checked escape sequence", "ran test"],
      observations: ["cursor was off by 1"],
      diffs: ["--- a/view.c\n+++ b/view.c"],
      outcome: "success",
    },
    context: {
      project: "site",
      subsystem: "axil-nd",
      module: "nd-view",
      grid: { x: 5, y: 12 },
    },
  };

  const encoded = encodePayload("2026-09-15", envelope);
  assert.strictEqual(encoded.startsWith("2026-09-15:{"), true);

  const decoded = decodePayload(encoded);
  assert.strictEqual(decoded.date, "2026-09-15");
  assert.strictEqual(decoded.envelope.level, "L0");
  assert.strictEqual(decoded.envelope.type, "episode");
  assert.strictEqual(decoded.envelope.lifecycle, "observed");
  assert.strictEqual(decoded.envelope.summary, "Fixed cursor move issue");
  assert.strictEqual(decoded.envelope.episode?.request, "Investigate cursor position");
  assert.strictEqual(decoded.envelope.episode?.observations?.[0], "cursor was off by 1");
  assert.strictEqual(decoded.envelope.context?.grid?.x, 5);
});

Deno.test("decodePayload gracefully falls back for legacy plain text", () => {
  const legacy = "2026-09-14:Beacon Harbor lights";
  const decoded = decodePayload(legacy);
  assert.strictEqual(decoded.date, "2026-09-14");
  assert.strictEqual(decoded.envelope.level, "L2");
  assert.strictEqual(decoded.envelope.type, "note");
  assert.strictEqual(decoded.envelope.lifecycle, "observed");
  assert.strictEqual(decoded.envelope.summary, "Beacon Harbor lights");
});

Deno.test("decodePayload handles evidence links and utility feedback", () => {
  const envelope: MemoryEnvelope = {
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "XY cross-module boundary rule",
    evidence: [101, 102],
    utility: {
      usedCount: 3,
      irrelevantCount: 0,
      obsoleteCount: 0,
      lastOutcome: "useful",
    },
  };

  const raw = encodePayload("2026-09-16", envelope);
  const decoded = decodePayload(raw);
  assert.strictEqual(decoded.envelope.level, "L2");
  assert.deepStrictEqual(decoded.envelope.evidence, [101, 102]);
  assert.strictEqual(decoded.envelope.utility?.usedCount, 3);
  assert.strictEqual(decoded.envelope.utility?.lastOutcome, "useful");
});
