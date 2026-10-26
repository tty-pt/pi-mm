import assert from "node:assert";
import { fuseRankingsRRF, computeRankingScore, filterAndEnrich, adaptiveRrfK } from "../src/tools/ranking.ts";
import { executeHybridScan } from "../src/tools/scan.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ResultLine } from "../src/corm.ts";
import type { MemoryEnvelope } from "../src/types.ts";

Deno.test("hybrid: fuseRankingsRRF calculates accurate reciprocal rank scores", () => {
  const lex: ResultLine[] = [
    { ref: 10, score: "0.95", record: "2026-03-30:lexical first" },
    { ref: 20, score: "0.80", record: "2026-03-30:lexical second" },
  ];
  const sem: ResultLine[] = [
    { ref: 30, score: "0.99", record: "2026-03-30:semantic first" },
    { ref: 10, score: "0.91", record: "2026-03-30:semantic second" },
  ];

  const fused = fuseRankingsRRF(lex, sem, 60);

  // ref 10 is in both: rank 1 in lex (1/61), rank 2 in sem (1/62)
  const ref10 = fused.find((c) => c.ref === 10);
  assert.ok(ref10);
  assert.strictEqual(ref10.origin, "both");
  assert.strictEqual(ref10.lexicalRank, 1);
  assert.strictEqual(ref10.semanticRank, 2);
  const expectedRef10Score = (1 / 61) + (1 / 62);
  assert.ok(Math.abs(ref10.rrfScore - expectedRef10Score) < 1e-9);

  // ref 30 is semantic only: rank 1 in sem (1/61)
  const ref30 = fused.find((c) => c.ref === 30);
  assert.ok(ref30);
  assert.strictEqual(ref30.origin, "sepal");
  assert.strictEqual(ref30.semanticRank, 1);
  assert.strictEqual(ref30.lexicalRank, undefined);
  assert.ok(Math.abs(ref30.rrfScore - (1 / 61)) < 1e-9);

  // ref 20 is lexical only: rank 2 in lex (1/62)
  const ref20 = fused.find((c) => c.ref === 20);
  assert.ok(ref20);
  assert.strictEqual(ref20.origin, "lemma");
  assert.strictEqual(ref20.lexicalRank, 2);
  assert.strictEqual(ref20.semanticRank, undefined);
  assert.ok(Math.abs(ref20.rrfScore - (1 / 62)) < 1e-9);

  // Candidate in both must outrank single-hit candidates
  assert.strictEqual(fused[0].ref, 10);
  assert.strictEqual(fused[1].ref, 30);
  assert.strictEqual(fused[2].ref, 20);
});

Deno.test("hybrid: returns semantic candidates when lexical path finds zero hits", () => {
  const lex: ResultLine[] = [];
  const sem: ResultLine[] = [
    { ref: 42, score: "0.87", record: "2026-03-30:paraphrased hit" },
  ];

  const fused = fuseRankingsRRF(lex, sem, 60);
  assert.strictEqual(fused.length, 1);
  assert.strictEqual(fused[0].ref, 42);
  assert.strictEqual(fused[0].origin, "sepal");
  assert.ok(Math.abs(fused[0].rrfScore - (1 / 61)) < 1e-9);
});

Deno.test("hybrid: returns lexical candidates when semantic path is empty or disabled", () => {
  const lex: ResultLine[] = [
    { ref: 101, score: "1.00", record: "2026-03-30:exact symbol match" },
  ];
  const sem: ResultLine[] = [];

  const fused = fuseRankingsRRF(lex, sem, 60);
  assert.strictEqual(fused.length, 1);
  assert.strictEqual(fused[0].ref, 101);
  assert.strictEqual(fused[0].origin, "lemma");
  assert.ok(Math.abs(fused[0].rrfScore - (1 / 61)) < 1e-9);
});

Deno.test("hybrid: multi-factor ranking respects lifecycle, provenance, and scope", () => {
  const baseCand = {
    ref: 1,
    record: "2026-03-30:{}",
    origin: "lemma" as const,
    rrfScore: 0.05,
  };

  const supportedEnv: MemoryEnvelope = {
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "Supported rule",
    evidence: [99],
    context: { project: "site", subsystem: "corm" },
  };

  const hypothesizedEnv: MemoryEnvelope = {
    ...supportedEnv,
    lifecycle: "hypothesized",
    evidence: [],
    context: { project: "other" },
  };

  const supersededEnv: MemoryEnvelope = {
    ...supportedEnv,
    lifecycle: "superseded",
  };

  const scoreSupported = computeRankingScore(
    { ...baseCand, envelope: supportedEnv },
    { limit: 10, project: "site" },
  );

  const scoreHypothesized = computeRankingScore(
    { ...baseCand, envelope: hypothesizedEnv },
    { limit: 10, project: "site" },
  );

  const scoreSuperseded = computeRankingScore(
    { ...baseCand, envelope: supersededEnv },
    { limit: 10, project: "site" },
  );

  assert.ok(scoreSupported > scoreHypothesized, "Supported with evidence and matching project must outrank hypothesized");
  assert.ok(scoreHypothesized > scoreSuperseded, "Hypothesized must outrank superseded");
});

