/**
 * Singleton manager, report formatters, and episodic lore fusion for CodeStore.
 */

import { CodeStore, type CodeStoreOptions } from "./store.ts";
import { CodeRecallEngine, type CodeRecallOutput } from "./recall.ts";
import type {
  CodeArchitectureOverview, CodeDiffImpactResult, CodeQueryOptions,
  CodeSymbolRecord, CodeTraceNode, CodeTraceResult,
} from "./types.ts";
import { resolveRuntimeCwd } from "../session/store.ts";
import type { ToolEnv } from "../tools/index.ts";
import { sepalConfigured } from "../config.ts";
import { executeHybridScan } from "../tools/scan.ts";
import { getSessionInstances } from "../session/manager.ts";
import { extractSessionId, setMmBusy, type PiCtx } from "../hooks/events.ts";
import {
  bindMemoryToCode, formatLoreDriftSection, getLoreBindings,
  isBindableArchitecturalLore, isRawToolTelemetryText, verifyLoreBindingsForSymbols,
} from "./lore_binding.ts";
import { formatSwarmStigmergySection, querySwarmStigmergy, recordSwarmAttentionLease } from "./stigmergy.ts";
import {
  buildCodeLoreTopic, isLoreRelevantToSymbol, resolveCrossBoundaryPairs, synthesizeFirstTouchModuleDossier,
} from "./dossier.ts";
import { evaluateCounterfactualGuardrail } from "../hooks/guardrails.ts";
import { evaluateModuleVerificationStatus, type ModuleVerificationReport } from "../hooks/verification_ledger.ts";
import { checkSessionContextDrift, formatContextDriftNotice, recordSessionSymbolsSnapshot } from "./context_sync.ts";

export interface CodeInstances { store: CodeStore; engine: CodeRecallEngine; }
const instancesByRoot = new Map<string, CodeInstances>();

export function hasCodeInstances(projectRoot?: string): boolean {
  return instancesByRoot.has(resolveRuntimeCwd(projectRoot));
}

export function getCodeInstances(options: CodeStoreOptions = {}): CodeInstances {
  const root = resolveRuntimeCwd(options.projectRoot);
  const existing = instancesByRoot.get(root);
  if (existing) { existing.store.configure(options); return existing; }
  const store = new CodeStore({ ...options, projectRoot: root });
  const created: CodeInstances = { store, engine: new CodeRecallEngine(store) };
  instancesByRoot.set(root, created);
  return created;
}

export function clearCodeInstances(): void { instancesByRoot.clear(); }

export function hasExplicitCodeParams(params: Record<string, unknown>): boolean {
  return Boolean(
    params["symbol"] || (Array.isArray(params["symbols"]) && params["symbols"].length > 0) ||
    params["trace"] || params["diff"] === true || params["diagnose"] || params["guardrail"] ||
    params["file"] || params["kind"] || params["parentSymbol"],
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
    diagnose: typeof params["diagnose"] === "string" ? params["diagnose"].trim() : undefined,
    guardrail: typeof params["guardrail"] === "string" ? params["guardrail"].trim() : undefined,
    lineRange: rawLineRange,
    maxLines: typeof params["maxLines"] === "number" ? params["maxLines"] : undefined,
    fullOutput: params["fullOutput"] === true,
    limit: typeof params["limit"] === "number" ? params["limit"] : undefined,
  };
}

async function collectLoreLines(
  env: ToolEnv,
  loreTopic: string,
  ctx: PiCtx,
  store?: CodeStore,
  primarySym?: CodeSymbolRecord,
): Promise<string[]> {
  const loreLines: string[] = [];
  if (!loreTopic || !env.cfg.cormBin) return loreLines;

  try {
    const scanRes = await executeHybridScan(env, { topic: loreTopic, limit: 3, includeL0: false, embed: false });
    for (const rec of scanRes.records) {
      const lvl = rec.envelope?.level ?? rec.level ?? "L2";
      const lc = rec.envelope?.lifecycle ?? rec.lifecycle ?? "supported";
      const sum = rec.envelope?.summary ?? rec.summary ?? rec.record.slice(0, 120);
      if (lvl === "L0" || isRawToolTelemetryText(sum)) continue;
      if (!isLoreRelevantToSymbol(sum, rec.envelope?.context?.subsystem, rec.envelope?.context?.path, primarySym)) continue;
      if (store && rec.envelope && isBindableArchitecturalLore(rec.envelope)) {
        const existing = getLoreBindings(store.indexDir);
        if (!existing.some((b) => b.memoryRef === rec.ref)) bindMemoryToCode(store, rec.ref, rec.envelope);
      }
      loreLines.push(`  • [Ref ${rec.ref}] (${lvl}, ${lc}): ${sum}`);
      for (const c of (rec.envelope?.constraints || []).slice(0, 2)) {
        loreLines.push(`    - [RESTRICTION]: ${c}`);
      }
    }
  } catch { /* best-effort lore fusion */ }

  try {
    const sessionId = extractSessionId(ctx);
    const sessInst = getSessionInstances(sessionId, { cwd: ctx?.cwd || env.cwd });
    if (sessInst.store.getEventCount() > 0) {
      const sessHits = await sessInst.engine.search({ query: loreTopic, limit: 3 }, ctx?.sessionManager);
      for (const c of sessHits.cards) {
        if ((c.speaker !== "User" && c.speaker !== "Assistant") || isRawToolTelemetryText(c.summary)) continue;
        if (c.speaker === "Assistant" && (c.toolName || (c.lineCount ?? 0) < 4)) continue;
        loreLines.push(`  • [Session Turn ${c.turnIndex} · ${c.speaker}]: ${c.summary}`);
      }
    }
  } catch { /* best-effort session lore fusion */ }

  return loreLines;
}

