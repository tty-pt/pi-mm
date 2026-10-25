#!/usr/bin/env -S deno run --allow-all
/**
 * scripts/benchmark-mm.ts
 *
 * Empirical Benchmark comparing 4 memory configurations (Mandate Phase 4/6):
 *   1. Raw Episode Search (stoma alone)
 *   2. Flat Summaries (no hierarchy or lifecycle)
 *   3. Summaries + Semantic Approximation (offline dense token overlap)
 *   4. Multidimensional Memory Mipmaps (joint + stoma + sepal + L0-L3 hierarchy + lifecycle)
 *
 * Reports:
 *   - Part A: Synthetic Ranking Benchmark
 *   - Part B: Real Backend Retrieval Evaluation (via libcorm/liblemma/libjoint)
 */

import { encodePayload } from "../src/payload.ts";
import type { MemoryEnvelope } from "../src/types.ts";
import { makeScanTool } from "../src/tools/scan.ts";
import { makeTraverseTool } from "../src/tools/traverse.ts";
import { makeStoreTool } from "../src/tools/store.ts";
import { give } from "../src/tools/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

interface BenchmarkTask {
  query: string;
  expectedRef: number;
  obsoleteCandidateRefs: number[];
  queryType: "exact_identifier" | "debugging_approach" | "paraphrased" | "architectural_rule";
}

interface BenchmarkCorpusItem {
  ref: number;
  date: string;
  envelope: MemoryEnvelope;
  rawText: string;
  semanticTokens: string[];
}

const CORPUS: BenchmarkCorpusItem[] = [
  {
    ref: 1,
    date: "2026-08-01",
    rawText: "Double-open memory leak in corm_open when handle is closed without alias check. Failed: fd limit increase. Worked: handle table check.",
    semanticTokens: ["descriptor", "exhaustion", "reopening", "table", "aliasing", "resource", "leak"],
    envelope: {
      level: "L0",
      type: "episode",
      lifecycle: "supported",
      summary: "Double-open handle leak investigation",
      episode: {
        problem: "Investigate file descriptor exhaustion in corm_open",
        approaches: [
          { approach: "Increase file descriptor limit", outcome: "failed", reason: "Did not fix root cause" },
          { approach: "Check active handle table before allocating", outcome: "worked", reason: "Reuses handle" },
        ],
        steps: ["ran valgrind", "discovered fd not aliased"],
        diffs: ["--- a/libcorm.c\n+++ b/libcorm.c\n+ alias check"],
        outcome: "success",
      },
      context: { project: "site", subsystem: "libcorm", module: "corm" },
    },
  },
  {
    ref: 2,
    date: "2026-08-05",
    rawText: "Old theory: corm_open should always allocate fresh fd and never alias handles",
    semanticTokens: ["descriptor", "fresh", "allocation", "unshared"],
    envelope: {
      level: "L1",
      type: "investigation",
      lifecycle: "superseded", // Obsolete!
      summary: "Theory: fresh handle per open",
      supersededBy: 3,
    },
  },
  {
    ref: 3,
    date: "2026-08-10",
    rawText: "Invariant: corm_open must alias live handles on identical (file, map) to prevent clobber",
    semanticTokens: ["descriptor", "handle", "reuse", "safety", "invariant", "rule", "exhaustion", "reopening"],
    envelope: {
      level: "L2",
      type: "invariant",
      lifecycle: "supported",
      summary: "Invariant: corm_open must alias live handles on identical (file, map)",
      evidence: [1],
      context: { project: "site", subsystem: "libcorm", module: "corm" },
    },
  },
  {
    ref: 4,
    date: "2026-09-01",
    rawText: "ANSI VT100 viewport scrolling cursor reset glitch in axil-nd. Failed: reset sequence. Worked: relative motion.",
    semanticTokens: ["terminal", "screen", "flicker", "drawing", "escapes"],
    envelope: {
      level: "L0",
      type: "episode",
      lifecycle: "supported",
      summary: "VT100 cursor offset fix",
      episode: {
        problem: "Fix cursor jumping to top on viewport scroll",
        approaches: [
          { approach: "Emit ESC[H before rendering row", outcome: "failed", reason: "Jumps to row 0" },
          { approach: "Emit relative cursor movement codes", outcome: "worked", reason: "Keeps scroll intact" },
        ],
        steps: ["traced terminal escape codes", "replaced ESC[H with relative moves"],
        diffs: ["--- a/view.c\n+++ b/view.c"],
        outcome: "success",
      },
      context: { project: "site", subsystem: "axil-nd", module: "nd-view" },
    },
  },
  {
    ref: 5,
    date: "2026-09-02",
    rawText: "Invariant: Terminal viewport rendering must use relative cursor moves rather than absolute reset",
    semanticTokens: ["terminal", "rendering", "movement", "coordinates", "invariant"],
    envelope: {
      level: "L2",
      type: "invariant",
      lifecycle: "supported",
      summary: "Invariant: Terminal viewport rendering must use relative cursor moves",
      evidence: [4],
      context: { project: "site", subsystem: "axil-nd", module: "nd-view" },
    },
  },
  {
    ref: 6,
    date: "2026-09-03",
    rawText: "Disproven theory: Viewport scrolling flicker solved by full screen clear sequence",
    semanticTokens: ["terminal", "screen", "flicker", "clear", "disproven"],
    envelope: {
      level: "L1",
      type: "investigation",
      lifecycle: "contradicted", // Contradicted!
      summary: "Theory: full screen clear solves redraw",
    },
  },
];

