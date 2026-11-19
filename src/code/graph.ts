/**
 * Call Graph Traversal, L3/L2 Architecture Overview, and Git Diff Blast Radius (src/code/graph.ts).
 * Zero regexes: uses deterministic string/character operations.
 */

import type { CodeStore } from "./store.ts";
import type {
  CodeArchitectureOverview,
  CodeDiffHunk,
  CodeDiffImpactResult,
  CodeQueryOptions,
  CodeSymbolRecord,
  CodeTraceNode,
  CodeTraceResult,
  RankedSymbolCandidate,
} from "./types.ts";
import { isAsciiDigit } from "./lexer.ts";
import { isTestOrMockRelPath, normalizeRelPath } from "./payload_codec.ts";
import { detectXyContractMismatches } from "./dossier.ts";
import { getSessionContextSnapshots } from "./context_sync.ts";
import { getLoreBindings } from "./lore_binding.ts";

function parseInlineSymRef(raw?: string): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  let digits = "";
  if (s.startsWith("symref:")) digits = s.slice(7).trim();
  else if (s.startsWith("symref ")) digits = s.slice(7).trim();
  else if (s.startsWith("#")) digits = s.slice(1).trim();
  if (!digits) return null;
  for (let i = 0; i < digits.length; i++) {
    if (!isAsciiDigit(digits.charCodeAt(i))) return null;
  }
  const n = Number(digits);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function resolveSymbolCandidates(
  store: CodeStore,
  opts: { name?: string; qualifiedName?: string; file?: string; kind?: string; parentSymbol?: string; symRef?: number },
): CodeSymbolRecord[] {
  if (typeof opts.symRef === "number" && Number.isInteger(opts.symRef) && opts.symRef > 0) {
    const byRef = store.getSymbolSync(opts.symRef);
    return byRef ? [byRef] : [];
  }
  const inlineRef = parseInlineSymRef(opts.name) ?? parseInlineSymRef(opts.qualifiedName);
  if (inlineRef !== null) {
    const byRef = store.getSymbolSync(inlineRef);
    return byRef ? [byRef] : [];
  }

  const qn = opts.qualifiedName?.trim();
  const name = opts.name?.trim();

  let cands: CodeSymbolRecord[];
  if (qn) {
    const exactQn = store.getSymbolByQualifiedName(qn);
    cands = exactQn ? [exactQn] : store.getAllSymbols().filter((s) =>
      s.qualifiedName === qn || s.qualifiedName.endsWith(`:${qn}`) || s.qualifiedName.endsWith(`.${qn}`)
    );
  } else if (name) {
    const byName = store.getSymbolsByName(name);
    const byQn = store.getSymbolByQualifiedName(name);
    if (byName.length > 0) cands = [...byName];
    else if (byQn) cands = [byQn];
    else {
      const all = store.getAllSymbols();
      const exactSuffix = all.filter((s) => s.qualifiedName.endsWith(`:${name}`) || s.qualifiedName.endsWith(`.${name}`));
      if (exactSuffix.length > 0) cands = exactSuffix;
      else {
        const lower = name.toLowerCase();
        const caseInsensitiveExact = all.filter((s) => s.name.toLowerCase() === lower);
        if (caseInsensitiveExact.length > 0) {
          cands = caseInsensitiveExact;
        } else {
          cands = all.filter((s) => s.name.toLowerCase().includes(lower) || s.qualifiedName.toLowerCase().includes(lower));
        }
      }
    }
  } else {
    cands = store.getAllSymbols();
  }

  const file = opts.file ? normalizeRelPath(opts.file.trim()).toLowerCase() : "";
  if (file) {
    cands = cands.filter((s) => {
      const sfp = s.filePath.toLowerCase();
      return sfp.includes(file) || file.endsWith(`/${sfp}`) || file === sfp;
    });
  }
  const kind = opts.kind?.trim().toLowerCase();
  if (kind) cands = cands.filter((s) => s.kind.toLowerCase() === kind);
  const parent = opts.parentSymbol?.trim();
  if (parent) cands = cands.filter((s) => s.parentSymbol === parent);

  if (cands.length > 1 && (name || qn)) {
    const nonDecl = cands.filter((s) => !s.signature.startsWith("XY_DECL("));
    if (nonDecl.length > 0 && nonDecl.length < cands.length) cands = nonDecl;
    if (!file) {
      const nonTest = cands.filter((s) => !isTestOrMockRelPath(s.filePath));
      if (nonTest.length > 0 && nonTest.length < cands.length) cands = nonTest;
    }
  }
  return cands;
}

