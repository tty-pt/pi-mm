import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type CaptureMode = "all" | "keyword" | "judge" | "off";
export type JudgeMode = "auto" | "heuristic" | "off";
export type JudgeFallback = "capture" | "skip";

export interface MmConfig {
  cormBin: string;
  qmapBin?: string;
  cormdBin?: string;
  axisLibs: string | null;
  memDir: string;
  scanLimit: number;
  advancedTools?: boolean;
  embedUrl?: string;
  embedModel?: string;
  embedKey?: string;
  semanticSearch?: boolean;
  captureMode?: CaptureMode;
  captureKeyword?: string;
  captureKeywords?: string[];
  judgeMode?: JudgeMode;
  judgeUrl?: string;
  judgeModel?: string;
  judgeKey?: string;
  judgeTimeoutMs?: number;
  judgeFallback?: JudgeFallback;
  consolidateL2Threshold?: number;
  consolidateL3Threshold?: number;
  consolidateMaxAgeHours?: number;
  consolidateBatchLimit?: number;
  synthUrl?: string;
  synthModel?: string;
  synthKey?: string;
  synthTimeoutMs?: number;
  ephemeralSepal?: boolean;
  ephemeralJoint?: boolean;
}

export const DEFAULT_CAPTURE_KEYWORDS: string[] = [
  "@remember",
  "@memory",
  "remember:",
  "note:",
];

export const DEFAULT_CONFIG: MmConfig = {
  cormBin: "",
  cormdBin: undefined,
  axisLibs: null,
  memDir: ".pi/mm",
  scanLimit: 10,
  advancedTools: false,
  captureMode: undefined,
  captureKeyword: "@remember",
  captureKeywords: DEFAULT_CAPTURE_KEYWORDS,
  judgeMode: "auto",
  judgeTimeoutMs: 15000,
  judgeFallback: "skip",
  consolidateL2Threshold: 3,
  consolidateL3Threshold: 2,
  consolidateMaxAgeHours: undefined,
  consolidateBatchLimit: 20,
  synthUrl: undefined,
  synthModel: undefined,
  synthKey: undefined,
  synthTimeoutMs: 15000,
  ephemeralSepal: false,
};

export type CormSource = "settings" | "env" | "path" | "insite" | "none";

export interface CormResolution {
  source: CormSource;
  path: string;
}

