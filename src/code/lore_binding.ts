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

export function isBindableArchitecturalLore(envelope: MemoryEnvelope): boolean {
  if (envelope.level === "L0" || (envelope.lifecycle !== "supported" && envelope.lifecycle !== "tested")) return false;
  return !isRawToolTelemetryText(envelope.summary || "");
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

export function toSymbolAnchor(sym: CodeSymbolRecord): CodeSymbolAnchor {
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

export function resolveSharedCoordinationDir(indexDir: string): string {
  const norm = indexDir.replaceAll("\\", "/");
  const marker = "/.pi/scratch/slot-";
  const idx = norm.indexOf(marker);
  if (idx <= 0) return indexDir;
  const afterSlot = norm.indexOf("/", idx + marker.length);
  return afterSlot < 0 ? indexDir : `${norm.slice(0, idx)}${norm.slice(afterSlot)}`;
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
            if (item.level === "L0" || isRawToolTelemetryText(sum)) { pruned = true; continue; }
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
  if (!isBindableArchitecturalLore(envelope)) return null;
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

export function updateLoreBindingLifecycle(indexDir: string, memoryRef: number, lifecycle: LoreCodeBinding["lifecycle"]): void {
  const map = loadBindingsMap(indexDir);
  const existing = map.get(memoryRef);
  if (existing) { existing.lifecycle = lifecycle; saveBindingsMap(indexDir, map); }
}

function evaluateSingleAnchorDrift(
  store: CodeStore,
  anchor: CodeSymbolAnchor,
  diffHunks: CodeDiffHunk[],
): DriftedAnchorDetail | null {
  const liveByQn = store.getSymbolByQualifiedName(anchor.qualifiedName);
  const liveByName = !liveByQn
    ? store.getSymbolsByName(anchor.symbolName).find((s) => s.filePath === anchor.filePath)
    : liveByQn;

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
    if (b.level === "L0" || isRawToolTelemetryText(b.summary)) continue;
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
        `  • [Ref ${r.memoryRef}] (${r.level}, STALE_SUSPECT — was ${r.lifecycle}): ${r.summary}\n    ⚠️ Epistemic Drift: ${reasons} [Bound to: ${anchorLabels}]`,
      );
    } else {
      lines.push(
        `  • [Ref ${r.memoryRef}] (${r.level}, ${r.lifecycle} · AST-verified ✓): ${r.summary} [Bound to: ${anchorLabels}]`,
      );
    }
  }
  return lines.join("\n");
}
