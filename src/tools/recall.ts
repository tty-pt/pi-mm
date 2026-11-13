import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { EnvSource, ToolEnv } from "./index.ts";
import { axisPath, memDir, sepalConfigured } from "./index.ts";
import { filespecFor, embedEnv } from "../corm.ts";
import { executeHybridScan } from "./scan.ts";
import { fetchEnvelope, traverseDown, renderTree } from "./traverse.ts";
import { buildMemoryOverview } from "./overview.ts";
import type { FusedCandidate } from "./ranking.ts";
import {
  enrichCandidatesWithSessionHistory,
  indexCandidateSessions,
  indexSingleMemorySession,
  type IndexedSessionSummary,
} from "../hooks/auto_recall.ts";
import type { SessionExcerpt } from "../session_history.ts";
import { canonicalSortByRef } from "../blocks.ts";
import type { MipmapLevel } from "../types.ts";
import {
  getSessionInstances,
  discoverPeerSessions,
  resolveTargetSessions,
} from "../session/manager.ts";
import {
  formatUnifiedRecallOutput,
  searchAcrossSessions,
} from "../session/recall.ts";
import { extractSessionId, setMmBusy } from "../hooks/events.ts";
import { executeCodeRecallWithLore, getCodeInstances, hasExplicitCodeParams } from "../code/manager.ts";

function parseInlineZoomRef(rawQuery: string): number | null {
  const lower = rawQuery.trim().toLowerCase();
  let rest = "";
  if (lower.startsWith("ref:")) {
    rest = lower.slice(4).trim();
  } else if (lower.startsWith("zoom:")) {
    rest = lower.slice(5).trim();
  } else if (lower.startsWith("ref ")) {
    rest = lower.slice(4).trim();
  } else if (lower.startsWith("zoom ")) {
    rest = lower.slice(5).trim();
  } else {
    return null;
  }
  if (!rest) return null;
  for (let i = 0; i < rest.length; i++) {
    const code = rest.charCodeAt(i);
    if (code < 48 || code > 57) return null;
  }
  const num = Number(rest);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function formatIndexedSessionBlock(ref: number, indexed?: IndexedSessionSummary): string {
  if (!indexed || indexed.totalEvents === 0) return "";
  const slotPart = indexed.workspaceLabel ? ` (${indexed.workspaceLabel})` : "";
  const lines: string[] = [
    `  Indexed Source Session: ${indexed.shortId}${slotPart} (Turns 1-${Math.max(1, indexed.totalTurns)}, ${indexed.totalEvents} events)`,
  ];
  for (const card of indexed.matchedCards.slice(0, 3)) {
    const status = card.exitCode !== undefined
      ? (card.exitCode === 0 ? " · SUCCESS (0)" : ` · FAILED (Exit ${card.exitCode})`)
      : "";
    lines.push(
      `    • [Turn ${card.turnIndex} · ${card.speaker}${status}] ${card.summary} (${card.lineCount} lines)`,
    );
  }
  const primaryCard = indexed.matchedCards[0];
  const targetTurn = primaryCard ? primaryCard.turnIndex : 1;
  const toolIdxPart = primaryCard?.toolIndex !== undefined ? `, toolIndex: ${primaryCard.toolIndex}` : "";
  const maxLines = primaryCard ? Math.min(Math.max(1, primaryCard.lineCount), 60) : 60;
  lines.push(
    `    • Zoom Session Turn: memory_recall({ zoomRef: ${ref}, zoomTurn: ${targetTurn}${toolIdxPart}, lineRange: [1, ${maxLines}] })`,
  );
  return lines.join("\n");
}

const RECALL_PARAMS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query: error message, symbol, concept, or natural language problem description. Omit or pass 'overview' for an all-time memory overview.",
    },
    zoomRef: {
      type: "number",
      description: "Zoom directly into a specific memory reference number, returning its complete multi-resolution details: approaches, diffs, and evidence tree.",
    },
    overview: {
      type: "boolean",
      description: "If true, returns a structured timeline and hierarchical overview (or L3/L2 codebase architecture overview when scope='code').",
    },
    project: { type: "string", description: "Filter or boost memories matching a specific project scope." },
    subsystem: { type: "string", description: "Filter or boost memories matching a specific subsystem." },
    level: { type: "string", enum: ["L0", "L1", "L2", "L3"], description: "Optional resolution level filter ('L0'|'L1'|'L2'|'L3')." },
    includeEvidence: { type: "boolean", description: "If true, automatically fetches and includes the supporting evidence tree for each memory." },
    limit: { type: "number", description: "Maximum number of memories to return (default 5 for search, 15 for overview, max 30)." },
    scope: { type: "string", enum: ["session", "persistent", "code", "all"], description: "Memory scope: 'session' (current active session), 'persistent' (cross-session project memory), 'code' (live codebase symbols, call graph, and source), or 'all' (unified)." },
    session: { type: "string", description: "Target session selector: 'current', 'parallel', 'all', session UUID/prefix (e.g. '01a1c8f7'), or workspace/slot label (e.g. 'slot-6')." },
    zoomTurn: { type: "number", description: "Specific turn number to inspect in session history (or within a persistent memory's session when combined with zoomRef)." },
    toolIndex: { type: "number", description: "Specific tool execution index within zoomTurn." },
    lineRange: { type: "array", items: { type: "number" }, description: "Specific [startLine, endLine] slice for zoomTurn or code symbol inspection." },
    lineage: { type: "string", enum: ["active", "all"], description: "Lineage scope for session recall ('active' branch vs 'all' branches)." },
    symbol: { type: "string", description: "Concrete code symbol name or qualified_name to resolve and read (fails closed with candidates if ambiguous)." },
    symbols: { type: "array", items: { type: "string" }, description: "Batch array of concrete code symbol names or qualified_names to resolve and read in one call." },
    file: { type: "string", description: "File path substring or suffix filter/disambiguator for code recall." },
    kind: { type: "string", description: "Code symbol kind filter ('Function'|'Method'|'Class'|'Struct'|'Interface'|'Type'|'Enum'|'Macro'|'Route')." },
    parentSymbol: { type: "string", description: "Enclosing class/struct/interface name disambiguator for code methods." },
    neighbors: { type: "string", enum: ["none", "callers", "callees", "both"], description: "Direct call graph neighbors to include when reading a symbol (default 'both')." },
    trace: { type: "string", description: "Function or method name to trace multi-hop callers and/or callees across the code graph." },
    direction: { type: "string", enum: ["inbound", "outbound", "both"], description: "Call graph trace direction ('inbound' callers, 'outbound' callees, or 'both')." },
    depth: { type: "number", description: "Maximum call graph trace depth (default 3) or diff blast-radius depth (default 2)." },
    diff: { type: "boolean", description: "If true, analyzes git worktree diff hunks, maps modified line intervals to symbols, and traces inbound caller blast radius." },
    maxLines: { type: "number", description: "Maximum source lines returned per code symbol before compacting (default 120)." },
    fullOutput: { type: "boolean", description: "If true, returns complete uncompacted code symbol source blocks." },
  },
  additionalProperties: false,
};