export function loadConfig(raw: unknown): MmConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_CONFIG;
  const record = raw as Record<string, unknown>;
  const bin = record["cormBin"] ?? record["qmapBin"];
  const cormd = record["cormdBin"];
  const libs = record["axisLibs"];
  const dir = record["memDir"];
  const limit = record["scanLimit"];
  const url = record["embedUrl"];
  const model = record["embedModel"];
  const key = record["embedKey"];
  const adv = record["advancedTools"];
  const semSearch = record["semanticSearch"];
  const capMode = record["captureMode"];
  const capKeyword = record["captureKeyword"];
  const capKeywords = record["captureKeywords"];
  const jMode = record["judgeMode"];
  const jUrl = record["judgeUrl"];
  const jModel = record["judgeModel"];
  const jKey = record["judgeKey"];
  const jTimeout = record["judgeTimeoutMs"];
  const jFallback = record["judgeFallback"];
  const l2Thresh = record["consolidateL2Threshold"];
  const l3Thresh = record["consolidateL3Threshold"];
  const maxAge = record["consolidateMaxAgeHours"];
  const batchLim = record["consolidateBatchLimit"];
  const sUrl = record["synthUrl"];
  const sModel = record["synthModel"];
  const sKey = record["synthKey"];
  const sTimeout = record["synthTimeoutMs"];
  const ephem = record["ephemeralSepal"] ?? record["sepalEphemeral"];

  // Migrate legacy judgeMode if captureMode is not explicitly set
  let effectiveCaptureMode: CaptureMode = "all";
  if (capMode === "all" || capMode === "keyword" || capMode === "judge" || capMode === "off") {
    effectiveCaptureMode = capMode;
  } else if (jMode === "off") {
    effectiveCaptureMode = "off";
  } else if (typeof jUrl === "string" && jUrl.trim() !== "") {
    effectiveCaptureMode = "judge";
  } else {
    effectiveCaptureMode = "all";
  }

  let effectiveKeywords: string[] = DEFAULT_CAPTURE_KEYWORDS;
  if (Array.isArray(capKeywords)) {
    effectiveKeywords = capKeywords
      .filter((k) => typeof k === "string" && k.trim() !== "")
      .map((k) => (k as string).trim());
  } else if (typeof capKeyword === "string" && capKeyword.trim() !== "") {
    // Backward-compatibility: if user specifies captureKeyword, prioritize [captureKeyword]
    effectiveKeywords = [capKeyword.trim()];
  }

  let effectiveFallback: JudgeFallback = DEFAULT_CONFIG.judgeFallback ?? "skip";
  if (jFallback === "capture" || jFallback === "skip") {
    effectiveFallback = jFallback;
  } else if (jFallback === "heuristic") {
    effectiveFallback = "skip";
  }

  const effectiveBin = typeof bin === "string" && bin.trim() !== "" ? bin.trim() : DEFAULT_CONFIG.cormBin;

  return {
    cormBin: effectiveBin,
    cormdBin: typeof cormd === "string" && cormd.trim() !== "" ? cormd.trim() : undefined,
    axisLibs: typeof libs === "string" && libs.trim() !== "" ? libs.trim() : DEFAULT_CONFIG.axisLibs,
    memDir: typeof dir === "string" && dir.trim() !== "" ? dir.trim() : DEFAULT_CONFIG.memDir,
    scanLimit: typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_CONFIG.scanLimit,
    advancedTools: typeof adv === "boolean" ? adv : DEFAULT_CONFIG.advancedTools,
    embedUrl: typeof url === "string" && url.trim() !== "" ? url.trim() : undefined,
    embedModel: typeof model === "string" && model.trim() !== "" ? model.trim() : undefined,
    embedKey: typeof key === "string" && key.trim() !== "" ? key.trim() : undefined,
    semanticSearch: typeof semSearch === "boolean" ? semSearch : undefined,
    captureMode: effectiveCaptureMode,
    captureKeyword: typeof capKeyword === "string" && capKeyword.trim() !== "" ? capKeyword.trim() : DEFAULT_CONFIG.captureKeyword,
    captureKeywords: effectiveKeywords,
    judgeMode: jMode === "auto" || jMode === "heuristic" || jMode === "off" ? jMode : DEFAULT_CONFIG.judgeMode,
    judgeUrl: typeof jUrl === "string" && jUrl.trim() !== "" ? jUrl.trim() : undefined,
    judgeModel: typeof jModel === "string" && jModel.trim() !== "" ? jModel.trim() : undefined,
    judgeKey: typeof jKey === "string" && jKey.trim() !== "" ? jKey.trim() : undefined,
    judgeTimeoutMs: typeof jTimeout === "number" && jTimeout > 0 ? jTimeout : DEFAULT_CONFIG.judgeTimeoutMs,
    judgeFallback: effectiveFallback,
    consolidateL2Threshold: typeof l2Thresh === "number" && l2Thresh > 0 ? l2Thresh : DEFAULT_CONFIG.consolidateL2Threshold,
    consolidateL3Threshold: typeof l3Thresh === "number" && l3Thresh > 0 ? l3Thresh : DEFAULT_CONFIG.consolidateL3Threshold,
    consolidateMaxAgeHours: typeof maxAge === "number" && maxAge > 0 ? maxAge : undefined,
    consolidateBatchLimit: typeof batchLim === "number" && batchLim > 0 ? batchLim : DEFAULT_CONFIG.consolidateBatchLimit,
    synthUrl: typeof sUrl === "string" && sUrl.trim() !== "" ? sUrl.trim() : undefined,
    synthModel: typeof sModel === "string" && sModel.trim() !== "" ? sModel.trim() : undefined,
    synthKey: typeof sKey === "string" && sKey.trim() !== "" ? sKey.trim() : undefined,
    synthTimeoutMs: typeof sTimeout === "number" && sTimeout > 0 ? sTimeout : DEFAULT_CONFIG.synthTimeoutMs,
    ephemeralSepal: typeof ephem === "boolean" ? ephem : DEFAULT_CONFIG.ephemeralSepal,
  };
}

