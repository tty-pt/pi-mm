import assert from "node:assert";
import { OVERVIEW_EXEMPLARS, OVERVIEW_KINDS } from "../src/judge/overview-exemplars.ts";
import { classifyOverviewByEmbedding } from "../src/judge/adapter.ts";
import {
  DEFAULT_CONFIG,
  loadConfig,
  applyEnv,
  describeCapabilities,
  overviewEmbed,
  overviewMinMargin,
  overviewMinSimilarity,
  overviewFallback,
  type MmConfig,
} from "../src/config.ts";
import {
  isDirectMemoryQuestion,
  evaluateDirectMemoryQuestion,
} from "../src/hooks/auto_recall.ts";

Deno.test("overview_routing: exemplars are bilingual, non-empty, and kinds are defined", () => {
  assert.ok(OVERVIEW_KINDS.has("overview_query"));
  assert.ok(OVERVIEW_KINDS.has("specific_query"));
  assert.strictEqual(OVERVIEW_KINDS.size, 2);

  assert.ok(Array.isArray(OVERVIEW_EXEMPLARS.overview_query));
  assert.ok(Array.isArray(OVERVIEW_EXEMPLARS.specific_query));
  assert.ok(OVERVIEW_EXEMPLARS.overview_query.length >= 5);
  assert.ok(OVERVIEW_EXEMPLARS.specific_query.length >= 5);

  const overviewTexts = OVERVIEW_EXEMPLARS.overview_query;
  const specificTexts = OVERVIEW_EXEMPLARS.specific_query;

  assert.ok(overviewTexts.length >= 5);
  assert.ok(specificTexts.length >= 5);

  // Check bilingual coverage (EN + PT)
  assert.ok(overviewTexts.some((s) => s.includes("what do you remember")));
  assert.ok(overviewTexts.some((s) => s.includes("panorama geral")));
  assert.ok(specificTexts.some((s) => s.includes("sampling rate")));
  assert.ok(specificTexts.some((s) => s.includes("taxa de amostragem")));
});

Deno.test("overview_routing: config defaults and environment parsing", () => {
  assert.strictEqual(overviewEmbed(DEFAULT_CONFIG), "auto");
  assert.strictEqual(DEFAULT_CONFIG.overviewMinMargin, 0.08);
  assert.strictEqual(DEFAULT_CONFIG.overviewMinSimilarity, 0.60);
  assert.strictEqual(DEFAULT_CONFIG.overviewFallback, "regex");
  assert.strictEqual(overviewMinMargin(DEFAULT_CONFIG), 0.08);
  assert.strictEqual(overviewMinSimilarity(DEFAULT_CONFIG), 0.60);
  assert.strictEqual(overviewFallback(DEFAULT_CONFIG), "regex");

  const loaded = loadConfig({
    overviewEmbed: "off",
    overviewMinMargin: 0.12,
    overviewMinSimilarity: 0.70,
    overviewFallback: "skip",
    overviewExemplars: {
      overview_query: ["Custom overview query"],
      specific_query: ["Custom specific query"],
    },
  });

  assert.strictEqual(loaded.overviewEmbed, "off");
  assert.strictEqual(loaded.overviewMinMargin, 0.12);
  assert.strictEqual(loaded.overviewMinSimilarity, 0.70);
  assert.strictEqual(loaded.overviewFallback, "skip");
  assert.deepStrictEqual(loaded.overviewExemplars?.overview_query, ["Custom overview query"]);

  // applyEnv overrides
  const envConfig = applyEnv(DEFAULT_CONFIG, {
    PI_MM_OVERVIEW_EMBED: "off",
    PI_MM_OVERVIEW_MIN_MARGIN: "0.15",
    PI_MM_OVERVIEW_MIN_SIMILARITY: "0.85",
    PI_MM_OVERVIEW_FALLBACK: "skip",
  });

  assert.strictEqual(envConfig.overviewEmbed, "off");
  assert.strictEqual(envConfig.overviewMinMargin, 0.15);
  assert.strictEqual(envConfig.overviewMinSimilarity, 0.85);
  assert.strictEqual(envConfig.overviewFallback, "skip");

  // Capabilities string output
  const caps = describeCapabilities(loaded);
  assert.ok(caps.includes("overview=regex"));

  const capsAuto = describeCapabilities(DEFAULT_CONFIG);
  assert.ok(capsAuto.includes("overview=embed"));
});