function formatResult(
  cand: FusedCandidate,
  evidenceText?: string,
  excerpts?: SessionExcerpt[],
  indexedSession?: IndexedSessionSummary,
): string {
  const ref = cand.ref;
  const env = cand.envelope;
  const level = env?.level ?? cand.level ?? "L2";
  const lifecycle = env?.lifecycle ?? cand.lifecycle ?? "supported";
  const isHypothesis = lifecycle === "hypothesized";
  const scopeParts: string[] = [];
  if (env?.context?.project) scopeParts.push(env.context.project);
  if (env?.context?.subsystem) scopeParts.push(env.context.subsystem);
  const scopeStr = scopeParts.length > 0 ? ` [${scopeParts.join("/")}]` : "";
  const lifecycleLabel = isHypothesis ? "[HYPOTHESIS]" : lifecycle;

  const summary = env?.summary ?? cand.summary ?? cand.record.slice(0, 120);
  let text = `[Ref ${ref}] (${level}, ${lifecycleLabel}${scopeStr}): ${summary}\n  Origin: ${cand.origin} (score: ${cand.score ?? "1.0"})`;

  if (evidenceText) {
    text += `\n  Supporting Evidence:\n${evidenceText.split("\n").map((l) => "    " + l).join("\n")}`;
  } else if (env?.evidence && env.evidence.length > 0) {
    text += `\n  Cites evidence refs: [${env.evidence.join(", ")}]`;
  }

  if (excerpts && excerpts.length > 0) {
    text += `\n  Source Session Excerpts:\n` + excerpts.map((e) => `    ${e.role === "user" ? "User" : "Assistant"}: "${e.text}"`).join("\n");
  }

  const sessionBlock = formatIndexedSessionBlock(ref, indexedSession);
  if (sessionBlock) {
    text += `\n${sessionBlock}`;
  }

  return text;
}

