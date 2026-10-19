import { decodePayload } from "../payload.ts";
import type { ResultLine } from "../qmap.ts";
import type { LifecycleState, MemoryEnvelope, MipmapLevel } from "../types.ts";

export type CandidateOrigin = "lemma" | "sepal" | "both";

export interface FusedCandidate {
  ref: number;
  record: string;
  origin: CandidateOrigin;
  rrfScore: number;
  score?: string;
  lexicalRank?: number;
  semanticRank?: number;
  lexicalScore?: string;
  semanticScore?: string;
  envelope?: MemoryEnvelope;
  level?: MipmapLevel;
  lifecycle?: LifecycleState;
  summary?: string;
  rankingScore?: number;
}

export interface FilterCriteria {
  mipmap?: MipmapLevel;
  lifecycle?: string;
  project?: string;
  subsystem?: string;
  limit: number;
  query?: string;
  dedupe?: boolean;
}

export function isCodeOrDocArtifact(cand: FusedCandidate, envelope: MemoryEnvelope): boolean {
  if (envelope.level === "L0") return true;
  const s = envelope.summary || cand.record || "";
  if (s.startsWith("# ") || s.startsWith("## ")) return true;
  if (/^(?:import\s+|export\s+|const\s+|function\s+|class\s+|var\s+|let\s+)/.test(s)) return true;
  if (/:\d+:\s*(?:const|let|var|function|import|export|#include)/.test(s)) return true;
  if (s.includes("isletFspec") || s.includes("mem-islet.db")) return true;
  return false;
}

export function isQuestionMemory(_cand: FusedCandidate, envelope: MemoryEnvelope): boolean {
  const s = (envelope.summary || "").trim();
  if (s.endsWith("?")) return true;
  if (/^(?:remember\s+anything|anything\s+about|do\s+you\s+remember|can\s+you\s+remember|what\s+did\s+i\s+say|did\s+i\s+mention)\b/i.test(s)) {
    return true;
  }
  return false;
}

export function isAssistantEcho(_cand: FusedCandidate, envelope: MemoryEnvelope): boolean {
  const s = (envelope.summary || "").trim();
  if (/^(?:you\s+mentioned|you\s+said|i\s+remember\s+that\s+you|as\s+you\s+said)\s*[:\-—]/i.test(s)) {
    return true;
  }
  if (s.startsWith("> *\"") || s.startsWith("> \"")) {
    return true;
  }
  return false;
}

/**
 * Standard Reciprocal Rank Fusion (RRF) with configurable smoothing constant k (default 60).
 * Merges independent candidate sets without scale incompatibility between lexical BM25 and cosine ANN.
 */
export function fuseRankingsRRF(
  lexical: ResultLine[],
  semantic: ResultLine[],
  k = 60,
): FusedCandidate[] {
  const candidateMap = new Map<number, FusedCandidate>();

  for (let i = 0; i < lexical.length; i++) {
    const item = lexical[i];
    const rank = i + 1;
    const rrfContrib = 1 / (k + rank);
    candidateMap.set(item.ref, {
      ref: item.ref,
      record: item.record,
      origin: "lemma",
      rrfScore: rrfContrib,
      lexicalRank: rank,
      lexicalScore: item.score,
    });
  }

  for (let j = 0; j < semantic.length; j++) {
    const item = semantic[j];
    const rank = j + 1;
    const rrfContrib = 1 / (k + rank);
    const existing = candidateMap.get(item.ref);
    if (existing) {
      existing.origin = "both";
      existing.rrfScore += rrfContrib;
      existing.semanticRank = rank;
      existing.semanticScore = item.score;
      if (!existing.record && item.record) existing.record = item.record;
    } else {
      candidateMap.set(item.ref, {
        ref: item.ref,
        record: item.record,
        origin: "sepal",
        rrfScore: rrfContrib,
        semanticRank: rank,
        semanticScore: item.score,
      });
    }
  }

  const result = Array.from(candidateMap.values());
  result.sort((a, b) => b.rrfScore - a.rrfScore || a.ref - b.ref);
  return result;
}

const LIFECYCLE_WEIGHTS: Record<LifecycleState, number> = {
  supported: 1.0,
  tested: 0.95,
  observed: 0.9,
  hypothesized: 0.7,
  contradicted: 0.1,
  superseded: 0.05,
};

export function computeRankingScore(cand: FusedCandidate, crit: FilterCriteria): number {
  let score = cand.rrfScore > 0 ? cand.rrfScore : (cand.score ? parseFloat(cand.score) : 1.0);
  if (isNaN(score) || score <= 0) score = 1.0;

  const env = cand.envelope;
  if (!env) return score;

  score *= (LIFECYCLE_WEIGHTS[env.lifecycle] ?? 0.8);

  // Provenance bonus for evidence-backed conclusions
  if (env.evidence && env.evidence.length > 0) {
    score += 0.005;
  }

  // Utility feedback factor
  if (env.utility) {
    const net = (env.utility.usedCount || 0) - (env.utility.irrelevantCount || 0) - (env.utility.obsoleteCount || 0) * 2;
    score += Math.max(-0.015, Math.min(0.015, net * 0.002));
  }

  // Scope compatibility bonus
  if (crit.project && env.context?.project === crit.project) score += 0.01;
  if (crit.subsystem && env.context?.subsystem === crit.subsystem) score += 0.01;

  return score;
}

export function filterAndEnrich(
  candidates: FusedCandidate[],
  crit: FilterCriteria,
): FusedCandidate[] {
  const filtered: FusedCandidate[] = [];

  for (const cand of candidates) {
    const { envelope } = decodePayload(cand.record);
    if (crit.mipmap && envelope.level !== crit.mipmap) continue;

    // Lifecycle filtering:
    // Exclude superseded records from normal search by default.
    const effectiveLifecycle = envelope.lifecycle ?? "supported";
    if (crit.lifecycle && crit.lifecycle !== "all") {
      if (effectiveLifecycle !== crit.lifecycle) continue;
    } else {
      if (effectiveLifecycle === "superseded") {
        continue;
      }
    }

    if (crit.project && envelope.context?.project !== crit.project) continue;
    if (crit.subsystem && envelope.context?.subsystem !== crit.subsystem) continue;

    // Normal recall prefers useful higher-level memories (L1+) over raw L0 turns,
    // unless L0 was explicitly requested.
    if (crit.mipmap === undefined && envelope.level === "L0") {
      continue;
    }

    // Exclude question-shaped memories
    if (isQuestionMemory(cand, envelope)) continue;
    // Exclude assistant echoes
    if (isAssistantEcho(cand, envelope)) continue;

    const enriched: FusedCandidate = {
      ...cand,
      envelope,
      level: envelope.level,
      lifecycle: effectiveLifecycle,
      summary: envelope.summary,
      score: cand.score ?? cand.lexicalScore ?? cand.semanticScore ?? cand.rrfScore.toFixed(6),
    };
    enriched.rankingScore = computeRankingScore(enriched, crit);
    filtered.push(enriched);
  }

  filtered.sort((a, b) => (b.rankingScore ?? 0) - (a.rankingScore ?? 0) || a.ref - b.ref);

  // Deduplicate candidates with identical normalized summaries only when requested (e.g. auto-recall)
  if (crit.dedupe) {
    const deduped: FusedCandidate[] = [];
    const seenSummaries = new Set<string>();
    for (const cand of filtered) {
      const norm = (cand.summary || "").toLowerCase().replace(/[^\w\s]/g, "").trim();
      if (seenSummaries.has(norm)) continue;
      seenSummaries.add(norm);
      deduped.push(cand);
    }
    return deduped.slice(0, crit.limit);
  }

  return filtered.slice(0, crit.limit);
}
