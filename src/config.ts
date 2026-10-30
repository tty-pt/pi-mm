import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type CaptureMode = "all" | "keyword" | "judge" | "off";
export type JudgeMode = "auto" | "heuristic" | "off";
export type JudgeProtocol = "auto" | "systemzero" | "systemone";
export type JudgeFallback = "capture" | "skip";

export interface ReinforcementConfig {
  enabled?: boolean;
  milestones?: number[];
  onSessionStart?: boolean;
  onCompaction?: boolean;
  maxTokens?: number;
  includeEnvironmentBaseline?: boolean;
}

export const DEFAULT_REINFORCEMENT_CONFIG: Required<ReinforcementConfig> = {
  enabled: true,
  milestones: [0.33, 0.66],
  onSessionStart: true,
  onCompaction: true,
  maxTokens: 180,
  includeEnvironmentBaseline: true,
};

export interface MmConfig {
  cormBin: string;
  qmapBin?: string;
  cormdBin?: string;
  socketPath?: string;
  runtimeDir?: string;
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
  judgeProtocol?: JudgeProtocol;
  judgeUrl?: string;
  judgeModel?: string;
  judgeKey?: string;
  judgeTimeoutMs?: number;
  judgeFallback?: JudgeFallback;
  /**
   * Embedding classification of conversational turns ("auto" | "off"). Independent of
   * `embedUrl`/`embedModel`, which configure the memory index (different server/model).
   */
  captureEmbed?: "auto" | "off";
  /** Embeddings server for classification; defaults to the judge url. */
  captureEmbedUrl?: string;
  /** Classification embedding model (default "bge-base"). */
  captureEmbedModel?: string;
  /** Best-vs-runner-up cosine margin a "remember" embedding verdict must clear (default 0.075). */
  captureMinMargin?: number;
  /** Minimum cosine similarity to the nearest exemplar for any verdict (default 0.6). */
  captureMinSimilarity?: number;
  /** Operator exemplars (kinds `remember` / `skip`, any language), merged with the shipped ones. */
  captureExemplars?: Record<string, string[]>;
  /**
   * Embedding classification of user prompts to detect recall intent ("auto" | "off", default "auto").
   * When enabled, prompts expressing interest in past decisions, lore, or preferences
   * proactively unlock auto-recall and receive agent tool recommendations.
   */
  recallEmbed?: "auto" | "off";
  /** Best-vs-runner-up cosine margin a "recall_past" embedding verdict must clear (default 0.08). */
  recallMinMargin?: number;
  /** Minimum cosine similarity to the nearest exemplar for a recall verdict (default 0.60). */
  recallMinSimilarity?: number;
  /** Operator exemplars (kinds `recall_past` / `standalone`, any language), merged with shipped ones. */
  recallExemplars?: Record<string, string[]>;
  /** Fallback strategy when the classifier endpoint is unreachable ("regex" | "skip", default "regex"). */
  recallFallback?: "regex" | "skip";
  /**
   * Action taken when recall intent or architectural wonder is confirmed:
   * - "hint": (default) Emit epistemic guidance to the agent via system prompt with zero database queries.
   * - "query": (legacy/enrichment) Pre-query memory database via corm/hybrid search and inject context.
   */
  recallAction?: "hint" | "query";
  /** Embedding classification of assistant turns and thoughts to detect cognitive wonderings ("auto" | "off", default "auto"). */
  wonderingEmbed?: "auto" | "off";
  wonderingMinMargin?: number;
  wonderingMinSimilarity?: number;
  /** Embedding classification of user prompts to detect standing operational directives ("auto" | "off", default "auto"). */
  directiveEmbed?: "auto" | "off";
  directiveMinMargin?: number;
  directiveMinSimilarity?: number;
  directiveExemplars?: Record<string, string[]>;
  directiveFallback?: "regex" | "skip";
  /** Embedding classification of direct memory inquiries to distinguish open-ended overviews from targeted queries ("auto" | "off", default "auto"). */
  overviewEmbed?: "auto" | "off";
  overviewMinMargin?: number;
  overviewMinSimilarity?: number;
  overviewExemplars?: Record<string, string[]>;
  overviewFallback?: "regex" | "skip";
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
  /** Start the local axil-auren server automatically when it is installed (default true). */
  autoStartAuren?: boolean;
  /** Model download policy: small models auto, large models ask once (default "ask"). */
  autoDownloadModels?: "auto" | "ask" | "never";
  reinforcement?: ReinforcementConfig;
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
  socketPath: undefined,
  runtimeDir: undefined,
  axisLibs: null,
  memDir: ".pi/mm",
  scanLimit: 10,
  advancedTools: false,
  captureMode: undefined,
  captureKeyword: "@remember",
  captureKeywords: DEFAULT_CAPTURE_KEYWORDS,
  judgeMode: "auto",
  judgeProtocol: "systemone",
  judgeModel: "olmoe",
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
  autoStartAuren: true,
  autoDownloadModels: "ask",
  recallEmbed: undefined,
  recallMinMargin: 0.08,
  recallMinSimilarity: 0.60,
  recallExemplars: undefined,
  recallFallback: "regex",
  recallAction: "query",
  wonderingEmbed: undefined,
  wonderingMinMargin: 0.08,
  wonderingMinSimilarity: 0.60,
  directiveEmbed: undefined,
  directiveMinMargin: 0.08,
  directiveMinSimilarity: 0.60,
  directiveExemplars: undefined,
  directiveFallback: "regex",
  overviewEmbed: undefined,
  overviewMinMargin: 0.08,
  overviewMinSimilarity: 0.60,
  overviewExemplars: undefined,
  overviewFallback: "regex",
  reinforcement: DEFAULT_REINFORCEMENT_CONFIG,
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
  const rawSocket = record["socketPath"];
  const socketPath = typeof rawSocket === "string" && rawSocket.trim() !== "" ? rawSocket.trim() : undefined;
  const rawRuntime = record["runtimeDir"];
  const runtimeDir = typeof rawRuntime === "string" && rawRuntime.trim() !== "" ? rawRuntime.trim() : undefined;
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
  const jProto = record["judgeProtocol"];
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
  const autoStart = record["autoStartAuren"];
  const autoDl = record["autoDownloadModels"];
  const rawReinf = record["reinforcement"];

