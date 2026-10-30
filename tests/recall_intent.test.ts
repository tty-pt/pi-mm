import assert from "node:assert";
import { RECALL_EXEMPLARS, RECALL_KINDS } from "../src/judge/recall-exemplars.ts";
import { classifyRecallByEmbedding } from "../src/judge/adapter.ts";
import { clearEmbedState } from "../src/judge/embed.ts";
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
import { STOP_WORDS, scanTokenFallback } from "../src/tools/scan.ts";
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
  clearEmbedState();
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
      recallAction: "query",
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

Deno.test("recall_intent: handleBeforeAgentStart in hint mode executes zero database queries and sets display false", async () => {
  let scanCalls = 0;
  const runner: CormRunner = {
    run: (_inv: unknown) => {
      scanCalls++;
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
      recallAction: "hint",
      captureEmbedUrl: "http://127.0.0.1:4242",
    },
  };

  const mockFetchRecall: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "recall_past",
      similarity: 0.95,
      margin: 0.35,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const event: BeforeAgentStartEvent = {
    messageType: "user",
    prompt: "Do you remember me mentioning my grand dad?",
    systemPromptOptions: { sections: {} },
  };

  const res = await handleBeforeAgentStart(
    event,
    { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" },
    () => Promise.resolve(env),
    { fetchFn: mockFetchRecall },
  );

  assert.ok(res !== null, "Must return a custom message");
  assert.ok(res.message);
  assert.strictEqual(res.message.display, false, "Must set display: false to prevent UI pollution");
  assert.strictEqual(scanCalls, 0, "Must execute zero database queries in hint mode");

  const content = res.message.content || "";
  assert.ok(content.includes("[Memory Intent Detected]"));
  assert.ok(content.includes("memory_recall"));
  assert.strictEqual(event.systemPromptOptions?.sections?.["memory_context"], content);
});

Deno.test("recall_intent: architectural wondering prompts emit epistemic hint without database queries", async () => {
  let scanCalls = 0;
  const runner: CormRunner = {
    run: (_inv: unknown) => {
      scanCalls++;
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
      recallAction: "hint",
      captureEmbedUrl: "http://127.0.0.1:4242",
    },
  };

  const mockFetchRecall: typeof fetch = () => {
    return Promise.resolve(new Response(JSON.stringify({
      choice: "recall_past",
      similarity: 0.91,
      margin: 0.28,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  const event: BeforeAgentStartEvent = {
    messageType: "user",
    prompt: "How does the caching layer work in this project?",
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
  assert.strictEqual(res.message.display, false);
  assert.strictEqual(scanCalls, 0, "Zero database scans on architectural wondering");
  assert.ok(res.message.content?.includes("[Memory Intent Detected]"));
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
      recallAction: "query",
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
  assert.strictEqual(res.message.display, false, "Notice message must have display: false to avoid UI pollution");
  const content = res.message.content || "";
  assert.ok(content.includes("[Persistent Memory Notice]"));
  assert.ok(content.includes("memory_recall"));
  assert.ok(event.systemPromptOptions?.sections?.["memory_context"]?.includes("[Persistent Memory Notice]"));
});

Deno.test("recall_intent: STOP_WORDS filters conversational stop words without regex heuristics", () => {
  // Conversational verbs and pronouns must be in STOP_WORDS
  assert.ok(STOP_WORDS.has("remember"), "remember must be a stopword");
  assert.ok(STOP_WORDS.has("recall"), "recall must be a stopword");
  assert.ok(STOP_WORDS.has("mention"), "mention must be a stopword");
  assert.ok(STOP_WORDS.has("mentioning"), "mentioning must be a stopword");
  assert.ok(STOP_WORDS.has("you"), "you must be a stopword");
  assert.ok(STOP_WORDS.has("me"), "me must be a stopword");
  assert.ok(STOP_WORDS.has("i"), "i must be a stopword");
  assert.ok(STOP_WORDS.has("we"), "we must be a stopword");
  assert.ok(STOP_WORDS.has("tell"), "tell must be a stopword");
  assert.ok(STOP_WORDS.has("told"), "told must be a stopword");
  assert.ok(STOP_WORDS.has("say"), "say must be a stopword");
  assert.ok(STOP_WORDS.has("said"), "said must be a stopword");

  // Non-regex token filtering drops conversational words naturally
  const rawPrompt = "Do you remember me mentioning my grand dad?";
  const tokens = rawPrompt.split(/\s+/)
    .map((w) => w.replace(/[^\w-]/g, "").toLowerCase())
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

  assert.deepStrictEqual(tokens, ["grand", "dad"], "Tokens must contain only content words ['grand', 'dad']");
});

Deno.test("recall_intent: buildInjectedContext strictly filters question-memories even on explicit recall", () => {
  const questionCand: FusedCandidate = {
    ref: 7167,
    record: "In general, what do you remember?",
    origin: "both",
    rrfScore: 0.95,
    level: "L1",
    lifecycle: "observed",
    summary: "In general, what do you remember?",
    score: "0.95",
    rankingScore: 0.95,
    envelope: {
      type: "investigation",
      level: "L1",
      lifecycle: "observed",
      summary: "In general, what do you remember?",
      episode: {
        problem: "In general, what do you remember?",
        approaches: [{ approach: "Scanned memories", outcome: "worked", reason: "Found 8 records" }],
      },
    },
  };

  const factualCand: FusedCandidate = {
    ref: 901,
    record: "I talked to my grandfather under the cherry tree",
    origin: "both",
    rrfScore: 0.90,
    level: "L1",
    lifecycle: "observed",
    summary: "I talked to my grandfather under the cherry tree",
    score: "0.90",
    rankingScore: 0.90,
    envelope: {
      type: "investigation",
      level: "L1",
      lifecycle: "observed",
      summary: "I talked to my grandfather under the cherry tree",
      episode: {
        problem: "Record this into memory: I talked to my grandfather under the cherry tree",
        approaches: [{ approach: "Recorded personal note", outcome: "worked", reason: "User explicit request" }],
      },
    },
  };

  // With explicit recall intent confirmed:
  const prompt = "Do you remember me mentioning my grand dad?";
  const context = buildInjectedContext([questionCand, factualCand], 1000, undefined, prompt, true);

  // Question memory Ref 7167 must be filtered out!
  assert.ok(!context.includes("In general, what do you remember?"), "Question-memories must not be injected into context");
  // Factual memory Ref 901 must be preserved!
  assert.ok(context.includes("I talked to my grandfather under the cherry tree"), "Factual memory must be retained");
});

Deno.test("recall_intent: scanTokenFallback queries only non-stopword tokens, never conversational words", async () => {
  const tokenQueries: string[] = [];
  const runner: CormRunner = {
    run: (inv: unknown) => {
      const invStr = JSON.stringify(inv);
      tokenQueries.push(invStr);
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

  const topic = "Do you remember me mentioning my grand dad?";
  await scanTokenFallback(env, "/tmp/fake-cwd", "text", 5, "joint,lemma:a:b", 0, new Date("2026-10-16"), undefined, topic);

  assert.ok(
    tokenQueries.some((q) => q.includes("--query=dad") || q.includes("--query=grand")),
    `Token queries must contain 'dad' or 'grand', got: ${JSON.stringify(tokenQueries)}`,
  );
  assert.ok(
    !tokenQueries.some((q) => q.includes("remember")),
    `Token queries must NOT query 'remember', got: ${JSON.stringify(tokenQueries)}`,
  );
  assert.ok(
    !tokenQueries.some((q) => q.includes("mentioning")),
    `Token queries must NOT query 'mentioning', got: ${JSON.stringify(tokenQueries)}`,
  );
});
