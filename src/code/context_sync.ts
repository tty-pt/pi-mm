/**
 * Working-Memory Context-Window Staleness Radar (src/code/context_sync.ts).
 * Tracks per-session file/symbol snapshots read or mutated by the agent and detects
 * when files already in the agent's context window are modified externally on disk,
 * auto-refreshing CodeStore and synthesizing a surgical symbol delta alert.
 * Zero regexes: uses deterministic string/map operations.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CodeStore } from "./store.ts";
import type { CodeSymbolRecord } from "./types.ts";
import { computeSymbolAnchorFingerprint } from "./lore_binding.ts";
import { normalizeRelPath } from "./payload_codec.ts";

export interface SymbolSnapshotEntry {
  name: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature: string;
  fingerprint: string;
}

export interface ContextFileSnapshot {
  filePath: string;
  observedMtimeMs: number;
  observedSize: number;
  symbolsByName: Map<string, SymbolSnapshotEntry>;
}

export interface ContextSymbolDelta {
  symbolName: string;
  changeKind: "modified" | "lines_shifted" | "added" | "removed";
  oldLines?: [number, number];
  newLines?: [number, number];
}

export interface ContextFileDriftReport {
  filePath: string;
  deltas: ContextSymbolDelta[];
}

const sessionSnapshots = new Map<string, Map<string, ContextFileSnapshot>>();

export function clearContextSnapshots(sessionId?: string): void {
  if (sessionId) sessionSnapshots.delete(sessionId);
  else sessionSnapshots.clear();
}

export function getSessionContextSnapshots(sessionId: string): ContextFileSnapshot[] {
  const map = sessionSnapshots.get(sessionId);
  return map ? Array.from(map.values()) : [];
}

function buildSymbolSnapshotMap(store: CodeStore, relPath: string): Map<string, SymbolSnapshotEntry> {
  const map = new Map<string, SymbolSnapshotEntry>();
  const entry = store.getFileEntry(relPath);
  if (!entry) return map;
  for (const ref of entry.symbolRefs) {
    const sym = store.getSymbolSync(ref);
    if (!sym || sym.kind === "Route") continue;
    map.set(sym.qualifiedName, {
      name: sym.name,
      qualifiedName: sym.qualifiedName,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
      signature: sym.signature,
      fingerprint: computeSymbolAnchorFingerprint(sym),
    });
  }
  return map;
}

export function recordSessionFileSnapshot(
  store: CodeStore,
  sessionId: string,
  rawFilePath: string,
): ContextFileSnapshot | null {
  if (!sessionId || sessionId === "default-session" || sessionId === "unknown-session") return null;
  const relPath = normalizeRelPath(rawFilePath);
  if (!relPath) return null;
  const absPath = join(store.projectRoot, relPath);
  if (!existsSync(absPath)) return null;

  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    const mtimeMs = Math.trunc(st.mtimeMs);
    const symbolsByName = buildSymbolSnapshotMap(store, relPath);
    const snap: ContextFileSnapshot = {
      filePath: relPath,
      observedMtimeMs: mtimeMs,
      observedSize: st.size,
      symbolsByName,
    };
    let map = sessionSnapshots.get(sessionId);
    if (!map) {
      map = new Map<string, ContextFileSnapshot>();
      sessionSnapshots.set(sessionId, map);
    }
    map.set(relPath, snap);
    return snap;
  } catch {
    return null;
  }
}

export function recordSessionSymbolsSnapshot(
  store: CodeStore,
  sessionId: string,
  symbols: CodeSymbolRecord[],
): void {
  const seenFiles = new Set<string>();
  for (const s of symbols) {
    if (!seenFiles.has(s.filePath)) {
      seenFiles.add(s.filePath);
      recordSessionFileSnapshot(store, sessionId, s.filePath);
    }
  }
}

function diffSymbolMaps(
  oldMap: Map<string, SymbolSnapshotEntry>,
  newMap: Map<string, SymbolSnapshotEntry>,
): ContextSymbolDelta[] {
  const deltas: ContextSymbolDelta[] = [];
  for (const [qn, oldSym] of oldMap.entries()) {
    const curSym = newMap.get(qn);
    if (!curSym) {
      deltas.push({
        symbolName: oldSym.name,
        changeKind: "removed",
        oldLines: [oldSym.startLine, oldSym.endLine],
      });
      continue;
    }
    if (curSym.fingerprint !== oldSym.fingerprint) {
      deltas.push({
        symbolName: curSym.name,
        changeKind: "modified",
        oldLines: [oldSym.startLine, oldSym.endLine],
        newLines: [curSym.startLine, curSym.endLine],
      });
    } else if (curSym.startLine !== oldSym.startLine || curSym.endLine !== oldSym.endLine) {
      deltas.push({
        symbolName: curSym.name,
        changeKind: "lines_shifted",
        oldLines: [oldSym.startLine, oldSym.endLine],
        newLines: [curSym.startLine, curSym.endLine],
      });
    }
  }
  for (const [qn, curSym] of newMap.entries()) {
    if (!oldMap.has(qn)) {
      deltas.push({
        symbolName: curSym.name,
        changeKind: "added",
        newLines: [curSym.startLine, curSym.endLine],
      });
    }
  }
  return deltas;
}

export async function checkSessionContextDrift(
  store: CodeStore,
  sessionId: string,
): Promise<ContextFileDriftReport[]> {
  const map = sessionSnapshots.get(sessionId);
  if (!map || map.size === 0) return [];
  const reports: ContextFileDriftReport[] = [];

  for (const [relPath, snap] of map.entries()) {
    const absPath = join(store.projectRoot, relPath);
    if (!existsSync(absPath)) continue;
    try {
      const st = statSync(absPath);
      const diskMtime = Math.trunc(st.mtimeMs);
      if (diskMtime === snap.observedMtimeMs && st.size === snap.observedSize) continue;

      await store.refreshFile(relPath);
      const newMap = buildSymbolSnapshotMap(store, relPath);
      const deltas = diffSymbolMaps(snap.symbolsByName, newMap);

      map.set(relPath, {
        filePath: relPath,
        observedMtimeMs: diskMtime,
        observedSize: st.size,
        symbolsByName: newMap,
      });

      reports.push({ filePath: relPath, deltas });
    } catch { /* ignore transient fs errors */ }
  }
  return reports;
}

