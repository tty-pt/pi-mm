import type { MmConfig } from "../config.ts";
import { judgeConfigured } from "../config.ts";
import type { JudgeAction, JudgeDecision, JudgeResult } from "./types.ts";

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
  const timeoutMs = cfg.judgeTimeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.judgeKey) {
    headers["Authorization"] = `Bearer ${cfg.judgeKey}`;
  }

  const stateText = threadContext
    ? `${threadContext}\nCurrent User: ${prompt}\nCurrent Assistant: ${response}`
    : `User: ${prompt}\nAssistant: ${response}`;

  const reqBody: Record<string, unknown> = {
    model: cfg.judgeModel || "default",
    state: stateText,
    questions: {
      memory_action: {
        type: "choice",
        instructions: "Is this user-provided information worth remembering for future conversations? Answer yes or no.",
        criteria: {
          yes: "The user provided meaningful personal facts, experiences, preferences, technical discoveries, decisions, or specific details worth remembering.",
          no: "The exchange is transient chitchat, routine acknowledgements, questions without new facts, or casual filler.",
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

export function callLlmJudge(
  prompt: string,
  response: string,
  cfg: MmConfig,
  fetchFn: typeof fetch = globalThis.fetch,
  threadContext?: string,
): Promise<JudgeDecision> {
  return callJevJudge(prompt, response, cfg, fetchFn, threadContext);
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
    console.warn(`[pi-mm] Judge service unavailable (${errMsg}). Applying fallback '${cfg.judgeFallback ?? "skip"}'.`);

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