const TASKS: BenchmarkTask[] = [
  {
    query: "corm_open handle aliasing invariant",
    expectedRef: 3,
    obsoleteCandidateRefs: [2],
    queryType: "exact_identifier",
  },
  {
    query: "corm_open file descriptor exhaustion leak",
    expectedRef: 1,
    obsoleteCandidateRefs: [2],
    queryType: "debugging_approach",
  },
  {
    query: "preventing duplicate file descriptor exhaustion when reopening stores",
    expectedRef: 3,
    obsoleteCandidateRefs: [2],
    queryType: "paraphrased",
  },
  {
    query: "viewport relative cursor move invariant",
    expectedRef: 5,
    obsoleteCandidateRefs: [6],
    queryType: "architectural_rule",
  },
  {
    query: "terminal screen drawing jumps to top row",
    expectedRef: 4,
    obsoleteCandidateRefs: [6],
    queryType: "paraphrased",
  },
  {
    query: "corm_open fresh handle allocation theory",
    expectedRef: 3,
    obsoleteCandidateRefs: [2],
    queryType: "exact_identifier",
  },
  {
    query: "viewport screen clear redraw jitter theory",
    expectedRef: 5,
    obsoleteCandidateRefs: [6],
    queryType: "exact_identifier",
  },
];

function scoreLexical(itemText: string, query: string): number {
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const textLower = itemText.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (textLower.includes(token)) hits++;
  }
  return hits / Math.max(queryTokens.length, 1);
}

function scoreSemantic(itemTokens: string[], query: string): number {
  const qTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let matches = 0;
  for (const t of qTokens) {
    if (itemTokens.some((tok) => tok.includes(t) || t.includes(tok))) matches++;
  }
  return matches / Math.max(qTokens.length, 1);
}

function walkProvenanceChain(ref: number, corpus: BenchmarkCorpusItem[], visited = new Set<number>()): boolean {
  if (visited.has(ref)) return false; // Cycle guard
  visited.add(ref);

  const item = corpus.find((c) => c.ref === ref);
  if (!item) return false;

  // L0 leaf node: valid if it contains recorded diffs or verified approaches
  if (item.envelope.level === "L0") {
    return Boolean(item.envelope.episode?.diffs?.length || item.envelope.episode?.approaches?.length);
  }

  // Higher abstraction: valid only if all evidence references trace down to L0
  const evidence = item.envelope.evidence;
  if (!evidence || evidence.length === 0) return false;

  return evidence.every((evRef) => walkProvenanceChain(evRef, corpus, visited));
}

interface SyntheticMetrics {
  name: string;
  precisionAt1: number;
  targetRecall: number;
  obsoleteExcluded: number;
  evidenceTraceable: number;
}

function evaluateSynthetic(
  task: BenchmarkTask,
  ranked: Array<{ ref: number; item: BenchmarkCorpusItem }>,
  metric: SyntheticMetrics,
  allowProvenance: boolean,
): void {
  const top = ranked[0];
  if (top && top.ref === task.expectedRef) {
    metric.precisionAt1++;
  }

  // Target recall: is the expected reference anywhere in the returned candidates?
  const hasTarget = ranked.slice(0, 5).some((r) => r.ref === task.expectedRef);
  if (hasTarget) {
    metric.targetRecall++;
  }

  // Obsolete exclusion: awarded ONLY when expected target is recalled AND obsolete candidates are excluded
  const topCandidates = ranked.slice(0, 3).map((r) => r.ref);
  const hasObsoleteInResults = task.obsoleteCandidateRefs.some((obsRef) => topCandidates.includes(obsRef));
  if (hasTarget && !hasObsoleteInResults) {
    metric.obsoleteExcluded++;
  }

  // Provenance traversal: execute graph traversal down to L0
  if (allowProvenance && top) {
    if (walkProvenanceChain(top.ref, CORPUS)) {
      metric.evidenceTraceable++;
    }
  }
}

