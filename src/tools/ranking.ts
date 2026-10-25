import { decodePayload, isCleanSummaryText } from "../payload.ts";
import type { ResultLine } from "../corm.ts";
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
  if (/^(?:investigation:\s*)?(?:remember\s+anything|anything\s+about|do\s+you\s+remember|can\s+you\s+remember|what\s+did\s+i\s+say|did\s+i\s+mention|what\s+do\s+you\s+remember|what\s+do\s+you\s+recall|what\s+did\s+i\s+tell)\b/i.test(s)) {
    return true;
  }
  const prob = (envelope.episode?.problem || envelope.episode?.request || "").trim();
  if (prob.endsWith("?") && /^(?:do\s+you|what\s+did|what\s+do|did\s+i|can\s+you)\b/i.test(prob)) {
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

export function isTechnicalInquiry(query?: string): boolean {
  if (!query) return false;
  const q = query.trim();
  if (/[/\\._#:]/.test(q)) return true; // file paths, extensions, symbols
  if (/\b(?:function|class|const|let|var|import|export|include|err|error|crash|bug|fix|build|make|socket|corm|db)\b/i.test(q)) return true;
  if (/[A-Z]+_[A-Z0-9_]+/.test(q)) return true; // UPPER_CASE constants
  if (/[a-z]+[A-Z][a-zA-Z0-9]*/.test(q)) return true; // camelCase identifiers
  return false;
}

/**
 * Dynamic RRF smoothing constant scaled adaptively to candidate pool size.
 * Handles edge cases |candidates| in {0, 1} cleanly.
 */
export function adaptiveRrfK(candidateCount: number): number {
  if (candidateCount <= 1) return 10;
  return Math.max(10, Math.min(60, candidateCount * 2));
}

/**
 * Standard Reciprocal Rank Fusion (RRF) with optional smoothing constant k.
 * When k is omitted, scales adaptively via adaptiveRrfK().
 * Merges independent candidate sets without scale incompatibility between lexical BM25 and cosine ANN.
 */
export function fuseRankingsRRF(
  lexical: ResultLine[],
  semantic: ResultLine[],
  k?: number,
): FusedCandidate[] {
  const effectiveK = k !== undefined ? k : adaptiveRrfK(lexical.length + semantic.length);
  const candidateMap = new Map<number, FusedCandidate>();

  for (let i = 0; i < lexical.length; i++) {
    const item = lexical[i];
    const rank = i + 1;
    const rrfContrib = 1 / (effectiveK + rank);
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
    const rrfContrib = 1 / (effectiveK + rank);
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

  // Provenance bonus for evidence-backed conclusions (multiplicative to preserve RRF scale)
  if (env.evidence && env.evidence.length > 0) {
    score *= 1.05;
  }

  // Utility feedback factor
  if (env.utility) {
    const net = (env.utility.usedCount || 0) - (env.utility.irrelevantCount || 0) - (env.utility.obsoleteCount || 0) * 2;
    score *= (1 + Math.max(-0.05, Math.min(0.05, net * 0.01)));
  }

  // Scope compatibility bonus
  if (crit.project && env.context?.project === crit.project) score *= 1.05;
  if (crit.subsystem && env.context?.subsystem === crit.subsystem) score *= 1.05;

  // Flashbulb anchor memory salience boost
  if (env.isAnchor) {
    score *= 1.25;
  }

  // Downrank code or documentation syntax artifacts unless L0 is explicitly requested
  if (crit.mipmap !== "L0" && isCodeOrDocArtifact(cand, env)) {
    score *= 0.2;
  }

  return score;
}

export function filterAndEnrich(
  candidates: FusedCandidate[],
  crit: FilterCriteria,
): FusedCandidate[] {
  const filtered: FusedCandidate[] = [];
  const technical = isTechnicalInquiry(crit.query);

  for (const cand of candidates) {
    const { envelope } = decodePayload(cand.record);
    if (crit.mipmap && envelope.level !== crit.mipmap) continue;

    // Strict pruning of code/doc artifacts on conversational queries
    if (crit.mipmap !== "L0" && isCodeOrDocArtifact(cand, envelope)) {
      if (!technical) {
        continue;
      }
    }

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

    // Exclude assistant echoes
    if (isAssistantEcho(cand, envelope)) continue;

    // Exclude corrupted or unprintable payloads
    if (!isCleanSummaryText(envelope.summary)) continue;

    // Exclude question-formed investigations from normal retrieval
    if (envelope.type === "investigation" && isQuestionMemory(cand, envelope)) continue;

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
