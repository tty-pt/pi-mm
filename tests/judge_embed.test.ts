import { strict as assert } from "node:assert";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { captureEmbedBase, clearEmbedState, cosine, embedTexts } from "../src/judge/embed.ts";
import { makeStubFetch } from "./judge-stub.ts";

const ON: MmConfig = { ...DEFAULT_CONFIG, judgeUrl: "http://judge.test/api/v1/systemone/" };

Deno.test("capture embedding base url: captureEmbedUrl wins, else the judge url, trimmed; off and missing are unavailable", () => {
  assert.equal(captureEmbedBase(ON), "http://judge.test");
  assert.equal(captureEmbedBase({ ...ON, captureEmbedUrl: "http://emb.test/" }), "http://emb.test");
  assert.equal(captureEmbedBase({ ...ON, judgeUrl: undefined }), null);
  assert.equal(captureEmbedBase({ ...ON, captureEmbed: "off" }), null);
});

Deno.test("the memory-index embedUrl is NOT used for classification (different server and model)", () => {
  assert.equal(captureEmbedBase({ ...DEFAULT_CONFIG, embedUrl: "http://index.test", judgeUrl: undefined }), null);
});

Deno.test("embedTexts returns unit vectors in input order, null on any failure", async () => {
  clearEmbedState();
  const ok = makeStubFetch(() => null, (t) => (t === "a" ? [3, 4] : [0, 2]));
  const v = await embedTexts(ON, ["a", "b"], { fetchFn: ok.fetch });
  assert.ok(v !== null && v.length === 2);
  assert.ok(Math.abs((v[0]?.[0] ?? 0) - 0.6) < 1e-9 && Math.abs((v[0]?.[1] ?? 0) - 0.8) < 1e-9, "normalized");
  assert.ok(Math.abs(cosine(v[0] ?? [], v[1] ?? []) - 0.8) < 1e-9, "cosine of unit vectors");
  clearEmbedState();
  const down = makeStubFetch(() => null, () => null);
  assert.equal(await embedTexts(ON, ["a"], { fetchFn: down.fetch }), null, "HTTP failure => null");
  clearEmbedState();
});

Deno.test("malformed embedding payloads are unavailable, never guessed", async () => {
  for (const body of [{}, { data: [] }, { data: [{ embedding: ["x"] }] }, { data: [{ embedding: [] }] }, { data: [{ embedding: [0, 0] }] }]) {
    clearEmbedState();
    const f = (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as typeof fetch;
    assert.equal(await embedTexts(ON, ["a"], { fetchFn: f }), null, `malformed ${JSON.stringify(body)}`);
  }
  clearEmbedState();
});

Deno.test("a failed endpoint is skipped for a backoff so a dead server cannot stall every turn", async () => {
  clearEmbedState();
  const down = makeStubFetch(() => null, () => null);
  await embedTexts(ON, ["a"], { fetchFn: down.fetch });
  const after1 = down.embedCalls();
  await embedTexts(ON, ["a"], { fetchFn: down.fetch });
  assert.equal(down.embedCalls(), after1, "second call skipped during backoff");
  clearEmbedState();
  await embedTexts(ON, ["a"], { fetchFn: down.fetch });
  assert.equal(down.embedCalls(), after1 + 1, "clearing the state re-enables the endpoint");
  clearEmbedState();
});

Deno.test("embeddings off or no texts never touch the network", async () => {
  clearEmbedState();
  const f = makeStubFetch(() => null, () => [1, 0]);
  assert.equal(await embedTexts({ ...ON, captureEmbed: "off" }, ["a"], { fetchFn: f.fetch }), null);
  assert.equal(await embedTexts(ON, [], { fetchFn: f.fetch }), null);
  assert.equal(f.embedCalls(), 0);
});