  let parsedReinforcement: ReinforcementConfig = { ...DEFAULT_REINFORCEMENT_CONFIG };
  if (typeof rawReinf === "object" && rawReinf !== null) {
    const r = rawReinf as Record<string, unknown>;
    parsedReinforcement = {
      enabled: typeof r["enabled"] === "boolean" ? r["enabled"] : DEFAULT_REINFORCEMENT_CONFIG.enabled,
      milestones: Array.isArray(r["milestones"]) && r["milestones"].every((m) => typeof m === "number" && m > 0 && m < 1)
        ? r["milestones"].sort((a, b) => a - b)
        : DEFAULT_REINFORCEMENT_CONFIG.milestones,
      onSessionStart: typeof r["onSessionStart"] === "boolean" ? r["onSessionStart"] : DEFAULT_REINFORCEMENT_CONFIG.onSessionStart,
      onCompaction: typeof r["onCompaction"] === "boolean" ? r["onCompaction"] : DEFAULT_REINFORCEMENT_CONFIG.onCompaction,
      maxTokens: typeof r["maxTokens"] === "number" && r["maxTokens"] > 0 ? r["maxTokens"] : DEFAULT_REINFORCEMENT_CONFIG.maxTokens,
      includeEnvironmentBaseline: typeof r["includeEnvironmentBaseline"] === "boolean" ? r["includeEnvironmentBaseline"] : DEFAULT_REINFORCEMENT_CONFIG.includeEnvironmentBaseline,
    };
  }

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
    socketPath,
    runtimeDir,
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
    judgeProtocol: jProto === "systemzero" || jProto === "systemone" || jProto === "auto" ? jProto : DEFAULT_CONFIG.judgeProtocol,
    judgeUrl: typeof jUrl === "string" && jUrl.trim() !== "" ? jUrl.trim() : undefined,
    judgeModel: typeof jModel === "string" && jModel.trim() !== "" ? jModel.trim() : DEFAULT_CONFIG.judgeModel,
    judgeKey: typeof jKey === "string" && jKey.trim() !== "" ? jKey.trim() : undefined,
    judgeTimeoutMs: typeof jTimeout === "number" && jTimeout > 0 ? jTimeout : DEFAULT_CONFIG.judgeTimeoutMs,
    judgeFallback: effectiveFallback,
    captureEmbed: embedMode(record["captureEmbed"]),
    captureEmbedUrl: typeof record["captureEmbedUrl"] === "string" && record["captureEmbedUrl"].trim() !== ""
      ? record["captureEmbedUrl"].trim()
      : (typeof jUrl === "string" && jUrl.trim() !== "" ? jUrl.trim() : undefined),
    captureEmbedModel: typeof record["captureEmbedModel"] === "string" && record["captureEmbedModel"].trim() !== "" ? record["captureEmbedModel"].trim() : undefined,
    captureMinMargin: unitInterval(record["captureMinMargin"]),
    captureMinSimilarity: unitInterval(record["captureMinSimilarity"]),
    captureExemplars: parseCaptureExemplars(record["captureExemplars"]),
    recallEmbed: embedMode(record["recallEmbed"]),
    recallMinMargin: unitInterval(record["recallMinMargin"]) ?? DEFAULT_CONFIG.recallMinMargin,
    recallMinSimilarity: unitInterval(record["recallMinSimilarity"]) ?? DEFAULT_CONFIG.recallMinSimilarity,
    recallExemplars: parseRecallExemplars(record["recallExemplars"]),
    recallFallback: record["recallFallback"] === "skip" || record["recallFallback"] === "regex" ? record["recallFallback"] : DEFAULT_CONFIG.recallFallback,
    recallAction: record["recallAction"] === "query" ? "query" : "hint",
    wonderingEmbed: embedMode(record["wonderingEmbed"]),
    wonderingMinMargin: unitInterval(record["wonderingMinMargin"]) ?? 0.08,
    wonderingMinSimilarity: unitInterval(record["wonderingMinSimilarity"]) ?? 0.60,
    directiveEmbed: embedMode(record["directiveEmbed"]),
    directiveMinMargin: unitInterval(record["directiveMinMargin"]) ?? DEFAULT_CONFIG.directiveMinMargin,
    directiveMinSimilarity: unitInterval(record["directiveMinSimilarity"]) ?? DEFAULT_CONFIG.directiveMinSimilarity,
    directiveExemplars: parseDirectiveExemplars(record["directiveExemplars"]),
    directiveFallback: record["directiveFallback"] === "skip" || record["directiveFallback"] === "regex" ? record["directiveFallback"] : DEFAULT_CONFIG.directiveFallback,
    overviewEmbed: embedMode(record["overviewEmbed"]),
    overviewMinMargin: unitInterval(record["overviewMinMargin"]) ?? DEFAULT_CONFIG.overviewMinMargin,
    overviewMinSimilarity: unitInterval(record["overviewMinSimilarity"]) ?? DEFAULT_CONFIG.overviewMinSimilarity,
    overviewExemplars: parseOverviewExemplars(record["overviewExemplars"]),
    overviewFallback: record["overviewFallback"] === "skip" || record["overviewFallback"] === "regex" ? record["overviewFallback"] : DEFAULT_CONFIG.overviewFallback,
    consolidateL2Threshold: typeof l2Thresh === "number" && l2Thresh > 0 ? l2Thresh : DEFAULT_CONFIG.consolidateL2Threshold,
    consolidateL3Threshold: typeof l3Thresh === "number" && l3Thresh > 0 ? l3Thresh : DEFAULT_CONFIG.consolidateL3Threshold,
    consolidateMaxAgeHours: typeof maxAge === "number" && maxAge > 0 ? maxAge : undefined,
    consolidateBatchLimit: typeof batchLim === "number" && batchLim > 0 ? batchLim : DEFAULT_CONFIG.consolidateBatchLimit,
    synthUrl: typeof sUrl === "string" && sUrl.trim() !== "" ? sUrl.trim() : undefined,
    synthModel: typeof sModel === "string" && sModel.trim() !== "" ? sModel.trim() : undefined,
    synthKey: typeof sKey === "string" && sKey.trim() !== "" ? sKey.trim() : undefined,
    synthTimeoutMs: typeof sTimeout === "number" && sTimeout > 0 ? sTimeout : DEFAULT_CONFIG.synthTimeoutMs,
    ephemeralSepal: typeof ephem === "boolean" ? ephem : DEFAULT_CONFIG.ephemeralSepal,
    autoStartAuren: typeof autoStart === "boolean" ? autoStart : DEFAULT_CONFIG.autoStartAuren,
    autoDownloadModels: autoDl === "auto" || autoDl === "ask" || autoDl === "never" ? autoDl : DEFAULT_CONFIG.autoDownloadModels,
    reinforcement: parsedReinforcement,
  };
}

