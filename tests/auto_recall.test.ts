import assert from "node:assert";
import {
  shouldTriggerAutoRecall,
  formatCompactMemoryEntry,
  buildInjectedContext,
  handleBeforeAgentStart,
  isDirectMemoryQuestion,
} from "../src/hooks/auto_recall.ts";
import type { FusedCandidate } from "../src/tools/ranking.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { CormRunner, Invocation } from "../src/corm.ts";
import type { PiExecResult } from "../src/hooks/events.ts";

Deno.test("auto_recall: shouldTriggerAutoRecall filters greetings and short inputs", () => {
  assert.strictEqual(shouldTriggerAutoRecall(""), false);
  assert.strictEqual(shouldTriggerAutoRecall("hi"), false);
  assert.strictEqual(shouldTriggerAutoRecall("hello!"), false);
  assert.strictEqual(shouldTriggerAutoRecall("thanks"), false);
  assert.strictEqual(shouldTriggerAutoRecall("thanks!!!"), false);
  assert.strictEqual(shouldTriggerAutoRecall("ok..."), false);
  assert.strictEqual(shouldTriggerAutoRecall("ok"), false);
  assert.strictEqual(shouldTriggerAutoRecall("yes"), false);
  assert.strictEqual(shouldTriggerAutoRecall("good morning"), false);

  assert.strictEqual(shouldTriggerAutoRecall("fix the corm_open leak in libcorm"), true);
  assert.strictEqual(shouldTriggerAutoRecall("how does session recovery work?"), true);
  assert.strictEqual(shouldTriggerAutoRecall("add support for ARM64 builds"), true);
});

Deno.test("auto_recall: formatCompactMemoryEntry formats ref, level, lifecycle, scope, and evidence", () => {
  const cand: FusedCandidate = {
    ref: 12,
    record: "2026-03-30:{}",
    origin: "lemma",
    rrfScore: 0.03,
    envelope: {
      level: "L2",
      type: "invariant",
      lifecycle: "supported",
      summary: "Invariant: corm_open must alias live handles on identical (file, map)",
      evidence: [8, 9],
      context: { project: "site", subsystem: "libcorm" },
    },
  };

  const formatted = formatCompactMemoryEntry(cand);
  assert.ok(formatted.includes("[Ref 12] (L2, supported, site/libcorm)"));
  assert.ok(formatted.includes("Invariant: corm_open must alias live handles"));
  assert.ok(formatted.includes("Evidence: cited refs [8, 9]"));
});

Deno.test("auto_recall: formatCompactMemoryEntry marks hypotheses explicitly", () => {
  const cand: FusedCandidate = {
    ref: 15,
    record: "2026-03-30:{}",
    origin: "sepal",
    rrfScore: 0.02,
    envelope: {
      level: "L1",
      type: "investigation",
      lifecycle: "hypothesized",
      summary: "Hypothesized root cause for WASM build crash",
      context: { project: "site" },
    },
  };

  const formatted = formatCompactMemoryEntry(cand);
  assert.ok(formatted.includes("[Ref 15] (L1, [HYPOTHESIS], site)"));
});

Deno.test("auto_recall: buildInjectedContext strictly excludes contradicted and superseded memories", () => {
  const candidates: FusedCandidate[] = [
    {
      ref: 1,
      record: "2026-03-30:{}",
      origin: "lemma",
      rrfScore: 0.04,
      envelope: {
        level: "L2",
        type: "invariant",
        lifecycle: "superseded",
        summary: "Old obsolete rule that must not be used",
      },
    },
    {
      ref: 2,
      record: "2026-03-30:{}",
      origin: "lemma",
      rrfScore: 0.03,
      envelope: {
        level: "L1",
        type: "investigation",
        lifecycle: "contradicted",
        summary: "Contradicted hypothesis disproven by testing",
      },
    },
    {
      ref: 3,
      record: "2026-03-30:{}",
      origin: "lemma",
      rrfScore: 0.02,
      envelope: {
        level: "L2",
        type: "invariant",
        lifecycle: "supported",
        summary: "Active supported invariant",
      },
    },
  ];

  const context = buildInjectedContext(candidates, 1500);
  assert.ok(!context.includes("Old obsolete rule"));
  assert.ok(!context.includes("Contradicted hypothesis"));
  assert.ok(context.includes("Active supported invariant"));
  assert.ok(context.includes("[Persistent Memory Context]"));
});

