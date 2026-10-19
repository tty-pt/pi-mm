/**
 * Opt-in structured diagnostics logging and JSONL tracing for pi-mm memory pipeline.
 * Enabled via PI_MM_DEBUG_MEMORY=1.
 */

import { appendFileSync } from "node:fs";

export type DebugStage = "startup" | "capture" | "judgement" | "persistence" | "recall" | "consolidation";

export type TraceTransition =
  | "extension_loaded"
  | "conversation_captured"
  | "judge_request"
  | "memory_write"
  | "index_verification"
  | "auto_recall"
  | "context_injected";

let processRunId: string | null = null;

export function getRunId(): string {
  if (typeof process !== "undefined" && process?.env?.["PI_MM_RUN_ID"]) {
    return process.env["PI_MM_RUN_ID"];
  }
  if (typeof Deno !== "undefined" && Deno?.env?.get("PI_MM_RUN_ID")) {
    return Deno.env.get("PI_MM_RUN_ID")!;
  }
  if (!processRunId) {
    processRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return processRunId;
}

export function getTraceFilePath(): string {
  if (typeof process !== "undefined" && process?.env?.["PI_MM_TRACE_FILE"]) {
    return process.env["PI_MM_TRACE_FILE"];
  }
  if (typeof Deno !== "undefined" && Deno?.env?.get("PI_MM_TRACE_FILE")) {
    return Deno.env.get("PI_MM_TRACE_FILE")!;
  }
  return "/tmp/pi_mm_trace.jsonl";
}

export function isDebugMemoryEnabled(): boolean {
  if (typeof process !== "undefined" && process?.env?.["PI_MM_DEBUG_MEMORY"] === "1") {
    return true;
  }
  if (typeof Deno !== "undefined" && Deno?.env?.get("PI_MM_DEBUG_MEMORY") === "1") {
    return true;
  }
  return false;
}

export function sanitizeDebugValue(val: unknown, keyName?: string): unknown {
  if (val === undefined || val === null) return val;
  if (typeof val === "string") {
    if (keyName && /key|token|secret|auth|password|bearer/i.test(keyName)) {
      return "[REDACTED]";
    }
    if (val.length > 250) {
      return `${val.slice(0, 247)}... [len=${val.length}]`;
    }
    return val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.slice(0, 50).map((v) => sanitizeDebugValue(v, keyName));
  }
  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (/key|token|secret|auth|password|bearer/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeDebugValue(v, k);
      }
    }
    return out;
  }
  return String(val);
}

export function debugLog(
  stage: DebugStage,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!isDebugMemoryEnabled()) return;

  const timestamp = new Date().toISOString();
  let details = "";
  if (data && Object.keys(data).length > 0) {
    try {
      const sanitized = sanitizeDebugValue(data);
      details = " " + JSON.stringify(sanitized);
    } catch {
      details = " [unserializable details]";
    }
  }

  const line = `[pi-mm:debug][${timestamp}][${stage}] ${message}${details}\n`;
  if (typeof Deno !== "undefined" && Deno?.stderr?.writeSync) {
    try {
      Deno.stderr.writeSync(new TextEncoder().encode(line));
      return;
    } catch { /* fallback to console */ }
  }
  if (typeof process !== "undefined" && process?.stderr?.write) {
    try {
      process.stderr.write(line);
      return;
    } catch { /* fallback to console */ }
  }
  console.error(line.trimEnd());
}

export interface TraceContext {
  runId?: string;
  sessionId?: string;
}

export function traceEvent(
  transition: TraceTransition,
  status: "ok" | "error" | "skip" | "info",
  data: Record<string, unknown>,
  ctx?: TraceContext,
): void {
  if (!isDebugMemoryEnabled()) return;

  const runId = ctx?.runId ?? getRunId();
  const sessionId = ctx?.sessionId ??
    (typeof process !== "undefined" ? process?.env?.["PI_SESSION_ID"] : undefined) ??
    (typeof Deno !== "undefined" ? Deno?.env?.get("PI_SESSION_ID") : undefined) ??
    "unknown-session";
  const timestamp = new Date().toISOString();

  const record = {
    transition,
    status,
    runId,
    sessionId,
    timestamp,
    ...sanitizeDebugValue(data) as Record<string, unknown>,
  };

  try {
    const tracePath = getTraceFilePath();
    const line = JSON.stringify(record) + "\n";
    appendFileSync(tracePath, line, "utf-8");
  } catch (err) {
    debugLog("startup", "Failed to write trace event to file", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Also emit to debug stderr
  debugLog(
    transition === "extension_loaded" ? "startup"
    : transition === "conversation_captured" ? "capture"
    : transition === "judge_request" ? "judgement"
    : transition === "memory_write" ? "persistence"
    : "recall",
    `Trace: ${transition} (${status})`,
    data,
  );
}