export function applyEnv(cfg: MmConfig, env: Record<string, string | undefined>): MmConfig {
  const envBin = env["CORM_BIN"];
  const envCormd = env["CORMD_BIN"];
  const envSocket = env["PI_MM_SOCKET"] ?? env["MM_SOCKET"];
  const envRuntimeDir = env["PI_MM_RUNTIME_DIR"] ?? env["MM_RUNTIME_DIR"];
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
  const envJProto = env["PI_MM_JUDGE_PROTOCOL"] ?? env["MM_JUDGE_PROTOCOL"];
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

  // Auren endpoint fallback
  const aurenBase = env["AUREN_URL"];
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
    const aurenModel = env["AUREN_MODEL"];
    const aurenKey = env["AUREN_KEY"];
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

  let autoStartAuren = cfg.autoStartAuren;
  const envAutoStart = env["PI_MM_AUTO_START_AUREN"];
  if (envAutoStart !== undefined) autoStartAuren = !(envAutoStart === "0" || envAutoStart === "false");
  let autoDownloadModels = cfg.autoDownloadModels;
  const envAutoDl = env["PI_MM_AUTO_DOWNLOAD_MODELS"];
  if (envAutoDl === "auto" || envAutoDl === "ask" || envAutoDl === "never") autoDownloadModels = envAutoDl;

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
    socketPath: cfg.socketPath ?? (typeof envSocket === "string" && envSocket.trim() !== "" ? envSocket.trim() : undefined),
    runtimeDir: cfg.runtimeDir ?? (typeof envRuntimeDir === "string" && envRuntimeDir.trim() !== "" ? envRuntimeDir.trim() : undefined),
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
    judgeProtocol: envJProto === "systemzero" || envJProto === "systemone" || envJProto === "auto" ? envJProto : cfg.judgeProtocol,
    judgeUrl: cfg.judgeUrl ?? (typeof envJUrl === "string" && envJUrl.trim() !== "" ? envJUrl.trim() : undefined),
    judgeModel: cfg.judgeModel ?? (typeof envJModel === "string" && envJModel.trim() !== "" ? envJModel.trim() : undefined),
    judgeKey: cfg.judgeKey ?? (typeof envJKey === "string" && envJKey.trim() !== "" ? envJKey.trim() : undefined),
    judgeTimeoutMs: timeoutNum && !isNaN(timeoutNum) && timeoutNum > 0 ? timeoutNum : cfg.judgeTimeoutMs,
    judgeFallback: jFallback,
    captureEmbed: cfg.captureEmbed ?? embedMode(env["PI_MM_CAPTURE_EMBED"] ?? env["MM_CAPTURE_EMBED"]),
    captureEmbedUrl: cfg.captureEmbedUrl ?? (env["PI_MM_CAPTURE_EMBED_URL"]?.trim() || undefined),
    captureEmbedModel: cfg.captureEmbedModel ?? (env["PI_MM_CAPTURE_EMBED_MODEL"]?.trim() || undefined),
    captureMinMargin: cfg.captureMinMargin ?? unitInterval(env["PI_MM_CAPTURE_MIN_MARGIN"] ?? env["MM_CAPTURE_MIN_MARGIN"]),
    captureMinSimilarity: cfg.captureMinSimilarity ?? unitInterval(env["PI_MM_CAPTURE_MIN_SIMILARITY"] ?? env["MM_CAPTURE_MIN_SIMILARITY"]),
    captureExemplars: cfg.captureExemplars,
    recallEmbed: embedMode(env["PI_MM_RECALL_EMBED"] ?? env["MM_RECALL_EMBED"]) ?? cfg.recallEmbed,
    recallMinMargin: unitInterval(env["PI_MM_RECALL_MIN_MARGIN"] ?? env["MM_RECALL_MIN_MARGIN"]) ?? cfg.recallMinMargin,
    recallMinSimilarity: unitInterval(env["PI_MM_RECALL_MIN_SIMILARITY"] ?? env["MM_RECALL_MIN_SIMILARITY"]) ?? cfg.recallMinSimilarity,
    recallExemplars: cfg.recallExemplars,
    recallFallback: (env["PI_MM_RECALL_FALLBACK"] === "skip" || env["PI_MM_RECALL_FALLBACK"] === "regex"
      ? env["PI_MM_RECALL_FALLBACK"]
      : (env["MM_RECALL_FALLBACK"] === "skip" || env["MM_RECALL_FALLBACK"] === "regex" ? env["MM_RECALL_FALLBACK"] : cfg.recallFallback)),
    recallAction: (env["PI_MM_RECALL_ACTION"] === "hint" || env["PI_MM_RECALL_ACTION"] === "query"
      ? env["PI_MM_RECALL_ACTION"]
      : (env["MM_RECALL_ACTION"] === "hint" || env["MM_RECALL_ACTION"] === "query" ? env["MM_RECALL_ACTION"] : cfg.recallAction)),
    wonderingEmbed: embedMode(env["PI_MM_WONDERING_EMBED"] ?? env["MM_WONDERING_EMBED"]) ?? cfg.wonderingEmbed,
    wonderingMinMargin: unitInterval(env["PI_MM_WONDERING_MIN_MARGIN"] ?? env["MM_WONDERING_MIN_MARGIN"]) ?? cfg.wonderingMinMargin,
    wonderingMinSimilarity: unitInterval(env["PI_MM_WONDERING_MIN_SIMILARITY"] ?? env["MM_WONDERING_MIN_SIMILARITY"]) ?? cfg.wonderingMinSimilarity,
    directiveEmbed: embedMode(env["PI_MM_DIRECTIVE_EMBED"] ?? env["MM_DIRECTIVE_EMBED"]) ?? cfg.directiveEmbed,
    directiveMinMargin: unitInterval(env["PI_MM_DIRECTIVE_MIN_MARGIN"] ?? env["MM_DIRECTIVE_MIN_MARGIN"]) ?? cfg.directiveMinMargin,
    directiveMinSimilarity: unitInterval(env["PI_MM_DIRECTIVE_MIN_SIMILARITY"] ?? env["MM_DIRECTIVE_MIN_SIMILARITY"]) ?? cfg.directiveMinSimilarity,
    directiveExemplars: cfg.directiveExemplars,
    directiveFallback: (env["PI_MM_DIRECTIVE_FALLBACK"] === "skip" || env["PI_MM_DIRECTIVE_FALLBACK"] === "regex"
      ? env["PI_MM_DIRECTIVE_FALLBACK"]
      : (env["MM_DIRECTIVE_FALLBACK"] === "skip" || env["MM_DIRECTIVE_FALLBACK"] === "regex" ? env["MM_DIRECTIVE_FALLBACK"] : cfg.directiveFallback)),
    overviewEmbed: embedMode(env["PI_MM_OVERVIEW_EMBED"] ?? env["MM_OVERVIEW_EMBED"]) ?? cfg.overviewEmbed,
    overviewMinMargin: unitInterval(env["PI_MM_OVERVIEW_MIN_MARGIN"] ?? env["MM_OVERVIEW_MIN_MARGIN"]) ?? cfg.overviewMinMargin,
    overviewMinSimilarity: unitInterval(env["PI_MM_OVERVIEW_MIN_SIMILARITY"] ?? env["MM_OVERVIEW_MIN_SIMILARITY"]) ?? cfg.overviewMinSimilarity,
    overviewExemplars: cfg.overviewExemplars,
    overviewFallback: (env["PI_MM_OVERVIEW_FALLBACK"] === "skip" || env["PI_MM_OVERVIEW_FALLBACK"] === "regex"
      ? env["PI_MM_OVERVIEW_FALLBACK"]
      : (env["MM_OVERVIEW_FALLBACK"] === "skip" || env["MM_OVERVIEW_FALLBACK"] === "regex" ? env["MM_OVERVIEW_FALLBACK"] : cfg.overviewFallback)),
    consolidateL2Threshold: l2ThreshNum && !isNaN(l2ThreshNum) && l2ThreshNum > 0 ? l2ThreshNum : cfg.consolidateL2Threshold,
    consolidateL3Threshold: l3ThreshNum && !isNaN(l3ThreshNum) && l3ThreshNum > 0 ? l3ThreshNum : cfg.consolidateL3Threshold,
    consolidateMaxAgeHours: maxAgeNum && !isNaN(maxAgeNum) && maxAgeNum > 0 ? maxAgeNum : cfg.consolidateMaxAgeHours,
    consolidateBatchLimit: batchLimNum && !isNaN(batchLimNum) && batchLimNum > 0 ? batchLimNum : cfg.consolidateBatchLimit,
    synthUrl: cfg.synthUrl ?? (typeof defaultSynthUrl === "string" && defaultSynthUrl.trim() !== "" ? defaultSynthUrl.trim() : undefined),
    synthModel: cfg.synthModel ?? (typeof defaultSynthModel === "string" && defaultSynthModel.trim() !== "" ? defaultSynthModel.trim() : undefined),
    synthKey: cfg.synthKey ?? (typeof defaultSynthKey === "string" && defaultSynthKey.trim() !== "" ? defaultSynthKey.trim() : undefined),
    synthTimeoutMs: synthTimeoutNum && !isNaN(synthTimeoutNum) && synthTimeoutNum > 0 ? synthTimeoutNum : cfg.synthTimeoutMs,
    ephemeralSepal,
    autoStartAuren,
    autoDownloadModels,
  };
}