Deno.test("overview_routing: classifyOverviewByEmbedding with mock endpoint and gating", async () => {
  const baseCfg: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:9999",
    overviewMinSimilarity: 0.60,
    overviewMinMargin: 0.08,
  };

  // Case 1: Strong overview query matching
  const mockFetchOverview: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "overview_query",
      similarity: 0.91,
      margin: 0.30,
      scores: { overview_query: 0.91, specific_query: 0.61 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const v1 = await classifyOverviewByEmbedding("Synthesize all the key architectural decisions made across time", baseCfg, mockFetchOverview);
  assert.strictEqual(v1, "overview_query");

  // Case 2: Below similarity floor -> falls back to specific_query (targeted search)
  const mockFetchLowSim: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "overview_query",
      similarity: 0.50, // < 0.60
      margin: 0.15,
      scores: { overview_query: 0.50, specific_query: 0.35 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const v2 = await classifyOverviewByEmbedding("Vague sentence", baseCfg, mockFetchLowSim);
  assert.strictEqual(v2, "specific_query");

  // Case 3: Margin too narrow -> falls back to specific_query
  const mockFetchNarrowMargin: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "overview_query",
      similarity: 0.80,
      margin: 0.02, // < 0.08
      scores: { overview_query: 0.80, specific_query: 0.78 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const v3 = await classifyOverviewByEmbedding("Ambiguous query", baseCfg, mockFetchNarrowMargin);
  assert.strictEqual(v3, "specific_query");
});

Deno.test("overview_routing: evaluateDirectMemoryQuestion fallback behavior when endpoint offline", async () => {
  const offlineFetch: typeof fetch = () => {
    return Promise.reject(new Error("Connection refused"));
  };

  const regexMatchingPrompt = "give me an overview of all memories";
  const nonRegexPrompt = "synthesize our investigations across the codebase";

  // With default fallback: "regex"
  const defaultCfg: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:9999",
    overviewFallback: "regex",
  };

  assert.strictEqual(await evaluateDirectMemoryQuestion(regexMatchingPrompt, defaultCfg, offlineFetch), true);
  assert.strictEqual(await evaluateDirectMemoryQuestion(nonRegexPrompt, defaultCfg, offlineFetch), false);

  // With fallback: "skip"
  const skipCfg: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:9999",
    overviewFallback: "skip",
  };

  assert.strictEqual(await evaluateDirectMemoryQuestion(regexMatchingPrompt, skipCfg, offlineFetch), false);
  assert.strictEqual(await evaluateDirectMemoryQuestion(nonRegexPrompt, skipCfg, offlineFetch), false);

  // When overviewEmbed is "off"
  const offCfg: MmConfig = {
    ...DEFAULT_CONFIG,
    overviewEmbed: "off",
  };
  assert.strictEqual(await evaluateDirectMemoryQuestion(regexMatchingPrompt, offCfg, offlineFetch), true);
  assert.strictEqual(await evaluateDirectMemoryQuestion(nonRegexPrompt, offCfg, offlineFetch), false);
});

Deno.test("overview_routing: natural open-ended query caught by embeddings vs missed by regex", async () => {
  const naturalQuery = "Synthesize all the key architectural decisions made across time";

  // Legacy regex fails
  assert.strictEqual(isDirectMemoryQuestion(naturalQuery), false);

  // Mock embedding classifier succeeds
  const mockFetch: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "overview_query",
      similarity: 0.93,
      margin: 0.32,
      scores: { overview_query: 0.93, specific_query: 0.61 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const testCfg: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:4242",
  };

  const res = await evaluateDirectMemoryQuestion(naturalQuery, testCfg, mockFetch);
  assert.strictEqual(res, true);
});
