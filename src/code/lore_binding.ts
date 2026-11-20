/**
 * Live Epistemic Invalidation via Code-to-Lore Causal Binding (src/code/lore_binding.ts).
 * Binds persistent technical memories (invariants, decisions, episodes) to AST symbol
 * fingerprints and spatial file/line spans in CodeStore, detecting when code edits or
 * git diffs render previously verified lore stale_suspect.
 * Zero regexes: uses deterministic character/token operations.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeStore } from "./store.ts";
import type { CodeDiffHunk, CodeSymbolRecord } from "./types.ts";
import { parseUnifiedDiffHunks, resolveSymbolCandidates } from "./graph.ts";
import { splitIdentifierWords } from "./lexer.ts";
import { hasSupportedExtension, normalizeRelPath } from "./payload_codec.ts";
import type { MemoryEnvelope } from "../types.ts";

export interface CodeSymbolAnchor {
  symbolName: string; qualifiedName: string; filePath: string;
  startLine: number; endLine: number; signature: string; fingerprint: string; mtimeMs: number;
}

export interface LoreCodeBinding {
  memoryRef: number; summary: string; level: string; lifecycle: string;
  subsystem?: string; boundAt: string; anchors: CodeSymbolAnchor[];
}

export interface DriftedAnchorDetail {
  anchor: CodeSymbolAnchor;
  reason: "modified_signature_or_callees" | "deleted_symbol" | "in_diff_hunk";
  currentSignature?: string; currentLines?: [number, number];
}

export interface LoreDriftReport {
  memoryRef: number; summary: string; level: string; lifecycle: string; boundAt: string;
  status: "fresh" | "stale_suspect"; matchedAnchors: CodeSymbolAnchor[]; driftedAnchors: DriftedAnchorDetail[];
}

const BINDINGS_FILENAME = "lore-bindings.json";
const bindingsCacheByDir = new Map<string, Map<number, LoreCodeBinding>>();
const RAW_TELEMETRY_PREFIXES = [
  "read ", "bash ", "edit ", "write ", "memory_recall ", "executed ",
  "const ", "let ", "var ", "import ", "export ", "function ", "return ",
  "if (", "?", "}", "{", "//", "/*",
];

export function isRawToolTelemetryText(text: string): boolean {
  const s = text.trim().toLowerCase();
  return !s || RAW_TELEMETRY_PREFIXES.some((p) => s.startsWith(p));
}

export function isBindableArchitecturalLore(envelope: MemoryEnvelope, hasExplicitAnchors = false): boolean {
  if (!hasExplicitAnchors && envelope.level === "L0") return false;
  if (envelope.lifecycle !== "supported" && envelope.lifecycle !== "tested") return false;
  if (isRawToolTelemetryText(envelope.summary || "")) return false;
  if (!hasExplicitAnchors && isRawToolTelemetryText(envelope.episode?.problem || "") && envelope.level === "L0") return false;
  return true;
}

export function computeSymbolAnchorFingerprint(sym: {
  kind: string;
  qualifiedName: string;
  signature: string;
  rawCallees: string[];
}): string {
  const sortedCallees = [...sym.rawCallees].sort().join(",");
  return `${sym.kind}\x1f${sym.qualifiedName}\x1f${sym.signature.trim()}\x1f${sortedCallees}`;
}

export function toSymbolAnchor(sym: CodeSymbolRecord): CodeSymbolRecord extends never ? never : CodeSymbolAnchor {
  return {
    symbolName: sym.name,
    qualifiedName: sym.qualifiedName,
    filePath: normalizeRelPath(sym.filePath),
    startLine: sym.startLine,
    endLine: sym.endLine,
    signature: sym.signature,
    fingerprint: computeSymbolAnchorFingerprint(sym),
    mtimeMs: sym.mtimeMs,
  };
}

const GENERIC_ENTRYPOINT_SYMBOLS = new Set([
  "xy_install",
  "bud_app_render",
  "main",
]);

export function isGenericSingleWordSymbol(name: string): boolean {
  if (GENERIC_ENTRYPOINT_SYMBOLS.has(name)) return true;
  return !name.includes("_") && !name.includes(":") && !name.includes(".") && splitIdentifierWords(name).length < 2;
}

const WORKTREE_MARKERS = [
  "/.pi/scratch/slot-",
  "/.worktrees/",
  "/.pi/subagents/worktrees/",
];

export function deriveWorkspaceLabel(dirPath: string): string | undefined {
  const norm = dirPath.replaceAll("\\", "/");
  for (const marker of WORKTREE_MARKERS) {
    const idx = norm.indexOf(marker);
    if (idx > 0) {
      const start = idx + (marker === "/.pi/scratch/slot-" ? "/.pi/scratch/".length : marker.length);
      const slash = norm.indexOf("/", start);
      const name = slash < 0 ? norm.slice(start) : norm.slice(start, slash);
      if (name) return name;
    }
  }
  return undefined;
}

export function resolvePrimaryWorktreeRoot(cwd: string): string {
  const norm = cwd.replaceAll("\\", "/");
  for (const marker of WORKTREE_MARKERS) {
    const idx = norm.indexOf(marker);
    if (idx > 0) return norm.slice(0, idx);
  }
  try {
    const gitPath = join(cwd, ".git");
    if (existsSync(gitPath)) {
      const text = readFileSync(gitPath, "utf8").trim();
      if (text.startsWith("gitdir:")) {
        const gitdir = text.slice(7).trim().replaceAll("\\", "/");
        const wtIdx = gitdir.lastIndexOf("/.git/worktrees/");
        if (wtIdx > 0) return gitdir.slice(0, wtIdx);
      }
    }
  } catch { /* fallback to cwd */ }
  return cwd;
}