export function applyEnv(cfg: MmConfig, env: Record<string, string | undefined>): MmConfig {
  const envBin = env["CORM_BIN"];
  const envCormd = env["CORMD_BIN"];
  const envLibs = env["CORM_AXIS_PATH"];

  // Independent embedding settings
  let defaultEmbedUrl = env["CORM_SEPAL_EMBED_URL"];
  let defaultEmbedModel = env["CORM_SEPAL_EMBED_MODEL"];
  let defaultEmbedKey = env["CORM_SEPAL_EMBED_KEY"];

  // Explicit capture settings
  const envCapMode = env["PI_MM_CAPTURE_MODE"] ?? env["MM_CAPTURE_MODE"];
  const envCapKeyword = env["PI_MM_CAPTURE_KEYWORD"] ?? env["MM_CAPTURE_KEYWORD"];

  // Independent judge settings
  const envJMode = env["PI_MM_JUDGE_MODE"] ?? env["MM_JUDGE_MODE"];
  let defaultJudgeUrl = env["PI_MM_JUDGE_URL"] ?? env["MM_JUDGE_URL"] ?? env["JEV_URL"];
  let defaultJudgeModel = env["PI_MM_JUDGE_MODEL"] ?? env["MM_JUDGE_MODEL"] ?? env["JEV_MODEL"];
  let defaultJudgeKey = env["PI_MM_JUDGE_KEY"] ?? env["MM_JUDGE_KEY"] ?? env["JEV_KEY"];
  const envJTimeout = env["PI_MM_JUDGE_TIMEOUT_MS"] ?? env["MM_JUDGE_TIMEOUT_MS"];
  const envJFallback = env["PI_MM_JUDGE_FALLBACK"] ?? env["MM_JUDGE_FALLBACK"];
  const envL2Thresh = env["PI_MM_CONSOLIDATE_L2_THRESHOLD"] ?? env["MM_CONSOLIDATE_L2_THRESHOLD"];
  const envL3Thresh = env["PI_MM_CONSOLIDATE_L3_THRESHOLD"] ?? env["MM_CONSOLIDATE_L3_THRESHOLD"];
  const envMaxAge = env["PI_MM_CONSOLIDATE_MAX_AGE_HOURS"] ?? env["MM_CONSOLIDATE_MAX_AGE_HOURS"];
  const envBatchLim = env["PI_MM_CONSOLIDATE_BATCH_LIMIT"] ?? env["MM_CONSOLIDATE_BATCH_LIMIT"];
  const envEphem = env["PI_MM_SEPAL_EPHEMERAL"] ?? env["MM_SEPAL_EPHEMERAL"] ?? env["CORM_SEPAL_EPHEMERAL"];

  // Independent synthesis settings
  const envSynthUrl = env["PI_MM_SYNTH_URL"] ?? env["MM_SYNTH_URL"];
  const envSynthModel = env["PI_MM_SYNTH_MODEL"] ?? env["MM_SYNTH_MODEL"];
  const envSynthKey = env["PI_MM_SYNTH_KEY"] ?? env["MM_SYNTH_KEY"];
  const envSynthTimeout = env["PI_MM_SYNTH_TIMEOUT_MS"] ?? env["MM_SYNTH_TIMEOUT_MS"];

  let defaultSynthUrl = envSynthUrl;
  let defaultSynthModel = envSynthModel;
  let defaultSynthKey = envSynthKey;

  // Auren endpoint fallback (or legacy QLLM_URL)
  const aurenBase = env["AUREN_URL"] ?? env["QLLM_URL"];
  if (aurenBase && aurenBase.trim() !== "") {
    const trimmedBase = aurenBase.trim().replace(/\/+$/, "");
    if (!defaultJudgeUrl) {
      defaultJudgeUrl = trimmedBase.endsWith("/api/v1/systemone/") ? trimmedBase :
                       (trimmedBase.endsWith("/api/v1/systemone") ? `${trimmedBase}/` : `${trimmedBase}/api/v1/systemone/`);
    }
    if (!defaultEmbedUrl) {
      defaultEmbedUrl = trimmedBase.endsWith("/v1/embeddings") ? trimmedBase : `${trimmedBase}/v1/embeddings`;
    }
    if (!defaultSynthUrl) {
      defaultSynthUrl = trimmedBase.endsWith("/v1/chat/completions") ? trimmedBase :
                       (trimmedBase.endsWith("/chat/completions") ? trimmedBase : `${trimmedBase}/v1/chat/completions`);
    }
    const aurenModel = env["AUREN_MODEL"] ?? env["QLLM_MODEL"];
    const aurenKey = env["AUREN_KEY"] ?? env["QLLM_KEY"];
    if (!defaultJudgeModel && aurenModel) defaultJudgeModel = aurenModel;
    if (!defaultEmbedModel && aurenModel) defaultEmbedModel = aurenModel;
    if (!defaultSynthModel && aurenModel) defaultSynthModel = aurenModel;
    if (!defaultJudgeKey && aurenKey) defaultJudgeKey = aurenKey;
    if (!defaultEmbedKey && aurenKey) defaultEmbedKey = aurenKey;
    if (!defaultSynthKey && aurenKey) defaultSynthKey = aurenKey;
  }

  const envUrl = defaultEmbedUrl;
  const envModel = defaultEmbedModel;
  const envKey = defaultEmbedKey;
  const envAdv = env["PI_MM_ADVANCED_TOOLS"];
  const envSemSearch = env["PI_MM_SEMANTIC_SEARCH"] ?? env["MM_SEMANTIC_SEARCH"];
  const envJUrl = defaultJudgeUrl;
  const envJModel = defaultJudgeModel;
  const envJKey = defaultJudgeKey;

  let ephemeralSepal = cfg.ephemeralSepal;
  if (envEphem !== undefined) {
    ephemeralSepal = envEphem === "1" || envEphem === "true";
  }

  let semSearch = cfg.semanticSearch;
  if (typeof envSemSearch === "string") {
    semSearch = envSemSearch === "1" || envSemSearch.toLowerCase() === "true";
  }

  let capMode = cfg.captureMode;
  if (envCapMode === "all" || envCapMode === "keyword" || envCapMode === "judge" || envCapMode === "off") {
    capMode = envCapMode;
  } else if (!capMode) {
    if (envJMode === "off") capMode = "off";
    else if (envJMode === "heuristic") capMode = "all";
    else if (envJMode === "auto") capMode = defaultJudgeUrl ? "judge" : "all";
  }

  let capKeyword = cfg.captureKeyword;
  if (typeof envCapKeyword === "string" && envCapKeyword.trim() !== "") {
    capKeyword = envCapKeyword.trim();
  }

  const envCapKeywords = env["PI_MM_CAPTURE_KEYWORDS"] ?? env["MM_CAPTURE_KEYWORDS"];
  let capKeywords = cfg.captureKeywords;
  if (typeof envCapKeywords === "string" && envCapKeywords.trim() !== "") {
    capKeywords = envCapKeywords.split(",").map((k) => k.trim()).filter(Boolean);
  }

  let jMode = cfg.judgeMode;
  if (envJMode === "auto" || envJMode === "heuristic" || envJMode === "off") {
    jMode = envJMode;
  }

  let jFallback = cfg.judgeFallback;
  if (envJFallback === "capture" || envJFallback === "skip") {
    jFallback = envJFallback;
  } else if (envJFallback === "heuristic") {
    jFallback = "skip";
  }

  const timeoutNum = envJTimeout ? parseInt(envJTimeout, 10) : undefined;
  const l2ThreshNum = envL2Thresh ? parseInt(envL2Thresh, 10) : undefined;
  const l3ThreshNum = envL3Thresh ? parseInt(envL3Thresh, 10) : undefined;
  const maxAgeNum = envMaxAge ? parseFloat(envMaxAge) : undefined;
  const batchLimNum = envBatchLim ? parseInt(envBatchLim, 10) : undefined;
  const synthTimeoutNum = envSynthTimeout ? parseInt(envSynthTimeout, 10) : undefined;

  const currentBin = cfg.cormBin || "";
  const resolvedBin = (currentBin === "" && typeof envBin === "string" && envBin.trim() !== "") ? envBin.trim() : currentBin;

  return {
    cormBin: resolvedBin,
    cormdBin: cfg.cormdBin ?? (typeof envCormd === "string" && envCormd.trim() !== "" ? envCormd.trim() : undefined),
    axisLibs: cfg.axisLibs === null && typeof envLibs === "string" && envLibs.trim() !== "" ? envLibs.trim() : cfg.axisLibs,
    memDir: cfg.memDir,
    scanLimit: cfg.scanLimit,
    advancedTools: typeof envAdv === "string" ? (envAdv === "1" || envAdv === "true") : cfg.advancedTools,
    embedUrl: cfg.embedUrl ?? (typeof envUrl === "string" && envUrl.trim() !== "" ? envUrl.trim() : undefined),
    embedModel: cfg.embedModel ?? (typeof envModel === "string" && envModel.trim() !== "" ? envModel.trim() : undefined),
    embedKey: cfg.embedKey ?? (typeof envKey === "string" && envKey.trim() !== "" ? envKey.trim() : undefined),
    semanticSearch: semSearch,
    captureMode: capMode,
    captureKeyword: capKeyword,
    captureKeywords: capKeywords,
    judgeMode: jMode,
    judgeUrl: cfg.judgeUrl ?? (typeof envJUrl === "string" && envJUrl.trim() !== "" ? envJUrl.trim() : undefined),
    judgeModel: cfg.judgeModel ?? (typeof envJModel === "string" && envJModel.trim() !== "" ? envJModel.trim() : undefined),
    judgeKey: cfg.judgeKey ?? (typeof envJKey === "string" && envJKey.trim() !== "" ? envJKey.trim() : undefined),
    judgeTimeoutMs: timeoutNum && !isNaN(timeoutNum) && timeoutNum > 0 ? timeoutNum : cfg.judgeTimeoutMs,
    judgeFallback: jFallback,
    consolidateL2Threshold: l2ThreshNum && !isNaN(l2ThreshNum) && l2ThreshNum > 0 ? l2ThreshNum : cfg.consolidateL2Threshold,
    consolidateL3Threshold: l3ThreshNum && !isNaN(l3ThreshNum) && l3ThreshNum > 0 ? l3ThreshNum : cfg.consolidateL3Threshold,
    consolidateMaxAgeHours: maxAgeNum && !isNaN(maxAgeNum) && maxAgeNum > 0 ? maxAgeNum : cfg.consolidateMaxAgeHours,
    consolidateBatchLimit: batchLimNum && !isNaN(batchLimNum) && batchLimNum > 0 ? batchLimNum : cfg.consolidateBatchLimit,
    synthUrl: cfg.synthUrl ?? (typeof defaultSynthUrl === "string" && defaultSynthUrl.trim() !== "" ? defaultSynthUrl.trim() : undefined),
    synthModel: cfg.synthModel ?? (typeof defaultSynthModel === "string" && defaultSynthModel.trim() !== "" ? defaultSynthModel.trim() : undefined),
    synthKey: cfg.synthKey ?? (typeof defaultSynthKey === "string" && defaultSynthKey.trim() !== "" ? defaultSynthKey.trim() : undefined),
    synthTimeoutMs: synthTimeoutNum && !isNaN(synthTimeoutNum) && synthTimeoutNum > 0 ? synthTimeoutNum : cfg.synthTimeoutMs,
    ephemeralSepal,
  };
}

