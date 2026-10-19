import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { EnvSource, ToolEnv } from "./index.ts";
import { axisPath, memDir, exportDetail, sepalConfigured } from "./index.ts";
import { filespecFor, buildScanInvocation, scanLexicalExpr, scanSemanticExpr, parseResultLines, embedEnv, SEPAL_MIN_SIM, scanWindowArgs, type ResultLine } from "../qmap.ts";
import type { MipmapLevel } from "../types.ts";
import { fuseRankingsRRF, filterAndEnrich, type FusedCandidate, type FilterCriteria } from "./ranking.ts";
import { debugLog } from "../debug.ts";

export type EnrichedRecord = FusedCandidate;

const SCAN_PARAMS = {
  type: "object",
  properties: {
    topic: { type: "string", description: "Search topic (accent-sensitive, passed verbatim to text index)." },
    level: { type: ["number", "string"], description: "Resolution level ('L0'|'L1'|'L2'|'L3') or legacy time window (0 all-time, 1 today, 2 month). Default 0." },
    timeWindow: { type: ["number", "string"], description: "Time window when level is used for mipmaps: 0 = all-time, 1 = today, 2 = month." },
    lifecycle: { type: "string", enum: ["observed", "hypothesized", "tested", "supported", "contradicted", "superseded", "all"], description: "Filter by lifecycle state (default all)." },
    project: { type: "string", description: "Filter by context project name." },
    subsystem: { type: "string", description: "Filter by context subsystem." },
    bbox: {
      type: "object",
      description: "Spatial bounding box for islet axis (dim, s=min_corner, l=extent).",
      properties: {
        dim: { type: "number" },
        s: { type: "string" },
        l: { type: "string" },
      },
      required: ["s", "l"],
    },
    until: { type: "string", description: "ISO date upper bound (YYYY-MM-DD)." },
    embed: { type: "boolean", description: "Add semantic (sepal) ranking when configured." },
    limit: { type: "number", description: "Maximum records returned (default 10)." },
  },
  required: ["topic"],
  additionalProperties: false,
};

function resolveTimeLevel(lvl: unknown, timeWin: unknown): number {
  if (typeof timeWin === "number" && timeWin >= 0 && timeWin <= 2) return timeWin;
  if (typeof timeWin === "string" && ["0", "1", "2"].includes(timeWin)) return Number(timeWin);
  if (typeof lvl === "number" && lvl >= 0 && lvl <= 2) return lvl;
  if (typeof lvl === "string" && ["0", "1", "2"].includes(lvl)) return Number(lvl);
  return 0;
}

function resolveMipmapFilter(lvl: unknown): MipmapLevel | undefined {
  if (typeof lvl === "string" && ["L0", "L1", "L2", "L3"].includes(lvl)) {
    return lvl as MipmapLevel;
  }
  return undefined;
}

function defaultLimit(n: unknown): number {
  if (typeof n === "number" && Number.isInteger(n) && n > 0) return n;
  return 10;
}

async function querySpatialFilter(
  env: ToolEnv, cwd: string, axes: string, limit: number, bbox: { dim?: number; s: string; l: string },
): Promise<Set<number>> {
  const isletFspec = `${cwd}/mem-islet.db@islet:a:s`;
  const res = await env.runner.run(buildScanInvocation(
    env.cfg.qmapBin, isletFspec, "islet", limit * 2, axes, cwd, undefined,
    [`--dim=${bbox.dim ?? 2}`, `--s=${bbox.s}`, `--l=${bbox.l}`],
  ));
  return res.code === 0 ? new Set(parseResultLines(res.stdout).map((l) => l.ref)) : new Set();
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "with",
  "by", "from", "of", "about", "into", "through", "after", "before", "is",
  "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
  "does", "did", "can", "could", "will", "would", "shall", "should", "what",
  "which", "who", "whom", "this", "that", "these", "those", "my", "your",
  "our", "their", "its", "there", "here", "when", "where", "why", "how",
]);