export function resolveSharedCoordinationDir(indexDir: string): string {
  const norm = indexDir.replaceAll("\\", "/");
  for (const marker of WORKTREE_MARKERS) {
    const idx = norm.indexOf(marker);
    if (idx > 0) {
      const afterSlot = norm.indexOf("/", idx + marker.length);
      return afterSlot < 0 ? indexDir : `${norm.slice(0, idx)}${norm.slice(afterSlot)}`;
    }
  }
  return indexDir;
}

function isAnchorCorroboratedByLore(anchor: CodeSymbolAnchor, summary: string, subsystem?: string): boolean {
  if (!isGenericSingleWordSymbol(anchor.symbolName)) return true;
  const corpus = `${summary} ${subsystem || ""}`.toLowerCase();
  const fp = anchor.filePath.toLowerCase();
  const slashIdx = fp.lastIndexOf("/");
  const baseName = slashIdx >= 0 ? fp.slice(slashIdx + 1) : fp;
  return corpus.includes(fp) || (baseName.length >= 4 && corpus.includes(baseName));
}

function loadBindingsMap(rawIndexDir: string): Map<number, LoreCodeBinding> {
  const indexDir = resolveSharedCoordinationDir(rawIndexDir);
  const cached = bindingsCacheByDir.get(indexDir);
  if (cached) return cached;
  const map = new Map<number, LoreCodeBinding>();
  const filePath = join(indexDir, BINDINGS_FILENAME);
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(raw)) {
        let pruned = false;
        for (const item of raw) {
          if (item && typeof item.memoryRef === "number" && Array.isArray(item.anchors)) {
            const sum = String(item.summary || "");
            if (isRawToolTelemetryText(sum)) { pruned = true; continue; }
            const validAnchors = (item.anchors as CodeSymbolAnchor[]).filter(
              (a) => isAnchorCorroboratedByLore(a, sum, item.subsystem),
            );
            if (validAnchors.length !== item.anchors.length) pruned = true;
            if (validAnchors.length === 0) continue;
            map.set(item.memoryRef, { ...(item as LoreCodeBinding), anchors: validAnchors });
          }
        }
        if (pruned) saveBindingsMap(indexDir, map);
      }
    } catch { /* Ignore corrupted cache */ }
  }
  bindingsCacheByDir.set(indexDir, map);
  return map;
}