function appendStigmergyAndDriftSections(
  store: CodeStore,
  codeOut: CodeRecallOutput,
  sessionId: string,
): { driftSection: string; swarmSection: string } {
  if (codeOut.symbols.length === 0) return { driftSection: "", swarmSection: "" };

  if (codeOut.mode === "symbol" && sessionId && sessionId !== "default-session") {
    const primary = codeOut.symbols[0];
    recordSwarmAttentionLease(store.indexDir, {
      sessionId,
      filePath: primary.filePath,
      symbolName: primary.name,
      qualifiedName: primary.qualifiedName,
      startLine: primary.startLine,
      endLine: primary.endLine,
      action: "inspecting",
    });
  }

  const neighborNames: string[] = [];
  for (const sym of codeOut.symbols.slice(0, 4)) {
    for (const r of [...sym.callers, ...sym.callees]) {
      const nSym = store.getSymbolSync(r);
      if (nSym && !neighborNames.includes(nSym.name)) neighborNames.push(nSym.name);
    }
  }

  const swarmMatches = querySwarmStigmergy(store.indexDir, {
    currentSessionId: sessionId,
    filePaths: codeOut.symbols.map((s) => s.filePath),
    symbolNames: codeOut.symbols.map((s) => s.name),
    neighborSymbolNames: neighborNames,
  });
  const swarmSection = formatSwarmStigmergySection(swarmMatches);
  const driftReports = codeOut.mode !== "diff"
    ? verifyLoreBindingsForSymbols(store, codeOut.symbols)
    : [];
  const driftSection = formatLoreDriftSection(driftReports);
  return { driftSection, swarmSection };
}

