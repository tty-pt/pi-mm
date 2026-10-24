import type { EnvSource, ToolEnv } from "../tools/index.ts";
import { executeHybridScan } from "../tools/scan.ts";
import type { FusedCandidate } from "../tools/ranking.ts";
import { type PiCtx, extractSessionId } from "./events.ts";
import { debugLog, traceEvent } from "../debug.ts";
import { memDir, sepalConfigured } from "../tools/index.ts";
import { filespecFor } from "../corm.ts";
import { resolveSessionFilePath, extractSessionExcerpts, type SessionExcerpt } from "../session_history.ts";

import { isCleanSummaryText } from "../payload.ts";
import { isQuestionMemory } from "../tools/ranking.ts";

export const DEFAULT_AUTO_RECALL_BUDGET = 1500;
export const DEFAULT_AUTO_RECALL_TIMEOUT_MS = 1500;

const TRIVIAL_PROMPT_RE = /^(hi|hello|hey|greetings|thanks|thank you|thx|ok|okay|k|yes|no|yep|nope|sure|good morning|good afternoon|good evening|cool|bye|goodbye|test|ping|pong)[!.?\s]*$/i;
const WORKFLOW_PROMPT_RE = /^(?:review running|quest \w+ promoted|setback recorded|verdict arrives|draft proposal)\b/i;

export function shouldTriggerAutoRecall(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 5) return false;
  if (TRIVIAL_PROMPT_RE.test(trimmed)) return false;
  if (WORKFLOW_PROMPT_RE.test(trimmed)) return false;
  // Normalize internal whitespace and strip trailing punctuation for robust matching
  const normalized = trimmed.replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  if (TRIVIAL_PROMPT_RE.test(normalized)) return false;
  if (WORKFLOW_PROMPT_RE.test(normalized)) return false;
  return true;
}

export const KNOWN_SUBSYSTEMS = [
  "song", "gig", "poem", "grp", "corm", "joint", "sepal", "lemma", "stoma", "islet", "axil", "bud",
  "libcorm", "libjoint", "libsepal", "liblemma", "libstoma", "libislet",
];

export function detectSubsystemMentions(prompt: string): string[] {
  if (!prompt) return [];
  const lower = prompt.toLowerCase();
  const matches: Array<{ name: string; index: number }> = [];
  for (const sub of KNOWN_SUBSYSTEMS) {
    const pattern = new RegExp(`\\b${sub}\\b`, "i");
    const m = pattern.exec(lower);
    if (m || lower.includes(`mods/${sub}`) || lower.includes(`external/${sub}`)) {
      const idx = m ? m.index : lower.indexOf(sub);
      const normalized = sub.startsWith("lib") ? sub.slice(3) : sub;
      if (!matches.some((x) => x.name === normalized)) {
        matches.push({ name: normalized, index: idx });
      }
    }
  }
  matches.sort((a, b) => a.index - b.index);
  return matches.map((m) => m.name);
}

export async function primeSubsystemInvariants(
  env: ToolEnv,
  subsystems: string[],
  timeoutMs = 50,
): Promise<FusedCandidate[]> {
  if (subsystems.length === 0) return [];
  const results: FusedCandidate[] = [];
  const timer = new Promise<FusedCandidate[]>((resolve) => setTimeout(() => resolve([]), timeoutMs));
  const work = (async () => {
    for (const sub of subsystems.slice(0, 3)) {
      try {
        const scanRes = await executeHybridScan(env, {
          topic: sub,
          subsystem: sub,
          level: "L2",
          lifecycle: "supported",
          limit: 2,
          embed: false,
        });
        if (scanRes.records && scanRes.records.length > 0) {
          for (const r of scanRes.records) {
            if (!results.some((x) => x.ref === r.ref)) {
              results.push(r);
            }
          }
        }
      } catch {
        // Best-effort proactive priming
      }
    }
    return results;
  })();
  return await Promise.race([work, timer]);
}