function saveBindingsMap(rawIndexDir: string, map: Map<number, LoreCodeBinding>): void {
  const indexDir = resolveSharedCoordinationDir(rawIndexDir);
  try {
    mkdirSync(indexDir, { recursive: true });
    const filePath = join(indexDir, BINDINGS_FILENAME);
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(Array.from(map.values()), null, 2), "utf8");
    renameSync(tmpPath, filePath);
  } catch { /* Best-effort persistence */ }
}

export function clearLoreBindingsCache(): void {
  bindingsCacheByDir.clear();
}

function extractFilePathsFromText(text: string): string[] {
  const results: string[] = [];
  let token = "";
  const flushToken = (raw: string) => {
    let cleaned = raw;
    while (cleaned.length > 0 && " `'\"()[],;:<>".includes(cleaned[0])) cleaned = cleaned.slice(1);
    while (cleaned.length > 0 && " `'\"()[],;:<>.".includes(cleaned[cleaned.length - 1])) cleaned = cleaned.slice(0, -1);
    const colonIdx = cleaned.indexOf(":");
    if (colonIdx > 0) cleaned = cleaned.slice(0, colonIdx);
    const norm = normalizeRelPath(cleaned);
    if (norm.includes("/") && hasSupportedExtension(norm) && !results.includes(norm)) results.push(norm);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (token) { flushToken(token); token = ""; }
    } else token += ch;
  }
  if (token) flushToken(token);
  return results;
}

function isTokenChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 95 || code === 46 || code === 58 || code === 47 || code === 45;
}

function collectCandidateTokensFromText(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = (p: string) => {
    if (!p || p.length < 3) return;
    const trimmed = p.endsWith("()") ? p.slice(0, -2) : p;
    const hasUpper = splitIdentifierWords(trimmed).length >= 2;
    const hasUnderscore = trimmed.includes("_") || trimmed.includes(":");
    if ((hasUpper || hasUnderscore) && !out.includes(trimmed)) out.push(trimmed);
  };
  for (let i = 0; i < text.length; i++) {
    if (isTokenChar(text.charCodeAt(i))) cur += text[i];
    else if (cur) { flush(cur); cur = ""; }
  }
  if (cur) flush(cur);
  return out;
}

export function extractMemorySymbolAnchors(
  store: CodeStore,
  envelope: MemoryEnvelope,
  explicitSymbols?: string[],
  explicitFile?: string,
): CodeSymbolAnchor[] {
  const anchorsByRef = new Map<number, CodeSymbolAnchor>();
  const addSym = (sym: CodeSymbolRecord) => {
    if (anchorsByRef.size < 12 && !anchorsByRef.has(sym.ref)) anchorsByRef.set(sym.ref, toSymbolAnchor(sym));
  };

  for (const diffStr of envelope.episode?.diffs || []) {
    for (const h of parseUnifiedDiffHunks(diffStr)) {
      for (const s of store.getAllSymbols()) {
        if (s.filePath === h.filePath && s.startLine <= h.endLine && s.endLine >= h.startLine) addSym(s);
      }
    }
  }

  const textCorpus = [
    envelope.summary, envelope.context?.path || "", envelope.episode?.problem || "", ...(envelope.episode?.findings || []),
  ].join(" ");
  const mentionedFiles = [
    ...(explicitFile ? [normalizeRelPath(explicitFile)] : []),
    ...(envelope.context?.path ? [normalizeRelPath(envelope.context.path)] : []),
    ...extractFilePathsFromText(textCorpus),
  ];
  const explicitSet = new Set(explicitSymbols || []);
  const symbolProbes = [...(explicitSymbols || []), ...collectCandidateTokensFromText(textCorpus)];
  const matchesFile = (s: CodeSymbolRecord) =>
    mentionedFiles.some((f) => s.filePath === f || s.filePath.endsWith(f) || s.filePath.startsWith(`${f}/`));

  for (const probe of symbolProbes) {
    if (anchorsByRef.size >= 12) break;
    const exactByName = store.getSymbolsByName(probe);
    const isGeneric = isGenericSingleWordSymbol(probe) && !explicitSet.has(probe);
    if (exactByName.length === 1 && (!isGeneric || matchesFile(exactByName[0]))) {
      addSym(exactByName[0]);
      continue;
    }
    if (exactByName.length >= 1 && mentionedFiles.length > 0) {
      const fileFiltered = exactByName.filter(matchesFile);
      if (fileFiltered.length === 1) addSym(fileFiltered[0]);
    }
  }

  if (anchorsByRef.size === 0 && mentionedFiles.length > 0) {
    for (const f of mentionedFiles.slice(0, 2)) {
      for (const s of resolveSymbolCandidates(store, { file: f }).slice(0, 4)) addSym(s);
    }
  }
  return Array.from(anchorsByRef.values());
}