async function attachEvidence(
  env: ToolEnv,
  records: FusedCandidate[],
): Promise<Map<number, string>> {
  const embed = sepalConfigured(env.cfg);
  const cwd = memDir(env);
  const fspec = filespecFor(cwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);
  const evidenceMap = new Map<number, string>();

  for (const rec of records) {
    if (rec.envelope?.evidence && rec.envelope.evidence.length > 0) {
      try {
        const tree = await traverseDown(env, fspec, axes, cwd, eEnv, rec.ref, 0, 1, new Set());
        if (tree) evidenceMap.set(rec.ref, renderTree(tree).trim());
      } catch {
        // Fallback gracefully without evidence tree
      }
    }
  }
  return evidenceMap;
}

/**
 * Zooms into a specific memory reference number, fetching its full vertical context,
 * problem, attempted approaches, recorded diffs, verification status, and evidence tree.
 */
async function zoomInMemory(
  env: ToolEnv,
  ref: number,
  cwd?: string,
) {
  const embed = sepalConfigured(env.cfg);
  const memCwd = memDir(env);
  const fspec = filespecFor(memCwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);

  const item = await fetchEnvelope(env, fspec, axes, memCwd, eEnv, ref);
  if (!item) {
    return {
      content: [{ type: "text", text: `Memory Ref ${ref} not found in database.` }],
      details: { error: "not-found", ref },
    };
  }

  const { envelope, date } = item;
  const tree = await traverseDown(env, fspec, axes, memCwd, eEnv, ref, 0, 3, new Set());
  const treeText = tree ? renderTree(tree).trim() : `[${envelope.level}] Ref ${ref}: ${envelope.summary}`;
  const indexedSession = await indexSingleMemorySession(env, ref, envelope, undefined, cwd || env.cwd);

  const scopeParts: string[] = [];
  if (envelope.context?.project) scopeParts.push(envelope.context.project);
  if (envelope.context?.subsystem) scopeParts.push(envelope.context.subsystem);
  const scopeStr = scopeParts.length > 0 ? ` [${scopeParts.join("/")}]` : "";

  const lines = [
    `=== Memory Zoom-In: Ref ${ref} ===`,
    `Level: ${envelope.level} | Lifecycle: ${envelope.lifecycle} | Type: ${envelope.type ?? "note"}${scopeStr}`,
    `Date: ${date} | Summary: ${envelope.summary}`,
  ];

  if (envelope.constraints && envelope.constraints.length > 0) {
    lines.push(`\nConstraints & Rules:`);
    for (const c of envelope.constraints) {
      lines.push(`- [RESTRICTION]: ${c}`);
    }
  }

  const ep = envelope.episode;
  if (ep) {
    if (ep.problem) {
      lines.push(`\nProblem Addressed:\n  ${ep.problem}`);
    }
    if (ep.approaches && ep.approaches.length > 0) {
      lines.push(`\nAttempted Approaches:`);
      for (const a of ep.approaches) {
        lines.push(`- [${a.outcome.toUpperCase()}] ${a.approach}${a.reason ? ": " + a.reason : ""}`);
      }
    }
    if (ep.findings && ep.findings.length > 0) {
      lines.push(`\nFindings:\n` + ep.findings.map((f) => `  • ${f}`).join("\n"));
    }
    if (ep.diffs && ep.diffs.length > 0) {
      const diffJoined = ep.diffs.join("\n");
      const diffClipped = diffJoined.length > 1500 ? diffJoined.slice(0, 1500) + "\n...[diff truncated]" : diffJoined;
      lines.push(`\nRecorded Diffs / Changes:\n${diffClipped}`);
    }
    if (ep.outcome) {
      lines.push(`\nOutcome: ${ep.outcome}`);
    }
  }

  if (indexedSession) {
    lines.push(`\n${formatIndexedSessionBlock(ref, indexedSession).trimStart()}`);
  }

  lines.push(`\nEvidence Hierarchy (Mipmap Lineage):`);
  lines.push(treeText);

  lines.push(`\n---`);
  lines.push(`💡 To inspect supporting evidence in further detail, run: memory_recall({ zoomRef: <childRef> })`);

  const serializableSession = indexedSession
    ? {
        sessionId: indexedSession.sessionId,
        shortId: indexedSession.shortId,
        workspaceLabel: indexedSession.workspaceLabel,
        totalTurns: indexedSession.totalTurns,
        totalEvents: indexedSession.totalEvents,
        matchedCards: indexedSession.matchedCards,
      }
    : undefined;

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { ref, envelope, date, tree, indexedSession: serializableSession },
  };
}

