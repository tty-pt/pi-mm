import { strict as assert } from "node:assert";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import {
  clearEmbedState,
  isCircuitOpen,
  recordCircuitFailure,
  recordCircuitSuccess,
  resetCircuitBreaker,
  withCircuitBreaker,
} from "../src/judge/embed.ts";
import { nearestExemplar } from "../src/judge/nearest.ts";

const CFG: MmConfig = {
  ...DEFAULT_CONFIG,
  judgeUrl: "http://test-server:4242",
  judgeMode: "auto",
};

const EXAMPLES = [
  { kind: "remember", text: "we use postgres" },
  { kind: "skip", text: "what time is it" },
];

Deno.test("pi-mm circuit breaker: trips on connection refusal and suppresses subsequent calls", async () => {
  clearEmbedState();
  const real = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (() => {
    fetchCount++;
    return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:4242"));
  }) as typeof fetch;

  try {
    assert.equal(isCircuitOpen("http://test-server:4242"), false, "circuit initially closed");

    // First attempt fails fast and trips the circuit
    const res1 = await nearestExemplar(CFG, EXAMPLES, "always use flac");
    assert.equal(res1, null, "returns null on failure");
    assert.equal(fetchCount, 1, `first call attempted fetch once, got ${fetchCount}`);
    assert.equal(isCircuitOpen("http://test-server:4242"), true, "circuit now open");

    // Second attempt should fail-fast without touching fetch
    const t0 = performance.now();
    const res2 = await nearestExemplar(CFG, EXAMPLES, "hello there");
    const elapsed = performance.now() - t0;

    assert.equal(res2, null, "second attempt returns null");
    assert.equal(fetchCount, 1, `second attempt did NOT call fetch (count remained ${fetchCount})`);
    assert.ok(elapsed < 10, `offline rejection took ${elapsed.toFixed(2)}ms (< 10ms target)`);
  } finally {
    globalThis.fetch = real;
    clearEmbedState();
  }
});

Deno.test("pi-mm circuit breaker: withCircuitBreaker enforces timeout and trips on slow response", async () => {
  clearEmbedState();
  const real = globalThis.fetch;
  let fetchCount = 0;

  // Mock fetch that hangs forever
  globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
    fetchCount++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    });
  }) as typeof fetch;

  try {
    const t0 = performance.now();
    const res = await withCircuitBreaker(
      "http://test-server:4242",
      async (signal) => {
        await globalThis.fetch("http://test-server:4242/v1/classify", { signal });
        return { ok: true };
      },
      { timeoutMs: 50 },
    );
    const elapsed = performance.now() - t0;

    assert.equal(res, null, "timed out call returns null / fallback");
    assert.equal(fetchCount, 1, "fetch called once");
    assert.ok(elapsed < 200, `aborted promptly in ${elapsed.toFixed(1)}ms`);
    assert.equal(isCircuitOpen("http://test-server:4242"), true, "circuit tripped on timeout");
  } finally {
    globalThis.fetch = real;
    clearEmbedState();
  }
});

Deno.test("pi-mm circuit breaker: manual reset and success recovery clears open state", () => {
  clearEmbedState();
  assert.equal(isCircuitOpen("http://test-server:4242"), false, "initially closed");

  recordCircuitFailure("http://test-server:4242");
  assert.equal(isCircuitOpen("http://test-server:4242"), true, "circuit opened by failure");

  recordCircuitSuccess("http://test-server:4242");
  assert.equal(isCircuitOpen("http://test-server:4242"), false, "circuit closed by success");

  recordCircuitFailure("http://test-server:4242");
  assert.equal(isCircuitOpen("http://test-server:4242"), true, "circuit opened again");

  resetCircuitBreaker();
  assert.equal(isCircuitOpen("http://test-server:4242"), false, "resetCircuitBreaker resets circuit");
});
