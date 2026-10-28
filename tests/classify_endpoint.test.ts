import { strict as assert } from "node:assert";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { nearestExemplar } from "../src/judge/nearest.ts";

Deno.test("pi-mm nearestExemplar uses /v1/classify when server responds 200", async () => {
  const real = globalThis.fetch;
  let classifyCalled = false;
  let embedCalled = false;

  globalThis.fetch = ((url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/v1/classify")) {
      classifyCalled = true;
      const parsed = JSON.parse(init?.body ?? "{}");
      assert.equal(parsed.text, "we use postgres");
      assert.ok(parsed.labels?.remember !== undefined);
      return Promise.resolve(new Response(JSON.stringify({
        choice: "remember",
        similarity: 0.88,
        margin: 0.30,
        scores: { remember: 0.88, skip: 0.58 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    if (u.includes("/v1/embeddings")) {
      embedCalled = true;
      return Promise.resolve(new Response("down", { status: 503 }));
    }
    return real(url as string, init as RequestInit);
  }) as typeof fetch;

  try {
    const res = await nearestExemplar(
      { ...DEFAULT_CONFIG, judgeUrl: "http://test-server:4242", judgeMode: "auto" },
      [{ kind: "remember", text: "we chose postgres" }, { kind: "skip", text: "hello" }],
      "we use postgres",
    );
    assert.ok(res !== null);
    assert.equal(res?.kind, "remember");
    assert.equal(res?.similarity, 0.88);
    assert.equal(res?.margin, 0.30);
    assert.ok(classifyCalled);
    assert.ok(!embedCalled);
  } finally {
    globalThis.fetch = real;
  }
});