async function scanTokenFallback(
  env: ToolEnv, cwd: string, expr: string, limit: number, axes: string,
  timeLevel: number, now: Date, until: string | undefined, topic: string,
): Promise<ResultLine[]> {
  const allTokens = topic.split(/\s+/)
    .map((w) => w.replace(/[^\w-]/g, ""))
    .filter((w) => w.length >= 2);

  const filtered = allTokens.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  const words = filtered.length > 0 ? filtered : allTokens;

  const seen = new Set<number>();
  const lines: ResultLine[] = [];
  for (const w of words.slice(0, 6)) {
    const subArgs = [
      ...scanWindowArgs(timeLevel, now, until),
      "--field=text", "--matched=1", "--query=" + w,
    ];
    const subRes = await env.runner.run(buildScanInvocation(env.cfg.qmapBin, filespecFor(cwd, false), expr, limit, axes, cwd, undefined, subArgs));
    if (subRes.code === 0) {
      for (const line of parseResultLines(subRes.stdout)) {
        if (!seen.has(line.ref)) { seen.add(line.ref); lines.push(line); }
      }
    }
  }
  return lines;
}

export async function queryLexicalPath(
  env: ToolEnv, cwd: string, axes: string, timeLevel: number, now: Date,
  until: string | undefined, topic: string, limit: number,
): Promise<{ lines: ResultLine[]; error?: string }> {
  const lexExpr = scanLexicalExpr(timeLevel, now, until);
  const lexArgs = [
    ...scanWindowArgs(timeLevel, now, until),
    "--field=text", "--matched=1", "--query=" + topic,
  ];
  const res = await env.runner.run(buildScanInvocation(
    env.cfg.qmapBin, filespecFor(cwd, false), lexExpr, limit, axes, cwd, undefined, lexArgs,
  ));
  if (res.code === 0) {
    let lines = parseResultLines(res.stdout);
    if (lines.length === 0 && topic.includes(" ")) {
      lines = await scanTokenFallback(env, cwd, lexExpr, limit, axes, timeLevel, now, until, topic);
    }
    return { lines };
  }
  return { lines: [], error: res.stderr || res.stdout };
}

export async function querySemanticPath(
  env: ToolEnv, cwd: string, axes: string, timeLevel: number, now: Date,
  until: string | undefined, topic: string, limit: number,
): Promise<{ lines: ResultLine[]; error?: string }> {
  const semExpr = scanSemanticExpr(timeLevel, now, until);
  const semArgs = [
    ...scanWindowArgs(timeLevel, now, until),
    "--query=" + topic,
    "--min-sim=" + String(SEPAL_MIN_SIM),
  ];
  const res = await env.runner.run(buildScanInvocation(
    env.cfg.qmapBin, filespecFor(cwd, true), semExpr, limit, axes, cwd, embedEnv(env.cfg), semArgs,
  ));
  if (res.code === 0) {
    return { lines: parseResultLines(res.stdout) };
  }
  return { lines: [], error: res.stderr || res.stdout };
}

export interface HybridScanOptions {
  topic: string;
  level?: unknown;
  timeWindow?: unknown;
  lifecycle?: string;
  project?: string;
  subsystem?: string;
  bbox?: { dim?: number; s: string; l: string };
  until?: string;
  embed?: boolean;
  limit?: number;
  dedupe?: boolean;
}

