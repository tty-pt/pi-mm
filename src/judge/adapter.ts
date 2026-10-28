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
  const rawUrl = cfg.judgeUrl ? cfg.judgeUrl.trim() : "http://127.0.0.1:4242";
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

export function normalizeSystemZeroUrl(baseUrlOrUrl: string): string {
  const trimmed = baseUrlOrUrl.trim();
  if (trimmed.includes("/systemzero")) {
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  }
  return `${trimmed.replace(/\/+$/, "").replace(/\/api\/v1\/systemone$/, "").replace(/\/v1$/, "")}/api/v1/systemzero/`;
}

export async function callSystemZeroJudge(
  prompt: string,
  response: string,
  cfg: MmConfig,
  fetchFn: typeof fetch = globalThis.fetch,
  threadContext?: string,
): Promise<JudgeDecision> {
  const rawUrl = cfg.judgeUrl;
  if (!rawUrl) throw new Error("No judgeUrl configured");

  const url = normalizeSystemZeroUrl(rawUrl);
  const timeoutMs = cfg.judgeTimeoutMs ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.judgeKey) {
    headers["Authorization"] = `Bearer ${cfg.judgeKey}`;
  }

  const clippedResponse = response.length > 500 ? response.slice(0, 500) + "..." : response;
  const stateText = threadContext
    ? `${threadContext}\nCurrent User: ${prompt}\nCurrent Assistant: ${clippedResponse}`
    : `User: ${prompt}\nAssistant: ${clippedResponse}`;

  const reqBody = {
    model: cfg.judgeModel || "default",
    prompt: `Is this user-provided information meaningful personal facts, experiences, preferences, technical discoveries, or decisions worth remembering for future conversations (versus casual chitchat or questions)?\n${stateText}\nAnswer [y/n]:`,
    threshold: 0.5,
  };

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`SystemZero HTTP error ${res.status}: ${res.statusText}${errText ? ` - ${errText.slice(0, 100)}` : ""}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const decision = data["decision"];
    if (typeof decision !== "boolean" && data["choice"] === undefined) {
      throw new Error(`Invalid SystemZero response: expected boolean 'decision' or string 'choice'`);
    }
    const action: JudgeAction = decision === true || String(data["choice"]).toLowerCase() === "y" || String(data["choice"]).toLowerCase() === "yes" || String(data["choice"]).toLowerCase() === "remember" ? "remember" : "skip";
    return {
      action,
      summary: prompt.trim().slice(0, 250),
      reason: `SystemZero decision: ${action} (p=${data["probability"]})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeJevUrl(baseUrlOrUrl: string): string {
  const trimmed = baseUrlOrUrl.trim();
  if (trimmed.includes("/systemone")) {
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  }
  return `${trimmed.replace(/\/+$/, "")}/api/v1/systemone/`;
}

export function parseJevAction(data: unknown): JudgeAction {
  if (typeof data !== "object" || data === null) {
    throw new Error("Jev response must be an object");
  }
  const rec = data as Record<string, unknown>;
  let answerVal: unknown;

  // 1. Primary documented path: answers.memory_action.choice
  if (typeof rec.answers === "object" && rec.answers !== null && !Array.isArray(rec.answers)) {
    const ansObj = rec.answers as Record<string, unknown>;
    const memAction = ansObj["memory_action"] ?? ansObj["action"] ?? Object.values(ansObj)[0];
    if (typeof memAction === "object" && memAction !== null) {
      const objVal = memAction as Record<string, unknown>;
      answerVal = objVal["choice"] ?? objVal["answer"] ?? objVal["value"];
    } else {
      answerVal = memAction;
    }
  }

  // 2. Defensive fallback: array answers
  if (answerVal === undefined && Array.isArray(rec.answers)) {
    const list = rec.answers;
    if (list.length === 0) {
      throw new Error("Jev response contains empty answers list");
    }
    const matched = list.find(
      (a: unknown) =>
        typeof a === "object" && a !== null &&
        ((a as Record<string, unknown>).id === "memory_action" || (a as Record<string, unknown>).question_id === "memory_action"),
    );
    if (matched && typeof matched === "object") {
      const matchRec = matched as Record<string, unknown>;
      answerVal = matchRec.choice ?? matchRec.answer ?? matchRec.value;
    } else if (typeof list[0] === "string") {
      answerVal = list[0];
    } else if (typeof list[0] === "object" && list[0] !== null) {
      const firstRec = list[0] as Record<string, unknown>;
      answerVal = firstRec.choice ?? firstRec.answer ?? firstRec.value;
    }
  }

  if (typeof answerVal !== "string") {
    throw new Error(`Jev response missing choice answer: ${JSON.stringify(data).slice(0, 100)}`);
  }

  const normalized = answerVal.trim().toLowerCase();
  if (normalized === "yes" || normalized === "remember" || normalized.startsWith("yes")) {
    return "remember";
  }
  if (normalized === "update" || normalized.startsWith("update")) {
    return "update";
  }
  if (normalized === "no" || normalized === "skip" || normalized.startsWith("no")) {
    return "skip";
  }
  throw new Error(`Invalid Jev choice answer: '${answerVal}' (expected 'yes' or 'no')`);
}

