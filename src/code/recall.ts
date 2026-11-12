/**
 * Progressive Codebase Recall Engine & Formatters (src/code/recall.ts).
 * Zero regexes: uses deterministic string/token operations and C multi-axis RRF fusion.
 */

import type { CodeStore } from "./store.ts";
import type { CodeQueryOptions, CodeSliceHit, CodeSymbolRecord } from "./types.ts";
import {
  buildCodeArchitectureOverview,
  detectWorktreeChangesImpact,
  resolveSymbolCandidates,
  traceSymbolPath,
} from "./graph.ts";
import {
  formatAmbiguousCandidates,
  formatCodeDiffImpact,
  formatCodeOverview,
  formatCodeTrace,
  formatSymbolCard,
} from "./manager.ts";
import { splitIdentifierWords } from "./lexer.ts";
import { normalizeRelPath } from "./payload_codec.ts";
import { fuseRankingsRRF } from "../tools/ranking.ts";

export { formatCodeDiffImpact, formatCodeOverview, formatCodeTrace, formatSymbolCard };

export interface CodeRecallOutput {
  mode: "overview" | "diff" | "trace" | "symbol" | "search";
  rendered: string;
  symbols: CodeSymbolRecord[];
}

export class CodeRecallEngine {
  private readonly store: CodeStore;

  constructor(store: CodeStore) {
    this.store = store;
  }

  async execute(
    options: CodeQueryOptions,
    gitDiffProvider?: () => Promise<string>,
  ): Promise<CodeRecallOutput> {
    await this.store.ensureIndexed();

    if (options.overview === true) {
      const ov = buildCodeArchitectureOverview(this.store);
      return { mode: "overview", rendered: formatCodeOverview(ov), symbols: [] };
    }

    if (options.diff === true) {
      const diffText = gitDiffProvider ? await gitDiffProvider() : await runGitDiff(this.store);
      const impact = await detectWorktreeChangesImpact(this.store, diffText, options.depth ?? 2);
      return { mode: "diff", rendered: formatCodeDiffImpact(impact), symbols: impact.modifiedSymbols };
    }

    if (typeof options.trace === "string" && options.trace.trim() !== "") {
      const tr = traceSymbolPath(this.store, options.trace.trim(), options);
      return { mode: "trace", rendered: formatCodeTrace(tr), symbols: tr.root ? [tr.root] : (tr.candidates ?? []) };
    }

    const batchTargets = Array.isArray(options.symbols) && options.symbols.length > 0
      ? options.symbols
      : (typeof options.symbol === "string" && options.symbol.trim() !== "" ? [options.symbol.trim()] : []);

    if (batchTargets.length > 0) {
      return this.executeSymbolRead(batchTargets, options);
    }

    return await this.executeHybridSearch(options);
  }

  private executeSymbolRead(targets: string[], options: CodeQueryOptions): CodeRecallOutput {
    const sections: string[] = [];
    const matchedSymbols: CodeSymbolRecord[] = [];
    const neighborsMode = options.neighbors ?? "both";

    for (const target of targets.slice(0, 15)) {
      const cands = resolveSymbolCandidates(this.store, {
        name: target, file: options.file, kind: options.kind, parentSymbol: options.parentSymbol,
      });

      if (cands.length === 0) {
        sections.push(`[Symbol "${target}"]: Not found. Try memory_recall({ query: "${target}", scope: "code" }).`);
        continue;
      }
      if (cands.length > 1) {
        sections.push(formatAmbiguousCandidates(target, cands));
        continue;
      }

      const sym = cands[0];
      matchedSymbols.push(sym);
      const slice = this.store.sliceSymbolSource(sym, {
        lineRange: options.lineRange, maxLines: options.maxLines, fullOutput: options.fullOutput,
      });
      sections.push(slice ? formatCodeSlice(slice, neighborsMode, options.neighborLimit ?? 8) : formatSymbolCard(sym));
    }

    return { mode: "symbol", rendered: sections.join("\n\n"), symbols: matchedSymbols };
  }

  private async executeHybridSearch(options: CodeQueryOptions): Promise<CodeRecallOutput> {
    const query = (options.query || "").trim();
    const limit = Math.max(1, Math.min(options.limit ?? 8, 25));

    if (!query) {
      const cands = resolveSymbolCandidates(this.store, {
        file: options.file, kind: options.kind, parentSymbol: options.parentSymbol,
      }).slice(0, limit);
      return { mode: "search", rendered: formatCodeSearchCards(cands, query), symbols: cands };
    }

    await this.store.flush(50);
    const [lexLines, semLines] = await Promise.all([
      this.store.queryLexical(query, limit * 2),
      this.store.querySemantic(query, limit * 2),
    ]);
    const scores = new Map<number, { sym: CodeSymbolRecord; score: number }>();

    if (lexLines.length > 0 || semLines.length > 0) {
      const fused = fuseRankingsRRF(lexLines, semLines, 60);
      for (const f of fused) {
        const sym = await this.store.getSymbol(f.ref);
        if (sym) scores.set(sym.ref, { sym, score: f.rrfScore * 100 });
      }
    }

    const queryLower = query.toLowerCase();
    const queryWords = splitIdentifierWords(query);
    const filteredPool = resolveSymbolCandidates(this.store, {
      file: options.file, kind: options.kind, parentSymbol: options.parentSymbol,
    });

    for (const sym of filteredPool) {
      const sc = scoreSymbolAgainstQuery(sym, queryLower, queryWords);
      if (sc > 0) {
        const prev = scores.get(sym.ref);
        scores.set(sym.ref, { sym, score: (prev ? prev.score : 0) + sc });
      }
    }

    const allowedRefs = new Set(filteredPool.map((s) => s.ref));
    const ranked = Array.from(scores.values())
      .filter((x) => allowedRefs.has(x.sym.ref))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.sym);