export function sepalConfigured(cfg: MmConfig): boolean {
  if (cfg.semanticSearch === false) return false;
  return typeof cfg.embedUrl === "string" && cfg.embedUrl.trim() !== "" &&
    typeof cfg.embedModel === "string" && cfg.embedModel.trim() !== "";
}

export const DEFAULT_CAPTURE_MIN_MARGIN = 0.075;
export const DEFAULT_CAPTURE_MIN_SIMILARITY = 0.6;

export const DEFAULT_RECALL_MIN_MARGIN = 0.08;
export const DEFAULT_RECALL_MIN_SIMILARITY = 0.60;
export const DEFAULT_RECALL_FALLBACK = "regex";
export const DEFAULT_RECALL_ACTION = "hint";

export function recallAction(cfg: MmConfig): "hint" | "query" {
  return cfg.recallAction ?? DEFAULT_RECALL_ACTION;
}

export function captureMinMargin(cfg: MmConfig): number {
  return cfg.captureMinMargin ?? DEFAULT_CAPTURE_MIN_MARGIN;
}

export function captureMinSimilarity(cfg: MmConfig): number {
  return cfg.captureMinSimilarity ?? DEFAULT_CAPTURE_MIN_SIMILARITY;
}

export function recallEmbed(cfg: MmConfig): "auto" | "off" {
  return cfg.recallEmbed ?? "auto";
}