Deno.test("auto_recall: buildInjectedContext enforces character budget", () => {
  const candidates: FusedCandidate[] = [];
  for (let i = 1; i <= 20; i++) {
    candidates.push({
      ref: i,
      record: "2026-03-30:{}",
      origin: "lemma",
      rrfScore: 0.01,
      envelope: {
        level: "L2",
        type: "invariant",
        lifecycle: "supported",
        summary: `Invariant rule number ${i} with long descriptive explanation of architectural constraint`,
      },
    });
  }

  const budget = 300;
  const context = buildInjectedContext(candidates, budget);
  assert.ok(context.length <= budget, `Length ${context.length} must not exceed budget ${budget}`);
  assert.ok(context.includes("[Persistent Memory Context]"));
});

Deno.test("auto_recall: prompt-adaptive compression omits guidance for direct memory questions", () => {
  const candidates: FusedCandidate[] = [
    {
      ref: 1,
      record: "2026-10-15:{}",
      origin: "lemma",
      rrfScore: 0.05,
      envelope: {
        level: "L1",
        lifecycle: "supported",
        summary: "I spoke to my grandfather under the cherry tree",
      },
    },
  ];

  // Direct question: guidance omitted to free space for memories
  assert.strictEqual(isDirectMemoryQuestion("What do you remember?"), true);
  assert.strictEqual(isDirectMemoryQuestion("what do you recall"), true);
  assert.strictEqual(isDirectMemoryQuestion("tell me what you remember"), true);
  const directContext = buildInjectedContext(candidates, 1000, undefined, "What do you remember?");
  assert.ok(!directContext.includes("Usage guidelines:"), "Direct questions must omit guidance block");
  assert.ok(directContext.includes("cherry tree"));

  // Specific query or normal turn: guidance included
  assert.strictEqual(isDirectMemoryQuestion("Do you remember what dog I adopted in the mountains?"), false);
  assert.strictEqual(isDirectMemoryQuestion("Let's refactor the database connector"), false);
  const normalContext = buildInjectedContext(candidates, 1000, undefined, "Let's refactor the database connector");
  assert.ok(normalContext.includes("Usage guidelines:"), "Normal prompt must include guidance block");
});

