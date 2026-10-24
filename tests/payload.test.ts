import assert from "node:assert";
import {
  encodePayload,
  encodeLegacyJsonPayload,
  decodePayload,
  splitRawPayload,
  encodeHtokPayload,
  decodeHtokPayload,
  isHtokPayload,
  HTOK_MAGIC,
  HTOK_VERSION,
  HTOK_TYPE_TOKENS,
  HTOK_TYPE_UUID,
  HTOK_TYPE_HISTORY,
  FLAG_HAS_SUPERSEDES,
  FLAG_HAS_SUPERSEDED_BY,
  FLAG_HAS_EVIDENCE,
  writeVarint,
  readVarint,
  packTriad,
  unpackTriad,
  packVarTag,
  unpackVarTag,
} from "../src/payload.ts";
import { packTokens, unpackTokens, encodeTokens, decodeTokens } from "../src/tok.ts";
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

Deno.test("encodeHtokPayload formats strictly as HTOK binary container", () => {
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

  const encoded = encodeHtokPayload("2026-09-15", envelope);
  assert.ok(isHtokPayload(encoded), "encodeHtokPayload must emit HTOK binary container");

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

  const raw = encodeHtokPayload("2026-09-16", envelope);
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
  const rawCompact = encodeLegacyJsonPayload("2026-10-20", envelope);

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
  const reEncoded = encodeLegacyJsonPayload(decodedLegacy.date, decodedLegacy.envelope);
  assert.ok(reEncoded.startsWith("2026-10-15:{\"_v\":1,"));

  const reDecoded = decodePayload(reEncoded);
  assert.strictEqual(reDecoded.envelope.summary, "Legacy verbose note");
  assert.strictEqual(reDecoded.envelope.level, "L1");
  assert.deepStrictEqual(reDecoded.envelope.evidence, [42]);
});

Deno.test("HTOK binary container: encodeHtokPayload and decodePayload roundtrip flawlessly", () => {
  const envelope: MemoryEnvelope = {
    level: "L0",
    type: "episode",
    lifecycle: "observed",
    summary: "Fixed segfault in liblemma tokenizer",
    episode: {
      request: "Investigate crash in lemma_tok_decode",
      problem: "Buffer overflow on oversized tokens",
      approaches: [
        { approach: "Increase buffer capacity", outcome: "worked", reason: "buffer was too small" },
      ],
      findings: ["Capacity check was missing"],
      diffs: ["--- a/tok.c\n+++ b/tok.c"],
      outcome: "success",
    },
    context: {
      project: "site",
      subsystem: "liblemma",
      module: "tok",
    },
    tags: ["c", "bugfix"],
    evidence: [77, 88],
  };

  const htokBytes = encodeHtokPayload("2026-10-22", envelope);
  assert.ok(isHtokPayload(htokBytes), "Payload must be detected as HTOK");

  const decoded = decodePayload(htokBytes);
  assert.strictEqual(decoded.date, "2026-10-22");
  assert.strictEqual(decoded.envelope.level, "L0");
  assert.strictEqual(decoded.envelope.type, "episode");
  assert.strictEqual(decoded.envelope.lifecycle, "observed");
  assert.strictEqual(decoded.envelope.summary, "Fixed segfault in liblemma tokenizer");
  assert.strictEqual(decoded.envelope.episode?.problem, "Buffer overflow on oversized tokens");
  assert.strictEqual(decoded.envelope.episode?.approaches?.[0]?.approach, "Increase buffer capacity");
  assert.strictEqual(decoded.envelope.episode?.approaches?.[0]?.outcome, "worked");
  assert.deepStrictEqual(decoded.envelope.evidence, [77, 88]);
  assert.deepStrictEqual(decoded.envelope.tags, ["c", "bugfix"]);
  assert.strictEqual(decoded.envelope.context?.project, "site");
  assert.strictEqual(decoded.envelope.context?.subsystem, "liblemma");
});