export function recallMinMargin(cfg: MmConfig): number {
  return cfg.recallMinMargin ?? DEFAULT_RECALL_MIN_MARGIN;
}

export function recallMinSimilarity(cfg: MmConfig): number {
  return cfg.recallMinSimilarity ?? DEFAULT_RECALL_MIN_SIMILARITY;
}

export function recallFallback(cfg: MmConfig): "regex" | "skip" {
  return cfg.recallFallback ?? DEFAULT_RECALL_FALLBACK;
}

export const DEFAULT_DIRECTIVE_MIN_MARGIN = 0.08;
export const DEFAULT_DIRECTIVE_MIN_SIMILARITY = 0.60;
export const DEFAULT_DIRECTIVE_FALLBACK = "regex";

export const DEFAULT_OVERVIEW_MIN_MARGIN = 0.08;
export const DEFAULT_OVERVIEW_MIN_SIMILARITY = 0.60;
export const DEFAULT_OVERVIEW_FALLBACK = "regex";

export function directiveEmbed(cfg: MmConfig): "auto" | "off" {
  return cfg.directiveEmbed ?? "auto";
}

export function directiveMinMargin(cfg: MmConfig): number {
  return cfg.directiveMinMargin ?? DEFAULT_DIRECTIVE_MIN_MARGIN;
}