export function isMemoryRecallPrompt(prompt?: string): boolean {
  if (!prompt) return false;
  const p = prompt.trim().toLowerCase();
  if (/^(?:do\s+you\s+(?:remember|recall)|what\s+do\s+you\s+(?:remember|recall)|tell\s+me\s+what\s+you\s+(?:remember|recall)|what\s+did\s+(?:i|we)\s+(?:say|tell|mention|decide|discuss)|did\s+i\s+(?:mention|tell|say)|can\s+you\s+(?:remember|recall)|remind\s+me|have\s+we\s+discussed|did\s+we\s+talk\s+about)\b/i.test(p)) {
    return true;
  }
  if (/\b(?:did\s+(?:i|we|he|she|they)\s+(?:\w+\s+)?(?:mention|say|discuss|talk\s+about|fly|agree|use|mean|decide)|were\s+we\s+(?:talking|discussing)\s+about)\b/i.test(p)) {
    return true;
  }
  if (/^(?:what\s+(?:standard|rule|policy|convention|format|approach|method)\s+(?:applies|is\s+used|do\s+we\s+use))\b/i.test(p)) {
    return true;
  }
  return false;
}

export function isDirectMemoryQuestion(prompt?: string): boolean {
  if (!prompt) return false;
  const p = prompt.trim().toLowerCase();
  // Open-ended introspection: user asking agent what it remembers/recalls in general
  if (/^(?:what\s+do\s+you\s+remember|what\s+do\s+you\s+recall|tell\s+me\s+what\s+you\s+remember|what\s+did\s+i\s+say(?:\s+earlier|\s+before)?|what\s+were\s+we\s+talking\s+about|do\s+you\s+remember\s+anything|do\s+you\s+recall\s+anything)[?.!\s]*$/i.test(p)) {
    return true;
  }
  return false;
}

export function formatCompactMemoryEntry(cand: FusedCandidate): string {
  const ref = cand.ref;
  const env = cand.envelope;
  const level = env?.level ?? cand.level ?? "L2";
  const lifecycle = env?.lifecycle ?? cand.lifecycle ?? "supported";
  const isHypothesis = lifecycle === "hypothesized";
  const scopeParts: string[] = [];
  if (env?.context?.project) scopeParts.push(env.context.project);
  if (env?.context?.subsystem) scopeParts.push(env.context.subsystem);
  const scopeStr = scopeParts.length > 0 ? `, ${scopeParts.join("/")}` : "";
  const lifecycleLabel = isHypothesis ? "[HYPOTHESIS]" : lifecycle;

  const summary = env?.summary ?? cand.summary ?? cand.record.slice(0, 100);
  let line = `- [Ref ${ref}] (${level}, ${lifecycleLabel}${scopeStr}): ${summary}`;

  if (env?.evidence && env.evidence.length > 0) {
    line += `\n  Evidence: cited refs [${env.evidence.join(", ")}]`;
  }
  if (env?.constraints && env.constraints.length > 0) {
    for (const rule of env.constraints) {
      line += `\n  - [RESTRICTION]: ${rule}`;
    }
  }
  return line;
}

export function formatMemoryEntryWithExcerpts(
  cand: FusedCandidate,
  excerpts?: SessionExcerpt[],
): string {
  let line = formatCompactMemoryEntry(cand);
  if (excerpts && excerpts.length > 0) {
    line += "\n  Session Excerpts:";
    for (const ex of excerpts) {
      const roleLabel = ex.role === "user" ? "User" : "Assistant";
      line += `\n    ${roleLabel}: "${ex.text}"`;
    }
  }
  return line;
}