Deno.test("HTOK v3 layout: exact header structure and bitmask permutations", () => {
  // 1. Standard record with no optional fields (flags == 0x00) -> exactly 16 bytes header
  const envStandard: MemoryEnvelope = {
    level: "L0",
    type: "episode",
    lifecycle: "tested",
    summary: "Base test",
  };
  const b1 = encodeHtokPayload("2026-10-22", envStandard, 3);
  const v1 = new DataView(b1.buffer, b1.byteOffset, b1.byteLength);

  assert.strictEqual(v1.getUint32(0, true), HTOK_MAGIC, "Magic must match HTOK");
  assert.strictEqual(v1.getUint16(4, true), 3, "Version must be 3");
  const ts1 = v1.getUint32(6, true);
  assert.ok(ts1 > 0, "Timestamp at offset 6 must be positive unix epoch");
  assert.strictEqual(v1.getUint8(10), 0, "Level L0 -> 0");
  assert.strictEqual(v1.getUint8(11), 2, "Lifecycle tested -> 2");
  assert.strictEqual(v1.getUint8(12), 0, "Type episode -> 0");
  assert.strictEqual(v1.getUint8(13), 0x00, "Flags must be 0x00");
  // Field count is at offset 14 (total header: 16 bytes)
  const fc1 = v1.getUint16(14, true);
  assert.ok(fc1 >= 1, "Field count at offset 14 must be >= 1");

  // 2. Flags: FLAG_HAS_SUPERSEDES (0x01)
  const envSup: MemoryEnvelope = {
    ...envStandard,
    supersedes: 1234,
  };
  const bSup = encodeHtokPayload("2026-10-22", envSup, 3);
  const vSup = new DataView(bSup.buffer, bSup.byteOffset, bSup.byteLength);
  assert.strictEqual(vSup.getUint8(13) & FLAG_HAS_SUPERSEDES, FLAG_HAS_SUPERSEDES);
  assert.strictEqual(vSup.getUint32(14, true), 1234, "supersedes must be at offset 14");
  const fcSup = vSup.getUint16(18, true);
  assert.ok(fcSup >= 1, "Field count must be at offset 18");

  // 3. Flags: FLAG_HAS_SUPERSEDED_BY (0x02)
  const envSupBy: MemoryEnvelope = {
    ...envStandard,
    supersededBy: 5678,
  };
  const bSupBy = encodeHtokPayload("2026-10-22", envSupBy, 3);
  const vSupBy = new DataView(bSupBy.buffer, bSupBy.byteOffset, bSupBy.byteLength);
  assert.strictEqual(vSupBy.getUint8(13) & FLAG_HAS_SUPERSEDED_BY, FLAG_HAS_SUPERSEDED_BY);
  assert.strictEqual(vSupBy.getUint32(14, true), 5678, "supersededBy must be at offset 14");
  const fcSupBy = vSupBy.getUint16(18, true);
  assert.ok(fcSupBy >= 1, "Field count must be at offset 18");

  // 4. Flags: FLAG_HAS_EVIDENCE (0x04)
  const envEvid: MemoryEnvelope = {
    ...envStandard,
    evidence: [99, 100],
  };
  const bEvid = encodeHtokPayload("2026-10-22", envEvid, 3);
  const vEvid = new DataView(bEvid.buffer, bEvid.byteOffset, bEvid.byteLength);
  assert.strictEqual(vEvid.getUint8(13) & FLAG_HAS_EVIDENCE, FLAG_HAS_EVIDENCE);
  assert.strictEqual(vEvid.getUint16(14, true), 2, "evidence count must be at offset 14");
  assert.strictEqual(vEvid.getUint32(16, true), 99);
  assert.strictEqual(vEvid.getUint32(20, true), 100);
  const fcEvid = vEvid.getUint16(24, true);
  assert.ok(fcEvid >= 1, "Field count must be at offset 24");

  // 5. Compound flags: 0x07 (supersedes + supersededBy + evidence)
  const envAll: MemoryEnvelope = {
    ...envStandard,
    supersedes: 111,
    supersededBy: 222,
    evidence: [333],
  };
  const bAll = encodeHtokPayload("2026-10-22", envAll, 3);
  const vAll = new DataView(bAll.buffer, bAll.byteOffset, bAll.byteLength);
  assert.strictEqual(vAll.getUint8(13), 0x07);
  assert.strictEqual(vAll.getUint32(14, true), 111);
  assert.strictEqual(vAll.getUint32(18, true), 222);
  assert.strictEqual(vAll.getUint16(22, true), 1);
  assert.strictEqual(vAll.getUint32(24, true), 333);
  const fcAll = vAll.getUint16(28, true);
  assert.ok(fcAll >= 1);

  // Verify full roundtrip decode of compound record
  const decAll = decodePayload(bAll);
  assert.strictEqual(decAll.envelope.supersedes, 111);
  assert.strictEqual(decAll.envelope.supersededBy, 222);
  assert.deepStrictEqual(decAll.envelope.evidence, [333]);
});