export function bindMemoryToCode(
  store: CodeStore,
  memoryRef: number,
  envelope: MemoryEnvelope,
  options?: { timestampIso?: string; explicitSymbols?: string[]; explicitFile?: string },
): LoreCodeBinding | null {
  const hasExplicit = Boolean((options?.explicitSymbols && options.explicitSymbols.length > 0) || options?.explicitFile);
  if (!isBindableArchitecturalLore(envelope, hasExplicit)) return null;
  const anchors = extractMemorySymbolAnchors(store, envelope, options?.explicitSymbols, options?.explicitFile);
  if (anchors.length === 0) return null;
  const binding: LoreCodeBinding = {
    memoryRef, summary: envelope.summary, level: envelope.level, lifecycle: envelope.lifecycle,
    subsystem: envelope.context?.subsystem, boundAt: options?.timestampIso ?? new Date().toISOString().slice(0, 10), anchors,
  };
  const map = loadBindingsMap(store.indexDir);
  map.set(memoryRef, binding);
  saveBindingsMap(store.indexDir, map);
  return binding;
}

export function getLoreBindings(storeOrIndexDir: CodeStore | string): LoreCodeBinding[] {
  const dir = typeof storeOrIndexDir === "string" ? storeOrIndexDir : storeOrIndexDir.indexDir;
  return Array.from(loadBindingsMap(dir).values());
}

export function getLoreBindingForRef(storeOrIndexDir: CodeStore | string, memoryRef: number): LoreCodeBinding | null {
  const dir = typeof storeOrIndexDir === "string" ? storeOrIndexDir : storeOrIndexDir.indexDir;
  return loadBindingsMap(dir).get(memoryRef) ?? null;
}

export function updateLoreBindingLifecycle(indexDir: string, memoryRef: number, lifecycle: LoreCodeBinding["lifecycle"]): void {
  const map = loadBindingsMap(indexDir);
  const existing = map.get(memoryRef);
  if (existing) { existing.lifecycle = lifecycle; saveBindingsMap(indexDir, map); }
}

function resolveLiveSymbolForAnchor(store: CodeStore, anchor: CodeSymbolAnchor): CodeSymbolRecord | undefined {
  const liveByQn = store.getSymbolByQualifiedName(anchor.qualifiedName);
  return !liveByQn
    ? store.getSymbolsByName(anchor.symbolName).find((s) => s.filePath === anchor.filePath)
    : liveByQn;
}