export function formatContextDriftNotice(reports: ContextFileDriftReport[]): string {
  if (reports.length === 0) return "";
  const lines = [
    `=== 🔄 [pi-mm Working-Memory Sync: External Disk Modifications Detected] ===`,
    `Files you previously inspected in this session were modified externally on disk (CodeStore auto-refreshed):`,
  ];
  for (const r of reports.slice(0, 6)) {
    if (r.deltas.length === 0) {
      lines.push(`  • ${r.filePath}: file body modified (re-read before editing)`);
      continue;
    }
    const items = r.deltas.slice(0, 5).map((d) => {
      if (d.changeKind === "removed") return `${d.symbolName} (removed, was lines ${d.oldLines![0]}-${d.oldLines![1]})`;
      if (d.changeKind === "added") return `${d.symbolName} (added at lines ${d.newLines![0]}-${d.newLines![1]})`;
      if (d.changeKind === "lines_shifted") {
        return `${d.symbolName} (lines shifted ${d.oldLines![0]}-${d.oldLines![1]} -> ${d.newLines![0]}-${d.newLines![1]})`;
      }
      return `${d.symbolName} (modified at lines ${d.newLines![0]}-${d.newLines![1]}, was ${d.oldLines![0]}-${d.oldLines![1]})`;
    });
    lines.push(`  • ${r.filePath}: ${items.join(", ")}. Re-read before editing.`);
  }
  return lines.join("\n");
}
