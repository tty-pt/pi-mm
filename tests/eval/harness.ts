// Shared measurement harness for "can embeddings replace the judge for this decision?",
// ported from pi-quest/tests/eval/harness.ts. A decision is a labelled corpus plus
// strategies (judge, embeddings). The harness reports accuracy, wrong state-changing
// verdicts, latency percentiles and every miss; `gateDecision` applies the adoption rule:
// embeddings must match or beat the judge's accuracy with ZERO wrong state-changing
// verdicts and no unavailable answers. Live runners are opt-in and never part of
// `npm test`; everything here that does not touch a server is unit-tested.
import type { MmConfig } from "../../src/config.ts";
import { callLlmJudge } from "../../src/judge/adapter.ts";
import { captureEmbedBase, captureEmbedModel, embedTexts } from "../../src/judge/embed.ts";
import { type Exemplar, gate, type GateOptions, nearestExemplar } from "../../src/judge/nearest.ts";

export interface Case {
  /** The user's prompt (the text embeddings classify). */
  text: string;
  /** The assistant's reply (judge context only). */
  response?: string;
  want: string;
}

export interface Strategy {
  name: string;
  /** The decided label, or null when the strategy is unavailable for this input. */
  classify: (c: Case) => Promise<string | null>;
  /** Cold-start work with its own generous timeout (model load, exemplar index build). */
  warmup?: () => Promise<void>;
}

export interface Report {
  name: string;
  total: number;
  correct: number;
  accuracy: number;
  /** Wrong verdicts whose label is state-changing (any such verdict is a gate failure). */
  falsePositives: number;
  /** falsePositives over the cases whose truth is NOT state-changing (informative; the gate uses the count). */
  falsePositiveRate: number;
  unavailable: number;
  p50Ms: number;
  p95Ms: number;
  misses: string[];
  byLabel: Record<string, { correct: number; total: number }>;
}

export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export async function evaluateStrategy(
  strategy: Strategy,
  corpus: readonly Case[],
  opts: { stateChanging: ReadonlySet<string>; warmup?: boolean },
): Promise<Report> {
  const first = corpus[0];
  if (opts.warmup !== false) {
    if (strategy.warmup !== undefined) await strategy.warmup();
    else if (first !== undefined) await strategy.classify(first);
  }
  const times: number[] = [];
  const misses: string[] = [];
  const byLabel: Report["byLabel"] = {};
  let correct = 0;
  let falsePositives = 0;
  let unavailable = 0;
  let negatives = 0;
  for (const c of corpus) {
    const slot = (byLabel[c.want] ??= { correct: 0, total: 0 });
    slot.total += 1;
    if (!opts.stateChanging.has(c.want)) negatives += 1;
    const t0 = performance.now();
    const got = await strategy.classify(c);
    times.push(Math.round(performance.now() - t0));
    if (got === null) {
      unavailable += 1;
      misses.push(`${c.text} => unavailable, want ${c.want}`);
      continue;
    }
    if (got === c.want) {
      correct += 1;
      slot.correct += 1;
    } else {
      misses.push(`${c.text} => ${got}, want ${c.want}`);
      if (opts.stateChanging.has(got)) falsePositives += 1;
    }
  }
  return {
    name: strategy.name,
    total: corpus.length,
    correct,
    accuracy: corpus.length === 0 ? 0 : correct / corpus.length,
    falsePositives,
    falsePositiveRate: negatives === 0 ? 0 : falsePositives / negatives,
    unavailable,
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    misses,
    byLabel,
  };
}

export function formatReport(decision: string, r: Report): string {
  return [
    `${decision} | ${r.name}: ${r.correct}/${r.total} correct, acc ${(r.accuracy * 100).toFixed(1)}%, ` +
      `fp ${r.falsePositives}/${r.total} (rate ${(r.falsePositiveRate * 100).toFixed(1)}%), ` +
      `unavailable ${r.unavailable}, p50 ${r.p50Ms}ms, p95 ${r.p95Ms}ms`,
    `  per label: ${Object.entries(r.byLabel).map(([k, v]) => `${k} ${v.correct}/${v.total}`).join(", ")}`,
    ...r.misses.map((m) => `  miss: ${m}`),
  ].join("\n");
}

export interface GateDecision {
  adopt: boolean;
  reason: string;
}