Deno.test("HTOK v3 LEB128 varint token packing: specification examples and zero interleaved nulls", () => {
  // Test explicit examples from specification:
  // Range 0..127: emitted as 1 byte
  const asciiTokens = new Uint16Array([
    32, // ' ' -> 0x20
    47, // '/' -> 0x2F
    45, // '-' -> 0x2D
  ]);
  const packedAscii = packTokens(asciiTokens);
  assert.strictEqual(packedAscii.length, 3, "Each ASCII character must take exactly 1 byte");
  assert.strictEqual(packedAscii[0], 0x20);
  assert.strictEqual(packedAscii[1], 0x2f);
  assert.strictEqual(packedAscii[2], 0x2d);

  // Range 128..16383:
  // Token 512: 512 & 0x7F = 0 -> 0x80; 512 >> 7 = 4 -> 0x04 => [0x80, 0x04]
  const tok512 = new Uint16Array([512]);
  const packed512 = packTokens(tok512);
  assert.strictEqual(packed512.length, 2);
  assert.strictEqual(packed512[0], 0x80);
  assert.strictEqual(packed512[1], 0x04);

  // Token 1000 ("investigation"): 1000 & 0x7F = 104 (0x68) -> 0xE8; 1000 >> 7 = 7 (0x07) => [0xE8, 0x07]
  const tok1000 = new Uint16Array([1000]);
  const packed1000 = packTokens(tok1000);
  assert.strictEqual(packed1000.length, 2);
  assert.strictEqual(packed1000[0], 0xe8);
  assert.strictEqual(packed1000[1], 0x07);

  // Lossless roundtrip unpackTokens
  const mixedTokens = new Uint16Array([32, 47, 45, 512, 1000, 65, 66, 16383]);
  const packedMixed = packTokens(mixedTokens);
  const unpacked = unpackTokens(packedMixed);
  assert.deepStrictEqual(unpacked, mixedTokens);

  // Text encoding lossless roundtrip without interleaved nulls
  const text = "path/to/subsystem-test.c: investigate memory issue 42";
  const encodedToks = encodeTokens(text);
  const packedText = packTokens(encodedToks);
  // In v2, every ASCII character had a 0x00 trailing byte (token < 256). In v3, ASCII is 1 byte without 0x00.
  // Count zero bytes in packed text:
  let zeroCount = 0;
  for (let i = 0; i < packedText.length; i++) {
    if (packedText[i] === 0) zeroCount++;
  }
  assert.strictEqual(zeroCount, 0, "Varint packed text stream must have 0 null bytes");
  assert.strictEqual(decodeTokens(unpackTokens(packedText)), text);
});

