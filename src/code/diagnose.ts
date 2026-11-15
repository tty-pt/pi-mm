/**
 * Execution-Trace & Differential Failure Topology Engine (src/code/diagnose.ts).
 * Parses stack traces, compiler diagnostics, and test failures without regexes,
 * projects frames onto the CodeStore call graph, and intersects them with
 * live git diff blast radius to compute the Causal Fault Intersection.
 */

import type { CodeStore } from "./store.ts";
import type { CodeDiffImpactResult, CodeSymbolRecord } from "./types.ts";
import { collectWorktreeDiffText, detectWorktreeChangesImpact, resolveSymbolCandidates } from "./graph.ts";
import { isAsciiAlpha, isAsciiDigit, splitIdentifierWords } from "./lexer.ts";
import { hasSupportedExtension, normalizeRelPath } from "./payload_codec.ts";

export interface StackFrameCoord {
  filePath?: string;
  line?: number;
  column?: number;
  symbolName?: string;
  rawLine: string;
}

export interface ParsedFailureTrace {
  headline: string;
  frames: StackFrameCoord[];
  mentionedIdentifiers: string[];
}

export interface FaultIntersectionHit {
  symbol: CodeSymbolRecord;
  role: "modified_on_stack" | "modified_callee_of_stack" | "caller_of_modified_on_stack";
  frameLine?: number;
  viaSymbol?: string;
  hopDistance: number;
}

export interface FailureDiagnosisResult {
  parsed: ParsedFailureTrace;
  stackSymbols: Array<{ symbol: CodeSymbolRecord; frame: StackFrameCoord }>;
  diffImpact: CodeDiffImpactResult;
  faultIntersections: FaultIntersectionHit[];
  rendered: string;
}

function isIdentChar(ch: number): boolean {
  return isAsciiAlpha(ch) || isAsciiDigit(ch) || ch === 95 || ch === 36;
}

function stripFileUrlAndProjectPrefix(rawPath: string, projectRoot?: string): string {
  let p = rawPath.trim();
  if (p.startsWith("file://")) p = p.slice(7);
  p = normalizeRelPath(p);
  if (projectRoot) {
    const normRoot = normalizeRelPath(projectRoot).replace(/\/+$/, "") + "/";
    if (p.startsWith(normRoot)) p = p.slice(normRoot.length);
  }
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

function parseFileLineToken(
  token: string,
  projectRoot?: string,
): { filePath: string; line?: number; column?: number } | null {
  let clean = token.trim();
  while (clean.length > 0 && "()[]\"'`,;<>".includes(clean[0])) clean = clean.slice(1);
  while (clean.length > 0 && "()[]\"'`,;<>:".includes(clean[clean.length - 1])) clean = clean.slice(0, -1);
  if (clean.startsWith("file://")) clean = clean.slice(7);

  const parts = clean.split(":");
  if (parts.length === 0) return null;
  const candidatePath = stripFileUrlAndProjectPrefix(parts[0], projectRoot);
  if (!hasSupportedExtension(candidatePath)) return null;

  let line: number | undefined;
  let column: number | undefined;
  if (parts.length >= 2 && parts[1].length > 0 && isAsciiDigit(parts[1].charCodeAt(0))) {
    const parsedLine = Number(parts[1]);
    if (Number.isInteger(parsedLine) && parsedLine > 0) line = parsedLine;
  }
  if (parts.length >= 3 && parts[2].length > 0 && isAsciiDigit(parts[2].charCodeAt(0))) {
    const parsedCol = Number(parts[2]);
    if (Number.isInteger(parsedCol) && parsedCol > 0) column = parsedCol;
  }
  return { filePath: candidatePath, line, column };
}

function parseSingleTraceLine(line: string, projectRoot?: string): StackFrameCoord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("File \"")) {
    const closeQuote = trimmed.indexOf("\"", 6);
    if (closeQuote > 6) {
      const rawFile = stripFileUrlAndProjectPrefix(trimmed.slice(6, closeQuote), projectRoot);
      const lineMarker = trimmed.indexOf("line ", closeQuote);
      let lineNum: number | undefined;
      if (lineMarker > 0) {
        let idx = lineMarker + 5;
        let numStr = "";
        while (idx < trimmed.length && isAsciiDigit(trimmed.charCodeAt(idx))) {
          numStr += trimmed[idx++];
        }
        if (numStr) lineNum = Number(numStr);
      }
      const inMarker = trimmed.indexOf(", in ", closeQuote);
      const sym = inMarker > 0 ? trimmed.slice(inMarker + 5).trim() : undefined;
      if (hasSupportedExtension(rawFile)) {
        return { filePath: rawFile, line: lineNum, symbolName: sym, rawLine: trimmed };
      }
    }
  }

  let symbolName: string | undefined;
  if (trimmed.startsWith("at ")) {
    const afterAt = trimmed.slice(3).trim();
    const spaceIdx = afterAt.indexOf(" ");
    if (spaceIdx > 0 && !afterAt.startsWith("file:") && !afterAt.startsWith("/")) {
      const rawSym = afterAt.slice(0, spaceIdx).trim();
      const dotIdx = rawSym.lastIndexOf(".");
      symbolName = dotIdx >= 0 ? rawSym.slice(dotIdx + 1) : rawSym;
    }
  }

  const tokens = trimmed.split(/\s+/);
  for (const tok of tokens) {
    const parsed = parseFileLineToken(tok, projectRoot);
    if (parsed) {
      return {
        filePath: parsed.filePath,
        line: parsed.line,
        column: parsed.column,
        symbolName,
        rawLine: trimmed,
      };
    }
  }
  return null;
}