/** The adoption rule. A judge that could not be measured never makes embeddings "win" silently. */
export function gateDecision(embed: Report, judge: Report | null): GateDecision {
  if (embed.falsePositives > 0) return { adopt: false, reason: `${embed.falsePositives} false state-changing verdicts` };
  if (embed.unavailable > 0) return { adopt: false, reason: `${embed.unavailable} answers unavailable (server down?)` };
  if (judge === null) return { adopt: false, reason: "judge not measured; nothing to compare against" };
  if (judge.unavailable > 0) return { adopt: false, reason: `judge unavailable for ${judge.unavailable} cases; comparison unsound` };
  if (embed.accuracy < judge.accuracy) {
    return { adopt: false, reason: `embeddings ${(embed.accuracy * 100).toFixed(1)}% < judge ${(judge.accuracy * 100).toFixed(1)}%` };
  }
  return {
    adopt: true,
    reason: `embeddings ${(embed.accuracy * 100).toFixed(1)}% >= judge ${(judge.accuracy * 100).toFixed(1)}%, 0 false state-changing verdicts`,
  };
}

// ---- live strategies --------------------------------------------------------------------

/** Embedding strategy: nearest exemplar to the USER prompt through the production gate. */
export function embedStrategy(cfg: MmConfig, examples: readonly Exemplar[], gateOptions: GateOptions): Strategy {
  return {
    name: `embeddings(${captureEmbedModel(cfg)})`,
    classify: async (c) => {
      const v = await nearestExemplar(cfg, examples, c.text);
      return v === null ? null : gate(v, gateOptions);
    },
  };
}

/** Cold model loads can take over a minute; the production timeout would abort them. */
export const JUDGE_WARMUP_TIMEOUT_MS = 180_000;
/** The judge's QUALITY is measured with a long timeout; its real latency is the p50/p95 reported. */
export const JUDGE_QUALITY_TIMEOUT_MS = 30_000;

/** Judge strategy: the production capture judge (remember | skip | update), unavailable on any error. */
export function judgeStrategy(cfg: MmConfig): Strategy {
  const quality: MmConfig = { ...cfg, judgeProtocol: "systemone", judgeTimeoutMs: JUDGE_QUALITY_TIMEOUT_MS };
  return {
    name: `judge(${cfg.judgeModel ?? "default"})`,
    classify: async (c) => {
      try {
        return (await callLlmJudge(c.text, c.response ?? "", quality)).action;
      } catch {
        return null;
      }
    },
    warmup: async () => {
      try {
        await callLlmJudge("hello", "hi", { ...quality, judgeTimeoutMs: JUDGE_WARMUP_TIMEOUT_MS });
      } catch { /* a failed warm-up shows up as unavailable answers */ }
    },
  };
}

/** One line identifying the servers a measurement ran against, so numbers are reproducible. */
export async function serverInfo(cfg: MmConfig): Promise<string> {
  const base = captureEmbedBase(cfg);
  let embedOk = "n/a";
  if (base !== null) {
    const t0 = performance.now();
    const v = await embedTexts(cfg, ["ping"], { timeoutMs: 5000 });
    embedOk = v === null ? "DOWN" : `up (${Math.round(performance.now() - t0)}ms)`;
  }
  return `judge ${cfg.judgeUrl ?? "-"} model=${cfg.judgeModel ?? "-"} protocol=${cfg.judgeProtocol ?? "-"}; ` +
    `embed ${base ?? "-"} model=${captureEmbedModel(cfg)} ${embedOk}; ${new Date().toISOString()}`;
}

/** Run both strategies on a corpus, print the comparison and the gate decision. */
export async function runComparison(
  title: string,
  corpus: readonly Case[],
  cfg: MmConfig,
  embed: Strategy,
  judge: Strategy | null,
  stateChanging: ReadonlySet<string>,
): Promise<{ embed: Report; judge: Report | null; decision: GateDecision }> {
  console.log(`\n=== ${title} (${corpus.length} cases) ===\n${await serverInfo(cfg)}`);
  const e = await evaluateStrategy(embed, corpus, { stateChanging });
  console.log(formatReport(title, e));
  const j = judge === null ? null : await evaluateStrategy(judge, corpus, { stateChanging });
  if (j !== null) console.log(formatReport(title, j));
  const decision = gateDecision(e, j);
  console.log(`${title} => ${decision.adopt ? "ADOPT embeddings" : "RETAIN judge"}: ${decision.reason}`);
  return { embed: e, judge: j, decision };
}
