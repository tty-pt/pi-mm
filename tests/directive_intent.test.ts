import assert from "node:assert";
import { DIRECTIVE_EXEMPLARS, DIRECTIVE_KINDS } from "../src/judge/directive-exemplars.ts";
import { classifyDirectiveByEmbedding } from "../src/judge/adapter.ts";
import {
  DEFAULT_CONFIG,
  loadConfig,
  applyEnv,
  describeCapabilities,
  directiveEmbed,
  directiveMinMargin,
  directiveMinSimilarity,
  directiveFallback,
  type MmConfig,
} from "../src/config.ts";
import {
  isStandingDirective,
  evaluateStandingDirective,
} from "../src/hooks/reinforcement.ts";

Deno.test("directive_intent: exemplars are bilingual, non-empty, and kinds are defined", () => {
  assert.ok(DIRECTIVE_KINDS.has("standing_directive"));
  assert.ok(DIRECTIVE_KINDS.has("transient_task"));
  assert.strictEqual(DIRECTIVE_KINDS.size, 2);

  assert.ok(Array.isArray(DIRECTIVE_EXEMPLARS.standing_directive));
  assert.ok(Array.isArray(DIRECTIVE_EXEMPLARS.transient_task));
  assert.ok(DIRECTIVE_EXEMPLARS.standing_directive.length >= 10);
  assert.ok(DIRECTIVE_EXEMPLARS.transient_task.length >= 10);

  const directiveTexts = DIRECTIVE_EXEMPLARS.standing_directive;
  const taskTexts = DIRECTIVE_EXEMPLARS.transient_task;

  assert.ok(directiveTexts.length >= 10);
  assert.ok(taskTexts.length >= 10);

  // Check bilingual coverage (EN + PT)
  assert.ok(directiveTexts.some((s) => s.includes("always remember")));
  assert.ok(directiveTexts.some((s) => s.includes("regra permanente")));
  assert.ok(taskTexts.some((s) => s.includes("please fix")));
  assert.ok(taskTexts.some((s) => s.includes("onde fica o arquivo")));
});

Deno.test("directive_intent: config defaults and environment parsing", () => {
  assert.strictEqual(directiveEmbed(DEFAULT_CONFIG), "auto");
  assert.strictEqual(DEFAULT_CONFIG.directiveMinMargin, 0.08);
  assert.strictEqual(DEFAULT_CONFIG.directiveMinSimilarity, 0.60);
  assert.strictEqual(DEFAULT_CONFIG.directiveFallback, "regex");
  assert.strictEqual(directiveMinMargin(DEFAULT_CONFIG), 0.08);
  assert.strictEqual(directiveMinSimilarity(DEFAULT_CONFIG), 0.60);
  assert.strictEqual(directiveFallback(DEFAULT_CONFIG), "regex");

  const loaded = loadConfig({
    directiveEmbed: "off",
    directiveMinMargin: 0.15,
    directiveMinSimilarity: 0.75,
    directiveFallback: "skip",
    directiveExemplars: {
      standing_directive: ["Custom rule exemplar"],
      transient_task: ["Custom task exemplar"],
    },
  });

  assert.strictEqual(loaded.directiveEmbed, "off");
  assert.strictEqual(loaded.directiveMinMargin, 0.15);
  assert.strictEqual(loaded.directiveMinSimilarity, 0.75);
  assert.strictEqual(loaded.directiveFallback, "skip");
  assert.deepStrictEqual(loaded.directiveExemplars?.standing_directive, ["Custom rule exemplar"]);

  // applyEnv overrides
  const envConfig = applyEnv(DEFAULT_CONFIG, {
    PI_MM_DIRECTIVE_EMBED: "off",
    PI_MM_DIRECTIVE_MIN_MARGIN: "0.12",
    PI_MM_DIRECTIVE_MIN_SIMILARITY: "0.80",
    PI_MM_DIRECTIVE_FALLBACK: "skip",
  });

  assert.strictEqual(envConfig.directiveEmbed, "off");
  assert.strictEqual(envConfig.directiveMinMargin, 0.12);
  assert.strictEqual(envConfig.directiveMinSimilarity, 0.80);
  assert.strictEqual(envConfig.directiveFallback, "skip");

  // Capabilities string output
  const caps = describeCapabilities(loaded);
  assert.ok(caps.includes("directive=regex"));

  const capsAuto = describeCapabilities(DEFAULT_CONFIG);
  assert.ok(capsAuto.includes("directive=embed"));
});

