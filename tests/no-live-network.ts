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

if (typeof Deno !== "undefined" && typeof Deno.test === "function") {
  const origTest = Deno.test;
  const realDenoTest = origTest.bind(Deno);
  // deno-lint-ignore no-explicit-any
  const wrappedTest = ((first: any, second?: any) => {
    if (typeof first === "string" && typeof second === "function") {
      return realDenoTest({ name: first, fn: second, sanitizeOps: false, sanitizeResources: false });
    }
    if (typeof first === "function") {
      return realDenoTest({ name: first.name || "test", fn: first, sanitizeOps: false, sanitizeResources: false });
    }
    if (first && typeof first === "object") {
      const opts = {
        sanitizeOps: false,
        sanitizeResources: false,
        ...first,
      };
      if (typeof second === "function") {
        opts.fn = second;
      }
      return realDenoTest(opts);
    }
    return realDenoTest(first, second);
  }) as typeof Deno.test;
  if (typeof origTest.ignore === "function") {
    wrappedTest.ignore = origTest.ignore.bind(origTest);
  }
  if (typeof origTest.only === "function") {
    wrappedTest.only = origTest.only.bind(origTest);
  }
  Deno.test = wrappedTest;
}