Deno.test("HTOK v3 history transitions: binary struct with native timestamps and tokenized reasons", () => {
  const envelope: MemoryEnvelope = {
    level: "L1",
    type: "investigation",
    lifecycle: "supported",
    summary: "Investigation into tokenizer memory bounds",
    history: [
      {
        from: "observed",
        to: "tested",
        timestamp: "2026-10-22T13:11:07.000Z",
        reason: "verified with test_runner",
        evidenceRef: 42,
      },
      {
        from: "tested",
        to: "supported",
        timestamp: "2026-10-22T14:20:00.000Z",
        reason: "cross-verified with reproduction script",
        evidenceRef: 43,
      },
    ],
  };

  const bytes = encodeHtokPayload("2026-10-22", envelope);
  const decoded = decodePayload(bytes);

  assert.ok(decoded.envelope.history, "History must be decoded");
  assert.strictEqual(decoded.envelope.history?.length, 2);

  const h0 = decoded.envelope.history[0];
  assert.strictEqual(h0.from, "observed");
  assert.strictEqual(h0.to, "tested");
  assert.strictEqual(h0.timestamp, "2026-10-22T13:11:07.000Z");
  assert.strictEqual(h0.evidenceRef, 42);
  assert.strictEqual(h0.reason, "verified with test_runner");

  const h1 = decoded.envelope.history[1];
  assert.strictEqual(h1.from, "tested");
  assert.strictEqual(h1.to, "supported");
  assert.strictEqual(h1.timestamp, "2026-10-22T14:20:00.000Z");
  assert.strictEqual(h1.evidenceRef, 43);
  assert.strictEqual(h1.reason, "cross-verified with reproduction script");
});

Deno.test("HTOK v3 session identifier: 16-byte raw UUID compression", () => {
  const standardUuid = "01a163a1-63cc-9e0b-73b3-b425f9088512";
  const envelope: MemoryEnvelope = {
    level: "L0",
    type: "episode",
    lifecycle: "observed",
    summary: "UUID session test",
    episode: {
      problem: "UUID session test",
      sessionId: standardUuid,
      sessionFile: "/tmp/sessions/synthetic.jsonl",
    },
  };

  const bytes = encodeHtokPayload("2026-10-22", envelope, 3);

  // Inspect the raw bytes to ensure ep_sid was stored as HTOK_TYPE_UUID (3) with exactly 16 bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fieldCount = view.getUint16(14, true);
  let offset = 16;
  let foundSid = false;

  for (let f = 0; f < fieldCount && offset < bytes.length; f++) {
    const nameLen = bytes[offset++];
    const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLen));
    offset += nameLen;
    const typeTag = bytes[offset++];
    const dataLen = view.getUint16(offset, true);
    offset += 2;
    const fieldData = bytes.subarray(offset, offset + dataLen);
    offset += dataLen;

    if (name === "ep_sid") {
      foundSid = true;
      assert.strictEqual(typeTag, HTOK_TYPE_UUID, "ep_sid type tag must be HTOK_TYPE_UUID (3)");
      assert.strictEqual(dataLen, 16, "ep_sid data length must be exactly 16 bytes (raw 128-bit UUID)");
    }
  }

  assert.ok(foundSid, "ep_sid field must be present in container");

  // Verify lossless roundtrip decode
  const decoded = decodePayload(bytes);
  assert.strictEqual(decoded.envelope.episode?.sessionId, standardUuid);
  assert.strictEqual(decoded.envelope.episode?.sessionFile, "/tmp/sessions/synthetic.jsonl");
});