function hasOtherPrimaryCodeMode(opts: CodeQueryOptions): boolean {
  return Boolean(
    opts.diagnose || opts.symbol || (opts.symbols && opts.symbols.length > 0) ||
    opts.trace || opts.diff || opts.overview || opts.query,
  );
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
  if (codeOpts.guardrail && !hasOtherPrimaryCodeMode(codeOpts)) {
    const gr = await evaluateCounterfactualGuardrail(
      env,
      {
        filePath: codeOpts.file,
        symbolName: codeOpts.symbol,
        intentText: codeOpts.guardrail,
        subsystem: typeof params["subsystem"] === "string" ? params["subsystem"] : undefined,
      },
      codeInst.store,
    );
    return {
      content: [{ type: "text", text: gr.rendered }],
      details: { mode: "guardrail", triggered: gr.triggered, warnings: gr.warnings, driftReports: gr.driftReports },
    };
  }

  const sessionId = extractSessionId(ctx);
  setMmBusy(ctx, true);
  let codeOut: CodeRecallOutput;
  let contextDriftNotice = "";
  try {
    await codeInst.store.ensureIndexed();
    const driftReports = await checkSessionContextDrift(codeInst.store, sessionId);
    contextDriftNotice = formatContextDriftNotice(driftReports);
    codeOut = await codeInst.engine.execute(codeOpts);
    if (codeOut.mode === "symbol" || codeOut.mode === "search") {
      recordSessionSymbolsSnapshot(codeInst.store, sessionId, codeOut.symbols);
    }
  } finally {
    setMmBusy(ctx, false);
  }

  const primarySym = codeOut.symbols[0];
  const shouldFuseLore =
    codeOut.mode === "search" || codeOut.mode === "diagnose" ||
    (codeOut.mode === "symbol" && (!codeOpts.symbols || codeOpts.symbols.length <= 1));
  const loreTopic = shouldFuseLore ? buildCodeLoreTopic(primarySym, codeOpts) : "";
  const loreLines = loreTopic ? await collectLoreLines(env, loreTopic.slice(0, 120), ctx, codeInst.store, primarySym) : [];
  const { driftSection, swarmSection } = appendStigmergyAndDriftSections(codeInst.store, codeOut, sessionId);
  const crossBoundaryLines = (codeOut.mode === "symbol" || codeOut.mode === "search")
    ? resolveCrossBoundaryPairs(codeInst.store, codeOut.symbols)
    : [];
  const primaryFile = primarySym?.filePath || codeOpts.file || "";
  const dossierSection = primaryFile && (codeOut.mode === "symbol" || codeOut.mode === "search")
    ? synthesizeFirstTouchModuleDossier(codeInst.store, sessionId, primaryFile)
    : "";

  let fullText = contextDriftNotice ? `${contextDriftNotice}\n\n${codeOut.rendered}` : codeOut.rendered;
  if (codeOut.mode === "diff") {
    const changedFiles = codeOut.changedFiles ?? Array.from(new Set(codeOut.symbols.map((s) => s.filePath)));
    const verReports = evaluateModuleVerificationStatus(sessionId, changedFiles);
    const verSection = formatModuleVerificationSection(verReports);
    if (verSection) fullText += `\n\n${verSection}`;
  }
  if (codeOpts.guardrail || (codeOut.mode === "diagnose" && codeOpts.diagnose)) {
    const intentText = codeOpts.guardrail || codeOut.symbols.map((s) => s.name).join(" ") || codeOpts.diagnose || "";
    const gr = await evaluateCounterfactualGuardrail(
      env,
      { symbolName: primarySym?.name || codeOpts.symbol, filePath: primarySym?.filePath || codeOpts.file, intentText },
      codeInst.store,
    );
    if (gr.triggered || codeOpts.guardrail) fullText += `\n\n${gr.rendered}`;
  }
  if (crossBoundaryLines.length > 0) fullText += `\n\n=== Cross-Boundary Protocol & Isomorphic Pairs ===\n${crossBoundaryLines.join("\n")}`;
  if (driftSection) fullText += `\n\n=== AST-Bound Invariant Freshness (Code-to-Lore DAG) ===\n${driftSection}`;
  if (swarmSection) fullText += `\n\n${swarmSection}`;
  if (loreLines.length > 0) fullText += `\n\n=== Linked Engineering Lore & Invariants (pi-mm) ===\n${loreLines.join("\n")}`;
  if (dossierSection) fullText += `\n\n${dossierSection}`;

  return {
    content: [{ type: "text", text: fullText }],
    details: { mode: codeOut.mode, symbolCount: codeOut.symbols.length, symbols: codeOut.symbols, loreCount: loreLines.length },
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

export function formatModuleVerificationSection(reports: ModuleVerificationReport[]): string {
  if (reports.length === 0) return "";
  const lines = [`=== Tier-0 Module Verification Gate Status ===`];
  for (const r of reports) {
    if (r.status === "verified") {
      lines.push(`  • [VERIFIED ✓ after last edit] ${r.moduleKey} (${r.changedFiles.join(", ")})`);
    } else if (r.status === "unverified_since_edit") {
      lines.push(`  • [UNVERIFIED SINCE LAST EDIT ⚠️] ${r.moduleKey} (${r.changedFiles.join(", ")}) -> run: \`${r.requiredCommand}\``);
    } else {
      lines.push(`  • [UNVERIFIED ⚠️] ${r.moduleKey} (${r.changedFiles.join(", ")}) -> run: \`${r.requiredCommand}\``);
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
  if (impact.contractMismatches && impact.contractMismatches.length > 0) {
    lines.push(`\n⚠️ Cross-Boundary XY Contract Mismatches (${impact.contractMismatches.length}):`);
    for (const m of impact.contractMismatches) {
      if (m.reason === "signature_mismatch" && m.declSymbol && m.implSymbol) {
        lines.push(
          `  • [XY Signature Mismatch] ${m.symbolName}: XY_DECL (${m.declSymbol.filePath}:${m.declSymbol.startLine}) != XY_IMPL (${m.implSymbol.filePath}:${m.implSymbol.startLine})\n    DECL: ${m.declSymbol.signature}\n    IMPL: ${m.implSymbol.signature}`,
        );
      } else if (m.reason === "missing_decl" && m.implSymbol) {
        lines.push(`  • [Missing XY_DECL] ${m.symbolName}: XY_IMPL in ${m.implSymbol.filePath}:${m.implSymbol.startLine} has no matching XY_DECL header declaration`);
      } else if (m.reason === "missing_impl" && m.declSymbol) {
        lines.push(`  • [Missing XY_IMPL] ${m.symbolName}: XY_DECL in ${m.declSymbol.filePath}:${m.declSymbol.startLine} has no matching XY_IMPL implementation`);
      }
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
