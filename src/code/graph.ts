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
} from "./types.ts";
import { isAsciiDigit } from "./lexer.ts";
import { normalizeRelPath } from "./payload_codec.ts";

export function resolveSymbolCandidates(
  store: CodeStore,
  opts: {
    name?: string;
    qualifiedName?: string;
    file?: string;
    kind?: string;
    parentSymbol?: string;
  },
): CodeSymbolRecord[] {
  const qn = opts.qualifiedName?.trim();
  const name = opts.name?.trim();

  let cands: CodeSymbolRecord[];
  if (qn) {
    const exactQn = store.getSymbolByQualifiedName(qn);
    if (exactQn) {
      cands = [exactQn];
    } else {
      cands = store.getAllSymbols().filter((s) =>
        s.qualifiedName === qn || s.qualifiedName.endsWith(`:${qn}`) || s.qualifiedName.endsWith(`.${qn}`)
      );
    }
  } else if (name) {
    const byName = store.getSymbolsByName(name);
    const byQn = store.getSymbolByQualifiedName(name);
    if (byName.length > 0) {
      cands = [...byName];
    } else if (byQn) {
      cands = [byQn];
    } else {
      const all = store.getAllSymbols();
      const exactSuffix = all.filter((s) =>
        s.qualifiedName.endsWith(`:${name}`) || s.qualifiedName.endsWith(`.${name}`)
      );
      if (exactSuffix.length > 0) {
        cands = exactSuffix;
      } else {
        const lower = name.toLowerCase();
        cands = all.filter((s) => s.name.toLowerCase().includes(lower) || s.qualifiedName.toLowerCase().includes(lower));
      }
    }
  } else {
    cands = store.getAllSymbols();
  }

  const file = opts.file ? normalizeRelPath(opts.file.trim()).toLowerCase() : "";
  if (file) {
    cands = cands.filter((s) => s.filePath.toLowerCase().includes(file));
  }

  const kind = opts.kind?.trim().toLowerCase();
  if (kind) {
    cands = cands.filter((s) => s.kind.toLowerCase() === kind);
  }

  const parent = opts.parentSymbol?.trim();
  if (parent) {
    cands = cands.filter((s) => s.parentSymbol === parent);
  }

  if (cands.length > 1 && (name || qn)) {
    const nonDecl = cands.filter((s) => !s.signature.startsWith("XY_DECL("));
    if (nonDecl.length > 0 && nonDecl.length < cands.length) {
      cands = nonDecl;
    }
  }

  return cands;
}

function buildTraceSubtree(
  store: CodeStore,
  sym: CodeSymbolRecord,
  direction: "inbound" | "outbound",
  currentDepth: number,
  maxDepth: number,
  visited: Set<number>,
): CodeTraceNode {
  const node: CodeTraceNode = {
    ref: sym.ref,
    name: sym.name,
    qualifiedName: sym.qualifiedName,
    kind: sym.kind,
    filePath: sym.filePath,
    startLine: sym.startLine,
    endLine: sym.endLine,
    signature: sym.signature,
    depth: currentDepth,
    direction: currentDepth === 0 ? "root" : direction,
    children: [],
  };

  if (currentDepth >= maxDepth) return node;
  visited.add(sym.ref);

  const neighborRefs = direction === "inbound" ? sym.callers : sym.callees;

  for (const nRef of neighborRefs) {
    if (visited.has(nRef)) continue;
    const neighbor = store.getSymbolSync(nRef);
    if (!neighbor) continue;
    const nextVisited = new Set(visited);
    node.children.push(
      buildTraceSubtree(store, neighbor, direction, currentDepth + 1, maxDepth, nextVisited),
    );
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
  return parts[0];
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

  const modules = Array.from(modMap.entries())
    .map(([moduleName, d]) => ({
      moduleName,
      fileCount: d.files,
      symbolCount: d.symbols,
      dependsOn: Array.from(d.deps).slice(0, 8),
    }))
    .sort((a, b) => {
      const aCore = a.moduleName.startsWith("mods/") || a.moduleName.startsWith("src/") || a.moduleName === "include" ? 0 : 1;
      const bCore = b.moduleName.startsWith("mods/") || b.moduleName.startsWith("src/") || b.moduleName === "include" ? 0 : 1;
      if (aCore !== bCore) return aCore - bCore;
      return b.symbolCount - a.symbolCount;
    })
    .slice(0, 18);

  const entryPointsAndRoutes = symbols
    .filter((s) =>
      s.kind === "Route" ||
      s.name === "main" ||
      s.name === "install" ||
      s.name.endsWith("_install") ||
      s.name === "bud_app_render"
    )
    .sort((a, b) => {
      const aTest = a.filePath.includes("test") ? 1 : 0;
      const bTest = b.filePath.includes("test") ? 1 : 0;
      if (aTest !== bTest) return aTest - bTest;
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
      !s.name.startsWith("ASSERT") &&
      !s.name.startsWith("TEST") &&
      !s.filePath.includes("/tests/") &&
      !s.filePath.endsWith("_test.c") &&
      !s.filePath.endsWith(".test.ts")
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
    if (line.startsWith("Subproject commit ")) {
      isSubproject = true;
      if (currentFile && hunks.length > 0 && hunks[hunks.length - 1].filePath === currentFile) {
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
        hunks.push({
          filePath: currentFile,
          startLine: range.startLine,
          endLine: range.startLine + range.count - 1,
        });
      }
    }
  }
  return hunks;
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

  return {
    changedFiles: Array.from(changedFilesSet),
    hunks,
    modifiedSymbols,
    impactedCallers,
  };
}