async function executeOverviewRecall(
  env: ToolEnv,
  params: Record<string, unknown>,
) {
  const limit = Math.min(Math.max(Number(params["limit"]) || 15, 1), 30);
  const overview = await buildMemoryOverview(env, {
    project: typeof params["project"] === "string" ? params["project"].trim() : undefined,
    subsystem: typeof params["subsystem"] === "string" ? params["subsystem"].trim() : undefined,
    level: params["level"] as MipmapLevel | undefined,
    limit,
  });

  return {
    content: [{ type: "text", text: overview.renderedOverview }],
    details: { overview, totalRecords: overview.totalRecords },
  };
}

async function executeTargetedHybridRecall(
  env: ToolEnv,
  query: string,
  params: Record<string, unknown>,
  cwd: string,
) {
  const limit = Math.min(Math.max(Number(params["limit"]) || 5, 1), 20);
  const filterLevel = params["level"];
  const includeL0 = filterLevel === undefined || filterLevel === "L0";
  const { records, details } = await executeHybridScan(env, {
    topic: query,
    project: typeof params["project"] === "string" ? params["project"].trim() : undefined,
    subsystem: typeof params["subsystem"] === "string" ? params["subsystem"].trim() : undefined,
    level: filterLevel,
    includeL0,
    limit,
    embed: true,
  });

  if (records.length === 0) {
    return {
      content: [{ type: "text", text: `No memories found matching "${query}".\nTip: Call memory_recall({ overview: true }) for a high-level timeline overview across all memories.` }],
      details: { query, results: [], scanDetails: details },
    };
  }

  let evidenceMap: Map<number, string> | undefined;
  if (params["includeEvidence"] === true) {
    evidenceMap = await attachEvidence(env, records);
  }

  const excerptsMap = await enrichCandidatesWithSessionHistory(records, query, cwd);
  const indexedSessionsMap = await indexCandidateSessions(env, records, query, cwd);
  const sortedRecords = canonicalSortByRef(records);

  const lines = [`Found ${sortedRecords.length} relevant memory record(s) for "${query}":\n`];
  for (const rec of sortedRecords) {
    lines.push(
      formatResult(
        rec,
        evidenceMap?.get(rec.ref),
        excerptsMap.get(rec.ref),
        indexedSessionsMap.get(rec.ref),
      ),
    );
  }

  lines.push(`\nTip: To zoom into any of these memories, call memory_recall({ zoomRef: <ref> }).`);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { query, count: sortedRecords.length, results: sortedRecords, scanDetails: details },
  };
}

