/**
 * Pre-Tool Counterfactual Guardrails ("Déjà Vu" Interception) (src/hooks/guardrails.ts).
 * Projects planned or failed tool intents (edit, write, bash) into persistent memory
 * and code-lore bindings to intercept repeated mistakes, contradicted approaches,
 * standing restrictions, and stale-suspect invariants.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { memDir, type ToolEnv } from "../tools/index.ts";
import { executeHybridScan } from "../tools/scan.ts";
import type { FusedCandidate } from "../tools/ranking.ts";
import type { CodeStore } from "../code/store.ts";
import { resolveSymbolCandidates } from "../code/graph.ts";
import {
  isRawToolTelemetryText,
  verifyLoreBindingsForSymbols,
  type LoreDriftReport,
} from "../code/lore_binding.ts";
import { normalizeRelPath } from "../code/payload_codec.ts";
import { splitIdentifierWords } from "../code/lexer.ts";

export interface CounterfactualInput {
  toolName?: string;
  filePath?: string;
  symbolName?: string;
  intentText: string;
  subsystem?: string;
}

export interface CounterfactualWarning {
  ref: number;
  kind: "contradicted_memory" | "failed_approach" | "standing_restriction" | "stale_bound_invariant";
  level: string;
  summary: string;
  failedApproach?: string;
  failureReason?: string;
  restriction?: string;
  driftDetail?: string;
  overlapScore: number;
}

export interface CounterfactualGuardrailResult {
  triggered: boolean;
  queryTopic: string;
  warnings: CounterfactualWarning[];
  driftReports: LoreDriftReport[];
  rendered: string;
}

const sessionGuardrailDedup = new Map<string, Set<string>>();

export function clearGuardrailDedupCache(): void {
  sessionGuardrailDedup.clear();
}

export function shouldEmitSessionGuardrail(sessionId: string, warningKey: string): boolean {
  let set = sessionGuardrailDedup.get(sessionId);
  if (!set) {
    set = new Set<string>();
    sessionGuardrailDedup.set(sessionId, set);
  }
  if (set.has(warningKey)) return false;
  set.add(warningKey);
  return true;
}

function extractSalientWords(text: string): string[] {
  const stop = new Set([
    "the", "and", "for", "with", "from", "that", "this", "into", "when", "where",
    "what", "which", "will", "should", "could", "would", "have", "been", "were",
    "true", "false", "null", "undefined", "const", "function", "return", "export",
    "import", "async", "await", "bash", "edit", "write", "read", "file", "line",
    "mods", "src", "include", "external", "tests", "unit", "Directly", "directly",
    "error", "unexpected", "syntax", "executed", "type", "string", "number",
    "boolean", "object", "array", "promise", "value", "result",
  ]);
  const words = splitIdentifierWords(text);
  const out: string[] = [];
  for (const w of words) {
    if (w.length >= 3 && !stop.has(w) && !out.includes(w)) {
      out.push(w);
      if (out.length >= 16) break;
    }
  }
  return out;
}

function computeWordOverlap(queryWords: string[], candidateText: string): number {
  if (queryWords.length === 0 || !candidateText) return 0;
  const candWords = splitIdentifierWords(candidateText);
  const candSet = new Set(candWords);
  let matched = 0;
  for (const qw of queryWords) {
    if (
      candSet.has(qw) ||
      (qw.length >= 4 && candWords.some((cw) => cw.length >= 4 && (cw.startsWith(qw) || qw.startsWith(cw))))
    ) {
      matched++;
    }
  }
  if (queryWords.length >= 3 && matched < 2) return 0;
  return matched / Math.max(1, Math.min(queryWords.length, 6));
}

const PROHIBITIVE_MARKERS = [
  "never ", "must not", "do not", "don't", "forbidden", "prohibited", "strictly", "zero coupling",
];

function hasProhibitiveDirective(text: string): boolean {
  const lower = text.toLowerCase();
  return PROHIBITIVE_MARKERS.some((m) => lower.includes(m));
}

function extractWarningsFromCandidate(
  cand: FusedCandidate,
  queryWords: string[],
): CounterfactualWarning[] {
  const env = cand.envelope;
  if (!env) return [];
  const warnings: CounterfactualWarning[] = [];
  const level = env.level ?? "L1";
  const summary = env.summary || cand.summary || "";

  if (level === "L0" || isRawToolTelemetryText(summary)) return [];

  if (env.lifecycle === "contradicted") {
    const score = computeWordOverlap(queryWords, `${summary} ${env.episode?.problem || ""}`);
    if (score >= 0.34 || (queryWords.length <= 2 && score > 0)) {
      warnings.push({
        ref: cand.ref, kind: "contradicted_memory", level, summary,
        failureReason: env.history?.[env.history.length - 1]?.reason, overlapScore: score + 0.3,
      });
    }
  }

  if (env.episode?.approaches) {
    for (const app of env.episode.approaches) {
      if (app.outcome !== "failed" && app.outcome !== "abandoned") continue;
      if (isRawToolTelemetryText(app.approach)) continue;
      const score = computeWordOverlap(queryWords, `${summary} ${app.approach} ${app.reason || ""}`);
      if (score >= 0.34 || (queryWords.length <= 2 && score > 0)) {
        warnings.push({
          ref: cand.ref, kind: "failed_approach", level, summary,
          failedApproach: app.approach, failureReason: app.reason || `Marked ${app.outcome}`,
          overlapScore: score + (app.outcome === "failed" ? 0.25 : 0.1),
        });
      }
    }
  }

  if (env.constraints && env.constraints.length > 0 && env.lifecycle !== "superseded") {
    for (const rule of env.constraints) {
      const score = computeWordOverlap(queryWords, `${summary} ${rule}`);
      if (score >= 0.25) {
        warnings.push({ ref: cand.ref, kind: "standing_restriction", level, summary, restriction: rule, overlapScore: score + 0.2 });
      }
    }
  } else if ((env.standing || level === "L2") && env.lifecycle !== "superseded" && hasProhibitiveDirective(summary)) {
    const score = computeWordOverlap(queryWords, summary);
    if (score >= 0.25) {
      warnings.push({ ref: cand.ref, kind: "standing_restriction", level, summary, restriction: summary, overlapScore: score + 0.2 });
    }
  }

  return warnings;
}

export function formatCounterfactualGuardrail(
  warnings: CounterfactualWarning[],
  queryTopic: string,
): string {
  if (warnings.length === 0) {
    return `=== Counterfactual Guardrail Check: Clear ===\nNo contradicted memories, failed approaches, or stale-bound invariants matched "${queryTopic}".`;
  }
  const lines = [
    `=== 🛡️ [pi-mm Déjà Vu Counterfactual Guardrail] (${warnings.length} warning${warnings.length === 1 ? "" : "s"}) ===`,
  ];
  for (const w of warnings.slice(0, 5)) {
    if (w.kind === "contradicted_memory") {
      lines.push(
        `  • [Ref ${w.ref} · CONTRADICTED ${w.level}] ${w.summary}${w.failureReason ? `\n    Reason contradicted: ${w.failureReason}` : ""}`,
      );
    } else if (w.kind === "failed_approach") {
      lines.push(
        `  • [Ref ${w.ref} · FAILED APPROACH] Tried: "${w.failedApproach}"\n    Why it failed: ${w.failureReason || "Failed in prior episode"} (Context: ${w.summary})`,
      );
    } else if (w.kind === "standing_restriction") {
      const ctxSuffix = w.restriction !== w.summary ? ` (${w.summary})` : "";
      lines.push(`  • [Ref ${w.ref} · RESTRICTION] ${w.restriction}${ctxSuffix}`);
    } else if (w.kind === "stale_bound_invariant") {
      lines.push(
        `  • [Ref ${w.ref} · STALE_SUSPECT INVARIANT] ${w.summary}\n    Drift: ${w.driftDetail}`,
      );
    }
  }
  return lines.join("\n");
}

function collectStandingFileWarnings(
  env: ToolEnv,
  salientWords: string[],
  seenKey: Set<string>,
  warnings: CounterfactualWarning[],
): void {
  try {
    const dirFile = join(memDir(env), "standing_directives.json");
    if (!existsSync(dirFile)) return;
    const items = JSON.parse(readFileSync(dirFile, "utf-8"));
    if (!Array.isArray(items)) return;
    for (const d of items) {
      if (!d || typeof d.ref !== "number" || typeof d.summary !== "string") continue;
      if (!hasProhibitiveDirective(d.summary)) continue;
      const score = computeWordOverlap(salientWords, d.summary);
      if (score >= 0.25) {
        const key = `${d.ref}:standing_restriction`;
        if (!seenKey.has(key)) {
          seenKey.add(key);
          warnings.push({
            ref: d.ref, kind: "standing_restriction", level: "L2",
            summary: d.summary, restriction: d.summary, overlapScore: score + 0.25,
          });
        }
      }
    }
  } catch { /* Best-effort standing file scan */ }
}