export function directiveMinSimilarity(cfg: MmConfig): number {
  return cfg.directiveMinSimilarity ?? DEFAULT_DIRECTIVE_MIN_SIMILARITY;
}

export function directiveFallback(cfg: MmConfig): "regex" | "skip" {
  return cfg.directiveFallback ?? DEFAULT_DIRECTIVE_FALLBACK;
}

export function overviewEmbed(cfg: MmConfig): "auto" | "off" {
  return cfg.overviewEmbed ?? "auto";
}

export function overviewMinMargin(cfg: MmConfig): number {
  return cfg.overviewMinMargin ?? DEFAULT_OVERVIEW_MIN_MARGIN;
}

export function overviewMinSimilarity(cfg: MmConfig): number {
  return cfg.overviewMinSimilarity ?? DEFAULT_OVERVIEW_MIN_SIMILARITY;
}

export function overviewFallback(cfg: MmConfig): "regex" | "skip" {
  return cfg.overviewFallback ?? DEFAULT_OVERVIEW_FALLBACK;
}

function parseDirectiveExemplars(raw: unknown): Record<string, string[]> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const kind of ["standing_directive", "transient_task"]) {
    const list = (raw as Record<string, unknown>)[kind];
    if (!Array.isArray(list)) continue;
    const items = list.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    if (items.length > 0) out[kind] = items;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseOverviewExemplars(raw: unknown): Record<string, string[]> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const kind of ["overview_query", "specific_query"]) {
    const list = (raw as Record<string, unknown>)[kind];
    if (!Array.isArray(list)) continue;
    const items = list.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    if (items.length > 0) out[kind] = items;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function unitInterval(raw: unknown): number | undefined {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

function embedMode(raw: unknown): "auto" | "off" | undefined {
  return raw === "auto" || raw === "off" ? raw : undefined;
}

function parseCaptureExemplars(raw: unknown): Record<string, string[]> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const kind of ["remember", "skip"]) {
    const list = (raw as Record<string, unknown>)[kind];
    if (!Array.isArray(list)) continue;
    const items = list.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    if (items.length > 0) out[kind] = items;
  }
  return out;
}