function extractDirPrefix(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx >= 0 ? filePath.slice(0, idx + 1) : "";
}

function buildSelectCommandForCandidate(
  sym: CodeSymbolRecord,
  allCands: CodeSymbolRecord[],
  mode: "symbol" | "trace",
): string {
  const targetKey = mode === "trace" ? "trace" : "symbol";
  const sameFileAndName = allCands.filter((c) => c.filePath === sym.filePath && c.name === sym.name);
  if (sameFileAndName.length === 1) {
    return `memory_recall({ scope: "code", ${targetKey}: "${sym.name}", file: "${sym.filePath}" })`;
  }
  if (sym.parentSymbol) {
    const sameParent = sameFileAndName.filter((c) => c.parentSymbol === sym.parentSymbol);
    if (sameParent.length === 1) {
      return `memory_recall({ scope: "code", ${targetKey}: "${sym.name}", file: "${sym.filePath}", parentSymbol: "${sym.parentSymbol}" })`;
    }
  }
  const sameKind = sameFileAndName.filter((c) => c.kind === sym.kind);
  if (sameKind.length === 1) {
    return `memory_recall({ scope: "code", ${targetKey}: "${sym.name}", file: "${sym.filePath}", kind: "${sym.kind}" })`;
  }
  return `memory_recall({ scope: "code", ${targetKey}: "${sym.name}", symRef: ${sym.ref} })`;
}

export function rankAmbiguousCandidates(
  store: CodeStore,
  target: string,
  cands: CodeSymbolRecord[],
  options?: { sessionId?: string; mode?: "symbol" | "trace" },
): RankedSymbolCandidate[] {
  const mode = options?.mode ?? "symbol";
  const sessionId = options?.sessionId || "";
  const snapshots = sessionId ? getSessionContextSnapshots(sessionId) : [];
  const activeFiles = new Set(snapshots.map((s) => s.filePath));
  const activeDirs = new Set(snapshots.map((s) => extractDirPrefix(s.filePath)).filter(Boolean));
  const activeNeighborRefs = new Set<number>();

  for (const snap of snapshots) {
    const entry = store.getFileEntry(snap.filePath);
    if (!entry) continue;
    for (const ref of entry.symbolRefs) {
      const s = store.getSymbolSync(ref);
      if (!s) continue;
      for (const cr of s.callers) activeNeighborRefs.add(cr);
      for (const ce of s.callees) activeNeighborRefs.add(ce);
    }
  }

  const loreByQn = new Map<string, number[]>();
  try {
    for (const b of getLoreBindings(store)) {
      if (b.lifecycle === "contradicted" || b.lifecycle === "superseded") continue;
      for (const a of b.anchors) {
        const key = `${a.filePath}:${a.symbolName}`;
        const list = loreByQn.get(key) ?? [];
        if (!list.includes(b.memoryRef)) list.push(b.memoryRef);
        loreByQn.set(key, list);
      }
    }
  } catch { /* ignore */ }

  const targetTrimmed = target.trim();
  const targetLower = targetTrimmed.toLowerCase();

  const ranked: RankedSymbolCandidate[] = cands.map((sym) => {
    let score = 0;
    const reasons: string[] = [];

    if (sym.name === targetTrimmed || sym.qualifiedName === targetTrimmed) {
      score += 40;
    } else if (sym.name.toLowerCase() === targetLower) {
      score += 25;
    } else if (sym.name.toLowerCase().startsWith(targetLower)) {
      score += 15;
    } else {
      score += 5;
    }

    if (activeFiles.has(sym.filePath)) {
      score += 30;
      reasons.push("active file in session context");
    } else {
      const dir = extractDirPrefix(sym.filePath);
      if (dir && activeDirs.has(dir)) {
        score += 12;
        reasons.push("active module in session context");
      }
    }

    if (activeNeighborRefs.has(sym.ref)) {
      score += 20;
      reasons.push("1-hop call neighbor of session context");
    }

    const loreRefs = loreByQn.get(`${sym.filePath}:${sym.name}`);
    if (loreRefs && loreRefs.length > 0) {
      score += 15;
      reasons.push(`bound lore [Ref ${loreRefs.join(", ")}]`);
    }

    const degree = sym.callers.length * 2 + sym.callees.length;
    if (degree > 0) {
      score += Math.min(15, degree);
      if (sym.callers.length >= 2 || degree >= 4) {
        reasons.push(`call-graph hotspot (callers:${sym.callers.length} callees:${sym.callees.length})`);
      }
    }

    if (!isTestOrMockRelPath(sym.filePath)) {
      score += 5;
    }

    return {
      symbol: sym,
      score,
      reasons,
      selectCommand: buildSelectCommandForCandidate(sym, cands, mode),
      boundLoreRefs: loreRefs,
    };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const degA = a.symbol.callers.length * 2 + a.symbol.callees.length;
    const degB = b.symbol.callers.length * 2 + b.symbol.callees.length;
    if (degB !== degA) return degB - degA;
    return a.symbol.filePath.localeCompare(b.symbol.filePath) || (a.symbol.startLine - b.symbol.startLine);
  });

  return ranked;
}

