import { strict as assert } from "node:assert";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { evaluateTurnWithJudge } from "../src/judge/adapter.ts";
import { CAPTURE_EXEMPLARS } from "../src/judge/capture-exemplars.ts";
import { clearEmbedState } from "../src/judge/embed.ts";
import { clearNearestIndexes } from "../src/judge/nearest.ts";
import { makeStubFetch } from "./judge-stub.ts";

const ON: MmConfig = { ...DEFAULT_CONFIG, judgeMode: "auto", judgeUrl: "http://judge.test", judgeProtocol: "systemone" };

const AXIS: Record<string, number[]> = { remember: [1, 0, 0], skip: [0, 1, 0] };

/** exemplars -> their kind's axis, probes by exact text, anything else -> an orthogonal axis. */
function kindEmbed(probes: Record<string, number[]>, extra: Record<string, string> = {}): (t: string) => number[] {
  const byText = new Map<string, number[]>();
  for (const [kind, texts] of Object.entries(CAPTURE_EXEMPLARS)) for (const t of texts) byText.set(t, AXIS[kind] ?? [0, 0, 1]);
  for (const [t, kind] of Object.entries(extra)) byText.set(t, AXIS[kind] ?? [0, 0, 1]);
  return (text) => probes[text] ?? byText.get(text) ?? [0, 0, 1];
}

function fresh(): void {
  clearEmbedState();
  clearNearestIndexes();
}

Deno.test("a clear embedding remember verdict is final: judge not consulted, summary carries the prompt", async () => {
  fresh();
  const f = makeStubFetch(() => "no", kindEmbed({ "We chose Redis for caching": AXIS["remember"] ?? [] }));
  const r = await evaluateTurnWithJudge("We chose Redis for caching", "Noted.", ON, f.fetch);
  assert.equal(r.decision.action, "remember");
  assert.equal(r.source, "embed");
  assert.equal(r.degraded, undefined);
  assert.ok(r.decision.summary?.includes("Redis"));
  assert.equal(f.judgeCalls(), 0, "judge not consulted");
  fresh();
});

Deno.test("an embedding skip verdict is final: the judge's false remembers are never reconsulted", async () => {
  fresh();
  const f = makeStubFetch(() => "yes", kindEmbed({ "good morning": AXIS["skip"] ?? [] }));
  const r = await evaluateTurnWithJudge("good morning", "Hello!", ON, f.fetch);
  assert.equal(r.decision.action, "skip");
  assert.equal(r.source, "embed");
  assert.equal(f.judgeCalls(), 0);
  fresh();
});

Deno.test("a thin margin or weak similarity is skip, never remember", async () => {
  fresh();
  const f = makeStubFetch(() => "yes", kindEmbed({ "half sure": [1, 1, 0], "far from everything": [0, 0, 1] }));
  assert.equal((await evaluateTurnWithJudge("half sure", "ok", ON, f.fetch)).decision.action, "skip", "tie => skip");
  assert.equal((await evaluateTurnWithJudge("far from everything", "ok", ON, f.fetch)).decision.action, "skip", "below the floor => skip");
  assert.equal(f.judgeCalls(), 0);
  fresh();
});

Deno.test("captureMinMargin and captureMinSimilarity gate remember", async () => {
  fresh();
  const f = makeStubFetch(() => null, kindEmbed({ borderline: [2, 1, 0] })); // sim ~0.894, margin ~0.447
  assert.equal((await evaluateTurnWithJudge("borderline", "ok", { ...ON, captureMinMargin: 0.075 }, f.fetch)).decision.action, "remember");
  assert.equal((await evaluateTurnWithJudge("borderline", "ok", { ...ON, captureMinMargin: 0.9 }, f.fetch)).decision.action, "skip");
  assert.equal((await evaluateTurnWithJudge("borderline", "ok", { ...ON, captureMinSimilarity: 0.95 }, f.fetch)).decision.action, "skip");
  fresh();
});