export async function callJevJudge(
  prompt: string,
  response: string,
  cfg: MmConfig,
  fetchFn: typeof fetch = globalThis.fetch,
  threadContext?: string,
): Promise<JudgeDecision> {
  const rawUrl = cfg.judgeUrl;
  if (!rawUrl) throw new Error("No judgeUrl configured");

  const url = normalizeJevUrl(rawUrl);
  const timeoutMs = cfg.judgeTimeoutMs ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.judgeKey) {
    headers["Authorization"] = `Bearer ${cfg.judgeKey}`;
  }

  const clippedResponse = response.length > 500 ? response.slice(0, 500) + "..." : response;
  const stateText = threadContext
    ? `${threadContext}\nCurrent User: ${prompt}\nCurrent Assistant: ${clippedResponse}`
    : `User: ${prompt}\nAssistant: ${clippedResponse}`;

  const reqBody: Record<string, unknown> = {
    model: cfg.judgeModel || "default",
    state: stateText,
    questions: {
      memory_action: {
        type: "choice",
        instructions: "Is this user-provided information worth remembering for future conversations? Answer yes or no.",
        criteria: {
          yes: "The user stated meaningful new personal facts, experiences, preferences, technical discoveries, or decisions worth remembering.",
          no: "The user is asking a question, inquiry, or recall test (e.g. 'do you remember', 'what did I say'), or the exchange is transient chitchat, routine acknowledgements, or casual filler.",
        },
      },
    },
  };

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Jev service HTTP error ${res.status}: ${errText.slice(0, 100)}`);
    }

    const data = await res.json();
    const action = parseJevAction(data);

    return {
      action,
      summary: prompt.trim().slice(0, 250),
      reason: `Classified as ${action === "remember" ? "yes" : "no"} by Jev System One`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function callLlmJudge(
  prompt: string,
  response: string,
  cfg: MmConfig,
  fetchFn: typeof fetch = globalThis.fetch,
  threadContext?: string,
): Promise<JudgeDecision> {
  const url = cfg.judgeUrl || "";
  if (cfg.judgeProtocol === "systemzero" || url.includes("/systemzero")) {
    return callSystemZeroJudge(prompt, response, cfg, fetchFn, threadContext);
  }
  if (cfg.judgeProtocol === "systemone" || url.includes("/systemone")) {
    return callJevJudge(prompt, response, cfg, fetchFn, threadContext);
  }
  // "auto": Try systemzero first, fall back to systemone on error
  try {
    return await callSystemZeroJudge(prompt, response, cfg, fetchFn, threadContext);
  } catch {
    return callJevJudge(prompt, response, cfg, fetchFn, threadContext);
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

  // Embeddings decide when available: deterministic and ~15 ms. The generative judge on the
  // default model answered "remember" to 40 of 44 non-memories in held-out evaluation.
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

  if (!judgeConfigured(cfg)) {
    const fallbackAction = cfg.judgeFallback === "capture" ? "remember" : "skip";
    return {
      decision: {
        action: fallbackAction,
        reason: `Judge endpoint not configured; fallback is '${cfg.judgeFallback ?? "skip"}'`,
      },
      source: "fallback",
      degraded: true,
    };
  }

  try {
    const decision = await callLlmJudge(prompt, response, cfg, fetchFn, threadContext);
    return {
      decision,
      source: "llm",
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const fallbackAction = cfg.judgeFallback === "capture" ? "remember" : "skip";
    debugLog("judgement", "Judge service unavailable", { error: errMsg, fallback: cfg.judgeFallback ?? "skip" });

    return {
      decision: {
        action: fallbackAction,
        reason: `Judge failed (${errMsg}), fallback is '${cfg.judgeFallback ?? "skip"}'`,
      },
      source: "fallback",
      degraded: true,
      error: errMsg,
    };
  }
}
