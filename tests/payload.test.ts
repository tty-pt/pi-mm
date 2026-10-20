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

Deno.test("payload optimization: compact encoding reduces payload size and preserves all fields", () => {
  const largeRequest = "A".repeat(5000);
  const largeProblem = "B".repeat(5000);
  const largeApproach = "C".repeat(2000);

  const envelope: MemoryEnvelope = {
    level: "L1",
    type: "investigation",
    lifecycle: "tested",
    summary: "Investigation into memory footprint",
    evidence: [201, 202, 203],
    supersedes: 150,
    supersededBy: 300,
    tags: ["perf", "corm"],
    context: {
      project: "site",
      subsystem: "pi-mm",
      module: "payload",
    },
    episode: {
      request: largeRequest,
      problem: largeProblem,
      approaches: [
        { approach: largeApproach, outcome: "worked", reason: "effective compression" },
      ],
      findings: ["Finding 1", "Finding 2"],
      outcome: "success",
      sessionId: "sess-abc-123",
      sessionFile: "/tmp/sess-abc-123.jsonl",
      leafId: "leaf_999",
    },
  };

  const rawLegacy = `2026-10-20:${JSON.stringify(envelope)}`;
  const rawCompact = encodePayload("2026-10-20", envelope);

  // Assert significant size reduction (>70% on large transcript-heavy records)
  assert.ok(rawCompact.length < rawLegacy.length * 0.3, `Expected >70% size reduction, got ${rawCompact.length} vs ${rawLegacy.length}`);

  // Assert compact payload format
  assert.ok(rawCompact.startsWith("2026-10-20:{\"_v\":1,"));

  // Assert decodePayload restores all essential fields
  const decoded = decodePayload(rawCompact);
  assert.strictEqual(decoded.date, "2026-10-20");
  assert.strictEqual(decoded.envelope.level, "L1");
  assert.strictEqual(decoded.envelope.type, "investigation");
  assert.strictEqual(decoded.envelope.lifecycle, "tested");
  assert.strictEqual(decoded.envelope.summary, "Investigation into memory footprint");
  assert.deepStrictEqual(decoded.envelope.evidence, [201, 202, 203]);
  assert.strictEqual(decoded.envelope.supersedes, 150);
  assert.strictEqual(decoded.envelope.supersededBy, 300);
  assert.deepStrictEqual(decoded.envelope.tags, ["perf", "corm"]);
  assert.strictEqual(decoded.envelope.context?.project, "site");
  assert.strictEqual(decoded.envelope.context?.subsystem, "pi-mm");

  // Transcript provenance pointers preserved for session_history lookup
  assert.strictEqual(decoded.envelope.episode?.sessionId, "sess-abc-123");
  assert.strictEqual(decoded.envelope.episode?.sessionFile, "/tmp/sess-abc-123.jsonl");
  assert.strictEqual(decoded.envelope.episode?.leafId, "leaf_999");
  assert.strictEqual(decoded.envelope.episode?.outcome, "success");
  assert.deepStrictEqual(decoded.envelope.episode?.findings, ["Finding 1", "Finding 2"]);

  // Oversized text fields are safely bounded
  assert.ok(decoded.envelope.episode?.request && decoded.envelope.episode.request.length <= 400);
  assert.ok(decoded.envelope.episode?.problem && decoded.envelope.episode.problem.length <= 400);
  assert.ok(decoded.envelope.episode?.approaches?.[0]?.approach && decoded.envelope.episode.approaches[0].approach.length <= 200);
});

Deno.test("payload optimization: decodePayload seamlessly reads both legacy verbose JSON and compact v1 JSON", () => {
  const legacyJson = JSON.stringify({
    level: "L1",
    type: "note",
    lifecycle: "observed",
    summary: "Legacy verbose note",
    evidence: [42],
    episode: {
      problem: "Legacy problem description",
      findings: ["legacy finding"],
      outcome: "success",
    },
  });

  const legacyPayload = `2026-10-15:${legacyJson}`;
  const decodedLegacy = decodePayload(legacyPayload);

  assert.strictEqual(decodedLegacy.date, "2026-10-15");
  assert.strictEqual(decodedLegacy.envelope.level, "L1");
  assert.strictEqual(decodedLegacy.envelope.type, "note");
  assert.strictEqual(decodedLegacy.envelope.lifecycle, "observed");
  assert.strictEqual(decodedLegacy.envelope.summary, "Legacy verbose note");
  assert.deepStrictEqual(decodedLegacy.envelope.evidence, [42]);
  assert.strictEqual(decodedLegacy.envelope.episode?.problem, "Legacy problem description");

  // Re-encoding converts it to compact v1 format
  const reEncoded = encodePayload(decodedLegacy.date, decodedLegacy.envelope);
  assert.ok(reEncoded.startsWith("2026-10-15:{\"_v\":1,"));

  const reDecoded = decodePayload(reEncoded);
  assert.strictEqual(reDecoded.envelope.summary, "Legacy verbose note");
  assert.strictEqual(reDecoded.envelope.level, "L1");
  assert.deepStrictEqual(reDecoded.envelope.evidence, [42]);
});