Deno.test("HTOK v3 session file path compression: authentic Pi session omitted vs synthetic path preserved", () => {
  const sessId = "01a163a1-63cc-9e0b-73b3-b425f9088512";

  // Case A: Authentic Pi session file inside .pi/agent/sessions/
  const envReal: MemoryEnvelope = {
    level: "L0",
    type: "episode",
    lifecycle: "observed",
    summary: "Real session test",
    episode: {
      problem: "Real session test",
      sessionId: sessId,
      sessionFile: "/home/quirinpa/.pi/agent/sessions/--home-quirinpa-site--/2026-10-22T13-11-07-485Z_01a163a1-63cc-9e0b-73b3-b425f9088512.jsonl",
    },
  };

  const bReal = encodeHtokPayload("2026-10-22", envReal);
  const decReal = decodePayload(bReal);
  // ep_sfl is omitted in container to eliminate redundant 120-byte path and embedded ISO date
  assert.strictEqual(decReal.envelope.episode?.sessionFile, undefined, "ep_sfl must be omitted for authentic Pi session");
  assert.strictEqual(decReal.envelope.episode?.sessionId, sessId);

  // Case B: Synthetic test path outside .pi/agent/sessions/ (e.g. /tmp/...)
  const envSynth: MemoryEnvelope = {
    level: "L0",
    type: "episode",
    lifecycle: "observed",
    summary: "Synthetic session test",
    episode: {
      problem: "Synthetic session test",
      sessionId: sessId,
      sessionFile: "/tmp/sessions/mock_sess.jsonl",
    },
  };

  const bSynth = encodeHtokPayload("2026-10-22", envSynth);
  const decSynth = decodePayload(bSynth);
  assert.strictEqual(decSynth.envelope.episode?.sessionFile, "/tmp/sessions/mock_sess.jsonl", "Synthetic sessionFile must be preserved");
});

Deno.test("HTOK v3 null-byte elimination and record space efficiency", () => {
  const envelope: MemoryEnvelope = {
    level: "L0",
    type: "episode",
    lifecycle: "tested",
    summary: "Fixed segfault in liblemma tokenizer",
    episode: {
      request: "Investigate crash in lemma_tok_decode",
      problem: "Buffer overflow on oversized tokens",
      approaches: [
        { approach: "Increase buffer capacity", outcome: "worked", reason: "buffer was too small" },
      ],
      findings: ["Capacity check was missing"],
      diffs: ["--- a/tok.c\n+++ b/tok.c"],
      outcome: "success",
      sessionId: "01a163a1-63cc-9e0b-73b3-b425f9088512",
      sessionFile: "/home/quirinpa/.pi/agent/sessions/--site--/session.jsonl",
      leafId: "m_leaf123",
      runId: "run_456",
      toolCallId: "call_789",
    },
    context: {
      project: "site",
      subsystem: "liblemma",
      module: "tok",
    },
    tags: ["c", "bugfix"],
    history: [
      {
        from: "observed",
        to: "tested",
        timestamp: "2026-10-22T13:11:07.000Z",
        reason: "verified with test",
      },
    ],
  };

  const htokV3Bytes = encodeHtokPayload("2026-10-22", envelope);

  // Count null bytes
  let nullBytes = 0;
  for (let i = 0; i < htokV3Bytes.length; i++) {
    if (htokV3Bytes[i] === 0) nullBytes++;
  }

  const nullRatio = nullBytes / htokV3Bytes.length;
  // In v2, this 16-field record was >720 bytes with >340 null bytes (>47% nulls).
  // In v3, ep_sfl is omitted, ep_sid is raw 16-byte UUID, tokens are LEB128 varints (0 interleaved nulls),
  // and hist is binary.
  assert.ok(nullBytes <= 30, `Null byte count (${nullBytes}) must be <= 30 nulls (down from >340 nulls in v2)`);
  assert.ok(nullRatio < 0.08, `Null byte ratio (${(nullRatio * 100).toFixed(2)}%) must be < 8% (down from ~48% in v2)`);
  assert.ok(htokV3Bytes.length < 400, `Record size (${htokV3Bytes.length} bytes) must be < 400 bytes (down from >720 bytes in v2)`);

  // Verify the exact Section 5 typical record:
  // summary + ep_sid + ep_lid/rid/tid + hist (sessionFile omitted)
  const envSection5: MemoryEnvelope = {
    level: "L0",
    type: "episode",
    lifecycle: "tested",
    summary: "Fixed segfault in liblemma",
    episode: {
      sessionId: "01a163a1-63cc-9e0b-73b3-b425f9088512",
      sessionFile: "/home/quirinpa/.pi/agent/sessions/--site--/2026-10-22T13-11-07-485Z_01a163a1-63cc-9e0b-73b3-b425f9088512.jsonl",
      leafId: "m_leaf123",
      runId: "run_456",
      toolCallId: "call_789",
    },
    history: [
      {
        from: "observed",
        to: "tested",
        timestamp: "2026-10-22T13:11:07.000Z",
        reason: "verified with test",
        evidenceRef: 42,
      },
    ],
  };

  const bSec5 = encodeHtokPayload("2026-10-22", envSection5);
  // Spec target: ~190 bytes (v2: ~720 bytes, -73% space reduction)
  assert.ok(bSec5.length <= 190, `Section 5 record size (${bSec5.length} bytes) must be <= 190 bytes`);
  let sec5Nulls = 0;
  for (let i = 0; i < bSec5.length; i++) {
    if (bSec5[i] === 0) sec5Nulls++;
  }
  // In v2, this record had ~265 nulls (37%). In v3, token payloads have 0 nulls, ep_sfl is 0 nulls, ep_sid is 0 nulls.
  assert.ok(sec5Nulls <= 18, `Section 5 null count (${sec5Nulls}) must be <= 18 (eliminated >93% of v2 nulls)`);
});

