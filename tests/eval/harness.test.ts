import { strict as assert } from "node:assert";
import { type Case, evaluateStrategy, formatReport, gateDecision, percentile, type Report, type Strategy } from "./harness.ts";

const CORPUS: Case[] = [
  { text: "I am allergic to peanuts", want: "remember" },
  { text: "We decided to use Postgres", want: "remember" },
  { text: "hello there", want: "skip" },
  { text: "what is a monad?", want: "skip" },
  { text: "obrigado", want: "skip" },
];

function fake(name: string, answers: Record<string, string | null>, delayMs = 0): Strategy {
  return {
    name,
    classify: async (c) => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return answers[c.text] ?? null;
    },
  };
}

const MEM = new Set(["remember"]);

Deno.test("percentile uses nearest-rank on sorted samples", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile([], 50), 0);
});

Deno.test("evaluateStrategy counts accuracy, false state-changing verdicts and misses", async () => {
  const s = fake("fake", {
    "I am allergic to peanuts": "remember",
    "We decided to use Postgres": "skip", // missed memory: wrong but NOT a false positive
    "hello there": "skip",
    "what is a monad?": "remember", // false remember: the state-changing error
    "obrigado": "skip",
  });
  const r = await evaluateStrategy(s, CORPUS, { stateChanging: MEM });
  assert.equal(r.total, 5);
  assert.equal(r.correct, 3);
  assert.equal(r.falsePositives, 1);
  assert.ok(Math.abs(r.falsePositiveRate - 1 / 3) < 1e-9, "rate is over the cases whose truth is NOT state-changing");
  assert.equal(r.unavailable, 0);
  assert.equal(r.misses.length, 2);
  assert.ok(r.misses[0]?.includes("We decided to use Postgres"));
  assert.deepEqual(r.byLabel["remember"], { correct: 1, total: 2 });
});

Deno.test("unavailable answers are neither correct nor false positives", async () => {
  const r = await evaluateStrategy(fake("down", {}), CORPUS, { stateChanging: MEM });
  assert.equal(r.unavailable, 5);
  assert.equal(r.correct, 0);
  assert.equal(r.falsePositives, 0);
  assert.equal(r.accuracy, 0);
});

Deno.test("latency percentiles are recorded", async () => {
  const r = await evaluateStrategy(fake("slow", { "I am allergic to peanuts": "remember" }, 5), CORPUS.slice(0, 1), { stateChanging: MEM });
  assert.ok(r.p50Ms >= 4 && r.p95Ms >= r.p50Ms, `latency recorded (${r.p50Ms}/${r.p95Ms})`);
});

Deno.test("formatReport lists the gate numbers and every miss", async () => {
  const r = await evaluateStrategy(fake("f", { "I am allergic to peanuts": "skip" }), CORPUS.slice(0, 1), { stateChanging: MEM });
  const text = formatReport("capture", r);
  assert.ok(text.includes("capture | f:"));
  assert.ok(text.includes("miss: I am allergic to peanuts"));
  assert.ok(/acc \d+\.\d%/.test(text) && /fp \d+\/\d+/.test(text) && /p50 \d+ms/.test(text));
});

function rep(over: Partial<Report>): Report {
  return {
    name: "r", total: 10, correct: 9, accuracy: 0.9, falsePositives: 0, falsePositiveRate: 0,
    unavailable: 0, p50Ms: 10, p95Ms: 20, misses: [], byLabel: {}, ...over,
  };
}

Deno.test("gateDecision adopts only on accuracy parity with zero false state-changing verdicts", () => {
  assert.ok(gateDecision(rep({}), rep({ accuracy: 0.9 })).adopt, "equal accuracy adopts");
  assert.ok(gateDecision(rep({ accuracy: 0.95 }), rep({ accuracy: 0.9 })).adopt, "better accuracy adopts");
  assert.ok(!gateDecision(rep({ accuracy: 0.85 }), rep({ accuracy: 0.9 })).adopt, "worse accuracy retains");
  const fp = gateDecision(rep({ accuracy: 1, falsePositives: 1 }), rep({ accuracy: 0.5 }));
  assert.ok(!fp.adopt && fp.reason.includes("false state-changing"));
  assert.ok(!gateDecision(rep({ unavailable: 2 }), rep({})).adopt, "unavailable embeddings never adopt");
  assert.ok(!gateDecision(rep({}), null).adopt, "unmeasured judge never adopts silently");
  assert.ok(!gateDecision(rep({}), rep({ unavailable: 3 })).adopt, "an unavailable judge makes the comparison unsound");
});

Deno.test("a strategy's own warmup runs once, before timing, instead of the first classify", async () => {
  let warmups = 0;
  let classifies = 0;
  const s: Strategy = {
    name: "w",
    warmup: () => { warmups += 1; return Promise.resolve(); },
    classify: () => { classifies += 1; return Promise.resolve("remember"); },
  };
  await evaluateStrategy(s, CORPUS.slice(0, 3), { stateChanging: MEM });
  assert.equal(warmups, 1);
  assert.equal(classifies, 3, "no extra warm-up classify");
  classifies = 0;
  const plain: Strategy = { name: "p", classify: () => { classifies += 1; return Promise.resolve("skip"); } };
  await evaluateStrategy(plain, CORPUS.slice(0, 3), { stateChanging: MEM });
  assert.equal(classifies, 4, "without warmup the first classify warms up");
});
