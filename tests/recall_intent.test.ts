import assert from "node:assert";
import { RECALL_EXEMPLARS, RECALL_KINDS } from "../src/judge/recall-exemplars.ts";
import { classifyRecallByEmbedding } from "../src/judge/adapter.ts";
import {
  DEFAULT_CONFIG,
  loadConfig,
  applyEnv,
  describeCapabilities,
  recallEmbed,
  recallMinMargin,
  recallMinSimilarity,
  recallFallback,
  type MmConfig,
} from "../src/config.ts";
import {
  evaluateRecallIntent,
  handleBeforeAgentStart,
  buildInjectedContext,
  type BeforeAgentStartEvent,
} from "../src/hooks/auto_recall.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { CormRunner } from "../src/corm.ts";
import type { FusedCandidate } from "../src/tools/ranking.ts";

Deno.test("recall_intent: exemplars are bilingual, non-empty, and kinds are defined", () => {
  assert.ok(RECALL_KINDS.has("recall_past"));
  assert.ok(RECALL_KINDS.has("standalone"));
  assert.strictEqual(RECALL_KINDS.size, 2);

  assert.ok(Array.isArray(RECALL_EXEMPLARS.recall_past));
  assert.ok(Array.isArray(RECALL_EXEMPLARS.standalone));
  assert.ok(RECALL_EXEMPLARS.recall_past.length >= 20);
  assert.ok(RECALL_EXEMPLARS.standalone.length >= 20);

  // Check bilingual coverage (EN + PT)
  assert.ok(RECALL_EXEMPLARS.recall_past.some((s) => s.startsWith("Why did we")));
  assert.ok(RECALL_EXEMPLARS.recall_past.some((s) => s.startsWith("Por que razão")));
  assert.ok(RECALL_EXEMPLARS.standalone.some((s) => s.startsWith("Refactor")));
  assert.ok(RECALL_EXEMPLARS.standalone.some((s) => s.startsWith("Refatora")));
});

Deno.test("recall_intent: config defaults and environment parsing", () => {
  assert.strictEqual(recallEmbed(DEFAULT_CONFIG), "auto");
  assert.strictEqual(DEFAULT_CONFIG.recallMinMargin, 0.08);
  assert.strictEqual(DEFAULT_CONFIG.recallMinSimilarity, 0.60);
  assert.strictEqual(DEFAULT_CONFIG.recallFallback, "regex");
  assert.strictEqual(recallMinMargin(DEFAULT_CONFIG), 0.08);
  assert.strictEqual(recallMinSimilarity(DEFAULT_CONFIG), 0.60);
  assert.strictEqual(recallFallback(DEFAULT_CONFIG), "regex");

  const loaded = loadConfig({
    recallEmbed: "off",
    recallMinMargin: 0.12,
    recallMinSimilarity: 0.75,
    recallFallback: "skip",
    recallExemplars: {
      recall_past: ["Custom recall probe"],
      standalone: ["Custom standalone probe"],
    },
  });

  assert.strictEqual(loaded.recallEmbed, "off");
  assert.strictEqual(loaded.recallMinMargin, 0.12);
  assert.strictEqual(loaded.recallMinSimilarity, 0.75);
  assert.strictEqual(loaded.recallFallback, "skip");
  assert.deepStrictEqual(loaded.recallExemplars?.recall_past, ["Custom recall probe"]);

  // applyEnv overrides
  const envConfig = applyEnv(DEFAULT_CONFIG, {
    PI_MM_RECALL_EMBED: "off",
    PI_MM_RECALL_MIN_MARGIN: "0.15",
    PI_MM_RECALL_MIN_SIMILARITY: "0.80",
    PI_MM_RECALL_FALLBACK: "skip",
  });

  assert.strictEqual(envConfig.recallEmbed, "off");
  assert.strictEqual(envConfig.recallMinMargin, 0.15);
  assert.strictEqual(envConfig.recallMinSimilarity, 0.80);
  assert.strictEqual(envConfig.recallFallback, "skip");

  // Capabilities string
  const descAuto = describeCapabilities(DEFAULT_CONFIG);
  assert.ok(descAuto.includes("recall=embed (/v1/classify"));

  const descOff = describeCapabilities({ ...DEFAULT_CONFIG, recallEmbed: "off" });
  assert.ok(descOff.includes("recall=regex"));
});