Deno.test("hybrid: filterAndEnrich preserves candidate origins and formats score", () => {
  const rawCand = {
    ref: 5,
    record: "2026-03-30:" + JSON.stringify({
      level: "L1",
      type: "investigation",
      lifecycle: "tested",
      summary: "Investigation into memory leak",
    }),
    origin: "both" as const,
    rrfScore: 0.032,
    lexicalScore: "0.5",
    semanticScore: "0.85",
  };

  const enriched = filterAndEnrich([rawCand], { limit: 10 });
  assert.strictEqual(enriched.length, 1);
  assert.strictEqual(enriched[0].ref, 5);
  assert.strictEqual(enriched[0].origin, "both");
  assert.strictEqual(enriched[0].level, "L1");
  assert.strictEqual(enriched[0].lifecycle, "tested");
  assert.ok(typeof enriched[0].score === "string");
  assert.ok(enriched[0].rankingScore! > 0);
});

Deno.test("hybrid: scan fallback preserves 2-letter tokens and filters stop words", async () => {
  const queriedTokens: string[] = [];
  const runner = {
    run: (inv: import("../src/corm.ts").Invocation) => {
      for (const arg of inv.args) {
        if (arg.startsWith("--query=")) {
          queriedTokens.push(arg.slice("--query=".length));
        }
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const env = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-10-15"),
    cfg: { ...DEFAULT_CONFIG, cormBin: "/usr/bin/corm", memDir: ".pi/mm" },
  };

  await executeHybridScan(env, {
    topic: "What about from my cv?",
    embed: false,
    limit: 5,
  });

  assert.ok(queriedTokens.includes("cv"), "2-letter token 'cv' must be queried");
  assert.strictEqual(queriedTokens.includes("what"), false, "stop word 'what' must be filtered");
  assert.strictEqual(queriedTokens.includes("about"), false, "stop word 'about' must be filtered");
  assert.strictEqual(queriedTokens.includes("from"), false, "stop word 'from' must be filtered");
  assert.strictEqual(queriedTokens.includes("my"), false, "stop word 'my' must be filtered");
});

Deno.test("hybrid: scan fallback on all-stop-words query degrades gracefully", async () => {
  const queriedTokens: string[] = [];
  const runner = {
    run: (inv: import("../src/corm.ts").Invocation) => {
      for (const arg of inv.args) {
        if (arg.startsWith("--query=")) {
          queriedTokens.push(arg.slice("--query=".length));
        }
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const env = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-10-15"),
    cfg: { ...DEFAULT_CONFIG, cormBin: "/usr/bin/corm", memDir: ".pi/mm" },
  };

  const res = await executeHybridScan(env, {
    topic: "what about that?",
    embed: false,
    limit: 5,
  });

  assert.ok(Array.isArray(res.records));
  assert.ok(queriedTokens.length > 0, "All-stop-words query must fall back to non-empty tokens");
});

Deno.test("hybrid: adaptiveRrfK computes dynamic smoothing constant with safe edge cases", () => {
  assert.strictEqual(adaptiveRrfK(0), 10);
  assert.strictEqual(adaptiveRrfK(1), 10);
  assert.strictEqual(adaptiveRrfK(2), 10);
  assert.strictEqual(adaptiveRrfK(10), 20);
  assert.strictEqual(adaptiveRrfK(25), 50);
  assert.strictEqual(adaptiveRrfK(50), 60);
  assert.strictEqual(adaptiveRrfK(100), 60);
});

Deno.test("hybrid: computeRankingScore penalizes code and syntax artifacts by 0.2 when L0 is not requested", () => {
  const codeEnv: MemoryEnvelope = {
    level: "L1",
    lifecycle: "supported",
    summary: "const isletFspec = `${cwd}/mem-islet.db@islet:a:s`;",
  };
  const cand = {
    ref: 1,
    record: "2026-10-15:code",
    origin: "lemma" as const,
    rrfScore: 0.1,
    envelope: codeEnv,
  };

  const normalScore = computeRankingScore(cand, { limit: 5 });
  const l0Score = computeRankingScore(cand, { limit: 5, mipmap: "L0" });

  assert.ok(normalScore < l0Score);
  assert.ok(Math.abs(normalScore - l0Score * 0.2) < 1e-6);
});
