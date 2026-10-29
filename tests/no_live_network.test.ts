import { strict as assert } from "node:assert";

// `npm test` preloads tests/no-live-network.ts. Opt-in live evaluations (and anyone running
// with PI_MM_ALLOW_LIVE=1) run without it, so these assertions only apply when it is active.
const GUARDED = (globalThis as { __piMmNetworkGuard?: boolean }).__piMmNetworkGuard === true;

Deno.test({
  name: "no-live-network guard: the real auren port and the public internet are refused during npm test",
  ignore: !GUARDED,
  fn: async () => {
    for (const url of ["http://127.0.0.1:4242/v1/models", "http://localhost:4242/v1/embeddings", "https://example.com/"]) {
      await assert.rejects(() => fetch(url), /live network is blocked/, `${url} must be refused`);
    }
  },
});

Deno.test({
  name: "no-live-network guard: ephemeral loopback fake servers still work",
  ignore: !GUARDED,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen: () => {} }, () => new Response("ok"));
    try {
      const res = await fetch(`http://127.0.0.1:${server.addr.port}/`);
      assert.equal(await res.text(), "ok");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "hermetic suite never auto-starts or provisions a local auren server",
  ignore: !GUARDED,
  fn: () => {
    assert.equal(Deno.env.get("PI_MM_AUTO_START_AUREN"), "0", "npm test must set PI_MM_AUTO_START_AUREN=0");
  },
});