export async function executeHybridScan(
  env: ToolEnv,
  opts: HybridScanOptions,
): Promise<{ records: FusedCandidate[]; details: Record<string, unknown> }> {
  const topic = opts.topic.trim();
  const details: Record<string, unknown> = {};
  if (topic === "") return { records: [], details: { records: [] } };
  if (env.cfg.qmapBin === "") return { records: [], details: { error: "no-qmap", records: [] } };

  const timeLevel = resolveTimeLevel(opts.level, opts.timeWindow);
  const limit = defaultLimit(opts.limit) || env.cfg.scanLimit;
  const untilRaw = opts.until;
  const until = typeof untilRaw === "string" && /^\d{4}-\d{2}-\d{2}/.test(untilRaw) ? untilRaw.slice(0, 10) : undefined;
  const wantEmbed = opts.embed === true;
  const embedReady = wantEmbed && sepalConfigured(env.cfg);
  if (wantEmbed && !embedReady) details["embed"] = "unconfigured";

  const axes = axisPath(env);
  const cwd = memDir(env);
  const now = env.nowProvider();

  const lexResult = await queryLexicalPath(env, cwd, axes, timeLevel, now, until, topic, limit);
  if (lexResult.error) details["lexicalError"] = lexResult.error;
  debugLog("recall", "Lexical query path evaluated", {
    topic: topic.slice(0, 80),
    hitCount: lexResult.lines.length,
    refs: lexResult.lines.map((l) => l.ref),
    error: lexResult.error,
  });

  let semLines: ResultLine[] = [];
  if (embedReady) {
    const semResult = await querySemanticPath(env, cwd, axes, timeLevel, now, until, topic, limit);
    if (semResult.error) details["embedError"] = semResult.error;
    semLines = semResult.lines;
    debugLog("recall", "Semantic query path evaluated", {
      topic: topic.slice(0, 80),
      hitCount: semLines.length,
      refs: semLines.map((l) => l.ref),
      error: semResult.error,
    });
  } else {
    debugLog("recall", "Semantic query path skipped", {
      wantEmbed,
      embedReady,
    });
  }

  let fused = fuseRankingsRRF(lexResult.lines, semLines, 60);

  if (opts.bbox) {
    const isletRefs = await querySpatialFilter(env, cwd, axes, limit, opts.bbox);
    fused = fused.filter((c) => isletRefs.has(c.ref));
  }

  const filterCrit: FilterCriteria = {
    mipmap: resolveMipmapFilter(opts.level),
    lifecycle: typeof opts.lifecycle === "string" ? opts.lifecycle : undefined,
    project: typeof opts.project === "string" ? opts.project.trim() : undefined,
    subsystem: typeof opts.subsystem === "string" ? opts.subsystem.trim() : undefined,
    limit,
    query: topic,
    dedupe: opts.dedupe,
  };
  const records = filterAndEnrich(fused, filterCrit);
  details["records"] = records;
  debugLog("recall", "Hybrid scan fused and filtered records", {
    topic: topic.slice(0, 80),
    fusedCount: fused.length,
    returnedCount: records.length,
    refs: records.map((r) => r.ref),
  });
  return { records, details };
}

async function executeScan(envSource: EnvSource, params: Record<string, unknown>, ctx: PiCtx) {
  try {
    const env = await envSource(ctx);
    const topic = typeof params["topic"] === "string" ? params["topic"].trim() : "";
    if (topic === "") return { content: [{ type: "text", text: "mm scan: empty topic (degradation: soft)" }], details: { records: [] } };
    if (env.cfg.qmapBin === "") return { content: [{ type: "text", text: "mm unavailable: qmap binary not found" }], details: { error: "no-qmap", records: [] } };

    const { details } = await executeHybridScan(env, params as unknown as HybridScanOptions);
    if (details["lexicalError"] && (!details["records"] || (details["records"] as unknown[]).length === 0)) {
      return { content: [{ type: "text", text: `mm scan failed: ${details["lexicalError"]}` }], details };
    }
    return exportDetail(details);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `mm unavailable: ${msg}` }], details: { error: msg, records: [] } };
  }
}

export function makeScanTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_scan",
    label: "Scan Memory",
    description: "Search stored memories across time, text, semantics, and mipmap resolution levels (L0-L3). Returns matching records with decoded metadata.",
    parameters: SCAN_PARAMS,
    execute: (_id, params, _sig, _upd, ctx) => executeScan(envSource, params, ctx as PiCtx),
  };
}

export async function scanTopRef(envSource: EnvSource, ctx: PiCtx, topic: string): Promise<number | null> {
  const env = await envSource(ctx as PiCtx);
  if (env.cfg.qmapBin === "") return null;
  const { records } = await executeHybridScan(env, { topic, limit: 1 });
  return records.length > 0 ? records[0].ref : null;
}