Deno.test("HTOK backward compatibility: decodes v2 binary container with fixed 26-byte header", () => {
  // Synthesize an HTOK v2 payload with 26-byte header and fixed uint16 token fields
  const enc = new TextEncoder();
  const summaryTokens = encodeTokens("Legacy v2 summary record");
  const fieldName = enc.encode("text");

  const totalSize = 26 + 1 + fieldName.length + 2 + summaryTokens.length * 2;
  const v2Bytes = new Uint8Array(totalSize);
  const view = new DataView(v2Bytes.buffer);

  let offset = 0;
  view.setUint32(offset, HTOK_MAGIC, true); offset += 4;
  view.setUint16(offset, 2, true); offset += 2; // version 2
  view.setUint32(offset, 1729602000, true); offset += 4; // timestamp
  view.setUint8(offset++, 1); // level: L1 (1)
  view.setUint8(offset++, 3); // lifecycle: supported (3)
  view.setUint8(offset++, 1); // type: investigation (1)
  view.setUint8(offset++, 0); // reserved (flags in v3)
  view.setUint32(offset, 0, true); offset += 4; // supersedes
  view.setUint32(offset, 0, true); offset += 4; // supersededBy
  view.setUint16(offset, 0, true); offset += 2; // evid_count
  view.setUint16(offset, 1, true); offset += 2; // field_count (1 field)

  // Field: "text"
  v2Bytes[offset++] = fieldName.length;
  v2Bytes.set(fieldName, offset); offset += fieldName.length;
  view.setUint16(offset, summaryTokens.length, true); offset += 2;
  for (let i = 0; i < summaryTokens.length; i++) {
    view.setUint16(offset, summaryTokens[i], true);
    offset += 2;
  }

  assert.ok(isHtokPayload(v2Bytes), "Must be recognized as HTOK payload");
  const decoded = decodePayload(v2Bytes);
  assert.strictEqual(decoded.envelope.level, "L1");
  assert.strictEqual(decoded.envelope.type, "investigation");
  assert.strictEqual(decoded.envelope.lifecycle, "supported");
  assert.strictEqual(decoded.envelope.summary, "Legacy v2 summary record");
});

Deno.test("HTOK v4 triad packing and unpacking: 1-byte cognitive triad", () => {
  const levels = ["L0", "L1", "L2", "L3"] as const;
  const lifecycles = ["observed", "hypothesized", "tested", "supported", "contradicted", "superseded"] as const;
  const types = ["episode", "investigation", "decision", "invariant", "pattern", "note", "concept"] as const;

  for (const lvl of levels) {
    for (const lc of lifecycles) {
      for (const tp of types) {
        const packed = packTriad(lvl, lc, tp);
        assert.ok(packed >= 0 && packed <= 255, `Triad must fit in 1 byte, got ${packed}`);
        const unpacked = unpackTriad(packed);
        assert.strictEqual(unpacked.level, lvl);
        assert.strictEqual(unpacked.lifecycle, lc);
        assert.strictEqual(unpacked.type, tp);
      }
    }
  }
});