export function sepalConfigured(cfg: MmConfig): boolean {
  if (cfg.semanticSearch === false) return false;
  return typeof cfg.embedUrl === "string" && cfg.embedUrl.trim() !== "" &&
    typeof cfg.embedModel === "string" && cfg.embedModel.trim() !== "";
}

export function judgeConfigured(cfg: MmConfig): boolean {
  if (cfg.captureMode === "off") return false;
  return typeof cfg.judgeUrl === "string" && cfg.judgeUrl.trim() !== "";
}

export function synthConfigured(cfg: MmConfig): boolean {
  return typeof cfg.synthUrl === "string" && cfg.synthUrl.trim() !== "" &&
         typeof cfg.synthModel === "string" && cfg.synthModel.trim() !== "";
}

export function describeCapabilities(cfg: MmConfig): string {
  const parts: string[] = [];
  const cap = cfg.captureMode ?? (cfg.judgeUrl ? "judge" : "all");
  if (cap === "off") {
    parts.push("capture=off");
  } else if (cap === "keyword") {
    parts.push(`capture=keyword ("${cfg.captureKeyword ?? "@remember"}")`);
  } else if (cap === "judge") {
    parts.push(`capture=judge (systemone @ ${cfg.judgeUrl || "unconfigured"}, fallback: ${cfg.judgeFallback ?? "skip"})`);
  } else {
    parts.push("capture=all");
  }

  if (cfg.judgeMode === "heuristic" || (!cfg.judgeUrl && cap === "all")) {
    parts.push("judge=heuristic (explicit)");
  }

  if (!sepalConfigured(cfg)) {
    parts.push(`semantic=disabled (${cfg.semanticSearch === false ? "explicitly disabled" : "unconfigured"})`);
  } else {
    parts.push(`semantic=enabled (${cfg.embedModel ?? "model"} @ ${cfg.embedUrl})`);
  }

  parts.push("lemma=active (FTS)");
  return `pi-mm: ${parts.join(", ")}`;
}

