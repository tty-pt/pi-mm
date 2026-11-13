import type { EnvSource, ToolEnv } from "../tools/index.ts";
import { executeHybridScan } from "../tools/scan.ts";
import type { FusedCandidate } from "../tools/ranking.ts";
import { type PiCtx, extractSessionId } from "./events.ts";
import { debugLog, traceEvent } from "../debug.ts";
import { memDir, sepalConfigured, axisPath } from "../tools/index.ts";
import { filespecFor, embedEnv } from "../corm.ts";
import { fetchEnvelope } from "../tools/traverse.ts";
import { resolveSessionFilePath, extractSessionExcerpts, type SessionExcerpt } from "../session_history.ts";
import type { MemoryEnvelope } from "../types.ts";
import type { SessionCardHit, SessionTurnEvent } from "../session/types.ts";

import { isCleanSummaryText } from "../payload.ts";
import { isQuestionMemory } from "../tools/ranking.ts";
import { buildMemoryOverview } from "../tools/overview.ts";
import { classifyOverviewByEmbedding, classifyRecallByEmbedding } from "../judge/adapter.ts";
import { overviewEmbed, overviewFallback, recallEmbed, recallFallback, recallAction, type MmConfig } from "../config.ts";
import { getSessionInstances, ensureSessionIndexed, type SessionContextInstances } from "../session/manager.ts";

export interface EpisodeSessionProvenance {
  sessionId?: string;
  sessionFile?: string;
  leafId?: string;
  eventIds: string[];
  toolCallIds: string[];
  summaries: string[];
  problem?: string;
}

export interface IndexedSessionSummary {
  sessionId: string;
  shortId: string;
  workspaceLabel?: string;
  totalTurns: number;
  totalEvents: number;
  matchedCards: SessionCardHit[];
  instances: SessionContextInstances;
}

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

export function isSessionRecentQuestion(prompt?: string): boolean {
  if (!prompt) return false;
  const p = prompt.trim().toLowerCase();
  if (/^(?:do\s+you\s+(?:remember|recall)\s+what\s+(?:you|we|i)\s+(?:had\s+)?(?:just\s+)?(?:said|discussed|talked\s+about|asked)|what\s+did\s+(?:you|we|i)\s+just\s+(?:say|discuss|talk\s+about|ask)|what\s+were\s+we\s+(?:just\s+)?(?:talking|discussing)\s+about(?:\s+right\s+before\s+compaction|\s+before\s+compaction)?|can\s+you\s+(?:repeat|summarize)\s+your\s+last\s+(?:response|message|reply)|what\s+was\s+your\s+last\s+(?:response|message|reply)|voc[eê]\s+lembra\s+do\s+que\s+(?:acabou|tinha\s+acabado)\s+de\s+(?:dizer|falar|responder)|sobre\s+o\s+que\s+est[aá]vamos\s+(?:falando|conversando)\s+agora\s+h[aá]\s+pouco|o\s+que\s+voc[eê]\s+(?:acabou|tinha\s+acabado)\s+de\s+(?:dizer|responder)|do\s+que\s+est[aá]vamos\s+conversando\s+antes\s+da\s+compacta[cç][aã]o)[?.!\s]*$/i.test(p)) {
    return true;
  }
  return false;
}

