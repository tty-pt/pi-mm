/**
 * Payload encoding, file walking, and O(1) source slicing helpers for CodeStore.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { CodeSliceHit, CodeSymbolRecord } from "./types.ts";
import { splitIdentifierWords } from "./lexer.ts";

const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".pi", "dist", "build", "target", "var",
  "uploads", ".stage", "coverage", "__pycache__", ".next", "vendor",
  "archive", "scratch", "tmp",
]);

const ROOT_DIR_PRIORITY: Record<string, number> = {
  mods: 1,
  include: 2,
  src: 3,
  htdocs: 4,
  lib: 5,
  packages: 6,
  scripts: 7,
  tests: 8,
  external: 9,
  docs: 10,
};

const CODE_EXTENSIONS = new Set([
  ".c", ".h", ".cc", ".cpp", ".hpp", ".ts", ".tsx", ".js", ".jsx",
  ".mjs", ".cjs", ".py", ".go", ".rs", ".sh",
]);

export function formatSymbolSearchText(sym: CodeSymbolRecord): string {
  const nameWords = splitIdentifierWords(sym.name).join(" ");
  const pathWords = splitIdentifierWords(sym.filePath).join(" ");
  const parentPart = sym.parentSymbol ? ` parent:${sym.parentSymbol}` : "";
  const routePart = sym.routePath ? ` route:${sym.routeMethod || ""} ${sym.routePath}` : "";
  const docPart = sym.docComment ? ` doc:${sym.docComment}` : "";
  const calleesPart = sym.rawCallees.length > 0 ? ` calls:${sym.rawCallees.slice(0, 12).join(" ")}` : "";
  return `[${sym.kind}] ${sym.qualifiedName} ${sym.name} (${nameWords}) file:${sym.filePath} (${pathWords})${parentPart}${routePart} sig:${sym.signature}${docPart}${calleesPart}`;
}

export function encodeCodeSymbolPayload(date: string, sym: CodeSymbolRecord): Uint8Array {
  const searchSummary = formatSymbolSearchText(sym);
  const payloadString = [
    date,
    "[CODE_SYMBOL:JSON]",
    JSON.stringify(sym),
    "[/CODE_SYMBOL]",
    "[SUMMARY]",
    searchSummary,
    "[/SUMMARY]",
  ].join("\n");
  return new TextEncoder().encode(payloadString);
}

export function decodeCodeSymbolPayload(rawText: string): { date: string; symbol: CodeSymbolRecord } | null {
  if (!rawText || !rawText.trim()) return null;
  const firstNewline = rawText.indexOf("\n");
  const date = (firstNewline >= 0 ? rawText.slice(0, firstNewline) : rawText).trim();
  const startTag = "[CODE_SYMBOL:JSON]\n";
  const endTag = "\n[/CODE_SYMBOL]";
  const metaStart = rawText.indexOf(startTag);
  const metaEnd = rawText.indexOf(endTag);
  if (metaStart < 0 || metaEnd < 0) return null;

  const jsonStr = rawText.slice(metaStart + startTag.length, metaEnd).trim();
  try {
    const symbol = JSON.parse(jsonStr) as CodeSymbolRecord;
    return { date, symbol };
  } catch {
    return null;
  }
}

export function formatIsletCoord2D(fileId: number, startLine: number): string {
  const clampedFile = Math.max(0, Math.min(32000, fileId));
  const clampedLine = Math.max(0, Math.min(32000, startLine));
  return `${clampedFile},${clampedLine}`;
}

export function normalizeRelPath(p: string): string {
  return p.split("\\").join("/");
}

export function hasSupportedExtension(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf(".");
  if (dotIdx < 0) return false;
  return CODE_EXTENSIONS.has(filePath.slice(dotIdx).toLowerCase());
}

function walkSourceDir(rootDir: string, dir: string, maxFiles: number, results: string[]): void {
  if (results.length >= maxFiles) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const isRoot = dir === rootDir;
  entries.sort((a, b) => {
    const aIsFile = a.isFile() ? 0 : 1;
    const bIsFile = b.isFile() ? 0 : 1;
    if (aIsFile !== bIsFile) return aIsFile - bIsFile;
    if (isRoot && a.isDirectory() && b.isDirectory()) {
      const pa = ROOT_DIR_PRIORITY[a.name] ?? 5;
      const pb = ROOT_DIR_PRIORITY[b.name] ?? 5;
      if (pa !== pb) return pa - pb;
    }
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    if (entry.name.startsWith(".") && entry.name !== ".pi") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walkSourceDir(rootDir, fullPath, maxFiles, results);
    } else if (entry.isFile() && hasSupportedExtension(entry.name)) {
      results.push(normalizeRelPath(relative(rootDir, fullPath)));
    }
  }
}

export function collectProjectSourceFiles(rootDir: string, maxFiles: number): string[] {
  const results: string[] = [];
  walkSourceDir(rootDir, rootDir, maxFiles, results);
  return results;
}

export function sliceSymbolLinesFromDisk(
  projectRoot: string,
  sym: CodeSymbolRecord,
  symbolsByRef: Map<number, CodeSymbolRecord>,
  options?: { lineRange?: [number, number]; maxLines?: number; fullOutput?: boolean },
): CodeSliceHit | null {
  const absPath = join(projectRoot, sym.filePath);
  if (!existsSync(absPath)) return null;
  let rawText = "";
  try {
    rawText = readFileSync(absPath, "utf-8");
  } catch {
    return null;
  }

  const allLines = rawText.split("\n");
  const totalLines = allLines.length;
  const maxLines = Math.max(10, options?.maxLines ?? 120);

  let start = sym.startLine;
  let end = sym.endLine;
  let compacted = false;

  if (options?.lineRange && options.lineRange.length === 2) {
    start = Math.max(1, Math.min(options.lineRange[0], totalLines));
    end = Math.max(start, Math.min(options.lineRange[1], totalLines));
  } else if (!options?.fullOutput && (end - start + 1) > maxLines) {
    end = start + maxLines - 1;
    compacted = true;
  }

  const sliced = allLines.slice(start - 1, end).map((text, idx) => ({
    lineNum: start + idx,
    text,
  }));

  const directCallers = sym.callers.map((r) => symbolsByRef.get(r)).filter(Boolean) as CodeSymbolRecord[];
  const directCallees = sym.callees.map((r) => symbolsByRef.get(r)).filter(Boolean) as CodeSymbolRecord[];

  return {
    ref: sym.ref,
    symbol: sym,
    totalLines,
    startLine: start,
    endLine: end,
    compacted,
    lines: sliced,
    directCallers,
    directCallees,
  };
}
