import { strict as assert } from "node:assert";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { clearEmbedState } from "../src/judge/embed.ts";
import { clearNearestIndexes, gate, mergeExemplars, nearestExemplar } from "../src/judge/nearest.ts";
import { makeStubFetch } from "./judge-stub.ts";

const ON: MmConfig = { ...DEFAULT_CONFIG, judgeUrl: "http://judge.test" };
const TABLE = { a: ["alpha one", "alpha two"], b: ["beta one"], c: ["gamma one"] };

/** alpha -> x, beta -> y, gamma -> z, "mix" -> halfway x/y, anything else -> w. */
function axisEmbed(text: string): number[] {
  if (text.includes("mix")) return [1, 1, 0, 0];
  if (text.includes("alpha")) return [1, 0, 0, 0];
  if (text.includes("beta")) return [0, 1, 0, 0];
  if (text.includes("gamma")) return [0, 0, 1, 0];
  return [0, 0, 0, 1];
}

function fresh(): void {
  clearEmbedState();
  clearNearestIndexes();
}

Deno.test("mergeExemplars de-duplicates, adds operator examples and drops unknown kinds", () => {
  const merged = mergeExemplars(TABLE, { a: ["alpha one", "alpha three"], zzz: ["ignored"] }, new Set(["a", "b", "c"]));
  const keys = merged.map((e) => `${e.kind}:${e.text}`);
  assert.equal(keys.length, 5);
  assert.ok(keys.includes("a:alpha three"));
  assert.ok(!keys.some((k) => k.startsWith("zzz")));
  assert.equal(mergeExemplars(TABLE, {}).length, 4, "no allow-list keeps every kind");
});

Deno.test("nearestExemplar returns the best kind with similarity and margin", async () => {
  fresh();
  const f = makeStubFetch(() => null, axisEmbed);
  const examples = mergeExemplars(TABLE, {});
  const hit = await nearestExemplar(ON, examples, "alpha question", f.fetch);
  assert.equal(hit?.kind, "a");
  assert.ok(Math.abs((hit?.similarity ?? 0) - 1) < 1e-9);
  assert.ok(Math.abs((hit?.margin ?? 0) - 1) < 1e-9);
  const tie = await nearestExemplar(ON, examples, "mix", f.fetch);
  assert.ok(Math.abs(tie?.margin ?? 1) < 1e-9, "a tie has zero margin");
  fresh();
});

Deno.test("nearestExemplar embeds the examples once and reuses the index", async () => {
  fresh();
  let batches = 0;
  const f = makeStubFetch(() => null, axisEmbed);
  const counting = ((url: unknown, init?: { body?: string }) => {
    const input = (JSON.parse(init?.body ?? "{}") as { input?: string | string[] }).input;
    if (Array.isArray(input) && input.length > 1) batches += 1;
    return f.fetch(url as string, init as RequestInit);
  }) as typeof fetch;
  const examples = mergeExemplars(TABLE, {});
  await nearestExemplar(ON, examples, "alpha 1", counting);
  await nearestExemplar(ON, examples, "beta 1", counting);
  assert.equal(batches, 1, "examples batch-embedded once");
  await nearestExemplar(ON, mergeExemplars({ a: ["alpha only"], b: ["beta only"] }, {}), "alpha 1", counting);
  assert.equal(batches, 2, "a new example set re-embeds");
  fresh();
});

Deno.test("nearestExemplar is null when embeddings are off, down or there are no examples", async () => {
  fresh();
  const examples = mergeExemplars(TABLE, {});
  const up = makeStubFetch(() => null, axisEmbed);
  assert.equal(await nearestExemplar({ ...ON, captureEmbed: "off" }, examples, "alpha", up.fetch), null);
  assert.equal(await nearestExemplar({ ...ON, judgeUrl: undefined }, examples, "alpha", up.fetch), null);
  assert.equal(await nearestExemplar(ON, [], "alpha", up.fetch), null);
  const down = makeStubFetch(() => null, () => null);
  assert.equal(await nearestExemplar(ON, examples, "alpha", down.fetch), null);
  fresh();
});

Deno.test("gate: the floor sends everything weak to the harmless kind; the margin only binds actionable kinds", () => {
  const opts = { minSimilarity: 0.6, minMargin: 0.1, harmless: "skip", actionable: new Set(["remember"]) };
  assert.equal(gate({ kind: "remember", similarity: 0.9, margin: 0.5 }, opts), "remember");
  assert.equal(gate({ kind: "remember", similarity: 0.5, margin: 0.5 }, opts), "skip");
  assert.equal(gate({ kind: "remember", similarity: 0.9, margin: 0.05 }, opts), "skip");
  assert.equal(gate({ kind: "other", similarity: 0.9, margin: 0 }, opts), "other");
  assert.equal(gate({ kind: "other", similarity: 0.3, margin: 0.9 }, opts), "skip");
});
