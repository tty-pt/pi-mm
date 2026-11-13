/**
 * Singleton manager, report formatters, and episodic lore fusion for CodeStore.
 */

import { CodeStore, type CodeStoreOptions } from "./store.ts";
import { CodeRecallEngine, type CodeRecallOutput } from "./recall.ts";
import type {
  CodeArchitectureOverview,
  CodeDiffImpactResult,
  CodeQueryOptions,
  CodeSymbolRecord,
  CodeTraceNode,
  CodeTraceResult,
} from "./types.ts";
import { resolveRuntimeCwd } from "../session/store.ts";
import type { ToolEnv } from "../tools/index.ts";
import { sepalConfigured } from "../config.ts";
import { executeHybridScan } from "../tools/scan.ts";
import { getSessionInstances } from "../session/manager.ts";
import { extractSessionId, setMmBusy, type PiCtx } from "../hooks/events.ts";

export interface CodeInstances {
  store: CodeStore;
  engine: CodeRecallEngine;
}

const instancesByRoot = new Map<string, CodeInstances>();

export function getCodeInstances(options: CodeStoreOptions = {}): CodeInstances {
  const root = resolveRuntimeCwd(options.projectRoot);
  const existing = instancesByRoot.get(root);
  if (existing) {
    existing.store.configure(options);
    return existing;
  }

  const store = new CodeStore({ ...options, projectRoot: root });
  const engine = new CodeRecallEngine(store);
  const created: CodeInstances = { store, engine };
  instancesByRoot.set(root, created);
  return created;
}

export function clearCodeInstances(): void {
  instancesByRoot.clear();
}

export function hasExplicitCodeParams(params: Record<string, unknown>): boolean {
  return Boolean(
    params["symbol"] ||
    (Array.isArray(params["symbols"]) && params["symbols"].length > 0) ||
    params["trace"] ||
    params["diff"] === true ||
    params["file"] ||
    params["kind"] ||
    params["parentSymbol"],
  );
}

export function buildCodeQueryOptions(params: Record<string, unknown>): CodeQueryOptions {
  const rawLineRange = Array.isArray(params["lineRange"]) && params["lineRange"].length === 2
    ? [Number(params["lineRange"][0]), Number(params["lineRange"][1])] as [number, number]
    : undefined;
  const rawSymbols = Array.isArray(params["symbols"])
    ? (params["symbols"] as unknown[]).filter((s): s is string => typeof s === "string" && s.trim() !== "")
    : undefined;

  return {
    query: typeof params["query"] === "string" ? params["query"].trim() : undefined,
    symbol: typeof params["symbol"] === "string" ? params["symbol"].trim() : undefined,
    symbols: rawSymbols,
    file: typeof params["file"] === "string" ? params["file"].trim() : undefined,
    kind: typeof params["kind"] === "string" ? params["kind"].trim() : undefined,
    parentSymbol: typeof params["parentSymbol"] === "string" ? params["parentSymbol"].trim() : undefined,
    neighbors: (params["neighbors"] as CodeQueryOptions["neighbors"]) ?? undefined,
    trace: typeof params["trace"] === "string" ? params["trace"].trim() : undefined,
    direction: (params["direction"] as CodeQueryOptions["direction"]) ?? undefined,
    depth: typeof params["depth"] === "number" ? params["depth"] : undefined,
    diff: params["diff"] === true,
    overview: params["overview"] === true,
    lineRange: rawLineRange,
    maxLines: typeof params["maxLines"] === "number" ? params["maxLines"] : undefined,
    fullOutput: params["fullOutput"] === true,
    limit: typeof params["limit"] === "number" ? params["limit"] : undefined,
  };
}