export async function enrichCandidatesWithSessionHistory(
  candidates: FusedCandidate[],
  query?: string,
  cwd?: string,
): Promise<Map<number, SessionExcerpt[]>> {
  const map = new Map<number, SessionExcerpt[]>();

  for (const cand of candidates) {
    const ep = cand.envelope?.episode;
    const sessionFile = ep?.sessionFile;
    const sessionId = ep?.sessionId;

    if (!sessionFile && !sessionId) continue;

    try {
      const resolvedPath = await resolveSessionFilePath(sessionFile, sessionId, cwd);
      if (!resolvedPath) continue;

      const epFindings = ep?.findings ? ep.findings.join(" ") : "";
      const originContext = [cand.summary ?? ep?.problem, epFindings].filter(Boolean).join(" ");
      const excerpts = await extractSessionExcerpts(resolvedPath, {
        originText: originContext,
        query,
        leafId: ep?.leafId,
        maxFollowUps: 5,
        charBudget: 750,
      });

      if (excerpts.length > 0) {
        map.set(cand.ref, excerpts);
      }
    } catch {
      // Degrade gracefully
    }
  }

  return map;
}

export function buildInjectedContext(
  candidates: FusedCandidate[],
  budget = DEFAULT_AUTO_RECALL_BUDGET,
  excerptsMap?: Map<number, SessionExcerpt[]>,
  prompt?: string,
): string {
  // Exclude contradicted and superseded records, raw tool episodes (L0),
  // corrupted/unprintable summaries, and question-memories from conversational context
  const isDirectQuestion = isDirectMemoryQuestion(prompt);
  const isExplicitRecall = isMemoryRecallPrompt(prompt);
  const valid = candidates.filter((c) => {
    const lc = c.envelope?.lifecycle ?? c.lifecycle;
    const level = c.envelope?.level ?? c.level;
    if (lc === "contradicted" || lc === "superseded" || level === "L0") return false;
    const summary = c.envelope?.summary || c.summary;
    if (!isCleanSummaryText(summary)) return false;
    if (!isDirectQuestion && !isExplicitRecall && c.envelope && isQuestionMemory(c, c.envelope)) return false;
    return true;
  });
  if (valid.length === 0) return "";

  const header = "[Persistent Memory Context]\nBackground memories for conversational reference:\n";
  const guidance = `\nUsage guidelines:
- Memories provide background continuity only. Do not interpret them as coding tasks, bug reports, or instructions to search code or the web.
- Do NOT search the codebase, read files, or run bash/git commands unless the user explicitly requests technical work in their prompt.
- When the user asks about prior discussions, what they said, past decisions, or memory queries, use memory_recall to find relevant context.
- For casual conversation and greetings, reply conversationally without invoking codebase tools.`;

  // Compress/omit guidance when user explicitly asks direct memory questions, freeing budget for memories
  const includeGuidance = !isDirectQuestion && budget >= 600;
  const guidanceText = includeGuidance ? guidance : "";

  // True Mipmap LOD separation:
  // L2 architectural knowledge, invariants, and active hypotheses are eligible for proactive priming.
  // L1 episodic notes and conversational history are latent: only recalled on explicit recall intent or subsystem tasks.
  const isKnowledgeQuery = isDirectQuestion || isExplicitRecall;
  const hasSubsystem = typeof prompt === "string" && detectSubsystemMentions(prompt).length > 0;
  const isUnprompted = typeof prompt === "string" && !isKnowledgeQuery && !hasSubsystem;

  const personaItems = valid.filter((c) => c.envelope?.context?.project === "user" || c.envelope?.context?.subsystem === "persona" || c.envelope?.context?.subject === "user");
  const architecturalItems = valid.filter((c) =>
    (c.envelope?.level === "L2" || c.envelope?.type === "invariant" || c.envelope?.lifecycle === "hypothesized") &&
    !personaItems.includes(c)
  );
  const subsystemInvariants = architecturalItems.filter((c) =>
    Boolean(c.envelope?.context?.subsystem) && c.envelope?.type === "invariant"
  );
  const generalMemories = isUnprompted
    ? []
    : valid.filter((c) => !personaItems.includes(c) && !subsystemInvariants.includes(c));

  let primedText = "";
  if (personaItems.length > 0) {
    primedText += "\n[User Persona & Engineering Tenets]\n";
    for (const p of personaItems.slice(0, 2)) {
      primedText += `- ${p.envelope?.summary || p.record}\n`;
    }
  }
  if (subsystemInvariants.length > 0) {
    primedText += "\n[Primed Subsystem Invariants]\n";
    for (const s of subsystemInvariants.slice(0, 2)) {
      primedText += formatCompactMemoryEntry(s) + "\n";
    }
  }

  // Token budgeting: subtract primed blocks from effective budget for general memories
  const effectiveBudget = Math.max(100, budget - guidanceText.length - primedText.length);

  const activeGeneral = [...architecturalItems.filter((c) => !subsystemInvariants.includes(c)), ...generalMemories];
  // Deduplicate by ref
  const seenRefs = new Set<number>();
  const dedupedGeneral: FusedCandidate[] = [];
  for (const c of activeGeneral) {
    if (!seenRefs.has(c.ref)) {
      seenRefs.add(c.ref);
      dedupedGeneral.push(c);
    }
  }

  let content = dedupedGeneral.length > 0 ? header : "";
  for (const cand of dedupedGeneral) {
    const excerpts = excerptsMap?.get(cand.ref);
    const entry = (excerpts && excerpts.length > 0
      ? formatMemoryEntryWithExcerpts(cand, excerpts)
      : formatCompactMemoryEntry(cand)) + "\n";

    if (content.length + entry.length > effectiveBudget) {
      if (excerpts && excerpts.length > 0) {
        const compactEntry = formatCompactMemoryEntry(cand) + "\n";
        if (content.length + compactEntry.length <= effectiveBudget) {
          content += compactEntry;
          continue;
        }
      }
      if (content === header) {
        content += entry.slice(0, Math.max(0, effectiveBudget - content.length - 4)) + "...\n";
      }
      break;
    }
    content += entry;
  }

  const hasMemories = (content.trim() !== "" && content.trim() !== header.trim()) || primedText.trim() !== "";
  if (!hasMemories) return "";

  let full = content.trim();
  if (primedText) full = (full ? full + "\n" : "") + primedText.trim();
  if (guidanceText) full += guidanceText;
  if (full.length > budget) {
    return full.slice(0, budget);
  }
  return full;
}

