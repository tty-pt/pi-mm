// pi-mm capture measurement (opt-in live part):
//   PI_MM_EVAL_JUDGE=1 deno test --allow-all --sloppy-imports tests/eval/capture-eval.test.ts
// Judge (production memory_action question) vs nearest-exemplar embeddings of the USER
// prompt through the gate. The state-changing error is a false "remember" (it writes to
// the memory store). Embedding-only measurements run BEFORE the judge so a slow judge
// cannot leave the server busy for them.
import { strict as assert } from "node:assert";
import { DEFAULT_CONFIG, type MmConfig } from "../../src/config.ts";
import { gate, mergeExemplars, nearestExemplar } from "../../src/judge/nearest.ts";
import { CAPTURE_CORPUS, CAPTURE_CORPUS_B, CAPTURE_EXEMPLARS } from "./corpora/capture.ts";
import { type Case, embedStrategy, judgeStrategy, runComparison } from "./harness.ts";

const LIVE = Deno.env.get("PI_MM_EVAL_JUDGE") === "1";
const URL_ = Deno.env.get("PI_MM_EVAL_URL") ?? "http://127.0.0.1:4242";
const MIN_SIMILARITY = 0.6;
const DEFAULT_MARGIN = 0.075;

export function liveCfg(): MmConfig {
  return { ...DEFAULT_CONFIG, judgeMode: "auto", judgeUrl: URL_, judgeProtocol: "systemone", judgeModel: "olmoe" };
}

export function assertCorpus(name: string, corpus: Case[], exemplars: Record<string, string[]>, others: Case[] = []): void {
  assert.ok(corpus.length >= 40, `${name}: >= 40 cases, got ${corpus.length}`);
  for (const want of ["remember", "skip"]) {
    assert.ok(corpus.filter((x) => x.want === want).length >= 15, `${name}: >= 15 ${want} cases`);
  }
  assert.ok(corpus.some((x) => /Sou |Decidimos|Olá|Obrigado|Bom dia/.test(x.text)), `${name}: Portuguese cases present`);
  assert.equal(new Set(corpus.map((x) => x.text)).size, corpus.length, `${name}: no duplicate cases`);
  const seen = new Set([
    ...Object.values(exemplars).flat().map((x) => x.toLowerCase()),
    ...others.map((x) => x.text.toLowerCase()),
  ]);
  for (const x of corpus) assert.ok(!seen.has(x.text.toLowerCase()), `${name}: overlaps exemplars or another corpus: ${x.text}`);
}

export function gateAt(minMargin: number) {
  return { minSimilarity: MIN_SIMILARITY, minMargin, harmless: "skip", actionable: new Set(["remember"]) };
}

Deno.test("capture corpus B is held out: balanced, bilingual, no overlap with A or the exemplars", () => {
  assertCorpus("B", CAPTURE_CORPUS_B, CAPTURE_EXEMPLARS, CAPTURE_CORPUS);
});

Deno.test({
  name: "live: capture held-out corpus B with exemplar set v2 at the pre-registered default margin",
  ignore: !LIVE,
  fn: async () => {
    const cfg = liveCfg();
    const examples = mergeExemplars(CAPTURE_EXEMPLARS, {});
    // Embedding-only first; the judge last.
    const out = await runComparison("capture B (exemplars v2, margin 0.075)", CAPTURE_CORPUS_B, cfg, embedStrategy(cfg, examples, gateAt(DEFAULT_MARGIN)), judgeStrategy(cfg), new Set(["remember"]));
    const nRem = CAPTURE_CORPUS_B.filter((x) => x.want === "remember").length;
    console.log(`B summary: embeddings ${out.embed.correct}/${out.embed.total} false-remember ${out.embed.falsePositives} remember ${out.embed.byLabel["remember"]?.correct}/${nRem}; judge ${out.judge?.correct}/${out.judge?.total} false-remember ${out.judge?.falsePositives}`);
    assert.equal(out.embed.total, CAPTURE_CORPUS_B.length);
  },
});

Deno.test("capture corpus A is large, balanced, bilingual and disjoint from the exemplars", () => {
  assertCorpus("A", CAPTURE_CORPUS, CAPTURE_EXEMPLARS);
  assert.ok((CAPTURE_EXEMPLARS["remember"] ?? []).length >= 12 && (CAPTURE_EXEMPLARS["skip"] ?? []).length >= 12);
});

Deno.test({
  name: "live: capture corpus A, embeddings first then judge",
  ignore: !LIVE,
  fn: async () => {
    const cfg = liveCfg();
    const examples = mergeExemplars(CAPTURE_EXEMPLARS, {});
    const raw = [];
    for (const x of CAPTURE_CORPUS) raw.push({ x, v: await nearestExemplar(cfg, examples, x.text) });
    console.log("margin sweep (corpus A, floor 0.6): margin | accuracy | false-remember | remember recall");
    const nRem = CAPTURE_CORPUS.filter((x) => x.want === "remember").length;
    for (const m of [0, 0.02, 0.05, 0.075, 0.1, 0.125, 0.15]) {
      let ok = 0, falseRem = 0, remOk = 0;
      for (const { x, v } of raw) {
        const got = v === null ? null : gate(v, gateAt(m));
        if (got === x.want) { ok += 1; if (x.want === "remember") remOk += 1; }
        else if (got === "remember") falseRem += 1;
      }
      console.log(`  ${m} | ${ok}/${CAPTURE_CORPUS.length} | ${falseRem} | ${remOk}/${nRem}`);
    }
    const out = await runComparison("capture A", CAPTURE_CORPUS, cfg, embedStrategy(cfg, examples, gateAt(DEFAULT_MARGIN)), judgeStrategy(cfg), new Set(["remember"]));
    assert.equal(out.embed.total, CAPTURE_CORPUS.length);
  },
});