function extractIdentifiersFromText(text: string): string[] {
  const seen = new Set<string>();
  const stop = new Set([
    "error", "failed", "failure", "assertion", "expected", "actual", "undefined",
    "null", "true", "false", "function", "object", "string", "number", "async",
    "promise", "return", "const", "line", "file", "test", "trace", "stack",
  ]);
  let i = 0;
  while (i < text.length) {
    while (i < text.length && !isIdentChar(text.charCodeAt(i))) i++;
    const start = i;
    while (i < text.length && isIdentChar(text.charCodeAt(i))) i++;
    if (i > start) {
      const tok = text.slice(start, i);
      if (tok.length >= 3 && !isAsciiDigit(tok.charCodeAt(0)) && !stop.has(tok.toLowerCase())) {
        const words = splitIdentifierWords(tok);
        if (words.length >= 2 || tok.includes("_") || tok.length >= 5) {
          seen.add(tok);
          if (seen.size >= 25) break;
        }
      }
    }
  }
  return Array.from(seen);
}

export function parseFailureTrace(traceText: string, projectRoot?: string): ParsedFailureTrace {
  const lines = traceText.split("\n");
  let headline = "";
  const frames: StackFrameCoord[] = [];
  const seenKey = new Set<string>();

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!headline && !trimmed.startsWith("at ")) {
      headline = trimmed.slice(0, 200);
    }
    const frame = parseSingleTraceLine(trimmed, projectRoot);
    if (frame) {
      const key = `${frame.filePath || ""}:${frame.line || 0}:${frame.symbolName || ""}`;
      if (!seenKey.has(key)) {
        seenKey.add(key);
        frames.push(frame);
      }
    }
  }

  if (!headline && lines.length > 0) headline = lines[0].trim().slice(0, 200);
  const mentionedIdentifiers = extractIdentifiersFromText(traceText);
  return { headline, frames, mentionedIdentifiers };
}

async function resolveFrameSymbols(
  store: CodeStore,
  parsed: ParsedFailureTrace,
): Promise<Array<{ symbol: CodeSymbolRecord; frame: StackFrameCoord }>> {
  const results: Array<{ symbol: CodeSymbolRecord; frame: StackFrameCoord }> = [];
  const seenRefs = new Set<number>();

  for (const frame of parsed.frames) {
    let matched: CodeSymbolRecord | undefined;
    if (frame.filePath && frame.line !== undefined) {
      const spanSyms = await store.querySpatialSpan(frame.filePath, frame.line, frame.line);
      if (spanSyms.length > 0) matched = spanSyms[0];
    }
    if (!matched && frame.symbolName) {
      const cands = resolveSymbolCandidates(store, { name: frame.symbolName, file: frame.filePath });
      if (cands.length > 0) matched = cands[0];
    }
    if (!matched && frame.filePath) {
      const fileSyms = resolveSymbolCandidates(store, { file: frame.filePath });
      if (frame.line !== undefined) {
        matched = fileSyms.find((s) => s.startLine <= frame.line! && s.endLine >= frame.line!);
      }
      if (!matched && fileSyms.length === 1) matched = fileSyms[0];
    }
    if (matched && !seenRefs.has(matched.ref)) {
      seenRefs.add(matched.ref);
      results.push({ symbol: matched, frame });
    }
  }

  for (const ident of parsed.mentionedIdentifiers) {
    if (results.length >= 10) break;
    const byName = store.getSymbolsByName(ident);
    if (byName.length === 1 && !seenRefs.has(byName[0].ref)) {
      seenRefs.add(byName[0].ref);
      results.push({
        symbol: byName[0],
        frame: { symbolName: ident, filePath: byName[0].filePath, line: byName[0].startLine, rawLine: `identifier: ${ident}` },
      });
    }
  }
  return results;
}