function evaluateSingleAnchorDrift(
  store: CodeStore,
  anchor: CodeSymbolAnchor,
  diffHunks: CodeDiffHunk[],
): DriftedAnchorDetail | null {
  const liveByName = resolveLiveSymbolForAnchor(store, anchor);

  if (!liveByName) {
    return { anchor, reason: "deleted_symbol" };
  }

  const currentFp = computeSymbolAnchorFingerprint(liveByName);
  if (currentFp !== anchor.fingerprint) {
    return {
      anchor,
      reason: "modified_signature_or_callees",
      currentSignature: liveByName.signature,
      currentLines: [liveByName.startLine, liveByName.endLine],
    };
  }

  const inHunk = diffHunks.some(
    (h) =>
      h.filePath === liveByName.filePath &&
      h.startLine <= liveByName.endLine &&
      h.endLine >= liveByName.startLine,
  );
  if (inHunk) {
    return {
      anchor,
      reason: "in_diff_hunk",
      currentSignature: liveByName.signature,
      currentLines: [liveByName.startLine, liveByName.endLine],
    };
  }

  return null;
}

export function verifyLoreBindingForRef(
  store: CodeStore,
  memoryRef: number,
  envelope?: MemoryEnvelope,
  diffHunks: CodeDiffHunk[] = [],
): LoreDriftReport | null {
  let binding = getLoreBindingForRef(store, memoryRef);
  if (!binding && envelope && isBindableArchitecturalLore(envelope) && store.getStats().symbols > 0) {
    binding = bindMemoryToCode(store, memoryRef, envelope);
  }
  if (!binding) return null;
  if (binding.lifecycle === "contradicted" || binding.lifecycle === "superseded") return null;
  if (isRawToolTelemetryText(binding.summary)) return null;

  const driftedAnchors: DriftedAnchorDetail[] = [];
  const matchedAnchors: CodeSymbolAnchor[] = [];
  for (const anchor of binding.anchors) {
    const live = resolveLiveSymbolForAnchor(store, anchor);
    const updatedAnchor = live
      ? { ...anchor, startLine: live.startLine, endLine: live.endLine }
      : anchor;
    matchedAnchors.push(updatedAnchor);
    const drift = evaluateSingleAnchorDrift(store, anchor, diffHunks);
    if (drift) driftedAnchors.push(drift);
  }

  return {
    memoryRef: binding.memoryRef,
    summary: binding.summary,
    level: binding.level,
    lifecycle: binding.lifecycle,
    boundAt: binding.boundAt,
    status: driftedAnchors.length > 0 ? "stale_suspect" : "fresh",
    matchedAnchors,
    driftedAnchors,
  };
}

export function verifyLoreBindingsForSymbols(
  store: CodeStore,
  targetSymbols: CodeSymbolRecord[],
  diffHunks: CodeDiffHunk[] = [],
): LoreDriftReport[] {
  const bindings = getLoreBindings(store);
  if (bindings.length === 0) return [];

  const targetQns = new Set(targetSymbols.map((s) => s.qualifiedName));
  const targetFileNames = new Set(targetSymbols.map((s) => `${s.filePath}:${s.name}`));
  const filterToTargets = targetSymbols.length > 0;

  const reports: LoreDriftReport[] = [];
  for (const b of bindings) {
    if (b.lifecycle === "contradicted" || b.lifecycle === "superseded") continue;
    if (isRawToolTelemetryText(b.summary)) continue;
    const matchedAnchors = filterToTargets
      ? b.anchors.filter(
          (a) => targetQns.has(a.qualifiedName) || targetFileNames.has(`${a.filePath}:${a.symbolName}`),
        )
      : b.anchors;

    if (filterToTargets && matchedAnchors.length === 0) continue;

    const driftedAnchors: DriftedAnchorDetail[] = [];
    for (const anchor of b.anchors) {
      const drift = evaluateSingleAnchorDrift(store, anchor, diffHunks);
      if (drift) driftedAnchors.push(drift);
    }

    reports.push({
      memoryRef: b.memoryRef,
      summary: b.summary,
      level: b.level,
      lifecycle: b.lifecycle,
      boundAt: b.boundAt,
      status: driftedAnchors.length > 0 ? "stale_suspect" : "fresh",
      matchedAnchors,
      driftedAnchors,
    });
  }
  return reports;
}

