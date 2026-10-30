// HIGH_LEVEL: #judge — the single seam for the local embeddings server when pi-mm
// CLASSIFIES conversational turns (axil-auren `POST /v1/embeddings`, OpenAI-shaped).
// Self-contained on purpose: pi-mm never imports pi-quest, and this is NOT the memory
// index embedder (`embedUrl`/`embedModel` feed corm/sepal with a different model).
// Any failure — HTTP error, timeout, malformed or all-zero vectors — is `null`
// ("unavailable"), never a guess, and a failed endpoint trips the circuit breaker for
// a backoff so a dead server cannot stall every turn.
import type { MmConfig } from "../config.ts";
import {
  CIRCUIT_BACKOFF_MS,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
  DEFAULT_EMBED_TIMEOUT_MS,
  isCircuitOpen,
  recordCircuitFailure,
  recordCircuitSuccess,
  resetCircuitBreaker,
  clearCircuitBreakerState,
  withCircuitBreaker,
} from "./circuit.ts";

export {
  CIRCUIT_BACKOFF_MS,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
  DEFAULT_EMBED_TIMEOUT_MS,
  isCircuitOpen,
  recordCircuitFailure,
  recordCircuitSuccess,
  resetCircuitBreaker,
  clearCircuitBreakerState,
  withCircuitBreaker,
};

export const DEFAULT_CAPTURE_EMBED_MODEL = "bge-base";

/** How long a failed endpoint is skipped (backward compatibility). */
export const EMBED_BACKOFF_MS = CIRCUIT_BACKOFF_MS;

export function clearEmbedState(): void {
  resetCircuitBreaker();
}

/** Classification embeddings base URL (no trailing slash), or null when unavailable. */
export function captureEmbedBase(cfg: MmConfig): string | null {
  if (cfg.captureEmbed === "off") return null;
  const raw = (cfg.captureEmbedUrl ?? cfg.judgeUrl ?? "").trim();
  if (raw === "") return null;
  return raw.replace(/\/api\/v1\/systemone\/?$/, "").replace(/\/+$/, "");
}

export function captureEmbedModel(cfg: MmConfig): string {
  const m = (cfg.captureEmbedModel ?? "").trim();
  return m === "" ? DEFAULT_CAPTURE_EMBED_MODEL : m;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

function toUnit(vec: unknown): number[] | null {
  if (!Array.isArray(vec) || vec.length === 0) return null;
  let norm = 0;
  for (const x of vec) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    norm += x * x;
  }
  if (norm === 0) return null;
  const len = Math.sqrt(norm);
  return (vec as number[]).map((x) => x / len);
}

/**
 * Embed `texts` in ONE request. Resolves to unit vectors in input order, or null when
 * embeddings are off, unreachable, slow, or return anything malformed.
 */
export async function embedTexts(
  cfg: MmConfig,
  texts: readonly string[],
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<number[][] | null> {
  const base = captureEmbedBase(cfg);
  if (base === null || texts.length === 0) return null;

  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.judgeKey && cfg.judgeKey.trim() !== "") headers["Authorization"] = `Bearer ${cfg.judgeKey.trim()}`;

  const timeoutMs = opts.timeoutMs ?? Math.min(cfg.judgeTimeoutMs || DEFAULT_EMBED_TIMEOUT_MS, 4000);

  return await withCircuitBreaker(
    base,
    async (signal) => {
      const res = await fetchFn(`${base}/v1/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: captureEmbedModel(cfg), input: texts }),
        signal,
      });
      if (res.status >= 500) {
        recordCircuitFailure(base);
        return null;
      }
      if (!res.ok) return null;
      const body: unknown = await res.json();
      const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
      if (!Array.isArray(data) || data.length !== texts.length) return null;
      const ordered = [...data].sort(
        (a, b) => Number((a as { index?: number })?.index ?? 0) - Number((b as { index?: number })?.index ?? 0),
      );
      const out: number[][] = [];
      for (const item of ordered) {
        const unit = toUnit((item as { embedding?: unknown })?.embedding);
        if (unit === null) return null;
        out.push(unit);
      }
      return out;
    },
    { timeoutMs },
  );
}