async function executeRecall(
  envSource: EnvSource,
  params: Record<string, unknown>,
  ctx: PiCtx,
) {
  try {
    const env = await envSource(ctx);
    const bin = env.cfg.cormBin;
    if (!bin) {
      return { content: [{ type: "text", text: "mm unavailable: corm binary not found" }], details: { error: "no-corm", results: [] } };
    }

    // 1. Direct Zoom-In by Reference ID (with optional zoomTurn into the memory's source session)
    if (typeof params["zoomRef"] === "number" && Number.isInteger(params["zoomRef"])) {
      const targetRef = params["zoomRef"];
      if (typeof params["zoomTurn"] === "number" && Number.isInteger(params["zoomTurn"])) {
        const embed = sepalConfigured(env.cfg);
        const memCwd = memDir(env);
        const fspec = filespecFor(memCwd, embed);
        const axes = axisPath(env);
        const eEnv = embedEnv(env.cfg);
        const item = await fetchEnvelope(env, fspec, axes, memCwd, eEnv, targetRef);
        if (!item) {
          return {
            content: [{ type: "text", text: `Memory Ref ${targetRef} not found in database.` }],
            details: { error: "not-found", ref: targetRef },
          };
        }
        const indexed = await indexSingleMemorySession(env, targetRef, item.envelope, undefined, ctx?.cwd || env.cwd);
        if (!indexed) {
          return {
            content: [{ type: "text", text: `Memory Ref ${targetRef} does not have an indexed source session transcript.` }],
            details: { error: "no-session", ref: targetRef },
          };
        }
        const toolIndex = typeof params["toolIndex"] === "number" ? params["toolIndex"] : undefined;
        const rawLineRange = Array.isArray(params["lineRange"]) && params["lineRange"].length === 2
          ? [Number(params["lineRange"][0]), Number(params["lineRange"][1])] as [number, number]
          : undefined;
        const zoomResult = await indexed.instances.engine.search({
          query: "",
          zoomTurn: params["zoomTurn"],
          toolIndex,
          lineRange: rawLineRange,
        });
        if (zoomResult.zoom) {
          zoomResult.zoom.sessionId = indexed.sessionId;
          zoomResult.zoom.sessionShortId = indexed.shortId;
          zoomResult.zoom.sessionOrigin = "persistent-ref";
          zoomResult.zoom.workspaceLabel = indexed.workspaceLabel;
          zoomResult.zoom.sourceMemoryRef = targetRef;
        }
        const rendered = formatUnifiedRecallOutput(zoomResult);
        return {
          content: [{ type: "text", text: rendered }],
          details: { ref: targetRef, sessionId: indexed.sessionId, sessionResult: zoomResult, totalMatches: zoomResult.totalMatches },
        };
      }
      return await zoomInMemory(env, targetRef, ctx?.cwd);
    }

    const rawQuery = typeof params["query"] === "string" ? params["query"].trim() : "";

    // Check if query is an inline zoom command (e.g. "ref:42" or "zoom:42")
    const inlineRef = parseInlineZoomRef(rawQuery);
    if (inlineRef !== null) {
      return await zoomInMemory(env, inlineRef, ctx?.cwd);
    }

    // Codebase-specific recall mode (scope='code' or explicit code navigation parameters)
    const scope = typeof params["scope"] === "string" ? params["scope"] : undefined;
    if (scope === "code" || hasExplicitCodeParams(params)) {
      return await executeCodeRecallWithLore(env, params, ctx);
    }

    // Session-specific recall mode, explicit session selector, or zoomTurn inspection
    const sessionParam = typeof params["session"] === "string" ? params["session"].trim() : undefined;
    const isSessionExplicit = scope === "session" || typeof params["zoomTurn"] === "number" || Boolean(sessionParam);
    const embed = sepalConfigured(env.cfg);
    const sessionOpts = {
      cwd: ctx?.cwd,
      cormBin: env.cfg.cormBin,
      axisLibs: env.cfg.axisLibs,
      embedUrl: embed ? env.cfg.embedUrl : undefined,
      embedModel: env.cfg.embedModel,
      embedKey: env.cfg.embedKey,
      ephemeralSepal: env.cfg.ephemeralSepal,
    };

    if (isSessionExplicit) {
      const sessionId = extractSessionId(ctx);
      const instances = getSessionInstances(sessionId, sessionOpts);
      const zoomTurn = typeof params["zoomTurn"] === "number" ? params["zoomTurn"] : undefined;
      const toolIndex = typeof params["toolIndex"] === "number" ? params["toolIndex"] : undefined;
      const rawLineRange = Array.isArray(params["lineRange"]) && params["lineRange"].length === 2
        ? [Number(params["lineRange"][0]), Number(params["lineRange"][1])] as [number, number]
        : undefined;
      const lineage = params["lineage"] === "all" ? "all" : "active";
      const sessionQuery = params["overview"] === true ? "" : rawQuery;
      const limit = typeof params["limit"] === "number" ? params["limit"] : (params["overview"] === true ? 10 : 5);
      const leafId = ctx?.sessionManager?.getLeafId?.();

      if (sessionParam) {
        const targetEntries = resolveTargetSessions(sessionParam, {
          cwd: ctx?.cwd,
          currentSessionId: sessionId,
          sessionOpts,
        });
        const sessionResult = await searchAcrossSessions(
          targetEntries,
          { query: sessionQuery, zoomTurn, toolIndex, lineRange: rawLineRange, lineage, limit, leafId },
          ctx?.sessionManager,
        );
        const rendered = formatUnifiedRecallOutput(sessionResult, sessionQuery);
        return {
          content: [{ type: "text", text: rendered }],
          details: { sessionResult, totalMatches: sessionResult.totalMatches },
        };
      }

      const peerEntries = discoverPeerSessions({
        cwd: ctx?.cwd,
        currentSessionId: sessionId,
        sessionOpts,
      });

      if (peerEntries.length > 1 && zoomTurn === undefined) {
        const sessionResult = await searchAcrossSessions(
          peerEntries,
          { query: sessionQuery, zoomTurn, toolIndex, lineRange: rawLineRange, lineage, limit, leafId },
          ctx?.sessionManager,
        );
        const rendered = formatUnifiedRecallOutput(sessionResult, sessionQuery);
        return {
          content: [{ type: "text", text: rendered }],
          details: { sessionResult, totalMatches: sessionResult.totalMatches },
        };
      }

      const sessionResult = await instances.engine.search({
        query: sessionQuery,
        zoomTurn,
        toolIndex,
        lineRange: rawLineRange,
        lineage,
        limit,
        leafId,
      }, ctx?.sessionManager);

      const rendered = formatUnifiedRecallOutput(sessionResult, sessionQuery);
      return {
        content: [{ type: "text", text: rendered }],
        details: { sessionResult, totalMatches: sessionResult.totalMatches },
      };
    }

    // 2. High-Level Memory Overview Mode
    const isOverview = params["overview"] === true || rawQuery === "" || rawQuery.toLowerCase() === "overview" || rawQuery === "*";
    if (isOverview) {
      return await executeOverviewRecall(env, params);
    }

    // Unified Session + Code + Persistent Recall when scope is "all" or omitted with active session history
    if (scope !== "persistent") {
      const sessionId = extractSessionId(ctx);
      const instances = getSessionInstances(sessionId, sessionOpts);
      const peerEntries = discoverPeerSessions({
        cwd: ctx?.cwd,
        currentSessionId: sessionId,
        sessionOpts,
      });
      if (scope === "all" || instances.store.getEventCount() > 0 || peerEntries.length > 1) {
        const sessionResult = peerEntries.length > 1
          ? await searchAcrossSessions(
            peerEntries,
            {
              query: rawQuery,
              limit: 3,
              leafId: ctx?.sessionManager?.getLeafId?.(),
            },
            ctx?.sessionManager,
          )
          : await instances.engine.search({
            query: rawQuery,
            limit: 3,
            leafId: ctx?.sessionManager?.getLeafId?.(),
          }, ctx?.sessionManager);

        let codeText = "";
        if (scope === "all" && rawQuery) {
          const codeInst = getCodeInstances({
            projectRoot: ctx?.cwd || env.cwd,
            cormBin: env.cfg.cormBin,
            axisLibs: env.cfg.axisLibs,
            embedUrl: embed ? env.cfg.embedUrl : undefined,
            embedModel: env.cfg.embedModel,
            embedKey: env.cfg.embedKey,
            ephemeralSepal: env.cfg.ephemeralSepal,
          });
          setMmBusy(ctx, true);
          try {
            const codeOut = await codeInst.engine.execute({ query: rawQuery, limit: 3 });
            if (codeOut.symbols.length > 0) codeText = codeOut.rendered;
          } finally {
            setMmBusy(ctx, false);
          }
        }

        if (scope === "all" || sessionResult.cards.length > 0) {
          const persistentResult = await executeTargetedHybridRecall(env, rawQuery, params, ctx.cwd);
          const sessionText = sessionResult.cards.length > 0 ? formatUnifiedRecallOutput(sessionResult, rawQuery) : "";
          const persistentText = persistentResult.content[0]?.text || "";

          const combinedText = [
            sessionText,
            codeText,
            persistentText,
          ].filter(Boolean).join("\n\n---\n\n");

          return {
            content: [{ type: "text", text: combinedText }],
            details: { sessionResult, persistentDetails: persistentResult.details },
          };
        }
      }
    }

    // 3. Targeted Hybrid Semantic & Lexical Recall
    return await executeTargetedHybridRecall(env, rawQuery, params, ctx.cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `mm recall error: ${msg}` }], details: { error: msg, results: [] } };
  }
}

export function makeRecallTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_recall",
    label: "Codebase Symbol Graph, Session Transcript & Persistent Memory Recall",
    description:
      "Primary codebase symbol search, AST source reader, call-graph tracer, and git diff blast-radius analyzer (scope: 'code', symbol, symbols, trace, diff), plus active session transcript search/zoom (scope: 'session', zoomTurn) and persistent engineering lore (scope: 'persistent', zoomRef). Prefer this tool over grep/rg for finding functions, structs, callers, callees, and prior decisions.",
    parameters: RECALL_PARAMS,
    execute: (_id, params, _sig, _upd, ctx) => executeRecall(envSource, params, ctx as PiCtx),
  };
}