async function runScanWithTimeout(
  env: ToolEnv,
  topic: string,
  timeoutMs: number,
): Promise<FusedCandidate[]> {
  const startTime = Date.now();
  let timerId: ReturnType<typeof setTimeout> | null = null;

  // Allocate ~67% of total budget to semantic hybrid, leaving remainder for lexical fallback
  const semanticTimeout = Math.min(1000, Math.max(100, Math.floor(timeoutMs * 0.67)));

  try {
    const hybridPromise = executeHybridScan(env, { topic, limit: 5, embed: true, dedupe: true, overfetch: true })
      .then((res) => res.records);

    const timeoutPromise = new Promise<null>((resolve) => {
      timerId = setTimeout(() => resolve(null), semanticTimeout);
    });

    const fastResult = await Promise.race([hybridPromise, timeoutPromise]);
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }

    if (fastResult !== null) {
      return fastResult;
    }
  } catch {
    // If hybrid throws early, proceed to lexical fallback immediately
  } finally {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  // If hybrid timed out or failed, attempt bounded lexical fallback
  const elapsed = Date.now() - startTime;
  const remainingMs = Math.max(50, timeoutMs - elapsed);

  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const lexPromise = executeHybridScan(env, { topic, limit: 5, embed: false, dedupe: true, overfetch: true })
      .then((res) => res.records);

    const fallbackTimeoutPromise = new Promise<FusedCandidate[]>((resolve) => {
      fallbackTimer = setTimeout(() => resolve([]), remainingMs);
    });

    return await Promise.race([lexPromise, fallbackTimeoutPromise]);
  } catch {
    return [];
  } finally {
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
    }
  }
}

export interface BeforeAgentStartEvent {
  messageType: "user" | "custom";
  prompt?: string;
  systemPromptOptions?: {
    sections?: Record<string, string | null>;
    [key: string]: unknown;
  };
}