export function formatBoundCodeAnchorsForLore(
  report: LoreDriftReport,
  options?: { verbose?: boolean; indent?: string },
): string {
  const anchors = report.matchedAnchors;
  if (anchors.length === 0) return "";
  const ind = options?.indent ?? "  ";
  const verbose = options?.verbose === true;
  const driftByQn = new Map<string, DriftedAnchorDetail>();
  for (const d of report.driftedAnchors) {
    driftByQn.set(`${d.anchor.filePath}:${d.anchor.qualifiedName}`, d);
  }

  const headerStatus = report.status === "stale_suspect"
    ? `⚠️ STALE_SUSPECT — AST drifted since ${report.boundAt}`
    : "AST-verified ✓";
  const lines: string[] = [`${ind}Bound Code Symbols (${headerStatus}):`];

  const displayAnchors = verbose ? anchors : anchors.slice(0, 4);
  for (const a of displayAnchors) {
    const drift = driftByQn.get(`${a.filePath}:${a.qualifiedName}`);
    const span = drift?.currentLines
      ? `${a.filePath}:${drift.currentLines[0]}-${drift.currentLines[1]}`
      : `${a.filePath}:${a.startLine}-${a.endLine}`;
    if (drift) {
      let reasonText = "AST signature/callees mutated";
      if (drift.reason === "deleted_symbol") reasonText = "symbol deleted or renamed";
      else if (drift.reason === "in_diff_hunk") reasonText = "modified in uncommitted git diff";
      lines.push(`${ind}  • ${a.symbolName} (${span}) — ⚠️ ${reasonText}`);
      if (verbose && drift.currentSignature && drift.currentSignature !== a.signature) {
        lines.push(`${ind}    Bound signature:   ${a.signature}`);
        lines.push(`${ind}    Current signature: ${drift.currentSignature}`);
      }
    } else {
      const sigPart = verbose && a.signature ? ` — \`${a.signature}\`` : "";
      lines.push(`${ind}  • ${a.symbolName} (${span})${sigPart}`);
    }
  }

  if (anchors.length === 1) {
    const first = anchors[0];
    lines.push(
      `${ind}  • Inspect Code: memory_recall({ scope: "code", symbol: "${first.symbolName}", file: "${first.filePath}" })`,
    );
  } else {
    const symList = anchors.slice(0, 4).map((a) => `"${a.symbolName}"`).join(", ");
    lines.push(`${ind}  • Inspect Code: memory_recall({ scope: "code", symbols: [${symList}] })`);
  }

  return lines.join("\n");
}

export function formatLoreDriftSection(reports: LoreDriftReport[]): string {
  if (reports.length === 0) return "";
  const lines: string[] = [];
  for (const r of reports) {
    const anchorLabels = (r.matchedAnchors.length > 0 ? r.matchedAnchors : r.driftedAnchors.map((d) => d.anchor))
      .slice(0, 3)
      .map((a) => `${a.symbolName} (${a.filePath}:${a.startLine}-${a.endLine})`)
      .join(", ");
    if (r.status === "stale_suspect") {
      const reasons = r.driftedAnchors
        .map((d) => {
          if (d.reason === "deleted_symbol") return `${d.anchor.symbolName} was deleted/renamed`;
          if (d.reason === "in_diff_hunk") return `${d.anchor.symbolName} modified in uncommitted git diff`;
          return `${d.anchor.symbolName} AST signature/callees mutated since ${r.boundAt}`;
        })
        .join("; ");
      lines.push(
        `  • [Ref ${r.memoryRef}] (${r.level}, STALE_SUSPECT — was ${r.lifecycle}): ${r.summary}\n    ⚠️ Epistemic Drift: ${reasons} [Bound to: ${anchorLabels}] (Zoom: memory_recall({ zoomRef: ${r.memoryRef} }))`,
      );
    } else {
      lines.push(
        `  • [Ref ${r.memoryRef}] (${r.level}, ${r.lifecycle} · AST-verified ✓): ${r.summary} [Bound to: ${anchorLabels}] (Zoom: memory_recall({ zoomRef: ${r.memoryRef} }))`,
      );
    }
  }
  return lines.join("\n");
}
