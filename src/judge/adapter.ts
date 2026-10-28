import type { MmConfig } from "../config.ts";
import { captureMinMargin, captureMinSimilarity } from "../config.ts";
import { CAPTURE_EXEMPLARS, CAPTURE_KINDS } from "./capture-exemplars.ts";
import { gate, mergeExemplars, nearestExemplar } from "./nearest.ts";
import type { JudgeResult } from "./types.ts";

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
  _response: string,
  cfg: MmConfig,
  fetchFn: typeof fetch = globalThis.fetch,
  _threadContext?: string,
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

  // Deterministic offline fallback (no generative LLM execution)
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