async function collectLoreLines(env: ToolEnv, loreTopic: string, ctx: PiCtx): Promise<string[]> {
  const loreLines: string[] = [];
  if (!loreTopic || !env.cfg.cormBin) return loreLines;

  try {
    const scanRes = await executeHybridScan(env, { topic: loreTopic, limit: 3, includeL0: true, embed: false });
    for (const rec of scanRes.records) {
      const lvl = rec.envelope?.level ?? rec.level ?? "L2";
      const lc = rec.envelope?.lifecycle ?? rec.lifecycle ?? "supported";
      const sum = rec.envelope?.summary ?? rec.summary ?? rec.record.slice(0, 120);
      loreLines.push(`  • [Ref ${rec.ref}] (${lvl}, ${lc}): ${sum}`);
    }
  } catch { /* best-effort lore fusion */ }

  try {
    const sessionId = extractSessionId(ctx);
    const sessInst = getSessionInstances(sessionId, { cwd: ctx?.cwd || env.cwd });
    if (sessInst.store.getEventCount() > 0) {
      const sessHits = await sessInst.engine.search({ query: loreTopic, limit: 2 }, ctx?.sessionManager);
      for (const c of sessHits.cards) {
        loreLines.push(`  • [Session Turn ${c.turnIndex} · ${c.speaker}]: ${c.summary}`);
      }
    }
  } catch { /* best-effort session lore fusion */ }

  return loreLines;
}

export async function executeCodeRecallWithLore(
  env: ToolEnv,
  params: Record<string, unknown>,
  ctx: PiCtx,
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
  const embed = sepalConfigured(env.cfg);
  const codeInst = getCodeInstances({
    projectRoot: ctx?.cwd || env.cwd,
    cormBin: env.cfg.cormBin,
    axisLibs: env.cfg.axisLibs,
    embedUrl: embed ? env.cfg.embedUrl : undefined,
    embedModel: env.cfg.embedModel,
    embedKey: env.cfg.embedKey,
    ephemeralSepal: env.cfg.ephemeralSepal,
  });

  const codeOpts = buildCodeQueryOptions(params);
  setMmBusy(ctx, true);
  let codeOut: CodeRecallOutput;
  try {
    codeOut = await codeInst.engine.execute(codeOpts);
  } finally {
    setMmBusy(ctx, false);
  }

  const shouldFuseLore =
    codeOut.mode === "search" ||
    (codeOut.mode === "symbol" && (!codeOpts.symbols || codeOpts.symbols.length <= 1));
  const loreTopic = shouldFuseLore
    ? (codeOut.symbols[0]?.name || codeOpts.symbol || codeOpts.query || codeOpts.file || "")
    : "";
  const loreLines = loreTopic ? await collectLoreLines(env, loreTopic, ctx) : [];

  let fullText = codeOut.rendered;
  if (loreLines.length > 0) {
    fullText += `\n\n=== Linked Engineering Lore & Invariants (pi-mm) ===\n${loreLines.join("\n")}`;
  }

  return {
    content: [{ type: "text", text: fullText }],
    details: {
      mode: codeOut.mode,
      symbolCount: codeOut.symbols.length,
      symbols: codeOut.symbols,
      loreCount: loreLines.length,
    },
  };
}

export function formatSymbolCard(sym: CodeSymbolRecord): string {
  const degree = `callers:${sym.callers.length} callees:${sym.callees.length}`;
  const doc = sym.docComment ? `\n    Doc: ${sym.docComment}` : "";
  return `• [SymRef ${sym.ref}] (${sym.kind}) ${sym.filePath}:${sym.startLine}-${sym.endLine} · ${sym.qualifiedName} [${degree}]\n    Sig: ${sym.signature}${doc}`;
}

export function formatAmbiguousCandidates(target: string, cands: CodeSymbolRecord[]): string {
  const lines = [
    `=== Ambiguous Symbol "${target}" (${cands.length} candidates — fail-closed) ===`,
    `Pass file or kind to disambiguate, e.g. memory_recall({ scope: "code", symbol: "${target}", file: "<path>" }):`,
  ];
  for (const c of cands.slice(0, 12)) lines.push(formatSymbolCard(c));
  return lines.join("\n");
}

