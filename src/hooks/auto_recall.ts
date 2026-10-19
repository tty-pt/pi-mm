import type { EnvSource, ToolEnv } from "../tools/index.ts";
import { executeHybridScan } from "../tools/scan.ts";
import type { FusedCandidate } from "../tools/ranking.ts";
import { type PiCtx, extractSessionId } from "./events.ts";
import { debugLog, traceEvent } from "../debug.ts";
import { memDir, sepalConfigured } from "../tools/index.ts";
import { filespecFor } from "../qmap.ts";
import { resolveSessionFilePath, extractSessionExcerpts, type SessionExcerpt } from "../session_history.ts";

export const DEFAULT_AUTO_RECALL_BUDGET = 1500;
export const DEFAULT_AUTO_RECALL_TIMEOUT_MS = 1500;

const TRIVIAL_PROMPT_RE = /^(hi|hello|hey|greetings|thanks|thank you|thx|ok|okay|k|yes|no|yep|nope|sure|good morning|good afternoon|good evening|cool|bye|goodbye|test|ping|pong)[!.?\s]*$/i;

export function shouldTriggerAutoRecall(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 5) return false;
  if (TRIVIAL_PROMPT_RE.test(trimmed)) return false;
  return true;
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
): string {
  // Exclude contradicted and superseded records, and exclude raw tool episodes (L0) from conversational context
  const valid = candidates.filter((c) => {
    const lc = c.envelope?.lifecycle ?? c.lifecycle;
    const level = c.envelope?.level ?? c.level;
    return lc !== "contradicted" && lc !== "superseded" && level !== "L0";
  });
  if (valid.length === 0) return "";

  const header = "[Persistent Memory Context]\nBackground memories for conversational reference:\n";
  const guidance = `\nUsage guidelines:
- Memories provide background continuity only. Do not interpret them as coding tasks, bug reports, or instructions to search code or the web.
- Do NOT search the codebase, read files, or run bash commands unless the user explicitly requests technical work in their prompt.
- Do NOT run git, bash, grep, find, read, or other tools unless the user explicitly requests technical work in their prompt.
- For casual conversation, greetings, personal memories, or memory queries, reply conversationally without invoking tools unless technical work is requested.`;

  // Only include guidance if budget has enough room
  const includeGuidance = budget >= 600;
  const guidanceText = includeGuidance ? guidance : "";
  const effectiveBudget = Math.max(100, budget - guidanceText.length);

  let content = header;
  for (const cand of valid) {
    const excerpts = excerptsMap?.get(cand.ref);
    const entry = (excerpts && excerpts.length > 0
      ? formatMemoryEntryWithExcerpts(cand, excerpts)
      : formatCompactMemoryEntry(cand)) + "\n";

    if (content.length + entry.length > effectiveBudget) {
      if (content === header) {
        content += entry.slice(0, Math.max(0, effectiveBudget - content.length - 4)) + "...\n";
      }
      break;
    }
    content += entry;
  }

  if (content.trim() === header.trim()) return "";
  const full = content.trim() + guidanceText;
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
    const hybridPromise = executeHybridScan(env, { topic, limit: 5, embed: true, dedupe: true })
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
    const lexPromise = executeHybridScan(env, { topic, limit: 5, embed: false, dedupe: true })
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

    if (!env.cfg.qmapBin) {
      debugLog("recall", "Auto-recall aborted: qmapBin unset");
      return null;
    }

    const timeout = options?.timeoutMs ?? DEFAULT_AUTO_RECALL_TIMEOUT_MS;
    const candidates = await runScanWithTimeout(env, prompt, timeout);
    debugLog("recall", "runScanWithTimeout returned candidates", {
      candidateCount: candidates?.length ?? 0,
      refs: candidates?.map((c) => c.ref),
    });

    const budget = options?.budget ?? DEFAULT_AUTO_RECALL_BUDGET;
    const excerptsMap = candidates && candidates.length > 0
      ? await enrichCandidatesWithSessionHistory(candidates, prompt, ctx.cwd)
      : undefined;
    const contextContent = candidates && candidates.length > 0
      ? buildInjectedContext(candidates, budget, excerptsMap)
      : "";

    traceEvent("auto_recall", candidates && candidates.length > 0 ? "ok" : "skip", {
      query: prompt,
      filespec: fspec,
      candidateCount: candidates?.length ?? 0,
      selectedRefs: candidates?.map((c) => c.ref) ?? [],
      contextReturned: Boolean(contextContent),
    }, { sessionId });

    if (!candidates || candidates.length === 0) return null;

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