function buildTraceSubtree(
  store: CodeStore, sym: CodeSymbolRecord, direction: "inbound" | "outbound",
  currentDepth: number, maxDepth: number, visited: Set<number>,
): CodeTraceNode {
  const node: CodeTraceNode = {
    ref: sym.ref, name: sym.name, qualifiedName: sym.qualifiedName, kind: sym.kind,
    filePath: sym.filePath, startLine: sym.startLine, endLine: sym.endLine,
    signature: sym.signature, depth: currentDepth, direction: currentDepth === 0 ? "root" : direction, children: [],
  };
  if (currentDepth >= maxDepth) return node;
  visited.add(sym.ref);
  const neighborRefs = direction === "inbound" ? sym.callers : sym.callees;
  for (const nRef of neighborRefs) {
    if (visited.has(nRef)) continue;
    const neighbor = store.getSymbolSync(nRef);
    if (!neighbor) continue;
    node.children.push(buildTraceSubtree(store, neighbor, direction, currentDepth + 1, maxDepth, new Set(visited)));
  }
  return node;
}

export function traceSymbolPath(
  store: CodeStore,
  targetQuery: string,
  opts: CodeQueryOptions = {},
): CodeTraceResult {
  const candidates = resolveSymbolCandidates(store, {
    name: targetQuery,
    file: opts.file,
    kind: opts.kind,
    parentSymbol: opts.parentSymbol,
    symRef: opts.symRef,
  });

  if (candidates.length === 0) {
    return { status: "not_found", targetQuery, candidates: [] };
  }
  if (candidates.length > 1) {
    return { status: "ambiguous", targetQuery, candidates: candidates.slice(0, 15) };
  }

  const root = candidates[0];
  const dir = opts.direction ?? "both";
  const maxDepth = Math.max(1, Math.min(opts.depth ?? 3, 6));

  const inboundTree = (dir === "inbound" || dir === "both")
    ? buildTraceSubtree(store, root, "inbound", 0, maxDepth, new Set())
    : undefined;
  const outboundTree = (dir === "outbound" || dir === "both")
    ? buildTraceSubtree(store, root, "outbound", 0, maxDepth, new Set())
    : undefined;

  return {
    status: "ok",
    targetQuery,
    root,
    inboundTree,
    outboundTree,
  };
}

function deriveModuleName(filePath: string): string {
  const parts = normalizeRelPath(filePath).split("/").filter(Boolean);
  if (parts.length <= 1) return "root";
  if ((parts[0] === "mods" || parts[0] === "external" || parts[0] === "src" || parts[0] === "packages") && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] === ".pi" && parts[1] === "extensions" && parts.length >= 3) {
    return `.pi/extensions/${parts[2]}`;
  }
  return parts[0];
}

function isOverviewTestFile(filePath: string): boolean {
  return isTestOrMockRelPath(filePath);
}