export function resolveCormBin(
  cfg: MmConfig,
  cwd: string,
  pathDirs: string[],
  probe: (p: string) => boolean,
): CormResolution {
  const currentBin = cfg.cormBin || "";
  if (currentBin !== "") return { source: "settings", path: currentBin };
  for (const dir of pathDirs) {
    const candidateCorm = join(dir, "corm");
    if (probe(candidateCorm)) return { source: "path", path: candidateCorm };
  }
  const inSiteCorm = join(cwd, "external", "libcorm", "bin", "corm");
  if (probe(inSiteCorm)) return { source: "insite", path: inSiteCorm };
  return { source: "none", path: "" };
}

export function resolveCormdBin(
  cfg: MmConfig,
  cwd: string,
  pathDirs: string[],
  probe: (p: string) => boolean,
): CormResolution {
  if (cfg.cormdBin && cfg.cormdBin !== "") return { source: "settings", path: cfg.cormdBin };
  const currentBin = cfg.cormBin || "";
  if (currentBin !== "") {
    const cdir = join(currentBin, "..");
    const alongside = join(cdir, "cormd");
    if (probe(alongside)) return { source: "insite", path: alongside };
  }
  for (const dir of pathDirs) {
    const candidateCormd = join(dir, "cormd");
    if (probe(candidateCormd)) return { source: "path", path: candidateCormd };
  }
  const inSiteCormd = join(cwd, "external", "libcorm", "bin", "cormd");
  if (probe(inSiteCormd)) return { source: "insite", path: inSiteCormd };
  return { source: "none", path: "" };
}