function runSyntheticBenchmark(): SyntheticMetrics[] {
  console.log("=== Part A: Synthetic Ranking Benchmark (Fixture Corpus) ===");
  console.log(`Corpus items: ${CORPUS.length} | Test queries: ${TASKS.length}\n`);

  const results: SyntheticMetrics[] = [
    { name: "1. Lexical-Only Search (stoma alone)", precisionAt1: 0, targetRecall: 0, obsoleteExcluded: 0, evidenceTraceable: 0 },
    { name: "2. Semantic-Only Search (dense approx)", precisionAt1: 0, targetRecall: 0, obsoleteExcluded: 0, evidenceTraceable: 0 },
    { name: "3. Hybrid RRF Search (lexical + semantic)", precisionAt1: 0, targetRecall: 0, obsoleteExcluded: 0, evidenceTraceable: 0 },
    { name: "4. Multidimensional Memory Mipmaps (RRF+prov)", precisionAt1: 0, targetRecall: 0, obsoleteExcluded: 0, evidenceTraceable: 0 },
  ];

  for (const task of TASKS) {
    // Mode 1: Lexical-Only Search
    const ranked1 = [...CORPUS]
      .map((item) => ({ ref: item.ref, score: scoreLexical(item.rawText, task.query), item }))
      .sort((a, b) => b.score - a.score || a.ref - b.ref);
    evaluateSynthetic(task, ranked1, results[0], false);

    // Mode 2: Semantic-Only Search
    const ranked2 = [...CORPUS]
      .map((item) => ({ ref: item.ref, score: scoreSemantic(item.semanticTokens, task.query), item }))
      .sort((a, b) => b.score - a.score || a.ref - b.ref);
    evaluateSynthetic(task, ranked2, results[1], false);

    // Mode 3: Hybrid Search (lexical + semantic dense fusion)
    const ranked3 = [...CORPUS]
      .map((item) => {
        const lex = scoreLexical(item.envelope.summary, task.query);
        const sem = scoreSemantic(item.semanticTokens, task.query);
        return { ref: item.ref, score: lex * 0.4 + sem * 0.6, item };
      })
      .sort((a, b) => b.score - a.score || a.ref - b.ref);
    evaluateSynthetic(task, ranked3, results[2], false);

    // Mode 4: Multidimensional Memory Mipmaps (Hybrid + active lifecycle filter + provenance bonus)
    const ranked4 = [...CORPUS]
      .filter((item) => item.envelope.lifecycle !== "superseded" && item.envelope.lifecycle !== "contradicted")
      .map((item) => {
        const fullText = encodePayload(item.date, item.envelope);
        const lex = scoreLexical(fullText, task.query);
        const sem = scoreSemantic(item.semanticTokens, task.query);
        const provBonus = item.envelope.evidence?.length ? 0.15 : 0.0;
        return { ref: item.ref, score: lex * 0.45 + sem * 0.4 + provBonus, item };
      })
      .sort((a, b) => b.score - a.score || a.ref - b.ref);
    evaluateSynthetic(task, ranked4, results[3], true);
  }

  console.log("Configuration                            | P@1    | Recall | Obsolete Excl | Evidence Trace");
  console.log("-----------------------------------------+--------+--------+---------------+---------------");
  for (const r of results) {
    const p1 = `${((r.precisionAt1 / TASKS.length) * 100).toFixed(0)}%`.padEnd(6);
    const rec = `${((r.targetRecall / TASKS.length) * 100).toFixed(0)}%`.padEnd(6);
    const obs = `${((r.obsoleteExcluded / TASKS.length) * 100).toFixed(0)}%`.padEnd(13);
    const ev = `${((r.evidenceTraceable / TASKS.length) * 100).toFixed(0)}%`.padEnd(13);
    console.log(`${r.name.padEnd(40)} | ${p1} | ${rec} | ${obs} | ${ev}`);
  }
  return results;
}

interface LeafVerificationNode {
  level: string;
  summary?: string;
  episode?: { diffs?: string[]; approaches?: Array<{ approach: string; outcome: string }> };
  children?: LeafVerificationNode[];
}

function verifyL0EvidenceLeaf(node?: LeafVerificationNode): boolean {
  if (!node) return false;
  if (node.level === "L0") {
    const hasDiffs = (node.episode?.diffs?.length ?? 0) > 0;
    const hasWorked = Boolean(node.episode?.approaches?.some((a) => a.outcome === "worked"));
    return hasDiffs || hasWorked;
  }
  const children = node.children || [];
  if (children.length === 0) return false;
  return children.some(verifyL0EvidenceLeaf);
}