export function buildCodeArchitectureOverview(store: CodeStore): CodeArchitectureOverview {
  const files = store.getAllFiles();
  const symbols = store.getAllSymbols();
  const stats = store.getStats();

  const modMap = new Map<string, { files: number; symbols: number; deps: Set<string> }>();
  for (const f of files) {
    const modName = deriveModuleName(f.filePath);
    const entry = modMap.get(modName) ?? { files: 0, symbols: 0, deps: new Set<string>() };
    entry.files++;
    entry.symbols += f.symbolRefs.length;
    for (const imp of f.imports) {
      if (imp.length > 0) entry.deps.add(imp);
    }
    modMap.set(modName, entry);
  }

  const isPrimaryCluster = (m: string) =>
    m.startsWith("mods/") || m.startsWith("external/") || m.startsWith(".pi/extensions/") ||
    m.startsWith("src/") || m === "include" || m === "htdocs";

  const modules = Array.from(modMap.entries())
    .map(([moduleName, d]) => ({
      moduleName,
      fileCount: d.files,
      symbolCount: d.symbols,
      dependsOn: Array.from(d.deps).slice(0, 8),
    }))
    .sort((a, b) => {
      const aCore = isPrimaryCluster(a.moduleName) ? 0 : 1;
      const bCore = isPrimaryCluster(b.moduleName) ? 0 : 1;
      if (aCore !== bCore) return aCore - bCore;
      return b.symbolCount - a.symbolCount;
    })
    .slice(0, 18);

  const entryPointsAndRoutes = symbols
    .filter((s) =>
      !isOverviewTestFile(s.filePath) &&
      (s.kind === "Route" ||
        s.name === "main" ||
        s.name === "install" ||
        s.name.endsWith("_install") ||
        s.name === "bud_app_render" ||
        s.name.startsWith("STL_WASM_MODULE"))
    )
    .sort((a, b) => {
      const aMod = a.filePath.startsWith("mods/") ? 0 : 1;
      const bMod = b.filePath.startsWith("mods/") ? 0 : 1;
      return aMod - bMod;
    })
    .slice(0, 15)
    .map((s) => ({
      ref: s.ref,
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      filePath: s.filePath,
      startLine: s.startLine,
      routePath: s.routePath,
      routeMethod: s.routeMethod,
    }));

  const hotspots = symbols
    .filter((s) =>
      s.kind !== "Macro" &&
      s.name !== "main" &&
      !s.name.startsWith("ASSERT") &&
      !s.name.startsWith("TEST") &&
      !isOverviewTestFile(s.filePath)
    )
    .map((s) => ({
      ref: s.ref,
      name: s.name,
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      filePath: s.filePath,
      startLine: s.startLine,
      endLine: s.endLine,
      inboundCount: s.callers.length,
      outboundCount: s.callees.length,
      totalDegree: s.callers.length + s.callees.length,
    }))
    .filter((h) => h.totalDegree > 0)
    .sort((a, b) => b.totalDegree - a.totalDegree)
    .slice(0, 12);

  return {
    projectRoot: store.projectRoot,
    totalFiles: stats.files,
    totalSymbols: stats.symbols,
    totalCallEdges: stats.callEdges,
    modules,
    entryPointsAndRoutes,
    hotspots,
  };
}

function parsePlusRangeFromHunkHeader(line: string): { startLine: number; count: number } | null {
  const plusIdx = line.indexOf("+");
  const closeAt = line.indexOf("@@", 2);
  if (plusIdx < 0 || closeAt < 0 || plusIdx >= closeAt) return null;
  let i = plusIdx + 1;
  let startStr = "";
  while (i < closeAt && isAsciiDigit(line.charCodeAt(i))) {
    startStr += line.charAt(i);
    i++;
  }
  if (!startStr) return null;
  let countStr = "";
  if (i < closeAt && line.charCodeAt(i) === 44) {
    i++;
    while (i < closeAt && isAsciiDigit(line.charCodeAt(i))) {
      countStr += line.charAt(i);
      i++;
    }
  }
  const startLine = Number(startStr);
  const count = countStr ? Number(countStr) : 1;
  return { startLine: Math.max(1, startLine), count: Math.max(1, count) };
}

function isSubprojectCommitLine(line: string): boolean {
  return line.startsWith("Subproject commit ") || line.startsWith("-Subproject commit ") || line.startsWith("+Subproject commit ");
}

export function parseUnifiedDiffHunks(diffText: string): CodeDiffHunk[] {
  const hunks: CodeDiffHunk[] = [];
  let currentFile = "";
  let isSubproject = false;
  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("diff --git ")) {
      currentFile = "";
      isSubproject = false;
      continue;
    }
    if (line.startsWith("index ") && line.endsWith(" 160000")) {
      isSubproject = true;
      continue;
    }
    if (isSubprojectCommitLine(line)) {
      isSubproject = true;
      while (currentFile && hunks.length > 0 && hunks[hunks.length - 1].filePath === currentFile) {
        hunks.pop();
      }
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentFile = isSubproject ? "" : normalizeRelPath(line.slice(6).trim());
      continue;
    }
    if (line.startsWith("@@ ") && currentFile && !isSubproject) {
      const range = parsePlusRangeFromHunkHeader(line);
      if (range) {
        hunks.push({ filePath: currentFile, startLine: range.startLine, endLine: range.startLine + range.count - 1 });
      }
    }
  }
  return hunks;
}