Deno.test("recall_intent: classifyRecallByEmbedding with mock endpoint and gating", async () => {
  const cfg: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:4242",
    recallMinSimilarity: 0.60,
    recallMinMargin: 0.08,
  };

  // Mock server returning high-confidence recall_past
  const mockFetchRecall: typeof fetch = (_input, _init) => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "recall_past",
      similarity: 0.85,
      margin: 0.20,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const res1 = await classifyRecallByEmbedding("Why did we choose static buffers?", cfg, mockFetchRecall);
  assert.strictEqual(res1, "recall_past");

  // Mock server returning standalone
  const mockFetchStandalone: typeof fetch = (_input, _init) => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "standalone",
      similarity: 0.88,
      margin: 0.15,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const res2 = await classifyRecallByEmbedding("Refactor this loop", cfg, mockFetchStandalone);
  assert.strictEqual(res2, "standalone");

  // Low similarity below minSimilarity floor -> gates to harmless "standalone"
  const mockFetchLowSim: typeof fetch = (_input, _init) => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "recall_past",
      similarity: 0.45, // below 0.60
      margin: 0.25,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const res3 = await classifyRecallByEmbedding("Vague sentence", cfg, mockFetchLowSim);
  assert.strictEqual(res3, "standalone", "Low similarity must fall back to standalone");

  // Low margin below minMargin -> gates to harmless "standalone"
  const mockFetchLowMargin: typeof fetch = (_input, _init) => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "recall_past",
      similarity: 0.75,
      margin: 0.02, // below 0.08
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const res4 = await classifyRecallByEmbedding("Ambiguous query", cfg, mockFetchLowMargin);
  assert.strictEqual(res4, "standalone", "Low margin must fall back to standalone");
});

Deno.test("recall_intent: evaluateRecallIntent fallback behavior when endpoint offline", async () => {
  const cfgDefault: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:4242",
    recallFallback: "regex",
  };

  // Mock fetch failure (simulating offline server)
  const failingFetch: typeof fetch = () => {
    return Promise.reject(new Error("Connection refused"));
  };

  // With regex fallback: explicit recall question resolves to true
  const resRegexTrue = await evaluateRecallIntent(
    "What did we decide about the database schema?",
    cfgDefault,
    failingFetch,
  );
  assert.strictEqual(resRegexTrue, true, "Offline server should fall back to regex matching true");

  // With regex fallback: direct task resolves to false
  const resRegexFalse = await evaluateRecallIntent(
    "Refactor parse_header in site.c",
    cfgDefault,
    failingFetch,
  );
  assert.strictEqual(resRegexFalse, false, "Offline server should fall back to regex matching false");

  // With skip fallback: always returns false when endpoint fails
  const cfgSkip: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:4242",
    recallFallback: "skip",
  };

  const resSkip = await evaluateRecallIntent(
    "What did we decide about the database schema?",
    cfgSkip,
    failingFetch,
  );
  assert.strictEqual(resSkip, false, "Offline server with fallback: skip must return false");
});

