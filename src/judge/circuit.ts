// HIGH_LEVEL: #judge — Circuit breaker and resilient fetch wrapper for axil-auren daemon endpoints.
// Protects the Pi turn loop against hung sockets, connection timeouts, or offline daemons.
// Any failure trips the circuit breaker for that daemon base URL for CIRCUIT_BACKOFF_MS (30s),
// allowing subsequent calls to fail-fast in 0ms without touching the network or socket layer.

export const CIRCUIT_BACKOFF_MS = 30_000;
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 250;
export const DEFAULT_EMBED_TIMEOUT_MS = 2000;

/** Scoped per daemon base URL (e.g. "http://127.0.0.1:4242") */
const failedUntil = new Map<string, number>();

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/api\/v1\/systemone\/?$/, "").replace(/\/+$/, "");
}

/** Check if the circuit breaker is open (tripped/cooling down) for this base URL. */
export function isCircuitOpen(base: string): boolean {
  const norm = normalizeBaseUrl(base);
  return (failedUntil.get(norm) ?? 0) > Date.now();
}

/** Record a daemon failure, tripping the circuit breaker for `backoffMs`. */
export function recordCircuitFailure(base: string, backoffMs: number = CIRCUIT_BACKOFF_MS): void {
  const norm = normalizeBaseUrl(base);
  failedUntil.set(norm, Date.now() + backoffMs);
}

/** Record a daemon success, immediately clearing any circuit breaker cooldown. */
export function recordCircuitSuccess(base: string): void {
  const norm = normalizeBaseUrl(base);
  failedUntil.delete(norm);
}

/** Reset all circuit breaker state across all endpoints (for tests and clean resets). */
export function resetCircuitBreaker(): void {
  failedUntil.clear();
}

/** Compatibility alias for clearing circuit breaker state. */
export function clearCircuitBreakerState(): void {
  failedUntil.clear();
}

export interface CircuitBreakerOptions<T> {
  timeoutMs?: number;
  fallback?: T | null;
  backoffMs?: number;
}

/**
 * Execute a daemon operation with circuit-breaker protection:
 * 1. If circuit is open, return fallback immediately (0ms).
 * 2. Execute operation with strict AbortSignal timeout.
 * 3. On success, record success and return result.
 * 4. On timeout or error (network error, refused, hung socket, 5xx), record failure (trip circuit)
 *    and return fallback without throwing.
 */
export async function withCircuitBreaker<T>(
  base: string,
  fn: (signal: AbortSignal) => Promise<T | null>,
  options: CircuitBreakerOptions<T> = {},
): Promise<T | null> {
  const fallback = options.fallback ?? null;
  if (!base || base.trim() === "" || isCircuitOpen(base)) {
    return fallback;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? CIRCUIT_BACKOFF_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await fn(controller.signal);
    if (result !== null && result !== undefined) {
      recordCircuitSuccess(base);
      return result;
    }
    // Result is null (e.g. 404 unsupported endpoint); does not trip circuit breaker
    return fallback;
  } catch (_err) {
    // Network refusal, timeout, AbortError, socket hang, etc. -> trip circuit immediately
    recordCircuitFailure(base, backoffMs);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