    if (ranked.length === 1 || (ranked.length > 0 && ranked[0].name.toLowerCase() === queryLower && ranked.filter((s) => s.name.toLowerCase() === queryLower).length === 1)) {
      const primary = ranked[0];
      const slice = this.store.sliceSymbolSource(primary, {
        lineRange: options.lineRange, maxLines: options.maxLines ?? 60, fullOutput: options.fullOutput,
      });
      const sliceText = slice ? formatCodeSlice(slice, options.neighbors ?? "both", 6) : formatSymbolCard(primary);
      const restText = ranked.length > 1 ? "\n\nOther matching symbols:\n" + ranked.slice(1).map(formatSymbolCard).join("\n") : "";
      return { mode: "search", rendered: `${sliceText}${restText}`, symbols: ranked };
    }

    return { mode: "search", rendered: formatCodeSearchCards(ranked, query), symbols: ranked };
  }
}

function scoreSymbolAgainstQuery(sym: CodeSymbolRecord, queryLower: string, queryWords: string[]): number {
  let score = 0;
  const nameLower = sym.name.toLowerCase();
  const qnLower = sym.qualifiedName.toLowerCase();
  const sigLower = sym.signature.toLowerCase();
  const docLower = (sym.docComment || "").toLowerCase();
  const fileLower = normalizeRelPath(sym.filePath).toLowerCase();

  if (nameLower === queryLower) score += 25;
  else if (nameLower.startsWith(queryLower)) score += 12;
  else if (nameLower.includes(queryLower)) score += 8;
  if (qnLower.includes(queryLower)) score += 6;
  if (sigLower.includes(queryLower)) score += 4;
  if (docLower.includes(queryLower)) score += 5;

  for (const w of queryWords) {
    if (nameLower.includes(w)) score += 4;
    else if (sigLower.includes(w) || docLower.includes(w)) score += 2;
    else if (fileLower.includes(w)) score += 1.5;
    for (const callee of sym.rawCallees) {
      if (callee.toLowerCase().includes(w)) { score += 1.5; break; }
    }
  }
  if ( score > 0 && sym.signature.startsWith("XY_DECL(")) {
    score *= 0.85;
  }
  return score;
}

async function runGitDiff(store: CodeStore): Promise<string> {
  const res = await store.runner.run({
    command: "git", args: ["diff", "HEAD", "--unified=0"], env: {}, cwd: store.projectRoot,
  });
  return res.code === 0 ? res.stdout : "";
}

export function formatCodeSlice(
  slice: CodeSliceHit,
  neighborsMode: "none" | "callers" | "callees" | "both",
  neighborLimit: number,
): string {
  const sym = slice.symbol;
  const lines: string[] = [
    `=== [SymRef ${sym.ref}] ${sym.kind} ${sym.qualifiedName} (${sym.filePath}:${slice.startLine}-${slice.endLine} of ${sym.startLine}-${sym.endLine}) ===`,
  ];
  if (sym.docComment) lines.push(`Doc: ${sym.docComment}`);

  if ((neighborsMode === "callers" || neighborsMode === "both") && slice.directCallers.length > 0) {
    const callersStr = slice.directCallers.slice(0, neighborLimit).map((c) => `${c.name} (${c.filePath}:${c.startLine})`).join(", ");
    lines.push(`Direct Callers (${slice.directCallers.length}): ${callersStr}`);
  }
  if ((neighborsMode === "callees" || neighborsMode === "both") && slice.directCallees.length > 0) {
    const calleesStr = slice.directCallees.slice(0, neighborLimit).map((c) => `${c.name} (${c.filePath}:${c.startLine})`).join(", ");
    lines.push(`Direct Callees (${slice.directCallees.length}): ${calleesStr}`);
  }

  lines.push("");
  for (const l of slice.lines) lines.push(`${l.lineNum} | ${l.text}`);
  if (slice.compacted) {
    lines.push(`\n...[compacted at ${slice.lines.length} lines; pass lineRange: [${slice.endLine + 1}, ${sym.endLine}] or fullOutput: true to read remaining lines]`);
  }
  return lines.join("\n");
}

export function formatCodeSearchCards(symbols: CodeSymbolRecord[], query: string): string {
  if (symbols.length === 0) {
    return query ? `No code symbols found matching "${query}".` : "No code symbols indexed.";
  }
  const lines = [`=== Codebase Symbols (${symbols.length} match${symbols.length === 1 ? "" : "es"}${query ? ` for "${query}"` : ""}) ===`];
  for (const sym of symbols) lines.push(formatSymbolCard(sym));
  lines.push(`\nTip: Call memory_recall({ scope: "code", symbol: "<name>", file: "<file>" }) to read source, or trace: "<name>" to trace callers/callees.`);
  return lines.join("\n");
}