Deno.test("operator captureExemplars extend the shipped ones", async () => {
  fresh();
  const plain = makeStubFetch(() => null, (t) => (t === "yeet the config" ? [0, 0, 1] : kindEmbed({})(t)));
  assert.equal((await evaluateTurnWithJudge("yeet the config", "ok", ON, plain.fetch)).decision.action, "skip", "unknown phrasing skips by default");
  fresh();
  const own = makeStubFetch(() => null, (t) => (t === "yeet the config" ? [1, 0, 0] : kindEmbed({})(t)));
  const r = await evaluateTurnWithJudge("yeet the config", "ok", { ...ON, captureExemplars: { remember: ["yeet the config"] } }, own.fetch);
  assert.equal(r.decision.action, "remember");
  assert.equal(r.source, "embed");
  fresh();
});

Deno.test("only the USER prompt is embedded, never the assistant reply", async () => {
  fresh();
  const seen: string[] = [];
  const inner = makeStubFetch(() => null, kindEmbed({ "my prompt": AXIS["remember"] ?? [] }));
  const spy = ((url: unknown, init?: { body?: string }) => {
    const input = (JSON.parse(init?.body ?? "{}") as { input?: string[] }).input ?? [];
    if (input.length === 1) seen.push(String(input[0]));
    return inner.fetch(url as string, init as RequestInit);
  }) as typeof fetch;
  await evaluateTurnWithJudge("my prompt", "SECRET ASSISTANT REPLY", ON, spy);
  assert.deepEqual(seen, ["my prompt"]);
  fresh();
});

Deno.test("embeddings down falls to the judge, then to judgeFallback", async () => {
  fresh();
  const viaJudge = makeStubFetch(() => "yes"); // no embed => /v1/embeddings is down
  const r1 = await evaluateTurnWithJudge("anything", "ok", ON, viaJudge.fetch);
  assert.equal(r1.source, "llm");
  assert.equal(r1.decision.action, "remember");
  fresh();
  const bothDown = makeStubFetch(() => null);
  const skipFallback = await evaluateTurnWithJudge("anything", "ok", { ...ON, judgeFallback: "skip" }, bothDown.fetch);
  assert.equal(skipFallback.decision.action, "skip");
  assert.equal(skipFallback.source, "fallback");
  assert.equal(skipFallback.degraded, true);
  fresh();
  const captureFallback = await evaluateTurnWithJudge("anything", "ok", { ...ON, judgeFallback: "capture" }, makeStubFetch(() => null).fetch);
  assert.equal(captureFallback.decision.action, "remember");
  assert.equal(captureFallback.degraded, true);
  fresh();
});

Deno.test("embeddings alone are enough: no judge configured, captureEmbedUrl set", async () => {
  fresh();
  const cfg: MmConfig = { ...DEFAULT_CONFIG, judgeUrl: undefined, captureEmbedUrl: "http://emb.test" };
  const f = makeStubFetch(() => null, kindEmbed({ "I live in Faro": AXIS["remember"] ?? [] }));
  const r = await evaluateTurnWithJudge("I live in Faro", "ok", cfg, f.fetch);
  assert.equal(r.source, "embed");
  assert.equal(r.decision.action, "remember");
  fresh();
});

Deno.test("captureMode off and captureEmbed off never use embeddings", async () => {
  fresh();
  const f = makeStubFetch(() => "yes", kindEmbed({}));
  const off = await evaluateTurnWithJudge("x", "y", { ...ON, captureMode: "off" }, f.fetch);
  assert.equal(off.source, "disabled");
  assert.equal(f.embedCalls() + f.judgeCalls(), 0, "captureMode off touches nothing");
  const noEmbed = await evaluateTurnWithJudge("x", "y", { ...ON, captureEmbed: "off" }, f.fetch);
  assert.equal(noEmbed.source, "llm", "captureEmbed off restores the judge path");
  assert.equal(f.embedCalls(), 0);
  fresh();
});
