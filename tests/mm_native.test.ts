import assert from "node:assert";
import { getMmAddon, isMmNativeAvailable } from "../src/mm_native.ts";
import {
  adaptiveRrfK,
  isTechnicalInquiry,
  isCodeOrDocArtifact,
  isQuestionMemory,
  isAssistantEcho,
  fuseRankingsRRF,
  computeRankingScore,
  filterAndEnrich,
} from "../src/tools/ranking.ts";
import { levelWindow } from "../src/window.ts";
import { isCleanSummaryText } from "../src/payload.ts";
import { classifyPromptIntent } from "../src/hooks/auto_recall.ts";
import { scanSourceSymbolsNative } from "../src/code/scanner.ts";
import { detectComponentVersion } from "../src/versions.ts";

Deno.test("mm_native: loads @tty-pt/mm N-API addon in-process and accelerates ranking/fusion/window/payload/scanner/versions", () => {
  assert.strictEqual(isMmNativeAvailable(), true, "libmm native N-API addon should be loaded in-process");
  const addon = getMmAddon()!;
  assert.ok(addon);

  // 1. Verify ranking.ts delegates cleanly to libmm C functions
  assert.strictEqual(adaptiveRrfK(0), 10);
  assert.strictEqual(adaptiveRrfK(12), 24);
  assert.strictEqual(isTechnicalInquiry("mm_fusion.c"), true);
  assert.strictEqual(isTechnicalInquiry("What is your favorite color?"), false);
  assert.strictEqual(
    isCodeOrDocArtifact({ ref: 1, record: "#include <stdio.h>", origin: "lemma", rrfScore: 0.1 }, {
      level: "L1",
      lifecycle: "observed",
      summary: "#include <stdio.h>",
    }),
    true,
  );
  assert.strictEqual(
    isQuestionMemory({ ref: 1, record: "", origin: "lemma", rrfScore: 0.1 }, {
      level: "L1",
      lifecycle: "observed",
      summary: "Do you remember the port?",
    }),
    true,
  );
  assert.strictEqual(
    isAssistantEcho({ ref: 1, record: "", origin: "lemma", rrfScore: 0.1 }, {
      level: "L1",
      lifecycle: "observed",
      summary: "You mentioned — the port is 8081",
    }),
    true,
  );

  // 2. Verify RRF fusion + computeRankingScore via C addon
  const fused = fuseRankingsRRF(
    [
      { ref: 10, score: "0.90", record: `2026-11-17:${JSON.stringify({ level: "L2", lifecycle: "supported", summary: "Native C RRF" })}` },
      { ref: 20, score: "0.70", record: `2026-11-17:${JSON.stringify({ level: "L1", lifecycle: "contradicted", summary: "Bad claim" })}` },
    ],
    [
      { ref: 10, score: "0.95", record: `2026-11-17:${JSON.stringify({ level: "L2", lifecycle: "supported", summary: "Native C RRF" })}` },
    ],
    10,
  );
  assert.strictEqual(fused.length, 2);
  assert.strictEqual(fused[0].ref, 10);
  assert.strictEqual(fused[0].origin, "both");
  assert.strictEqual(fused[0].lexicalScore, "0.90");
  assert.strictEqual(fused[0].semanticScore, "0.95");

  const enriched = filterAndEnrich(fused, { limit: 5 });
  assert.strictEqual(enriched.length, 2);
  assert.ok((enriched[0].rankingScore ?? 0) > (enriched[1].rankingScore ?? 0) * 5);

  const score = computeRankingScore(enriched[0], { limit: 5 });
  assert.ok(score > 0.1);

  // 3. Verify window.ts delegation to addon.windowForLevel
  const d = new Date("2026-09-15T12:00:00");
  assert.strictEqual(levelWindow(0, d), null);
  assert.deepStrictEqual(levelWindow(1, d), { a: "2026-09-15", b: "2026-09-16" });
  assert.deepStrictEqual(levelWindow(2, d), { a: "2026-09-01", b: "2026-10-01" });
  assert.strictEqual(levelWindow(3, d), null);

  // 4. Verify payload.ts isCleanSummaryText + addon payloadEncode/payloadDecode
  assert.strictEqual(isCleanSummaryText("Valid clean summary text"), true);
  assert.strictEqual(isCleanSummaryText("\x01\x02\x03\x04\x05\x06\x07\x08"), false);
  const enc = addon.payloadEncode(JSON.stringify({ level: "L2", lifecycle: "supported", summary: "Roundtrip test" }));
  assert.ok(enc.bytes.byteLength > 10);
  const dec = JSON.parse(addon.payloadDecode(enc.bytes));
  assert.strictEqual(dec.summary, "Roundtrip test");

  // 5. Verify auto_recall.ts classifyPromptIntent delegation
  assert.strictEqual(classifyPromptIntent("Always use memory_recall before grep"), "directive");
  assert.strictEqual(classifyPromptIntent("Do you remember how we fixed the socket?"), "recall");
  assert.strictEqual(classifyPromptIntent("Give me the architecture overview"), "overview");
  assert.strictEqual(classifyPromptIntent("Who calls mm_open?"), "wondering");

  // 6. Verify code/scanner.ts scanSourceSymbolsNative via addon
  const syms = scanSourceSymbolsNative(
    "sample.c",
    "int multiply_pair(int x, int y) {\n  return x * y;\n}\n",
    1,
  );
  assert.strictEqual(syms.length, 1);
  assert.strictEqual(syms[0].name, "multiply_pair");
  assert.strictEqual(syms[0].kind, "Function");

  // 7. Verify versions.ts detects libmm >= 1.0.0
  const verRep = detectComponentVersion("libmm");
  assert.ok(verRep);
  assert.strictEqual(verRep.installed, true);
  assert.strictEqual(verRep.status, "satisfied");
});