Deno.test("HTOK v4 VarTag field encoding and escape mechanism", () => {
  // 1. Core fields
  const tagText = packVarTag("text", HTOK_TYPE_TOKENS);
  assert.strictEqual(tagText.varTag, (0 << 3) | 1); // 0x01
  assert.strictEqual(tagText.customName, undefined);
  const upText = unpackVarTag(tagText.varTag);
  assert.strictEqual(upText.fieldName, "text");
  assert.strictEqual(upText.typeTag, HTOK_TYPE_TOKENS);
  assert.strictEqual(upText.isEscape, false);

  const tagEpSid = packVarTag("ep_sid", HTOK_TYPE_UUID);
  assert.strictEqual(tagEpSid.varTag, (18 << 3) | 3); // 0x93
  const upEpSid = unpackVarTag(tagEpSid.varTag);
  assert.strictEqual(upEpSid.fieldName, "ep_sid");
  assert.strictEqual(upEpSid.typeTag, HTOK_TYPE_UUID);

  const tagHist = packVarTag("hist", HTOK_TYPE_HISTORY);
  assert.strictEqual(tagHist.varTag, (25 << 3) | 4); // 0xCC
  const upHist = unpackVarTag(tagHist.varTag);
  assert.strictEqual(upHist.fieldName, "hist");
  assert.strictEqual(upHist.typeTag, HTOK_TYPE_HISTORY);

  // 2. Custom extension field (FieldID 31 escape)
  const tagCustom = packVarTag("custom_extension_field", HTOK_TYPE_TOKENS);
  assert.strictEqual(tagCustom.varTag, (31 << 3) | 1);
  assert.strictEqual(tagCustom.customName, "custom_extension_field");
  const upCustom = unpackVarTag(tagCustom.varTag);
  assert.strictEqual(upCustom.isEscape, true);
});

Deno.test("HTOK v4 LEB128 varint utilities", () => {
  const testValues = [0, 1, 42, 127, 128, 255, 256, 370, 16383, 16384, 65535, 1000000];
  for (const val of testValues) {
    const encoded = writeVarint(val);
    const { value, bytesRead } = readVarint(encoded, 0);
    assert.strictEqual(value, val);
    assert.strictEqual(bytesRead, encoded.length);
  }
});

Deno.test("HTOK v4 delta citation arrays: sorted ascending and 0 null bytes", () => {
  // Citations 370..377
  const citations = [377, 372, 370, 371, 375, 373, 374, 376];
  const envelope: MemoryEnvelope = {
    level: "L1",
    type: "investigation",
    lifecycle: "supported",
    summary: "Delta citation run test",
    evidence: citations,
  };

  const v4Bytes = encodeHtokPayload("2026-10-22", envelope, 4);
  const view = new DataView(v4Bytes.buffer, v4Bytes.byteOffset, v4Bytes.byteLength);
  assert.strictEqual(view.getUint32(0, true), HTOK_MAGIC);
  assert.strictEqual(view.getUint16(4, true), 4, "Version must be 4");

  // Lossless roundtrip decode (citations returned sorted ascending)
  const decoded = decodePayload(v4Bytes);
  assert.deepStrictEqual(decoded.envelope.evidence, [370, 371, 372, 373, 374, 375, 376, 377]);
});