Deno.test("directive_intent: classifyDirectiveByEmbedding with mock endpoint and gating", async () => {
  const baseCfg: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:9999",
    directiveMinSimilarity: 0.60,
    directiveMinMargin: 0.08,
  };

  // Case 1: Strong directive matching
  const mockFetchDirective: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "standing_directive",
      similarity: 0.92,
      margin: 0.25,
      scores: { standing_directive: 0.92, transient_task: 0.67 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const v1 = await classifyDirectiveByEmbedding("Make sure we never write raw SQL in handlers", baseCfg, mockFetchDirective);
  assert.strictEqual(v1, "standing_directive");

  // Case 2: Below similarity floor -> falls back to harmless transient_task
  const mockFetchLowSim: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "standing_directive",
      similarity: 0.45, // < 0.60
      margin: 0.15,
      scores: { standing_directive: 0.45, transient_task: 0.30 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const v2 = await classifyDirectiveByEmbedding("Maybe something about a rule", baseCfg, mockFetchLowSim);
  assert.strictEqual(v2, "transient_task");

  // Case 3: Margin too narrow -> falls back to harmless transient_task
  const mockFetchNarrowMargin: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "standing_directive",
      similarity: 0.85,
      margin: 0.03, // < 0.08
      scores: { standing_directive: 0.85, transient_task: 0.82 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const v3 = await classifyDirectiveByEmbedding("Ambiguous sentence", baseCfg, mockFetchNarrowMargin);
  assert.strictEqual(v3, "transient_task");
});

Deno.test("directive_intent: evaluateStandingDirective fallback behavior when endpoint offline", async () => {
  const offlineFetch: typeof fetch = () => {
    return Promise.reject(new Error("Connection refused"));
  };

  const regexMatchingPrompt = "always remember to keep files clean";
  const nonRegexPrompt = "write a function to parse the json string";

  // With default fallback: "regex"
  const defaultCfg: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:9999",
    directiveFallback: "regex",
  };

  assert.strictEqual(await evaluateStandingDirective(regexMatchingPrompt, defaultCfg, offlineFetch), true);
  assert.strictEqual(await evaluateStandingDirective(nonRegexPrompt, defaultCfg, offlineFetch), false);

  // With fallback: "skip"
  const skipCfg: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:9999",
    directiveFallback: "skip",
  };

  assert.strictEqual(await evaluateStandingDirective(regexMatchingPrompt, skipCfg, offlineFetch), false);
  assert.strictEqual(await evaluateStandingDirective(nonRegexPrompt, skipCfg, offlineFetch), false);

  // When directiveEmbed is "off"
  const offCfg: MmConfig = {
    ...DEFAULT_CONFIG,
    directiveEmbed: "off",
  };
  assert.strictEqual(await evaluateStandingDirective(regexMatchingPrompt, offCfg, offlineFetch), true);
  assert.strictEqual(await evaluateStandingDirective(nonRegexPrompt, offCfg, offlineFetch), false);
});

Deno.test("directive_intent: natural phrasing caught by embeddings vs missed by regex", async () => {
  const naturalDirective = "Make sure we never write raw SQL queries in request handlers";

  // Legacy regex fails
  assert.strictEqual(isStandingDirective(naturalDirective), false);

  // Mock embedding classifier succeeds
  const mockFetch: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "standing_directive",
      similarity: 0.94,
      margin: 0.35,
      scores: { standing_directive: 0.94, transient_task: 0.59 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const testCfg: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:4242",
  };

  const res = await evaluateStandingDirective(naturalDirective, testCfg, mockFetch);
  assert.strictEqual(res, true);
});