async function collectMemoryGuardrailWarnings(
  env: ToolEnv,
  queryTopic: string,
  subsystem: string | undefined,
  salientWords: string[],
): Promise<CounterfactualWarning[]> {
  const warnings: CounterfactualWarning[] = [];
  const seenKey = new Set<string>();
  collectStandingFileWarnings(env, salientWords, seenKey, warnings);
  try {
    const [generalScan, contradictedScan] = await Promise.all([
      executeHybridScan(env, { topic: queryTopic, subsystem, includeL0: false, overfetch: true, limit: 15, embed: false }),
      executeHybridScan(env, { topic: queryTopic, lifecycle: "contradicted", includeL0: false, overfetch: true, limit: 8, embed: false }),
    ]);
    const pool = new Map<number, FusedCandidate>();
    for (const c of generalScan.records) pool.set(c.ref, c);
    for (const c of contradictedScan.records) pool.set(c.ref, c);
    for (const cand of pool.values()) {
      for (const w of extractWarningsFromCandidate(cand, salientWords)) {
        const key = w.kind === "standing_restriction" ? `${w.ref}:standing_restriction` : `${w.ref}:${w.kind}:${w.failedApproach || ""}`;
        if (!seenKey.has(key)) {
          seenKey.add(key);
          warnings.push(w);
        }
      }
    }
  } catch { /* Best-effort memory scan */ }
  return warnings;
}

