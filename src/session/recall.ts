import type { SessionStore } from "./store.ts";
import type { SessionLineageTracker, LineageSessionManagerLike } from "./lineage.ts";
import type { DiscoveredSessionEntry } from "./manager.ts";
import type {
  SessionQueryOptions,
  SessionQueryResult,
  SessionCardHit,
  SessionZoomHit,
  SessionTurnEvent,
} from "./types.ts";
import { fuseRankingsRRF } from "../tools/ranking.ts";
import { debugLog } from "../debug.ts";

const ERROR_QUERY_KEYWORDS = ["fail", "failed", "error", "err", "panic", "crash", "bug", "broken"];

function hasErrorQueryWord(queryLower: string): boolean {
  const parts = queryLower.split(/[^a-z0-9_]+/).filter(Boolean);
  for (const p of parts) {
    if (ERROR_QUERY_KEYWORDS.includes(p)) return true;
  }
  return false;
}

export class SessionRecallEngine {
  private readonly store: SessionStore;
  private readonly tracker: SessionLineageTracker;

  constructor(
    store: SessionStore,
    tracker: SessionLineageTracker,
  ) {
    this.store = store;
    this.tracker = tracker;
  }

  async search(
    options: SessionQueryOptions,
    sessionManager?: LineageSessionManagerLike,
  ): Promise<SessionQueryResult> {
    if (sessionManager) {
      this.store.hydrateFromSessionManager(sessionManager, this.tracker);
    }

    // 1. Direct line-level zoom inspection
    if (typeof options.zoomTurn === "number" && Number.isInteger(options.zoomTurn)) {
      const turnEvents = this.store.getEventsByTurn(options.zoomTurn);
      if (turnEvents.length === 0) {
        return { cards: [], totalMatches: 0 };
      }

      if (options.toolIndex !== undefined && options.toolIndex >= 0 && options.toolIndex < turnEvents.length) {
        const targetRef = turnEvents[options.toolIndex].ref;
        const zoom = this.store.sliceLines(targetRef, options.lineRange);
        if (zoom) {
          zoom.toolIndex = options.toolIndex;
        }
        return {
          cards: [],
          zoom: zoom ?? undefined,
          totalMatches: zoom ? 1 : 0,
        };
      }

      const hasToolEvent = turnEvents.some((e) => e.event.role === "tool");
      const hasConversationalPair =
        (turnEvents.some((e) => e.event.role === "user") || turnEvents.some((e) => e.event.role === "assistant")) &&
        (options.lineRange === undefined || !hasToolEvent);

      if (turnEvents.length > 1 && hasConversationalPair) {
        const combinedLines: string[] = [];
        for (let idx = 0; idx < turnEvents.length; idx++) {
          const ev = turnEvents[idx].event;
          if (ev.role === "user") {
            combinedLines.push(`[Turn ${options.zoomTurn} · User]`);
            combinedLines.push(...(ev.text || ev.summary || "").split("\n"));
          } else if (ev.role === "tool") {
            const status = ev.exitCode !== undefined
              ? (ev.exitCode === 0 ? "OK" : `FAILED (exit ${ev.exitCode})`)
              : "DONE";
            combinedLines.push(
              `[Turn ${options.zoomTurn} · Tool (toolIndex: ${idx}): ${ev.toolName || ev.speaker} (${status})] ${ev.summary || ""}`,
            );
          } else if (ev.role === "assistant") {
            combinedLines.push(`[Turn ${options.zoomTurn} · Assistant]`);
            combinedLines.push(...(ev.text || ev.summary || "").split("\n"));
          }
        }

        const totalLines = combinedLines.length;
        const range = options.lineRange ?? [1, Math.min(totalLines, 120)];
        const start = Math.max(1, Math.min(range[0], totalLines));
        const end = Math.max(start, Math.min(range[1], totalLines));
        const sliced = combinedLines.slice(start - 1, end).map((text, idx) => ({
          lineNum: start + idx,
          text,
        }));

        const zoom: SessionZoomHit = {
          ref: turnEvents[0].ref,
          turnIndex: options.zoomTurn,
          totalLines,
          startLine: start,
          endLine: end,
          lines: sliced,
          rawContent: sliced.map((l) => `${l.lineNum} | ${l.text}`).join("\n"),
        };
        return {
          cards: [],
          zoom,
          totalMatches: 1,
        };
      }

      let targetRef = turnEvents[0].ref;
      const toolIdx = turnEvents.findIndex((e) => e.event.role === "tool");
      if (toolIdx >= 0) {
        targetRef = turnEvents[toolIdx].ref;
      }

      const zoom = this.store.sliceLines(targetRef, options.lineRange);
      return {
        cards: [],
        zoom: zoom ?? undefined,
        totalMatches: zoom ? 1 : 0,
      };
    }

    const rawEvents = this.store.getAllEvents();
    if (rawEvents.length === 0) {
      return { cards: [], totalMatches: 0 };
    }

    const resolveCardToolIndex = (ev: SessionTurnEvent): number | undefined => {
      const turnEvents = this.store.getEventsByTurn(ev.turnIndex);
      if (turnEvents.length <= 1) return undefined;
      const defaultTarget = turnEvents.find((e) => e.event.role === "tool") ?? turnEvents[0];
      if (defaultTarget.event.id === ev.id) return undefined;
      const idx = turnEvents.findIndex((e) => e.event.id === ev.id);
      return idx >= 0 ? idx : undefined;
    };

    const lineageScope = options.lineage ?? "active";
    const rawQuery = (options.query || "").trim();
    const query = (rawQuery.toLowerCase() === "overview" || rawQuery === "*") ? "" : rawQuery;
    const limit = Math.max(1, options.limit ?? 5);

    // If query is empty, return recent events from lineage (deduplicating identical summaries)
    if (!query) {
      const filteredEvents = this.tracker.filterEvents(
        rawEvents,
        lineageScope,
        sessionManager,
        options.leafId,
      );
      const deduped: SessionTurnEvent[] = [];
      const seenKeys = new Set<string>();
      for (let i = filteredEvents.length - 1; i >= 0 && deduped.length < limit; i--) {
        const ev = filteredEvents[i];
        const key = `${ev.role}:${ev.speaker}:${ev.summary}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        deduped.push(ev);
      }
      const cards: SessionCardHit[] = deduped.map((ev, idx) => ({
        ref: idx + 1,
        turnIndex: ev.turnIndex,
        toolIndex: resolveCardToolIndex(ev),
        entryId: ev.entryId,
        parentId: ev.parentId,
        timestamp: ev.timestamp,
        role: ev.role,
        speaker: ev.speaker,
        summary: ev.summary,
        score: 1.0,
        toolName: ev.toolName,
        exitCode: ev.exitCode,
        filesTouched: ev.filesTouched,
        errorSnippet: ev.errorSnippet,
        inspectRef: `turn-${ev.turnIndex}`,
        lineCount: ev.lineCount ?? 0,
      }));

      return { cards, totalMatches: cards.length };
    }

    // 2. Genuine Multi-Axis C Retrieval via corm (liblemma lexical + libsepal semantic) + exact symbol fusion
    await this.store.flush();
    const lexLines = await this.store.queryLexical(query, limit * 2);
    const semLines = await this.store.querySemantic(query, limit * 2);

    debugLog("session", "Executed corm multi-axis session scan", {
      query,
      lexicalHits: lexLines.length,
      semanticHits: semLines.length,
    });

    const scoresByEntryId = new Map<string, { ev: SessionTurnEvent; score: number }>();

    if (lexLines.length > 0 || semLines.length > 0) {
      const fused = fuseRankingsRRF(lexLines, semLines, 60);
      for (const cand of fused) {
        const ev = await this.store.getEvent(cand.ref);
        if (ev) {
          scoresByEntryId.set(ev.id, { ev, score: cand.rrfScore * 100 });
        }
      }
    }

    // Fuse with in-memory exact token/identifier & diagnostic signal matching
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.trim().split(" ").map((t) => t.trim()).filter((t) => t.length > 1);
    const isErrorQuery = hasErrorQueryWord(queryLower);

    for (const ev of rawEvents) {
      const summaryLower = (ev.summary || "").toLowerCase();
      const textLower = (ev.text || "").toLowerCase();
      const errLower = (ev.errorSnippet || "").toLowerCase();
      let matchScore = 0;
      let matchedTerms = 0;

      for (const term of queryTerms) {
        if (summaryLower.includes(term) || errLower.includes(term)) {
          matchScore += 3.0;
          matchedTerms++;
        } else if (textLower.includes(term)) {
          matchScore += 1.5;
          matchedTerms++;
        }
      }

      if (summaryLower.includes(queryLower) || errLower.includes(queryLower)) matchScore += 5.0;
      if (textLower.includes(queryLower)) matchScore += 3.0;

      if (isErrorQuery && ev.exitCode && ev.exitCode !== 0) {
        matchScore += 4.0;
      }

      if (matchedTerms > 0 || matchScore > 0) {
        matchScore += ev.turnIndex * 0.05;
        const prev = scoresByEntryId.get(ev.id);
        scoresByEntryId.set(ev.id, {
          ev,
          score: (prev ? prev.score : 0) + matchScore,
        });
      }
    }

    const matchedEvents = Array.from(scoresByEntryId.values());

    // Apply lineage filtering
    const candidateEvents = matchedEvents.map((m) => m.ev);
    const filteredEvents = this.tracker.filterEvents(
      candidateEvents,
      lineageScope,
      sessionManager,
      options.leafId,
    );
    const allowedEntryIds = new Set(filteredEvents.map((e) => e.entryId));

    // Deduplicate identical (role, speaker, summary) hits across turns so highest-scoring turn wins
    const seenHitKeys = new Set<string>();
    const finalRanked: Array<{ ev: SessionTurnEvent; score: number }> = [];
    for (const hit of matchedEvents.filter((m) => allowedEntryIds.has(m.ev.entryId)).sort((a, b) => b.score - a.score)) {
      const dedupKey = `${hit.ev.role}:${hit.ev.speaker}:${hit.ev.summary}:${(hit.ev.text || "").slice(0, 120)}`;
      if (seenHitKeys.has(dedupKey)) continue;
      seenHitKeys.add(dedupKey);
      finalRanked.push(hit);
      if (finalRanked.length >= limit) break;
    }

    const cards: SessionCardHit[] = finalRanked.map((hit, idx) => ({
      ref: idx + 1,
      turnIndex: hit.ev.turnIndex,
      toolIndex: resolveCardToolIndex(hit.ev),
      entryId: hit.ev.entryId,
      parentId: hit.ev.parentId,
      timestamp: hit.ev.timestamp,
      role: hit.ev.role,
      speaker: hit.ev.speaker,
      summary: hit.ev.summary,
      score: Number(hit.score.toFixed(4)),
      toolName: hit.ev.toolName,
      exitCode: hit.ev.exitCode,
      filesTouched: hit.ev.filesTouched,
      errorSnippet: hit.ev.errorSnippet,
      inspectRef: `turn-${hit.ev.turnIndex}`,
      lineCount: hit.ev.lineCount ?? 0,
    }));

    return {
      cards,
      totalMatches: finalRanked.length,
    };
  }
}

export async function searchAcrossSessions(
  entries: DiscoveredSessionEntry[],
  options: SessionQueryOptions,
  currentSessionManager?: LineageSessionManagerLike,
): Promise<SessionQueryResult> {
  if (entries.length === 0) {
    return { cards: [], totalMatches: 0 };
  }

  // 1. Direct line-level zoom across candidate sessions
  if (typeof options.zoomTurn === "number" && Number.isInteger(options.zoomTurn)) {
    for (const entry of entries) {
      const mgr = entry.origin === "current" ? currentSessionManager : undefined;
      const res = await entry.instances.engine.search(options, mgr);
      if (res.zoom) {
        res.zoom.sessionId = entry.sessionId;
        res.zoom.sessionShortId = entry.shortId;
        res.zoom.sessionOrigin = entry.origin;
        res.zoom.workspaceLabel = entry.workspaceLabel;
        res.zoom.sourceMemoryRef = entry.sourceMemoryRef;
        return res;
      }
    }
    return { cards: [], totalMatches: 0 };
  }

  // 2. Multi-session card search
  const limit = Math.max(1, options.limit ?? 5);
  const allCards: SessionCardHit[] = [];

  for (const entry of entries) {
    const mgr = entry.origin === "current" ? currentSessionManager : undefined;
    const subResult = await entry.instances.engine.search(
      {
        ...options,
        leafId: entry.origin === "current" ? options.leafId : undefined,
        limit,
      },
      mgr,
    );
    for (const card of subResult.cards) {
      const originBoost = entry.origin === "current" ? 0.05 : 0;
      allCards.push({
        ...card,
        score: Number((card.score + originBoost).toFixed(4)),
        sessionId: entry.sessionId,
        sessionShortId: entry.shortId,
        sessionOrigin: entry.origin,
        workspaceLabel: entry.workspaceLabel,
        sourceMemoryRef: entry.sourceMemoryRef,
      });
    }
  }

  allCards.sort((a, b) => b.score - a.score);
  const topCards = allCards.slice(0, limit).map((c, idx) => ({
    ...c,
    ref: idx + 1,
  }));

  return {
    cards: topCards,
    totalMatches: allCards.length,
  };
}

function formatCardProvenancePrefix(c: SessionCardHit): string {
  if (!c.sessionOrigin) {
    return `Turn ${c.turnIndex}`;
  }
  if (c.sessionOrigin === "current") {
    return `Current Session · Turn ${c.turnIndex}`;
  }
  if (c.sessionOrigin === "parallel") {
    const shortId = c.sessionShortId || (c.sessionId ? c.sessionId.slice(0, 8) : "peer");
    const slotPart = c.workspaceLabel ? ` (${c.workspaceLabel})` : "";
    return `Parallel Session ${shortId}${slotPart} · Turn ${c.turnIndex}`;
  }
  const shortId = c.sessionShortId || (c.sessionId ? c.sessionId.slice(0, 8) : "hist");
  const refPart = c.sourceMemoryRef !== undefined ? ` (via Ref ${c.sourceMemoryRef})` : "";
  return `Session ${shortId}${refPart} · Turn ${c.turnIndex}`;
}

function formatCardZoomCommand(c: SessionCardHit): string {
  const toolIdxParam = c.toolIndex !== undefined ? `, toolIndex: ${c.toolIndex}` : "";
  const endLine = Math.min(Math.max(1, c.lineCount), 50);
  if (c.sessionOrigin === "persistent-ref" && c.sourceMemoryRef !== undefined) {
    return `memory_recall({ zoomRef: ${c.sourceMemoryRef}, zoomTurn: ${c.turnIndex}${toolIdxParam}, lineRange: [1, ${endLine}] })`;
  }
  if (c.sessionOrigin === "parallel" && (c.sessionShortId || c.sessionId)) {
    const targetId = c.sessionShortId || c.sessionId!;
    return `memory_recall({ session: "${targetId}", zoomTurn: ${c.turnIndex}${toolIdxParam}, lineRange: [1, ${endLine}] })`;
  }
  return `memory_recall({ zoomTurn: ${c.turnIndex}${toolIdxParam}, lineRange: [1, ${endLine}] })`;
}

export function formatSessionCards(cards: SessionCardHit[], query?: string): string {
  if (cards.length === 0) {
    return query ? `No session events found matching "${query}".` : "No session events recorded.";
  }

  const lines = [
    `=== Ephemeral Session Results (${cards.length} match${cards.length === 1 ? "" : "es"} in active lineage) ===\n`,
  ];

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const statusLabel = c.exitCode !== undefined
      ? (c.exitCode === 0 ? "SUCCESS (0)" : `FAILED (Exit ${c.exitCode})`)
      : undefined;

    const headPrefix = formatCardProvenancePrefix(c);
    lines.push(`[${headPrefix} · ${c.speaker}${statusLabel ? ` · ${statusLabel}` : ""}]`);
    lines.push(`  ├─ Summary: ${c.summary}`);
    if (statusLabel) {
      lines.push(`  ├─ Status: ${statusLabel}`);
    }
    if (c.errorSnippet) {
      lines.push(`  ├─ Error: ${c.errorSnippet}`);
    }
    if (c.filesTouched && c.filesTouched.length > 0) {
      lines.push(`  ├─ Files: ${c.filesTouched.join(", ")}`);
    }
    lines.push(`  └─ Zoom: ${formatCardZoomCommand(c)}`);
    lines.push("");
  }

  lines.push("Tip: Use memory_recall({ zoomTurn: <turn>, lineRange: [<start>, <end>] }) to inspect exact lines.");
  return lines.join("\n");
}

export function formatSessionZoom(zoom: SessionZoomHit): string {
  const toolSuffix = zoom.toolName ? ` · Tool: ${zoom.toolName}` : "";
  const header = `=== Turn ${zoom.turnIndex}${toolSuffix} (Lines ${zoom.startLine}-${zoom.endLine} of ${zoom.totalLines}) ===`;
  let provenanceLine = "";
  if (zoom.sessionOrigin === "parallel") {
    const shortId = zoom.sessionShortId || (zoom.sessionId ? zoom.sessionId.slice(0, 8) : "peer");
    const slotPart = zoom.workspaceLabel ? ` (${zoom.workspaceLabel})` : "";
    provenanceLine = `\nSession: ${shortId}${slotPart} [parallel]`;
  } else if (zoom.sessionOrigin === "persistent-ref" || zoom.sourceMemoryRef !== undefined) {
    const shortId = zoom.sessionShortId || (zoom.sessionId ? zoom.sessionId.slice(0, 8) : "hist");
    const slotPart = zoom.workspaceLabel ? ` (${zoom.workspaceLabel})` : "";
    const refPart = zoom.sourceMemoryRef !== undefined ? ` (via Ref ${zoom.sourceMemoryRef})` : "";
    provenanceLine = `\nSession: ${shortId}${slotPart}${refPart} [persistent-ref]`;
  }

  const renderedLines = zoom.lines.map((l) => `${l.lineNum} | ${l.text}`).join("\n");
  return `${header}${provenanceLine}\n\n${renderedLines}\n\nTip: Adjust lineRange: [${zoom.startLine}, ${zoom.endLine}] to slice surrounding lines.`;
}

export function formatUnifiedRecallOutput(result: SessionQueryResult, query?: string): string {
  if (result.zoom) {
    return formatSessionZoom(result.zoom);
  }
  return formatSessionCards(result.cards, query);
}