export function isDirectMemoryQuestion(prompt?: string): boolean {
  if (!prompt) return false;
  if (isSessionRecentQuestion(prompt)) return false;
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

export async function evaluateMemoryQuestionKind(
  prompt: string,
  cfg: MmConfig,
  fetchFn?: typeof fetch,
): Promise<"overview_query" | "session_recent" | "specific_query"> {
  if (isSessionRecentQuestion(prompt)) {
    return "session_recent";
  }
  if (overviewEmbed(cfg) !== "off") {
    try {
      const verdict = await classifyOverviewByEmbedding(prompt, cfg, fetchFn);
      if (verdict === "overview_query" || verdict === "session_recent" || verdict === "specific_query") {
        return verdict;
      }
    } catch {
      // Endpoint error or timeout
    }
    const fb = overviewFallback(cfg);
    if (fb === "skip") return "specific_query";
    if (isDirectMemoryQuestion(prompt)) return "overview_query";
    return "specific_query";
  }
  if (isDirectMemoryQuestion(prompt)) return "overview_query";
  return "specific_query";
}

export async function evaluateDirectMemoryQuestion(
  prompt: string,
  cfg: MmConfig,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  const kind = await evaluateMemoryQuestionKind(prompt, cfg, fetchFn);
  return kind === "overview_query";
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

export async function collectEpisodeSessionProvenance(
  env: ToolEnv | undefined,
  ref: number,
  envelope: MemoryEnvelope | undefined,
): Promise<EpisodeSessionProvenance> {
  const ep = envelope?.episode;
  let sessionId = ep?.sessionId;
  let sessionFile = ep?.sessionFile;
  let leafId = ep?.leafId;
  const eventIds = new Set<string>(ep?.eventIds || []);
  const toolCallIds = new Set<string>();
  if (ep?.toolCallId) toolCallIds.add(ep.toolCallId);

  const summaries: string[] = [];
  const addSummary = (s?: string) => {
    if (s && s.trim().length >= 4 && !summaries.includes(s.trim())) {
      summaries.push(s.trim());
    }
  };
  if (ep?.approaches) {
    for (const a of ep.approaches) addSummary(a.approach);
  }
  if (ep?.findings) {
    for (const f of ep.findings) addSummary(f);
  }
  addSummary(ep?.problem);
  addSummary(envelope?.summary);

  if (
    env &&
    envelope?.evidence &&
    envelope.evidence.length > 0 &&
    (!sessionId || !sessionFile || eventIds.size === 0)
  ) {
    try {
      const embed = sepalConfigured(env.cfg);
      const cwd = memDir(env);
      const fspec = filespecFor(cwd, embed);
      const axes = axisPath(env);
      const eEnv = embedEnv(env.cfg);
      const visited = new Set<number>([ref]);
      const queue: Array<{ childRef: number; depth: number }> = envelope.evidence
        .slice(0, 6)
        .map((r) => ({ childRef: r, depth: 1 }));

      while (queue.length > 0) {
        const next = queue.shift()!;
        if (visited.has(next.childRef)) continue;
        visited.add(next.childRef);

        const item = await fetchEnvelope(env, fspec, axes, cwd, eEnv, next.childRef);
        if (!item?.envelope) continue;
        const childEp = item.envelope.episode;
        if (childEp) {
          if (!sessionId && childEp.sessionId) sessionId = childEp.sessionId;
          if (!sessionFile && childEp.sessionFile) sessionFile = childEp.sessionFile;
          if (!leafId && childEp.leafId) leafId = childEp.leafId;
          if (childEp.eventIds) {
            for (const id of childEp.eventIds) eventIds.add(id);
          }
          if (childEp.toolCallId) toolCallIds.add(childEp.toolCallId);
          if (childEp.approaches) {
            for (const a of childEp.approaches) addSummary(a.approach);
          }
        }
        addSummary(item.envelope.summary);

        if (next.depth < 2 && item.envelope.evidence && item.envelope.evidence.length > 0) {
          for (const grandChild of item.envelope.evidence.slice(0, 4)) {
            if (!visited.has(grandChild)) {
              queue.push({ childRef: grandChild, depth: next.depth + 1 });
            }
          }
        }
      }
    } catch {
      // Degrade gracefully if evidence traversal fails
    }
  }

  return {
    sessionId,
    sessionFile,
    leafId,
    eventIds: Array.from(eventIds),
    toolCallIds: Array.from(toolCallIds),
    summaries,
    problem: ep?.problem || envelope?.summary,
  };
}

export async function resolveEpisodeSessionCoordinates(
  instances: SessionContextInstances,
  provenance: EpisodeSessionProvenance,
  ref: number,
  query?: string,
): Promise<SessionCardHit[]> {
  const allEvents = instances.store.getAllEvents();
  if (allEvents.length === 0) return [];

  const meta = instances.store.getMetadata();

  const resolveToolIndex = (ev: SessionTurnEvent): number | undefined => {
    const turnEvents = instances.store.getEventsByTurn(ev.turnIndex);
    if (turnEvents.length <= 1) return undefined;
    const defaultTarget = turnEvents.find((e) => e.event.role === "tool") ?? turnEvents[0];
    if (defaultTarget.event.id === ev.id) return undefined;
    const idx = turnEvents.findIndex((e) => e.event.id === ev.id);
    return idx >= 0 ? idx : undefined;
  };

  const toCard = (ev: SessionTurnEvent, idx: number, score: number): SessionCardHit => ({
    ref: idx + 1,
    turnIndex: ev.turnIndex,
    toolIndex: resolveToolIndex(ev),
    entryId: ev.entryId,
    parentId: ev.parentId,
    timestamp: ev.timestamp,
    role: ev.role,
    speaker: ev.speaker,
    summary: ev.summary,
    score,
    toolName: ev.toolName,
    exitCode: ev.exitCode,
    filesTouched: ev.filesTouched,
    errorSnippet: ev.errorSnippet,
    inspectRef: `turn-${ev.turnIndex}`,
    lineCount: ev.lineCount ?? 0,
    sessionId: instances.store.sessionId,
    sessionShortId: meta.shortId,
    sessionOrigin: "persistent-ref",
    workspaceLabel: meta.workspaceLabel,
    sourceMemoryRef: ref,
  });

  const prioritizeEvents = (evs: SessionTurnEvent[]): SessionTurnEvent[] => {
    const expanded = new Map<string, SessionTurnEvent>();
    for (const ev of evs) {
      expanded.set(ev.id, ev);
      // Include tool executions from the same turn so exact tool coordinates are surfaced
      for (const sibling of instances.store.getEventsByTurn(ev.turnIndex)) {
        if (sibling.event.role === "tool") {
          expanded.set(sibling.event.id, sibling.event);
        }
      }
    }
    const list = Array.from(expanded.values());
    list.sort((a, b) => {
      const roleRank = (r: string) => (r === "tool" ? 0 : r === "assistant" ? 1 : 2);
      const diff = roleRank(a.role) - roleRank(b.role);
      if (diff !== 0) return diff;
      return a.turnIndex - b.turnIndex;
    });
    return list.slice(0, 3);
  };

  // Tier 1: Exact ID match (eventIds, toolCallId, leafId)
  const tier1Matches: SessionTurnEvent[] = [];
  for (const ev of allEvents) {
    if (
      provenance.eventIds.includes(ev.id) ||
      provenance.eventIds.includes(ev.entryId) ||
      provenance.toolCallIds.includes(ev.id) ||
      (provenance.leafId && (ev.entryId === provenance.leafId || ev.parentId === provenance.leafId))
    ) {
      tier1Matches.push(ev);
    }
  }
  if (tier1Matches.length > 0) {
    return prioritizeEvents(tier1Matches).map((ev, idx) => toCard(ev, idx, 10.0));
  }

  // Tier 2: L0 Evidence / Summary / Approach substring match
  const tier2Matches: SessionTurnEvent[] = [];
  const candidateProbes = provenance.summaries
    .map((s) => s.toLowerCase().trim())
    .filter((s) => s.length >= 8);
  if (candidateProbes.length > 0) {
    for (const ev of allEvents) {
      const evSum = (ev.summary || "").toLowerCase();
      const evTxt = (ev.text || "").toLowerCase();
      for (const probe of candidateProbes) {
        const probeSlice = probe.slice(0, 60);
        if (
          (probeSlice.length >= 8 && (evSum.includes(probeSlice) || evTxt.includes(probeSlice))) ||
          (evSum.length >= 10 && probe.includes(evSum.slice(0, 60)))
        ) {
          tier2Matches.push(ev);
          break;
        }
      }
    }
  }
  if (tier2Matches.length > 0) {
    return prioritizeEvents(tier2Matches).map((ev, idx) => toCard(ev, idx, 8.0));
  }

  // Tier 3: Query-ranked session search
  const searchQuery = [query, provenance.problem, provenance.summaries[0]]
    .filter(Boolean)
    .join(" ")
    .trim();
  const searchRes = await instances.engine.search({
    query: searchQuery,
    limit: 3,
    lineage: "all",
  });
  return searchRes.cards.map((c) => ({
    ...c,
    sessionId: instances.store.sessionId,
    sessionShortId: meta.shortId,
    sessionOrigin: "persistent-ref",
    workspaceLabel: meta.workspaceLabel,
    sourceMemoryRef: ref,
  }));
}

export async function indexSingleMemorySession(
  env: ToolEnv | undefined,
  ref: number,
  envelope: MemoryEnvelope | undefined,
  query?: string,
  cwd?: string,
): Promise<IndexedSessionSummary | null> {
  const prov = await collectEpisodeSessionProvenance(env, ref, envelope);
  if (!prov.sessionId && !prov.sessionFile) return null;

  const indexed = await ensureSessionIndexed({
    sessionId: prov.sessionId,
    sessionFile: prov.sessionFile,
    cwd,
    sourceRef: ref,
  });
  if (!indexed) return null;

  const matchedCards = await resolveEpisodeSessionCoordinates(indexed, prov, ref, query);
  const meta = indexed.store.getMetadata();
  return {
    sessionId: indexed.store.sessionId,
    shortId: meta.shortId,
    workspaceLabel: meta.workspaceLabel,
    totalTurns: meta.turnCount,
    totalEvents: meta.eventCount,
    matchedCards,
    instances: indexed,
  };
}

export async function indexCandidateSessions(
  env: ToolEnv | undefined,
  candidates: FusedCandidate[],
  query?: string,
  cwd?: string,
): Promise<Map<number, IndexedSessionSummary>> {
  const map = new Map<number, IndexedSessionSummary>();
  for (const cand of candidates.slice(0, 5)) {
    try {
      const summary = await indexSingleMemorySession(env, cand.ref, cand.envelope, query, cwd);
      if (summary) {
        map.set(cand.ref, summary);
      }
    } catch {
      // Degrade gracefully
    }
  }
  return map;
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

      await ensureSessionIndexed({
        sessionId,
        sessionFile: resolvedPath,
        cwd,
        sourceRef: cand.ref,
      }).catch(() => {});

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
- Do NOT search the codebase with bash/rg or read files solely because of background memories; when the user asks technical, code, session, or historical questions, use memory_recall to find relevant context.
- For casual conversation and greetings, reply conversationally without invoking codebase tools.`;

  // Compress/omit guidance when user explicitly asks direct memory questions, freeing budget for memories
  const includeGuidance = !isDirectQuestion && budget >= 600;
  const guidanceText = includeGuidance ? guidance : "";

  // True Mipmap LOD separation:
  // L2 architectural knowledge, invariants, and active hypotheses are eligible for proactive priming on mentioned subsystems.
  // L1 episodic notes and conversational history are latent: only recalled on explicit recall intent.
  const isKnowledgeQuery = isDirectQuestion || isExplicitRecall;
  const mentionedSubsystems = typeof prompt === "string" ? detectSubsystemMentions(prompt) : [];
  const pLower = typeof prompt === "string" ? prompt.toLowerCase() : "";
  if (pLower) {
    for (const cand of valid) {
      const sub = cand.envelope?.context?.subsystem;
      if (sub && sub.length >= 3 && pLower.includes(sub.toLowerCase())) {
        const norm = sub.startsWith("lib") ? sub.slice(3) : sub;
        if (!mentionedSubsystems.includes(norm)) {
          mentionedSubsystems.push(norm);
        }
      }
    }
  }
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

    const questionKind = await evaluateMemoryQuestionKind(prompt, env.cfg, options?.fetchFn);
    if (questionKind === "session_recent") {
      const sessionInst = getSessionInstances(sessionId, { cwd: ctx.cwd });
      if (ctx.sessionManager) {
        sessionInst.store.hydrateFromSessionManager(ctx.sessionManager, sessionInst.tracker);
      }
      const allSessionEvents = sessionInst.store.getAllEvents();
      const convEvents = allSessionEvents.filter(
        (ev) => (ev.role === "user" || ev.role === "assistant") && (ev.text || "").trim().length > 0,
      );
      // Exclude the current incoming prompt if it was already recorded at the tail
      const priorConv = convEvents.length > 0 &&
          convEvents[convEvents.length - 1].role === "user" &&
          (convEvents[convEvents.length - 1].text || "").trim() === prompt.trim()
        ? convEvents.slice(0, -1)
        : convEvents;

      if (priorConv.length > 0) {
        const recentSlice = priorConv.slice(-6);
        const turnLines = recentSlice.map((ev) => {
          const roleLabel = ev.role === "user" ? "User" : "Assistant";
          const raw = (ev.text || ev.summary || "").trim();
          const clipped = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
          return `- Turn ${ev.turnIndex} (${roleLabel}): "${clipped}"`;
        });
        const contextContent =
          `[Recent Session Continuity Context]\nRecent turns from the current session transcript:\n${turnLines.join("\n")}\n\n` +
          `Guidance for the Assistant:\n` +
          `- The user is asking about what was just said or discussed in the current session. Answer directly using the recent session turns above (or call memory_recall({ scope: "session", zoomTurn: <turn> }) for full verbatim lines). Do NOT summarize all-time persistent memory unless asked.`;

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
            details: { sessionRecent: true, turnCount: recentSlice.length },
            timestamp: Date.now(),
          },
        };
      }
    }

    const isDirectQuestion = questionKind === "overview_query";
    if (isDirectQuestion) {
      const overview = await buildMemoryOverview(env, { limit: 8, maxScan: 200 });
      if (overview.totalRecords > 0) {
        const budget = options?.budget ?? env.cfg.autoRecallBudgetChars ?? DEFAULT_AUTO_RECALL_BUDGET;
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
    if (isRecallIntent && recallAction(env.cfg) === "hint") {
      const hint = `[Memory Intent Detected]\nThe user or agent is inquiring about past decisions, architectural patterns, or lore. Do not guess or assume. Consult memory_recall to retrieve the relevant records before answering.`;
      if (event.systemPromptOptions && typeof event.systemPromptOptions === "object") {
        if (!event.systemPromptOptions.sections) {
          event.systemPromptOptions.sections = {};
        }
        event.systemPromptOptions.sections["memory_context"] = hint;
      }
      traceEvent("auto_recall", "info", {
        query: prompt,
        filespec: fspec,
        recallIntent: true,
        hintOnly: true,
      }, { sessionId });
      return {
        message: {
          role: "custom",
          customType: "memory_context",
          content: hint,
          display: false,
          details: { recallIntent: true, hintOnly: true },
          timestamp: Date.now(),
        },
      };
    }
    const timeout = options?.timeoutMs ?? DEFAULT_AUTO_RECALL_TIMEOUT_MS;
    const candidates = await runScanWithTimeout(env, prompt, timeout);
    debugLog("recall", "runScanWithTimeout returned candidates", {
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

    const budget = options?.budget ?? env.cfg.autoRecallBudgetChars ?? DEFAULT_AUTO_RECALL_BUDGET;
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
