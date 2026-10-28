// Preloaded by `npm test` (deno test --preload): makes the suite hermetic by refusing any
// request to the real auren port (4242, the zero-config default) or to a non-loopback host.
// Ephemeral loopback fake servers, which the tests start themselves, keep working. Set
// PI_MM_ALLOW_LIVE=1 (or run the opt-in live evaluations directly) to disable the guard.
if (Deno.env.get("PI_MM_ALLOW_LIVE") !== "1") {
  const realFetch = globalThis.fetch.bind(globalThis);
  const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  (globalThis as { __piMmNetworkGuard?: boolean }).__piMmNetworkGuard = true;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let blocked = false;
    try {
      const u = new URL(raw);
      blocked = !LOOPBACK.has(u.hostname) || u.port === "4242";
    } catch {
      blocked = false;
    }
    if (blocked) {
      return Promise.reject(new TypeError(`live network is blocked during npm test (${raw}); set PI_MM_ALLOW_LIVE=1 to allow`));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}