async function semanticVerifyWarningsViaAuren(
  env: ToolEnv,
  intentText: string,
  warnings: CounterfactualWarning[],
): Promise<CounterfactualWarning[]> {
  if (warnings.length === 0 || !intentText.trim()) return warnings;
  const rawUrl = (env.cfg.captureEmbedUrl ?? env.cfg.judgeUrl ?? "").trim();
  if (!rawUrl) return warnings;
  const base = rawUrl.replace(/\/+$/, "").replace(/\/api\/v1\/systemone$/, "").replace(/\/v1$/, "");
  const model = env.cfg.captureEmbedModel || env.cfg.embedModel || "bge-small";
  const url = `${base}/v1/systemone`;
  const verified: CounterfactualWarning[] = [];
  for (const w of warnings) {
    if (w.kind === "stale_bound_invariant" || w.overlapScore >= 0.65) { verified.push(w); continue; }
    const targetClaim = (w.restriction || w.failedApproach || w.summary).slice(0, 220);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 160);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          text: `Planned action: ${intentText.slice(0, 220)}`,
          labels: {
            relevant_guardrail: [`Violates restriction or repeats failed approach: ${targetClaim}`, targetClaim],
            unrelated_topic: ["Unrelated routine code inspection, test execution, or orthogonal module change"],
          },
        }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as { decision?: string; choice?: string; similarity?: number; margin?: number };
        const choice = body.decision ?? body.choice;
        if (choice === "unrelated_topic" && (body.margin ?? 0) > 0.05) continue;
        if (choice === "relevant_guardrail" && typeof body.similarity === "number") w.overlapScore += Math.max(0, body.similarity * 0.25);
      }
      verified.push(w);
    } catch {
      verified.push(w);
    } finally {
      clearTimeout(timer);
    }
  }
  return verified;
}

export async function evaluateCounterfactualGuardrail(
  env: ToolEnv,
  input: CounterfactualInput,
  codeStore?: CodeStore,
): Promise<CounterfactualGuardrailResult> {
  const filePart = input.filePath ? normalizeRelPath(input.filePath) : "";
  const symPart = input.symbolName ? input.symbolName.trim() : "";
  const rawTopic = [symPart, input.intentText, filePart].filter(Boolean).join(" ").trim();
  const salientWords = extractSalientWords(rawTopic);
  const queryTopic = salientWords.length > 0 ? salientWords.slice(0, 8).join(" ") : rawTopic.slice(0, 120);

  if (!queryTopic || !env.cfg.cormBin) {
    return { triggered: false, queryTopic, warnings: [], driftReports: [], rendered: formatCounterfactualGuardrail([], queryTopic) };
  }

  let warnings = await collectMemoryGuardrailWarnings(env, queryTopic, input.subsystem, salientWords);
  let driftReports: LoreDriftReport[] = [];
  if (codeStore && (filePart || symPart)) {
    try {
      await codeStore.ensureIndexed();
      const targetSyms = resolveSymbolCandidates(codeStore, { name: symPart || undefined, file: filePart || undefined });
      driftReports = verifyLoreBindingsForSymbols(codeStore, targetSyms);
      for (const dr of driftReports) {
        if (dr.status === "stale_suspect") {
          const detail = dr.driftedAnchors.map((a) => `${a.anchor.symbolName} (${a.reason})`).join(", ");
          warnings.push({ ref: dr.memoryRef, kind: "stale_bound_invariant", level: dr.level, summary: dr.summary, driftDetail: detail, overlapScore: 0.9 });
        }
      }
    } catch { /* Best-effort drift check */ }
  }

  warnings = await semanticVerifyWarningsViaAuren(env, rawTopic, warnings);
  warnings.sort((a, b) => b.overlapScore - a.overlapScore);
  const topWarnings = warnings.slice(0, 6);
  return { triggered: topWarnings.length > 0, queryTopic, warnings: topWarnings, driftReports, rendered: formatCounterfactualGuardrail(topWarnings, queryTopic) };
}