Deno.test("recall_intent: buildInjectedContext lifts unprompted drop when recallIntentConfirmed is true", () => {
  const cand: FusedCandidate = {
    ref: 10,
    record: "2026-10-16:{}",
    origin: "lemma",
    rrfScore: 0.5,
    envelope: {
      level: "L2",
      type: "invariant",
      lifecycle: "supported",
      summary: "All memory writes must go through source_update_item, never direct var/",
    },
  };

  // Without recall intent confirmed, natural prompt with no subsystem yields empty string
  const prompt = "Why did we choose that write approach?";
  const unprompted = buildInjectedContext([cand], 1000, undefined, prompt, false);
  assert.strictEqual(unprompted, "", "Without recall intent, unprompted prompt yields empty string");

  // With recall intent confirmed, context is injected!
  const prompted = buildInjectedContext([cand], 1000, undefined, prompt, true);
  assert.ok(prompted.includes("[Persistent Memory Context]"));
  assert.ok(prompted.includes("All memory writes must go through source_update_item"));
});

Deno.test("recall_intent: handleBeforeAgentStart end-to-end with positive recall intent", async () => {
  const runner: CormRunner = {
    run: (_inv: unknown) => {
      const payload = "10 0.9 2026-10-16:" + JSON.stringify({
        level: "L2",
        type: "invariant",
        lifecycle: "supported",
        summary: "Static buffers are required for zero-alloc parser safety",
      }) + "\n";
      return Promise.resolve({ stdout: payload, stderr: "", code: 0 });
    },
  };

  const env: ToolEnv = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-10-16"),
    cfg: {
      ...DEFAULT_CONFIG,
      memDir: ".pi/mm",
      cormBin: "/usr/bin/corm",
      scanLimit: 5,
      captureEmbedUrl: "http://127.0.0.1:4242",
    },
  };

  const mockFetchRecall: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "recall_past",
      similarity: 0.90,
      margin: 0.25,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const event: BeforeAgentStartEvent = {
    messageType: "user",
    prompt: "Why did we choose static buffers instead of malloc?",
    systemPromptOptions: { sections: {} },
  };

  const res = await handleBeforeAgentStart(
    event,
    { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" },
    () => Promise.resolve(env),
    { fetchFn: mockFetchRecall },
  );

  assert.ok(res !== null);
  assert.ok(res.message);
  assert.strictEqual(res.message.role, "custom");
  assert.strictEqual(res.message.customType, "memory_context");

  const content = res.message.content || "";
  // Check memory content
  assert.ok(content.includes("Static buffers are required for zero-alloc parser safety"));
  // Check explicit tool guidance nudge (R4)
  assert.ok(content.includes("[Memory Intent Detected]"));
  assert.ok(content.includes("memory_recall"));

  // Check that systemPromptOptions.sections was populated
  assert.ok(event.systemPromptOptions?.sections);
  assert.ok(event.systemPromptOptions.sections["memory_context"]);
  assert.strictEqual(event.systemPromptOptions.sections["memory_context"], content);
});

Deno.test("recall_intent: handleBeforeAgentStart nudges agent when recall intent positive but DB empty", async () => {
  const runner: CormRunner = {
    run: (_inv: unknown) => {
      // Empty DB listing
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const env: ToolEnv = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-10-16"),
    cfg: {
      ...DEFAULT_CONFIG,
      memDir: ".pi/mm",
      cormBin: "/usr/bin/corm",
      scanLimit: 5,
      captureEmbedUrl: "http://127.0.0.1:4242",
    },
  };

  const mockFetchRecall: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "recall_past",
      similarity: 0.88,
      margin: 0.22,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const event: BeforeAgentStartEvent = {
    messageType: "user",
    prompt: "What was our agreed decision on transaction boundaries?",
    systemPromptOptions: { sections: {} },
  };

  const res = await handleBeforeAgentStart(
    event,
    { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" },
    () => Promise.resolve(env),
    { fetchFn: mockFetchRecall },
  );

  assert.ok(res !== null, "Even with empty DB, positive recall intent must inject a notice");
  assert.ok(res.message);
  const content = res.message.content || "";
  assert.ok(content.includes("[Persistent Memory Notice]"));
  assert.ok(content.includes("memory_recall"));
  assert.ok(event.systemPromptOptions?.sections?.["memory_context"]?.includes("[Persistent Memory Notice]"));
});