function fakeRunner(results: PiExecResult[]): CormRunner {
  let idx = 0;
  return {
    run: (_inv: Invocation): Promise<PiExecResult> => {
      if (idx < results.length) {
        return Promise.resolve(results[idx++]);
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };
}

Deno.test("auto_recall: handleBeforeAgentStart injects context for relevant user prompts", async () => {
  const fakeStdout = "1 0.5 2026-03-30:" + JSON.stringify({
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "Always check corm_open handles before allocating new file descriptors",
    context: { project: "site" },
  }) + "\n";

  const runner = fakeRunner([{ stdout: fakeStdout, stderr: "", code: 0 }]);
  const env: ToolEnv = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-03-30"),
    cfg: {
      ...DEFAULT_CONFIG,
      memDir: ".pi/mm",
      cormBin: "/usr/bin/corm",
      scanLimit: 5,
    },
  };
  const envSource = () => Promise.resolve(env);

  const res = await handleBeforeAgentStart(
    { messageType: "user", prompt: "Fix the corm handle descriptor leak" },
    { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" },
    envSource,
  );

  assert.ok(res);
  assert.ok(res.message);
  assert.strictEqual(res.message.role, "custom");
  assert.strictEqual(res.message.customType, "memory_context");
  assert.strictEqual(res.message.display, true);
  assert.ok(typeof res.message.timestamp === "number");
  assert.ok(res.message.content.includes("Always check corm_open handles"));
});

Deno.test("auto_recall: handleBeforeAgentStart populates systemPromptOptions.sections and ensures role: custom for LLM conversion", async () => {
  const fakeStdout = "1 0.5 2026-03-30:" + JSON.stringify({
    level: "L1",
    type: "note",
    lifecycle: "observed",
    summary: "I spoke to my grandfather under the cherry tree",
  }) + "\n";

  const runner = fakeRunner([{ stdout: fakeStdout, stderr: "", code: 0 }]);
  const env: ToolEnv = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-03-30"),
    cfg: {
      ...DEFAULT_CONFIG,
      memDir: ".pi/mm",
      cormBin: "/usr/bin/corm",
      scanLimit: 5,
    },
  };
  const envSource = () => Promise.resolve(env);

  const event: import("../src/hooks/auto_recall.ts").BeforeAgentStartEvent = {
    messageType: "user",
    prompt: "Do you remember me speaking about my grandfather?",
    systemPromptOptions: {
      sections: {},
    },
  };

  const res = await handleBeforeAgentStart(
    event,
    { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" },
    envSource,
  );

  assert.ok(res);
  assert.ok(res.message);
  assert.strictEqual(res.message.role, "custom");
  assert.strictEqual(res.message.customType, "memory_context");
  assert.ok(res.message.content.includes("I spoke to my grandfather under the cherry tree"));

  // Verify systemPromptOptions was augmented
  assert.ok(event.systemPromptOptions?.sections);
  assert.ok(event.systemPromptOptions.sections["memory_context"]);
  assert.ok(event.systemPromptOptions.sections["memory_context"]?.includes("I spoke to my grandfather under the cherry tree"));
});

Deno.test("auto_recall: handleBeforeAgentStart returns null for greeting or custom messages", async () => {
  const runner = fakeRunner([]);
  const env: ToolEnv = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-03-30"),
    cfg: { ...DEFAULT_CONFIG, memDir: ".pi/mm", cormBin: "/usr/bin/corm", scanLimit: 5 },
  };
  const envSource = () => Promise.resolve(env);

  // Greeting
  const resGreeting = await handleBeforeAgentStart(
    { messageType: "user", prompt: "hello" },
    { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" },
    envSource,
  );
  assert.strictEqual(resGreeting, null);

  // Custom message
  const resCustom = await handleBeforeAgentStart(
    { messageType: "custom" },
    { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" },
    envSource,
  );
  assert.strictEqual(resCustom, null);
});

Deno.test("auto_recall: fast success clears timers with zero redundant fallback queries", async () => {
  let invocationCount = 0;
  const runner: CormRunner = {
    run: (_inv) => {
      invocationCount++;
      const payload = "1 0.5 2026-03-30:" + JSON.stringify({
        level: "L2", type: "invariant", lifecycle: "supported", summary: "Fast memory",
      }) + "\n";
      return Promise.resolve({ stdout: payload, stderr: "", code: 0 });
    },
  };
  const env: ToolEnv = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-03-30"),
    cfg: { ...DEFAULT_CONFIG, memDir: ".pi/mm", cormBin: "/usr/bin/corm", scanLimit: 5 },
  };

  const res = await handleBeforeAgentStart(
    { messageType: "user", prompt: "Fix memory leak in corm" },
    { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" },
    () => Promise.resolve(env),
    { timeoutMs: 80 },
  );

  assert.ok(res);
  const initialInvocations = invocationCount;

  // Wait beyond the 80ms timeout window to verify no delayed timer fired
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(invocationCount, initialInvocations, "No delayed fallback queries must run after fast success");
});

Deno.test("auto_recall: delayed semantic retrieval triggers bounded lexical fallback", async () => {
  const queryTypes: string[] = [];
  const runner: CormRunner = {
    run: async (inv) => {
      const hasSepal = inv.args.some((a) => a.includes("sepal"));
      if (hasSepal) {
        queryTypes.push("semantic");
        // Simulate hung / slow remote semantic embedding call
        await new Promise((r) => setTimeout(r, 200));
        return { stdout: "", stderr: "delayed", code: 0 };
      }
      queryTypes.push("lexical");
      const payload = "2 0.8 2026-03-30:" + JSON.stringify({
        level: "L2", type: "invariant", lifecycle: "supported", summary: "Lexical fallback memory",
      }) + "\n";
      return { stdout: payload, stderr: "", code: 0 };
    },
  };
  const env: ToolEnv = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-03-30"),
    cfg: {
      ...DEFAULT_CONFIG,
      memDir: ".pi/mm",
      cormBin: "/usr/bin/corm",
      scanLimit: 5,
      embedUrl: "http://localhost:4242/v1/embeddings",
      embedModel: "nomic-embed-text",
    },
  };

  const res = await handleBeforeAgentStart(
    { messageType: "user", prompt: "Encountering descriptor exhaustion in corm" },
    { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" },
    () => Promise.resolve(env),
    { timeoutMs: 90 },
  );

  assert.ok(res, "Fallback should produce memory context");
  assert.ok(res.message?.content.includes("Lexical fallback memory"));
  assert.ok(queryTypes.includes("lexical"), "Lexical fallback must be invoked when semantic hangs");
});

Deno.test("auto_recall: stalled fallback does not exceed overall deadline", async () => {
  const runner: CormRunner = {
    run: async () => {
      // Simulate completely hung processes for both attempts
      await new Promise((r) => setTimeout(r, 500));
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  const env: ToolEnv = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-03-30"),
    cfg: { ...DEFAULT_CONFIG, memDir: ".pi/mm", cormBin: "/usr/bin/corm", scanLimit: 5 },
  };

  const t0 = performance.now();
  const res = await handleBeforeAgentStart(
    { messageType: "user", prompt: "Fix the corm handle descriptor leak" },
    { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" },
    () => Promise.resolve(env),
    { timeoutMs: 80 },
  );
  const elapsed = performance.now() - t0;

  assert.strictEqual(res, null, "Stalled retrieval must return null");
  // Total elapsed time must be bounded near the 80ms timeout, well under the 500ms stall
  assert.ok(elapsed < 200, `Elapsed ${elapsed}ms must be bounded near deadline`);
});