function parseRecallExemplars(raw: unknown): Record<string, string[]> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const kind of ["recall_past", "standalone"]) {
    const list = (raw as Record<string, unknown>)[kind];
    if (!Array.isArray(list)) continue;
    const items = list.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    if (items.length > 0) out[kind] = items;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    const target = cfg.captureEmbedUrl || cfg.judgeUrl || "unconfigured";
    parts.push(`capture=embed (/v1/classify @ ${target}, fallback: ${cfg.judgeFallback ?? "skip"})`);
  } else {
    parts.push("capture=all");
  }

  if (recallEmbed(cfg) !== "off") {
    const target = cfg.captureEmbedUrl || cfg.judgeUrl || "unconfigured";
    parts.push(`recall=embed (/v1/classify @ ${target}, fallback: ${cfg.recallFallback ?? "regex"})`);
  } else {
    parts.push("recall=regex");
  }

  if (directiveEmbed(cfg) !== "off") {
    const target = cfg.captureEmbedUrl || cfg.judgeUrl || "unconfigured";
    parts.push(`directive=embed (/v1/classify @ ${target}, fallback: ${cfg.directiveFallback ?? "regex"})`);
  } else {
    parts.push("directive=regex");
  }

  if (overviewEmbed(cfg) !== "off") {
    const target = cfg.captureEmbedUrl || cfg.judgeUrl || "unconfigured";
    parts.push(`overview=embed (/v1/classify @ ${target}, fallback: ${cfg.overviewFallback ?? "regex"})`);
  } else {
    parts.push("overview=regex");
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

export function resolveSocketPath(cfg: MmConfig, memDir: string): string {
  // 1. Explicit socket path (setting or env)
  if (cfg.socketPath && cfg.socketPath.trim() !== "") {
    return cfg.socketPath.trim();
  }

  // 2. Explicit runtime directory (setting or env)
  if (cfg.runtimeDir && cfg.runtimeDir.trim() !== "") {
    const hash = createHash("sha256").update(memDir).digest("hex").slice(0, 12);
    return join(cfg.runtimeDir.trim(), `cormd-${hash}.sock`);
  }

  // 3. Auto-fallback for filesystems lacking AF_UNIX support (e.g. WSL DrvFs /mnt/*)
  if (memDir.startsWith("/mnt/")) {
    const env = runtimeEnv();
    const fallbackBase = env["XDG_RUNTIME_DIR"] || "/tmp";
    const hash = createHash("sha256").update(memDir).digest("hex").slice(0, 12);
    return join(fallbackBase, "pi-mm", `cormd-${hash}.sock`);
  }

  // 4. Default: inside memDir
  return join(memDir, "cormd.sock");
}

export function resolveAxisPath(
  cfg: MmConfig,
  cwd: string,
  probe: (p: string) => boolean = existsSync,
): string {
  if (cfg.axisLibs !== null) return cfg.axisLibs;

  const env = runtimeEnv();
  const envAxis = env["CORM_AXIS_PATH"] ?? env["CORM_AXIS_LIBS"];
  if (envAxis && envAxis.trim() !== "") return envAxis.trim();

  // 1. If project has local monorepo external/lib* checkouts, prefer them
  const localJoint = join(cwd, "external", "libjoint", "lib");
  if (probe(localJoint)) {
    const lemma = join(cwd, "external", "liblemma", "lib");
    const islet = join(cwd, "external", "libislet", "lib");
    let base = `${localJoint}:${lemma}:${islet}`;
    if (sepalConfigured(cfg)) {
      base += `:${join(cwd, "external", "libsepal", "lib")}`;
    }
    return base;
  }

  // 2. System-wide library directories (standard system installation)
  const systemCandidates = [
    "/usr/lib/ttypt",
    "/usr/local/lib/ttypt",
    "/usr/lib",
    "/usr/local/lib",
    "/lib",
    "/usr/lib64",
  ];
  for (const dir of systemCandidates) {
    if (
      probe(join(dir, "libjoint.so")) ||
      probe(join(dir, "libjoint.dylib")) ||
      probe(join(dir, "libjoint.dll"))
    ) {
      return dir;
    }
  }

  // 3. Fallback: if nothing exists, default to local monorepo path
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

/**
 * Extract pi-mm or mm configuration object from parsed JSON.
 */
export function extractMmRaw(parsed: unknown): Record<string, unknown> | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;
  const raw = rec["pi-mm"] ?? rec["mm"];
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

/**
 * Merge two raw config objects with override precedence (overrides win).
 */
export function mergeRawConfigs(
  base?: Record<string, unknown>,
  overrides?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!base && !overrides) return undefined;
  if (!base) return overrides;
  if (!overrides) return base;
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(overrides)) {
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Candidate file paths for global settings.
 * Checks in precedence order:
 * 1. PI_SETTINGS_PATH (if set)
 * 2. PI_CODING_AGENT_DIR/settings.json (if PI_CODING_AGENT_DIR set)
 * 3. ~/.pi/agent/settings.json (standard global settings)
 * 4. ~/.pi/settings.json (fallback user settings)
 */
export function resolveGlobalSettingsPaths(env: Record<string, string | undefined> = runtimeEnv()): string[] {
  const paths: string[] = [];
  if (env["PI_SETTINGS_PATH"]) {
    paths.push(env["PI_SETTINGS_PATH"]);
  }
  const agentDir = env["PI_CODING_AGENT_DIR"];
  if (agentDir) {
    paths.push(join(agentDir, "settings.json"));
  }
  try {
    const home = env["HOME"] || env["USERPROFILE"] || homedir();
    if (home) {
      paths.push(join(home, ".pi", "agent", "settings.json"));
      paths.push(join(home, ".pi", "settings.json"));
    }
  } catch {
    const home = env["HOME"] || env["USERPROFILE"] || "";
    if (home) {
      paths.push(join(home, ".pi", "agent", "settings.json"));
      paths.push(join(home, ".pi", "settings.json"));
    }
  }
  return Array.from(new Set(paths));
}

export async function readSettingsFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    return extractMmRaw(parsed);
  } catch {
    return undefined;
  }
}