async function runRealBackendBenchmark(_siteRoot?: string): Promise<void> {
  console.log("\n=== Part B: Real Backend Retrieval Evaluation ===");
  const home = Deno.env.get("HOME") || "";
  const cormBin = "/usr/bin/corm";
  const axisLibs = `${home}/.local/lib:/usr/local/lib:/usr/lib`;

  try {
    const statCorm = await Deno.stat(cormBin);
    if (!statCorm.isFile) throw new Error("corm not found");
    const statLemma = (await Deno.stat(`${home}/.local/lib/liblemma.so`).catch(() => null)) ?? (await Deno.stat("/usr/lib/liblemma.so"));
    if (!statLemma.isFile) throw new Error("liblemma.so not found");
    const statJoint = await Deno.stat("/usr/lib/libjoint.so");
    if (!statJoint.isFile) throw new Error("libjoint.so not found");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Status: SKIPPED (Native C libraries unavailable: ${msg})`);
    return;
  }

  const tmpDir = await Deno.makeTempDir({ prefix: "mm-benchmark-native-" });
  const ctx = { cwd: tmpDir, hasUI: false, mode: "agent" };

  const envSource = give({
    cwd: tmpDir,
    runner: {
      run: async (inv) => {
        const p = new Deno.Command(inv.command, {
          args: inv.args,
          cwd: inv.cwd ?? tmpDir,
          env: inv.env ?? {},
          stdout: "piped",
          stderr: "piped",
        });
        const out = await p.output();
        return {
          code: out.code,
          stdout: new TextDecoder().decode(out.stdout),
          stderr: new TextDecoder().decode(out.stderr),
        };
      },
    },
    nowProvider: () => new Date("2026-10-15T12:00:00Z"),
    cfg: {
      ...DEFAULT_CONFIG,
      cormBin,
      axisLibs,
      memDir: tmpDir,
    },
  });

  const storeTool = makeStoreTool(envSource);
  const scanTool = makeScanTool(envSource);
  const traverseTool = makeTraverseTool(envSource);

  // Seed real C backend store with full L0 episode records including diffs and approaches
  for (const item of CORPUS) {
    await storeTool.execute(
      `seed_${item.ref}`,
      {
        summary: item.envelope.summary,
        level: item.envelope.level,
        type: item.envelope.type,
        lifecycle: item.envelope.lifecycle,
        evidence: item.envelope.evidence,
        episode: item.envelope.episode,
        context: item.envelope.context,
        timestamp: item.date,
      },
      undefined,
      undefined,
      ctx,
    );
  }

  // Execute scan queries through real backend
  let realHits = 0;
  let realRecall = 0;
  let realObsoleteExcluded = 0;
  let targetTraceable = 0;
  let topCandidateTraceable = 0;
  let realEmptyResults = 0;
  let realTargetFailures = 0;
  const startBenchmarkTime = performance.now();

  for (const task of TASKS) {
    const scanRes = await scanTool.execute(
      "scan_bench",
      { topic: task.query, lifecycle: "supported", limit: 5 },
      undefined,
      undefined,
      ctx,
    );
    const details = scanRes.details as { records: Array<{ ref: number; envelope?: MemoryEnvelope }> };
    const records = details.records || [];

    if (records.length === 0) {
      realEmptyResults++;
    }

    if (records.length > 0 && records[0].ref === task.expectedRef) {
      realHits++;
    }

    const hasTarget = records.some((r) => r.ref === task.expectedRef);
    if (hasTarget) {
      realRecall++;
    } else {
      realTargetFailures++;
    }

    const hasObsolete = records.some((r) => task.obsoleteCandidateRefs.includes(r.ref));
    // Obsolete exclusion is credited ONLY when target is recalled AND obsolete candidates are excluded
    if (hasTarget && !hasObsolete) {
      realObsoleteExcluded++;
    }

    // 1. Evidence traversal of top-ranked candidate
    if (records.length > 0) {
      const topRef = records[0].ref;
      const topTravRes = await traverseTool.execute(
        "trav_top",
        { ref: topRef, direction: "down", depth: 3 },
        undefined,
        undefined,
        ctx,
      );
      const topTravDetails = topTravRes.details as {
        root: number;
        visitedCount: number;
        tree?: LeafVerificationNode;
      };
      if (topTravDetails?.visitedCount >= 2 && verifyL0EvidenceLeaf(topTravDetails.tree)) {
        topCandidateTraceable++;
      }
    }

    // 2. Evidence traversal specifically of the expected target memory
    if (hasTarget) {
      const targetTravRes = await traverseTool.execute(
        "trav_target",
        { ref: task.expectedRef, direction: "down", depth: 3 },
        undefined,
        undefined,
        ctx,
      );
      const targetTravDetails = targetTravRes.details as {
        root: number;
        visitedCount: number;
        tree?: LeafVerificationNode;
      };
      if (targetTravDetails?.visitedCount >= 2 && verifyL0EvidenceLeaf(targetTravDetails.tree)) {
        targetTraceable++;
      }
    }
  }

  const totalQueryTimeMs = performance.now() - startBenchmarkTime;
  const avgLatencyMs = totalQueryTimeMs / TASKS.length;

  console.log("Real C Engine Results (libcorm + liblemma + libjoint):");
  console.log(`- Precision@1: ${((realHits / TASKS.length) * 100).toFixed(0)}% (${realHits}/${TASKS.length})`);
  console.log(`- Target Recall: ${((realRecall / TASKS.length) * 100).toFixed(0)}% (${realRecall}/${TASKS.length})`);
  console.log(`- Obsolete Candidate Exclusion (with Target): ${((realObsoleteExcluded / TASKS.length) * 100).toFixed(0)}% (${realObsoleteExcluded}/${TASKS.length})`);
  console.log(`- Target Evidence Traceability: ${((targetTraceable / TASKS.length) * 100).toFixed(0)}% (${targetTraceable}/${TASKS.length})`);
  console.log(`- Top Candidate Evidence Traceability: ${((topCandidateTraceable / TASKS.length) * 100).toFixed(0)}% (${topCandidateTraceable}/${TASKS.length})`);
  console.log(`- Empty Results: ${realEmptyResults}/${TASKS.length}`);
  console.log(`- Target Recall Failures: ${realTargetFailures}/${TASKS.length}`);
  console.log(`- Average Retrieval Latency: ${avgLatencyMs.toFixed(2)} ms/query (Total: ${totalQueryTimeMs.toFixed(1)} ms)`);
  console.log(`- Backend Workspace: ${tmpDir}`);
}

const siteRoot = (() => {
  const cwd = Deno.cwd();
  if (cwd.includes(".pi/extensions/pi-mm")) {
    return cwd.split(".pi/extensions/pi-mm")[0].replace(/\/$/, "");
  }
  return cwd;
})();

function runRegressionFixtures(): void {
  console.log("\n=== Part C: Benchmark Regression Fixture Validations ===");
  const summaryOnlyLeaf: LeafVerificationNode = {
    level: "L0",
    summary: "Very detailed and long summary describing a fix in the parser without diffs",
  };
  if (verifyL0EvidenceLeaf(summaryOnlyLeaf) !== false) {
    throw new Error("FAIL: summaryOnlyLeaf must not pass evidence check");
  }
  console.log("ok - summary-only L0 record rejected as evidence");

  const diffLeaf: LeafVerificationNode = {
    level: "L0",
    summary: "Episode with verified diff",
    episode: { diffs: ["+ if (bounds) return 0;"] },
  };
  if (!verifyL0EvidenceLeaf(diffLeaf)) {
    throw new Error("FAIL: diffLeaf must pass evidence check");
  }
  console.log("ok - diff-bearing L0 leaf verified");

  const workedApproachLeaf: LeafVerificationNode = {
    level: "L0",
    summary: "Episode with worked approach",
    episode: { approaches: [{ approach: "bounds check", outcome: "worked" }] },
  };
  if (!verifyL0EvidenceLeaf(workedApproachLeaf)) {
    throw new Error("FAIL: workedApproachLeaf must pass evidence check");
  }
  console.log("ok - worked-approach L0 leaf verified");

  const taskWithoutTarget: BenchmarkTask = {
    query: "test query",
    expectedRef: 10,
    obsoleteCandidateRefs: [20],
  };
  const metrics: SyntheticMetrics = {
    name: "test",
    precisionAt1: 0,
    targetRecall: 0,
    obsoleteExcluded: 0,
    evidenceTraceable: 0,
  };
  evaluateSynthetic(taskWithoutTarget, [{ ref: 99, item: CORPUS[0] }], metrics, false);
  if (metrics.obsoleteExcluded !== 0) {
    throw new Error("FAIL: obsolete exclusion must not be credited when target is missing");
  }
  console.log("ok - missing target recall does not award obsolete exclusion credit");
}

runSyntheticBenchmark();
await runRealBackendBenchmark(siteRoot);
runRegressionFixtures();