Deno.test("HTOK v4 layout and lossless roundtrip with backward compatibility", () => {
  const envelope: MemoryEnvelope = {
    level: "L0",
    type: "episode",
    lifecycle: "tested",
    summary: "Fixed segfault in liblemma tokenizer",
    evidence: [370, 371, 375],
    supersedes: 300,
    supersededBy: 400,
    tags: ["c", "bugfix"],
    context: {
      project: "site",
      subsystem: "libcorm",
      module: "lemma",
    },
    episode: {
      problem: "Oversized token overflow",
      approaches: [
        { approach: "Increase buffer", outcome: "worked", reason: "buffer resolved overflow" },
      ],
      findings: ["Boundary check missing"],
      diffs: ["--- a/tok.c\n+++ b/tok.c"],
      sessionId: "01a163a1-63cc-9e0b-73b3-b425f9088512",
      leafId: "leaf_1",
      runId: "run_1",
      toolCallId: "call_1",
    },
    history: [
      {
        from: "observed",
        to: "tested",
        timestamp: "2026-10-22T13:11:07.000Z",
        reason: "verified with unit tests",
        evidenceRef: 370,
      },
    ],
  };

  // 1. Encode in v4
  const v4Bytes = encodeHtokPayload("2026-10-22", envelope, 4);
  const v4View = new DataView(v4Bytes.buffer, v4Bytes.byteOffset, v4Bytes.byteLength);
  assert.strictEqual(v4View.getUint16(4, true), 4, "Default must be version 4");

  // 2. Decode v4
  const decodedV4 = decodePayload(v4Bytes);
  assert.strictEqual(decodedV4.date, "2026-10-22");
  assert.strictEqual(decodedV4.envelope.level, "L0");
  assert.strictEqual(decodedV4.envelope.type, "episode");
  assert.strictEqual(decodedV4.envelope.lifecycle, "tested");
  assert.strictEqual(decodedV4.envelope.summary, "Fixed segfault in liblemma tokenizer");
  assert.deepStrictEqual(decodedV4.envelope.evidence, [370, 371, 375]);
  assert.strictEqual(decodedV4.envelope.supersedes, 300);
  assert.strictEqual(decodedV4.envelope.supersededBy, 400);
  assert.deepStrictEqual(decodedV4.envelope.tags, ["c", "bugfix"]);
  assert.strictEqual(decodedV4.envelope.context?.project, "site");
  assert.strictEqual(decodedV4.envelope.episode?.sessionId, "01a163a1-63cc-9e0b-73b3-b425f9088512");
  assert.strictEqual(decodedV4.envelope.history?.length, 1);
  assert.strictEqual(decodedV4.envelope.history?.[0].reason, "verified with unit tests");

  // 3. Compare sizes: v4 should be substantially smaller than v3
  const v3Bytes = encodeHtokPayload("2026-10-22", envelope, 3);
  assert.ok(v4Bytes.length < v3Bytes.length, `v4 (${v4Bytes.length}B) must be smaller than v3 (${v3Bytes.length}B)`);

  // Count null bytes in v4 vs v3
  let v3Nulls = 0;
  for (let i = 0; i < v3Bytes.length; i++) if (v3Bytes[i] === 0) v3Nulls++;
  let v4Nulls = 0;
  for (let i = 0; i < v4Bytes.length; i++) if (v4Bytes[i] === 0) v4Nulls++;

  assert.ok(v4Nulls < v3Nulls, `v4 nulls (${v4Nulls}) must be strictly fewer than v3 nulls (${v3Nulls})`);

  // 4. Backward compatibility: v4 decoder reading v3
  const decodedFromV3 = decodeHtokPayload(v3Bytes);
  assert.strictEqual(decodedFromV3.envelope.summary, envelope.summary);
  assert.strictEqual(decodedFromV3.envelope.level, envelope.level);
  assert.deepStrictEqual(decodedFromV3.envelope.evidence, envelope.evidence);
});

Deno.test("HTOK v4 expanded system vocabulary tokens encode losslessly as single tokens", () => {
  const newWords = [
    "memory_recall",
    "memory_record",
    "memory_review",
    "playwright",
    "cormd",
    "e2e",
    "libjoint",
    "libislet",
    "libsepal",
    "liblemma",
    "libcorm",
  ];

  for (const word of newWords) {
    const tokens = encodeTokens(word);
    assert.strictEqual(tokens.length, 1, `Word '${word}' must encode as exactly 1 token`);
    assert.ok(tokens[0] >= 512, `Token ID for '${word}' (${tokens[0]}) must be >= 512`);
    const decoded = decodeTokens(tokens);
    assert.strictEqual(decoded, word, `Decoded word must equal '${word}'`);
  }
});


