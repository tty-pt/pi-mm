import type { MmConfig } from "../config.ts";
import { captureMinMargin, captureMinSimilarity, judgeConfigured } from "../config.ts";
import { CAPTURE_EXEMPLARS, CAPTURE_KINDS } from "./capture-exemplars.ts";
import { gate, mergeExemplars, nearestExemplar } from "./nearest.ts";
import { debugLog } from "../debug.ts";
import type { JudgeAction, JudgeDecision, JudgeResult } from "./types.ts";

export interface MmHealthReport {
  judgeOk: boolean;
  judgeEndpoint: string;
  judgeLatencyMs: number;
  judgeModels?: string[];
  judgeError?: string;
  embedOk?: boolean;
  embedEndpoint?: string;
  embedLatencyMs?: number;
  embedError?: string;
}

export async function checkMmHealth(cfg: MmConfig): Promise<MmHealthReport> {
  const rawUrl = (cfg.captureEmbedUrl ?? cfg.judgeUrl ?? "http://127.0.0.1:4242").trim();
  const base = rawUrl.replace(/\/+$/, "").replace(/\/api\/v1\/systemone$/, "").replace(/\/v1$/, "");
  const judgeStart = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(cfg.judgeTimeoutMs ?? 15000, 3000));

  let judgeOk = false;
  let judgeLatencyMs = 0;
  let judgeModels: string[] | undefined;
  let judgeError: string | undefined;

  try {
    const res = await fetch(`${base}/v1/models`, {
      method: "GET",
      headers: cfg.judgeKey ? { Authorization: `Bearer ${cfg.judgeKey.trim()}` } : {},
      signal: controller.signal,
    });
    judgeLatencyMs = Date.now() - judgeStart;
    if (res.ok) {
      judgeOk = true;
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data?.data)) {
        judgeModels = data.data.map((m: { id?: string }) => m.id).filter((id: unknown): id is string => typeof id === "string");
      }
    } else {
      judgeError = `HTTP ${res.status}: ${res.statusText}`;
    }
  } catch (err: unknown) {
    judgeLatencyMs = Date.now() - judgeStart;
    judgeError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  let embedOk: boolean | undefined;
  let embedLatencyMs: number | undefined;
  let embedError: string | undefined;
  const embedUrl = cfg.embedUrl?.trim();

  if (embedUrl) {
    const embedStart = Date.now();
    const embedCtrl = new AbortController();
    const embedTimer = setTimeout(() => embedCtrl.abort(), 3000);
    try {
      const res = await fetch(embedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.embedKey ? { Authorization: `Bearer ${cfg.embedKey.trim()}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.embedModel || "bge-small",
          input: "health check",
        }),
        signal: embedCtrl.signal,
      });
      embedLatencyMs = Date.now() - embedStart;
      if (res.ok) {
        embedOk = true;
      } else {
        embedOk = false;
        embedError = `HTTP ${res.status}: ${res.statusText}`;
      }
    } catch (err: unknown) {
      embedLatencyMs = Date.now() - embedStart;
      embedOk = false;
      embedError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(embedTimer);
    }
  }

  return {
    judgeOk,
    judgeEndpoint: base,
    judgeLatencyMs,
    judgeModels,
    judgeError,
    embedOk,
    embedEndpoint: embedUrl,
    embedLatencyMs,
    embedError,
  };
}

export function normalizeSystemOneUrl(baseUrlOrUrl: string): string {
  const trimmed = baseUrlOrUrl.trim();
  if (trimmed.includes("/systemone")) {
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  }
  return `${trimmed.replace(/\/+$/, "").replace(/\/api\/v1\/systemzero$/, "").replace(/\/v1$/, "")}/api/v1/systemone/`;
}

export function parseJevAnswer(data: unknown): JudgeDecision {
  if (typeof data !== "object" || data === null) {
    throw new Error("Jev response must be an object");
  }
  const obj = data as Record<string, unknown>;
  const answers = obj["answers"];
  if (typeof answers !== "object" || answers === null) {
    throw new Error("Jev response missing 'answers' object");
  }
  const aMap = answers as Record<string, unknown>;
  const memAns = aMap["memory_action"];
  if (typeof memAns !== "object" || memAns === null) {
    throw new Error("Jev response missing 'memory_action' question answer");
  }
  const memObj = memAns as Record<string, unknown>;
  const choice = memObj["choice"];
  if (typeof choice !== "string") {
    throw new Error("Jev memory_action answer missing 'choice' string");
  }
  let action: JudgeAction;
  if (choice === "yes" || choice === "remember") action = "remember";
  else if (choice === "no" || choice === "skip") action = "skip";
  else if (choice === "update") action = "update";
  else throw new Error(`Unknown Jev choice '${choice}'`);

  return { action, reason: `Parsed choice: ${choice}` };
}

export async function callLlmJudge(
  prompt: string,
  response: string,
  cfg: MmConfig,
  fetchFn: typeof fetch = globalThis.fetch,
  _threadContext?: string,
): Promise<JudgeDecision> {
  const url = cfg.judgeUrl || "";
  const endpoint = normalizeSystemOneUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.judgeTimeoutMs || 3000);

  const clippedResponse = response.length > 500 ? `${response.slice(0, 500)}...` : response;
  const payload = {
    model: cfg.judgeModel || "default",
    state: `User: ${prompt}\nAssistant: ${clippedResponse}`,
    questions: {
      memory_action: {
        type: "choice",
        instructions: "Should this turn be remembered as a permanent user preference, personal detail, or architectural invariant?",
        criteria: {
          yes: "Remember this turn",
          no: "Skip this turn",
        },
      },
    },
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.judgeKey && cfg.judgeKey.trim() !== "") {
    headers["Authorization"] = `Bearer ${cfg.judgeKey.trim()}`;
  }

  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const dec = parseJevAnswer(data);
    if (!dec.summary && (dec.action === "remember" || dec.action === "update")) {
      dec.summary = prompt.trim().slice(0, 250);
    }
    return dec;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embedding verdict on the USER prompt, or null when embeddings are unavailable. `remember`
 * needs `captureMinSimilarity` AND `captureMinMargin` over `skip`; anything weaker is `skip`
 * (a missed memory costs one @remember, a false one writes to the store).
 */
export async function classifyCaptureByEmbedding(
  prompt: string,
  cfg: MmConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<"remember" | "skip" | null> {
  const examples = mergeExemplars(CAPTURE_EXEMPLARS, cfg.captureExemplars ?? {}, CAPTURE_KINDS);
  const verdict = await nearestExemplar(cfg, examples, prompt, fetchFn);
  if (verdict === null) return null;
  return gate(verdict, {
    minSimilarity: captureMinSimilarity(cfg),
    minMargin: captureMinMargin(cfg),
    harmless: "skip",
    actionable: new Set(["remember"]),
  }) as "remember" | "skip";
}

export async function evaluateTurnWithJudge(
  prompt: string,
  response: string,
  cfg: MmConfig,
  fetchFn: typeof fetch = globalThis.fetch,
  threadContext?: string,
): Promise<JudgeResult> {
  if (cfg.captureMode === "off") {
    return {
      decision: { action: "skip", reason: "Automatic conversational capture is disabled (captureMode=off)" },
      source: "disabled",
    };
  }

  // Pure embeddings classification: fast, deterministic, ~15 ms.
  if (cfg.captureEmbed !== "off") {
    const embedded = await classifyCaptureByEmbedding(prompt, cfg, fetchFn);
    if (embedded !== null) {
      return {
        decision: {
          action: embedded,
          summary: embedded === "remember" ? prompt.trim().slice(0, 250) : undefined,
          reason: embedded === "remember" ? "Nearest remember exemplar (embeddings)" : "Nearest skip exemplar or below the remember gate (embeddings)",
        },
        source: "embed",
      };
    }
  }

  if (judgeConfigured(cfg)) {
    try {
      const decision = await callLlmJudge(prompt, response, cfg, fetchFn, threadContext);
      return {
        decision,
        source: "llm",
      };
    } catch (err: unknown) {
      debugLog("capture", "callLlmJudge failed in test/mock", { error: String(err) });
      // Fall through to deterministic fallback on error
    }
  }

  // Deterministic offline fallback
  const fallbackAction = cfg.judgeFallback === "capture" ? "remember" : "skip";
  return {
    decision: {
      action: fallbackAction,
      reason: `Embeddings unavailable; fallback is '${cfg.judgeFallback ?? "skip"}'`,
    },
    source: "fallback",
    degraded: true,
  };
}