export interface BeforeAgentStartResult {
  message?: {
    role: "custom";
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
    timestamp: number;
  };
  systemPrompt?: string;
}

export async function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: PiCtx,
  envSource: EnvSource,
  options?: { budget?: number; timeoutMs?: number },
): Promise<BeforeAgentStartResult | null> {
  if (event.messageType !== "user" || typeof event.prompt !== "string") {
    return null;
  }

  const prompt = event.prompt;
  const shouldTrigger = shouldTriggerAutoRecall(prompt);
  debugLog("recall", "handleBeforeAgentStart evaluating auto-recall", {
    promptPreview: prompt.slice(0, 80),
    length: prompt.length,
    shouldTrigger,
  });

  if (!shouldTrigger) {
    return null;
  }

  try {
    const env = await envSource(ctx);
    const sessionId = extractSessionId(ctx);
    const cwd = memDir(env);
    const embed = sepalConfigured(env.cfg);
    const fspec = filespecFor(cwd, embed);

    if (!env.cfg.cormBin) {
      debugLog("recall", "Auto-recall aborted: cormBin unset");
      return null;
    }

    const timeout = options?.timeoutMs ?? DEFAULT_AUTO_RECALL_TIMEOUT_MS;
    const candidates = await runScanWithTimeout(env, prompt, timeout);
    debugLog("recall", "runScanWithTimeout returned candidates", {
      candidateCount: candidates?.length ?? 0,
      refs: candidates?.map((c) => c.ref),
    });

    const mentionedSubsystems = detectSubsystemMentions(prompt);
    const subTimeout = Math.min(50, Math.max(10, Math.floor(timeout * 0.25)));
    const primedInvariants = mentionedSubsystems.length > 0
      ? await primeSubsystemInvariants(env, mentionedSubsystems, subTimeout)
      : [];

    const allCandidates = [...(candidates ?? [])];
    for (const primed of primedInvariants) {
      if (!allCandidates.some((c) => c.ref === primed.ref)) {
        allCandidates.push(primed);
      }
    }

    const budget = options?.budget ?? DEFAULT_AUTO_RECALL_BUDGET;
    const excerptsMap = allCandidates.length > 0
      ? await enrichCandidatesWithSessionHistory(allCandidates, prompt, ctx.cwd)
      : undefined;
    const contextContent = allCandidates.length > 0
      ? buildInjectedContext(allCandidates, budget, excerptsMap, prompt)
      : "";

    traceEvent("auto_recall", allCandidates.length > 0 ? "ok" : "skip", {
      query: prompt,
      filespec: fspec,
      candidateCount: allCandidates.length,
      selectedRefs: allCandidates.map((c) => c.ref),
      contextReturned: Boolean(contextContent),
    }, { sessionId });

    if (allCandidates.length === 0) return null;

    if (!contextContent) {
      debugLog("recall", "Auto-recall produced empty contextContent after filtering");
      return null;
    }

    debugLog("recall", "Auto-recall successfully injected context into prompt", {
      contextLength: contextContent.length,
      refs: candidates.map((c) => c.ref),
    });

    traceEvent("context_injected", "ok", {
      query: prompt,
      deliveredRefs: candidates.map((c) => c.ref),
      contextLength: contextContent.length,
    }, { sessionId });

    if (event.systemPromptOptions && typeof event.systemPromptOptions === "object") {
      if (!event.systemPromptOptions.sections) {
        event.systemPromptOptions.sections = {};
      }
      event.systemPromptOptions.sections["memory_context"] = contextContent;
    }

    return {
      message: {
        role: "custom",
        customType: "memory_context",
        content: contextContent,
        display: true,
        details: { refs: candidates.map((c) => c.ref) },
        timestamp: Date.now(),
      },
    };
  } catch (err) {
    debugLog("recall", "handleBeforeAgentStart encountered exception", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-blocking: fail open so agent turn is never disrupted
    return null;
  }
}