function computeFaultIntersections(
  _store: CodeStore,
  stackSymbols: Array<{ symbol: CodeSymbolRecord; frame: StackFrameCoord }>,
  diffImpact: CodeDiffImpactResult,
): FaultIntersectionHit[] {
  const modifiedByRef = new Map<number, CodeSymbolRecord>();
  for (const m of diffImpact.modifiedSymbols) modifiedByRef.set(m.ref, m);
  const impactedByRef = new Map<number, { calledModifiedSymbol: string; depth: number }>();
  for (const ic of diffImpact.impactedCallers) {
    impactedByRef.set(ic.symbol.ref, { calledModifiedSymbol: ic.calledModifiedSymbol, depth: ic.depth });
  }

  const hits: FaultIntersectionHit[] = [];
  const seen = new Set<string>();

  for (const { symbol, frame } of stackSymbols) {
    if (modifiedByRef.has(symbol.ref)) {
      const key = `mod:${symbol.ref}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ symbol, role: "modified_on_stack", frameLine: frame.line, hopDistance: 0 });
      }
    }
    const imp = impactedByRef.get(symbol.ref);
    if (imp) {
      const key = `caller:${symbol.ref}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({
          symbol,
          role: "caller_of_modified_on_stack",
          frameLine: frame.line,
          viaSymbol: imp.calledModifiedSymbol,
          hopDistance: imp.depth,
        });
      }
    }
    for (const calleeRef of symbol.callees) {
      const modCallee = modifiedByRef.get(calleeRef);
      if (modCallee) {
        const key = `callee:${modCallee.ref}`;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push({
            symbol: modCallee,
            role: "modified_callee_of_stack",
            viaSymbol: symbol.qualifiedName,
            hopDistance: 1,
          });
        }
      }
    }
  }

  return hits.sort((a, b) => a.hopDistance - b.hopDistance);
}

export function formatFailureDiagnosis(
  parsed: ParsedFailureTrace,
  stackSymbols: Array<{ symbol: CodeSymbolRecord; frame: StackFrameCoord }>,
  diffImpact: CodeDiffImpactResult,
  intersections: FaultIntersectionHit[],
): string {
  const lines = [
    `=== Differential Failure Topology & Causal Fault Intersection ===`,
    `Error Headline: ${parsed.headline || "(none)"}`,
  ];

  if (intersections.length > 0) {
    lines.push(`\n🎯 Causal Fault Intersection (Stack Trace × Git Diff Blast Radius):`);
    for (const h of intersections) {
      const s = h.symbol;
      if (h.role === "modified_on_stack") {
        lines.push(`  • [FAULT ROOT · hop 0] ${s.qualifiedName} (${s.filePath}:${s.startLine}-${s.endLine}) — directly modified in git diff AND on failing stack${h.frameLine ? ` at line ${h.frameLine}` : ""}`);
      } else if (h.role === "modified_callee_of_stack") {
        lines.push(`  • [MODIFIED CALLEE · hop 1] ${s.qualifiedName} (${s.filePath}:${s.startLine}-${s.endLine}) — modified in git diff, called by stack frame ${h.viaSymbol}`);
      } else {
        lines.push(`  • [IMPACTED STACK CALLER · hop ${h.hopDistance}] ${s.qualifiedName} (${s.filePath}:${s.startLine}-${s.endLine}) — on failing stack, calls modified symbol ${h.viaSymbol}`);
      }
      lines.push(`    Sig: ${s.signature}`);
    }
  } else if (diffImpact.modifiedSymbols.length > 0) {
    lines.push(`\nModified Symbols in Worktree (no direct call-edge overlap with parsed stack frames):`);
    for (const m of diffImpact.modifiedSymbols.slice(0, 5)) {
      lines.push(`  • [${m.kind}] ${m.qualifiedName} (${m.filePath}:${m.startLine}-${m.endLine})`);
    }
  }

  if (stackSymbols.length > 0) {
    lines.push(`\nResolved Stack Frame & Failure Site Symbols (${stackSymbols.length}):`);
    for (const { symbol: s, frame } of stackSymbols) {
      const lineNote = frame.line ? ` (trace line ${frame.line})` : "";
      lines.push(`  • [SymRef ${s.ref}] (${s.kind}) ${s.qualifiedName} (${s.filePath}:${s.startLine}-${s.endLine})${lineNote}\n    Sig: ${s.signature}`);
    }
  } else {
    lines.push(`\nResolved Stack Frame Symbols: 0 symbols matched in codebase index.`);
  }

  return lines.join("\n");
}

export async function diagnoseFailureTopology(
  store: CodeStore,
  traceText: string,
  options?: { diffText?: string; maxDepth?: number },
): Promise<FailureDiagnosisResult> {
  await store.ensureIndexed();
  const parsed = parseFailureTrace(traceText, store.projectRoot);
  const stackSymbols = await resolveFrameSymbols(store, parsed);

  let diffText = options?.diffText;
  if (diffText === undefined) {
    diffText = await collectWorktreeDiffText(store, { fallbackToHeadCommit: true });
  }

  const diffImpact = await detectWorktreeChangesImpact(store, diffText, options?.maxDepth ?? 2);
  const faultIntersections = computeFaultIntersections(store, stackSymbols, diffImpact);
  const rendered = formatFailureDiagnosis(parsed, stackSymbols, diffImpact, faultIntersections);

  return {
    parsed,
    stackSymbols,
    diffImpact,
    faultIntersections,
    rendered,
  };
}