export function readSettingsFileSync(filePath: string): Record<string, unknown> | undefined {
  try {
    const text = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    return extractMmRaw(parsed);
  } catch {
    return undefined;
  }
}

export async function readMmConfig(cwd: string, env: Record<string, string | undefined> = {}): Promise<MmConfig> {
  const mergedEnv = { ...runtimeEnv(), ...env };
  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  const projectRaw = await readSettingsFile(projectSettingsPath);

  let globalRaw: Record<string, unknown> | undefined;
  const globalCandidates = resolveGlobalSettingsPaths(mergedEnv);
  for (let i = globalCandidates.length - 1; i >= 0; i--) {
    const candidate = globalCandidates[i];
    if (candidate === projectSettingsPath) continue;
    const raw = await readSettingsFile(candidate);
    if (raw) {
      globalRaw = mergeRawConfigs(globalRaw, raw);
    }
  }

  const effectiveRaw = mergeRawConfigs(globalRaw, projectRaw);
  return applyEnv(loadConfig(effectiveRaw), mergedEnv);
}

export function resolveAdvancedTools(
  cwd = ".",
  env: Record<string, string | undefined> = runtimeEnv(),
): boolean {
  const envAdv = env["PI_MM_ADVANCED_TOOLS"];
  if (typeof envAdv === "string") {
    return envAdv === "1" || envAdv === "true";
  }

  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  const projectRaw = readSettingsFileSync(projectSettingsPath);
  if (typeof projectRaw?.["advancedTools"] === "boolean") {
    return projectRaw["advancedTools"] as boolean;
  }

  const globalCandidates = resolveGlobalSettingsPaths(env);
  for (const candidate of globalCandidates) {
    if (candidate === projectSettingsPath) continue;
    const globalRaw = readSettingsFileSync(candidate);
    if (typeof globalRaw?.["advancedTools"] === "boolean") {
      return globalRaw["advancedTools"] as boolean;
    }
  }

  return false;
}