export async function collectWorktreeDiffText(
  store: CodeStore,
  options?: { fallbackToHeadCommit?: boolean },
): Promise<string> {
  let res = await store.runner.run({
    command: "git", args: ["diff", "HEAD", "--unified=0"], env: {}, cwd: store.projectRoot,
  });
  let rootDiff = res.code === 0 ? res.stdout : "";
  if (!rootDiff.trim() && options?.fallbackToHeadCommit) {
    res = await store.runner.run({
      command: "git", args: ["diff", "HEAD~1", "HEAD", "--unified=0"], env: {}, cwd: store.projectRoot,
    });
    rootDiff = res.code === 0 ? res.stdout : "";
  }
  if (!rootDiff) return "";
  const subBaseByPath = new Map<string, string>();
  let candidate = "";
  for (const raw of rootDiff.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("+++ b/")) candidate = normalizeRelPath(line.slice(6).trim());
    else if (candidate && isSubprojectCommitLine(line)) {
      if (line.startsWith("-Subproject commit ")) {
        subBaseByPath.set(candidate, line.slice("-Subproject commit ".length).trim());
      } else if (!subBaseByPath.has(candidate)) {
        subBaseByPath.set(candidate, "HEAD");
      }
    }
  }
  if (subBaseByPath.size === 0) return rootDiff;
  const indexedFiles = store.getAllFiles();
  const parts = [rootDiff];
  for (const [sub, baseRef] of subBaseByPath.entries()) {
    const prefix = `${sub}/`;
    if (!indexedFiles.some((f) => f.filePath.startsWith(prefix))) continue;
    const subRes = await store.runner.run({
      command: "git", args: ["diff", baseRef, "--unified=0"], env: {}, cwd: `${store.projectRoot}/${sub}`,
    });
    if (subRes.code === 0 && subRes.stdout.trim()) {
      const rewritten = subRes.stdout
        .split("\n")
        .map((l) => (l.startsWith("+++ b/") ? `+++ b/${sub}/${normalizeRelPath(l.slice(6).trim())}` : l))
        .join("\n");
      parts.push(rewritten);
    }
  }
  return parts.join("\n");
}

export async function detectWorktreeChangesImpact(
  store: CodeStore,
  diffText: string,
  maxDepth = 2,
): Promise<CodeDiffImpactResult> {
  const hunks = parseUnifiedDiffHunks(diffText);
  const changedFilesSet = new Set<string>();
  const modifiedMap = new Map<number, CodeSymbolRecord>();

  for (const h of hunks) {
    changedFilesSet.add(h.filePath);
    const affected = await store.querySpatialSpan(h.filePath, h.startLine, h.endLine);
    for (const sym of affected) {
      modifiedMap.set(sym.ref, sym);
    }
  }

  const modifiedSymbols = Array.from(modifiedMap.values());
  const impactedCallers: Array<{ symbol: CodeSymbolRecord; calledModifiedSymbol: string; depth: number }> = [];
  const seenCaller = new Set<number>(modifiedMap.keys());

  for (const modSym of modifiedSymbols) {
    let frontier: number[] = [...modSym.callers];
    for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
      const nextFrontier: number[] = [];
      for (const callerRef of frontier) {
        if (seenCaller.has(callerRef)) continue;
        seenCaller.add(callerRef);
        const callerSym = store.getSymbolSync(callerRef);
        if (!callerSym) continue;
        impactedCallers.push({
          symbol: callerSym,
          calledModifiedSymbol: modSym.qualifiedName,
          depth: d,
        });
        for (const upperRef of callerSym.callers) nextFrontier.push(upperRef);
      }
      frontier = nextFrontier;
    }
  }

  const contractMismatches = detectXyContractMismatches(store, modifiedSymbols);

  return {
    changedFiles: Array.from(changedFilesSet),
    hunks,
    modifiedSymbols,
    impactedCallers,
    ...(contractMismatches.length > 0 ? { contractMismatches } : {}),
  };
}
