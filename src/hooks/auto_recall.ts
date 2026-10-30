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
import { buildMemoryOverview } from "../tools/overview.ts";
import { classifyOverviewByEmbedding, classifyRecallByEmbedding } from "../judge/adapter.ts";
import { overviewEmbed, overviewFallback, recallEmbed, recallFallback, type MmConfig } from "../config.ts";

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
  // Recognize corm_open symbol as corm subsystem alias
  if (/\bcorm_open\b/i.test(lower)) {
    if (!matches.some((x) => x.name === "corm" || x.name === "libcorm")) {
      matches.push({ name: "corm", index: lower.indexOf("corm_open") });
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

export function extractRecallSearchQuery(prompt: string): string {
  if (!prompt) return "";
  let cleaned = prompt.trim();
  // Strip common conversational recall trigger prefixes
  cleaned = cleaned.replace(
    /^(?:do\s+you\s+(?:remember|recall)(?:\s+(?:me\s+)?(?:mentioning|talking\s+about|speaking\s+about|telling\s+you\s+about|saying))?|what\s+do\s+you\s+(?:remember|recall)(?:\s+about)?|tell\s+me\s+what\s+you\s+(?:remember|recall)(?:\s+about)?|what\s+did\s+(?:i|we)\s+(?:say|tell\s+you|mention|decide|discuss)(?:\s+about)?|did\s+i\s+(?:mention|tell\s+you|say)(?:\s+about)?|can\s+you\s+(?:remember|recall)(?:\s+what)?|remind\s+me(?:\s+about)?|have\s+we\s+discussed|did\s+we\s+talk\s+about|lembras-te\s+(?:de|do\s+que|da)?|te\s+lembras\s+(?:de|do\s+que)?|o\s+que\s+(?:é\s+que\s+)?(?:eu\s+)?(?:disse|mencionei)\s+sobre)\b[:,\s]*/i,
    ""
  );
  // Strip trailing question marks and conversational punctuation
  cleaned = cleaned.replace(/[?!.\s]+$/, "").trim();
  // Strip leading punctuation (colons, commas, whitespace) left over after prefix removal
  cleaned = cleaned.replace(/^[:,\s]+/, "").trim();
  return cleaned || prompt.trim();
}

export function isDirectMemoryQuestion(prompt?: string): boolean {
  if (!prompt) return false;
  const p = prompt.trim().toLowerCase();
  // Open-ended introspection: user asking agent what it remembers/recalls in general across time
  if (/^(?:what\s+do\s+you\s+(?:remember|recall)|tell\s+me\s+what\s+you\s+(?:remember|recall)|what\s+did\s+i\s+say(?:\s+earlier|\s+before)?|what\s+were\s+we\s+talking\s+about|do\s+you\s+remember\s+anything|do\s+you\s+recall\s+anything|what\s+do\s+you\s+(?:remember|recall)\s+(?:across\s+all\s+time|from\s+all\s+time|from\s+past\s+sessions)?|give\s+me\s+(?:an?\s+)?(?:overview|summary)\s+of\s+(?:all\s+)?(?:your\s+)?memories|what\s+memories\s+do\s+you\s+have|what\s+have\s+we\s+worked\s+on(?:\s+across\s+all\s+time)?)[?.!\s]*$/i.test(p)) {
    return true;
  }
  if (/\b(?:give\s+me\s+an?\s+overview\s+of\s+(?:all\s+)?memories|high-level\s+overview\s+of\s+(?:all\s+)?memories)\b/i.test(p)) {
    return true;
  }
  return false;
}

export async function evaluateDirectMemoryQuestion(
  prompt: string,
  cfg: MmConfig,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  if (overviewEmbed(cfg) !== "off") {
    try {
      const verdict = await classifyOverviewByEmbedding(prompt, cfg, fetchFn);
      if (verdict === "overview_query") return true;
      if (verdict === "specific_query") return false;
    } catch {
      // Endpoint error or timeout
    }
    const fb = overviewFallback(cfg);
    if (fb === "skip") return false;
    return isDirectMemoryQuestion(prompt);
  }
  return isDirectMemoryQuestion(prompt);
}

export async function evaluateRecallIntent(
  prompt: string,
  cfg: MmConfig,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  if (recallEmbed(cfg) !== "off") {
    try {
      const verdict = await classifyRecallByEmbedding(prompt, cfg, fetchFn);
      if (verdict === "recall_past") return true;
      if (verdict === "standalone") return false;
    } catch {
      // Endpoint error or timeout
    }
    const fb = recallFallback(cfg);
    if (fb === "skip") return false;
    return isMemoryRecallPrompt(prompt);
  }
  return isMemoryRecallPrompt(prompt);
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
  recallIntentConfirmed = false,
): string {
  // Exclude contradicted and superseded records, raw tool episodes (L0),
  // corrupted/unprintable summaries, and question-memories from conversational context
  const isDirectQuestion = isDirectMemoryQuestion(prompt);
  const isExplicitRecall = recallIntentConfirmed || isMemoryRecallPrompt(prompt);
  const valid = candidates.filter((c) => {
    const lc = c.envelope?.lifecycle ?? c.lifecycle;
    const level = c.envelope?.level ?? c.level;
    if (lc === "contradicted" || lc === "superseded" || level === "L0") return false;
    const summary = c.envelope?.summary || c.summary;
    if (!isCleanSummaryText(summary)) return false;
    if (!isDirectQuestion && c.envelope && isQuestionMemory(c, c.envelope)) return false;
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
  // L2 architectural knowledge, invariants, and active hypotheses are eligible for proactive priming on mentioned subsystems.
  // L1 episodic notes and conversational history are latent: only recalled on explicit recall intent.
  const isKnowledgeQuery = isDirectQuestion || isExplicitRecall;
  const mentionedSubsystems = typeof prompt === "string" ? detectSubsystemMentions(prompt) : [];
  const hasSubsystem = mentionedSubsystems.length > 0;
  const isUnprompted = typeof prompt === "string" && !isKnowledgeQuery && !hasSubsystem;

  // Requirement R3: Prompts lacking recall cues and subsystem mentions yield zero context injection
  if (isUnprompted) {
    return "";
  }

  const personaItems = valid.filter((c) => c.envelope?.context?.project === "user" || c.envelope?.context?.subsystem === "persona" || c.envelope?.context?.subject === "user");

  // Requirement R2: Proactive priming bounded strictly to mentioned subsystems
  const subsystemInvariants = hasSubsystem
    ? valid.filter((c) => {
        if (c.envelope?.level !== "L2" && c.envelope?.type !== "invariant") return false;
        if (personaItems.includes(c)) return false;
        const sub = c.envelope?.context?.subsystem;
        const normSub = sub ? (sub.startsWith("lib") ? sub.slice(3) : sub) : undefined;
        return Boolean(normSub && (mentionedSubsystems.includes(normSub) || mentionedSubsystems.includes(`lib${normSub}`)));
      })
    : [];

  const activeHypotheses = hasSubsystem
    ? valid.filter((c) => {
        if (c.envelope?.lifecycle !== "hypothesized") return false;
        if (personaItems.includes(c)) return false;
        const sub = c.envelope?.context?.subsystem;
        const normSub = sub ? (sub.startsWith("lib") ? sub.slice(3) : sub) : undefined;
        return Boolean(normSub && (mentionedSubsystems.includes(normSub) || mentionedSubsystems.includes(`lib${normSub}`)));
      })
    : [];

  const generalMemories = valid.filter((c) => {
    if (personaItems.includes(c) || subsystemInvariants.includes(c) || activeHypotheses.includes(c)) {
      return false;
    }
    const sub = c.envelope?.context?.subsystem;
    const normSub = sub ? (sub.startsWith("lib") ? sub.slice(3) : sub) : undefined;
    // Exclude items belonging to unmentioned subsystems
    if (hasSubsystem && normSub && !mentionedSubsystems.includes(normSub) && !mentionedSubsystems.includes(`lib${normSub}`)) {
      return false;
    }
    // On technical turns without explicit recall intent, exclude conversational chat notes
    if (hasSubsystem && !isKnowledgeQuery && c.envelope?.level === "L1" && c.envelope?.type === "note") {
      return false;
    }
    return true;
  });

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

  // Token budgeting: subtract primed blocks from effective budget for memories
  const effectiveBudget = Math.max(100, budget - guidanceText.length - primedText.length);

  const itemsForContent = [...activeHypotheses, ...generalMemories];
  const seenRefs = new Set<number>();
  const dedupedItems: FusedCandidate[] = [];
  for (const item of itemsForContent) {
    if (!seenRefs.has(item.ref)) {
      seenRefs.add(item.ref);
      dedupedItems.push(item);
    }
  }

  let content = dedupedItems.length > 0 ? header : "";
  for (const cand of dedupedItems) {
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

export interface BeforeAgentStartOptions {
  budget?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export async function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: PiCtx,
  envSource: EnvSource,
  options?: BeforeAgentStartOptions,
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

    const isDirectQuestion = await evaluateDirectMemoryQuestion(prompt, env.cfg, options?.fetchFn);
    if (isDirectQuestion) {
      const overview = await buildMemoryOverview(env, { limit: 8, maxScan: 200 });
      if (overview.totalRecords > 0) {
        const budget = options?.budget ?? DEFAULT_AUTO_RECALL_BUDGET;
        let overviewText = overview.renderedOverview;
        if (overviewText.length > budget) {
          overviewText = overviewText.slice(0, budget - 40) + "\n\n[Overview truncated for budget...]";
        }
        const contextContent = `[Persistent Memory Overview Across All Time]\n${overviewText}\n\nGuidance for the Assistant:\n- The user is asking what you remember or for a memory overview. Provide a cohesive, high-level summary of your memories across all the operational time and domains shown above.\n- Offer to zoom in to any specific memory, task episode, or evidence tree using memory_recall(zoomRef=...).`;

        traceEvent("auto_recall", "ok", {
          query: prompt,
          filespec: fspec,
          candidateCount: overview.totalRecords,
          overviewInjected: true,
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
            details: { overview: true, totalRecords: overview.totalRecords },
            timestamp: Date.now(),
          },
        };
      }
    }

    const isRecallIntent = await evaluateRecallIntent(prompt, env.cfg, options?.fetchFn);
    const timeout = options?.timeoutMs ?? DEFAULT_AUTO_RECALL_TIMEOUT_MS;
    const searchQuery = isRecallIntent ? extractRecallSearchQuery(prompt) : prompt;
    const candidates = await runScanWithTimeout(env, searchQuery, timeout);
    debugLog("recall", "runScanWithTimeout returned candidates", {
      searchQuery,
      candidateCount: candidates?.length ?? 0,
      refs: candidates?.map((c) => c.ref),
      isRecallIntent,
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
      ? buildInjectedContext(allCandidates, budget, excerptsMap, prompt, isRecallIntent)
      : "";

    traceEvent("auto_recall", allCandidates.length > 0 ? "ok" : "skip", {
      query: prompt,
      filespec: fspec,
      candidateCount: allCandidates.length,
      selectedRefs: allCandidates.map((c) => c.ref),
      contextReturned: Boolean(contextContent),
      recallIntent: isRecallIntent,
    }, { sessionId });

    if (allCandidates.length === 0 || !contextContent) {
      if (isRecallIntent) {
        const notice = `[Persistent Memory Notice]\nThe user appears to be inquiring about past technical decisions, prior investigations, or lore. No direct memory entries were automatically matched. Consider using memory_recall({ query: "${prompt.slice(0, 80).replace(/"/g, "'")}" }) to check persistent memory before answering.`;
        if (event.systemPromptOptions && typeof event.systemPromptOptions === "object") {
          if (!event.systemPromptOptions.sections) {
            event.systemPromptOptions.sections = {};
          }
          event.systemPromptOptions.sections["memory_context"] = notice;
        }
        return {
          message: {
            role: "custom",
            customType: "memory_context",
            content: notice,
            display: false,
            details: { recallIntent: true, emptyMatch: true },
            timestamp: Date.now(),
          },
        };
      }
      return null;
    }

    let finalContent = contextContent;
    if (isRecallIntent) {
      finalContent += `\n\n[Memory Intent Detected]\nThe user's query references past technical decisions, investigations, or project lore. Relevant background has been checked; use memory_recall({ query: "${prompt.slice(0, 80).replace(/"/g, "'")}" }) or memory_recall({ zoomRef: <ref> }) if you need to inspect full evidence trees or historical approaches.`;
    }

    debugLog("recall", "Auto-recall successfully injected context into prompt", {
      contextLength: finalContent.length,
      refs: candidates.map((c) => c.ref),
      recallIntent: isRecallIntent,
    });

    traceEvent("context_injected", "ok", {
      query: prompt,
      deliveredRefs: candidates.map((c) => c.ref),
      contextLength: finalContent.length,
      recallIntent: isRecallIntent,
    }, { sessionId });

    if (event.systemPromptOptions && typeof event.systemPromptOptions === "object") {
      if (!event.systemPromptOptions.sections) {
        event.systemPromptOptions.sections = {};
      }
      event.systemPromptOptions.sections["memory_context"] = finalContent;
    }

    return {
      message: {
        role: "custom",
        customType: "memory_context",
        content: finalContent,
        display: true,
        details: { refs: candidates.map((c) => c.ref), recallIntent: isRecallIntent },
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