export function resolveAxisPath(cfg: MmConfig, cwd: string): string {
  if (cfg.axisLibs !== null) return cfg.axisLibs;
  const joint = join(cwd, "external", "libjoint", "lib");
  const lemma = join(cwd, "external", "liblemma", "lib");
  const islet = join(cwd, "external", "libislet", "lib");
  const base = `${joint}:${lemma}:${islet}`;
  if (sepalConfigured(cfg)) {
    return `${base}:${join(cwd, "external", "libsepal", "lib")}`;
  }
  return base;
}

export function runtimeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (typeof process !== "undefined" && process?.env) {
    Object.assign(env, process.env);
  }
  if (typeof Deno !== "undefined" && Deno?.env) {
    Object.assign(env, Deno.env.toObject());
  }
  return env;
}

export async function readMmConfig(cwd: string, env: Record<string, string | undefined> = {}): Promise<MmConfig> {
  let raw: unknown;
  try {
    const text = await readFile(join(cwd, ".pi", "settings.json"), "utf8");
    const parsed: unknown = JSON.parse(text);
    raw = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["pi-mm"]
      : undefined;
  } catch {
    raw = undefined;
  }
  return applyEnv(loadConfig(raw), { ...runtimeEnv(), ...env });
}

export function resolveAdvancedTools(cwd = "."): boolean {
  const env = runtimeEnv();
  const envAdv = env["PI_MM_ADVANCED_TOOLS"];
  if (typeof envAdv === "string") {
    return envAdv === "1" || envAdv === "true";
  }
  try {
    const text = readFileSync(join(cwd, ".pi", "settings.json"), "utf8");
    const parsed = JSON.parse(text);
    const mm = parsed?.["pi-mm"] ?? parsed?.["mm"];
    if (typeof mm?.advancedTools === "boolean") return mm.advancedTools;
  } catch {
    // Non-blocking fallback
  }
  return false;
}