function renderTraceTreeLines(node: CodeTraceNode, prefix = "", isLast = true, isRoot = true): string[] {
  const branch = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const line = `${prefix}${branch}[${node.kind}] ${node.qualifiedName} (${node.filePath}:${node.startLine}-${node.endLine})`;
  const out = [line];
  const nextPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
  for (let i = 0; i < node.children.length; i++) {
    out.push(...renderTraceTreeLines(node.children[i], nextPrefix, i === node.children.length - 1, false));
  }
  return out;
}

export function formatCodeTrace(tr: CodeTraceResult): string {
  if (tr.status === "not_found") return `Trace target "${tr.targetQuery}" not found in code graph.`;
  if (tr.status === "ambiguous" && tr.candidates) return formatAmbiguousCandidates(tr.targetQuery, tr.candidates);
  const root = tr.root!;
  const lines = [`=== Call Graph Trace: ${root.qualifiedName} (${root.filePath}:${root.startLine}-${root.endLine}) ===`];
  if (tr.inboundTree) {
    lines.push(`\nInbound Callers (who calls ${root.name}):`);
    lines.push(...renderTraceTreeLines(tr.inboundTree));
  }
  if (tr.outboundTree) {
    lines.push(`\nOutbound Callees (what ${root.name} calls):`);
    lines.push(...renderTraceTreeLines(tr.outboundTree));
  }
  return lines.join("\n");
}

export function formatCodeOverview(ov: CodeArchitectureOverview): string {
  const lines = [
    `=== Codebase Architecture Overview (L3/L2 Mipmap) ===`,
    `Indexed Files: ${ov.totalFiles} | Total Symbols: ${ov.totalSymbols} | Call Edges: ${ov.totalCallEdges}`,
  ];
  if (ov.modules.length > 0) {
    lines.push(`\nModule Clusters & Dependencies:`);
    for (const m of ov.modules) {
      const deps = m.dependsOn.length > 0 ? ` -> depends on: ${m.dependsOn.join(", ")}` : "";
      lines.push(`  • ${m.moduleName} (${m.fileCount} files, ${m.symbolCount} symbols)${deps}`);
    }
  }
  if (ov.entryPointsAndRoutes.length > 0) {
    lines.push(`\nEntry Points & Routes:`);
    for (const e of ov.entryPointsAndRoutes) {
      const r = e.routePath ? ` [${e.routeMethod} ${e.routePath}]` : "";
      lines.push(`  • [${e.kind}] ${e.qualifiedName} (${e.filePath}:${e.startLine})${r}`);
    }
  }
  if (ov.hotspots.length > 0) {
    lines.push(`\nArchitectural Hotspots (High Call Degree):`);
    for (const h of ov.hotspots.slice(0, 8)) {
      lines.push(`  • ${h.qualifiedName} (${h.filePath}:${h.startLine}) — degree ${h.totalDegree} (in:${h.inboundCount}, out:${h.outboundCount})`);
    }
  }
  return lines.join("\n");
}

export function formatCodeDiffImpact(impact: CodeDiffImpactResult): string {
  if (impact.changedFiles.length === 0) {
    return "=== Worktree Change Impact: Clean (0 modified files in git diff) ===";
  }
  const lines = [
    `=== Worktree Change Impact (${impact.changedFiles.length} changed file(s), ${impact.modifiedSymbols.length} modified symbol(s)) ===`,
    `Changed Files: ${impact.changedFiles.join(", ")}`,
  ];
  if (impact.modifiedSymbols.length > 0) {
    lines.push(`\nDirectly Modified Symbols:`);
    for (const s of impact.modifiedSymbols) {
      lines.push(`  • [${s.kind}] ${s.qualifiedName} (${s.filePath}:${s.startLine}-${s.endLine})`);
    }
  }
  if (impact.impactedCallers.length > 0) {
    lines.push(`\nBlast Radius (Inbound Callers of Modified Symbols):`);
    for (const c of impact.impactedCallers) {
      lines.push(`  • [hop ${c.depth}] ${c.symbol.qualifiedName} (${c.symbol.filePath}:${c.symbol.startLine}) -> calls ${c.calledModifiedSymbol}`);
    }
  } else {
    lines.push(`\nBlast Radius: 0 external inbound callers affected.`);
  }
  return lines.join("\n");
}
