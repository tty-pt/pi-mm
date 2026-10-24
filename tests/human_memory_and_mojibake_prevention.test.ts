import { strict as assert } from "node:assert";
import { decodePayload, isCleanSummaryText } from "../src/payload.ts";
import { isInformativeExecution } from "../src/hooks/events.ts";
import { isMemoryRecallPrompt, shouldTriggerAutoRecall, buildInjectedContext } from "../src/hooks/auto_recall.ts";
import { isQuestionMemory, filterAndEnrich, type FusedCandidate } from "../src/tools/ranking.ts";

Deno.test("human_memory: isCleanSummaryText rejects mojibake and accepts clean multilingual text", () => {
  // 1. Corrupted mojibake strings from real session
  const mojibake1 = "“  ¡or »w´“ü 2Û & ¡ 7b0Ì1Ï 7© 1792871121360-t5b0ùKª";
  const mojibake2 = "“  ¡o~ë\nq-†Á;çï‡<j¡ ì a0945© 1792871963652-Èlwg7zª";
  assert.strictEqual(isCleanSummaryText(mojibake1), false, "Mojibake 1 must be rejected");
  assert.strictEqual(isCleanSummaryText(mojibake2), false, "Mojibake 2 must be rejected");

  // 2. UTF-8 replacement character
  assert.strictEqual(isCleanSummaryText("Invalid data \uFFFD here"), false, "Replacement char must be rejected");

  // 3. Null bytes / unprintable control characters
  assert.strictEqual(isCleanSummaryText("Corrupted \x00 binary \x05 stream"), false, "Control bytes must be rejected");

  // 4. Clean text in various human languages
  assert.strictEqual(isCleanSummaryText("I spoke to my grandfather under the cherry tree"), true);
  assert.strictEqual(isCleanSummaryText("Always check corm_open handles before allocating"), true);
  assert.strictEqual(isCleanSummaryText("São Paulo é uma cidade linda"), true);
  assert.strictEqual(isCleanSummaryText("Café e pão na mesa"), true);
});

Deno.test("human_memory: decodePayload quarantines corrupted text as contradicted L0 rather than L2 observed", () => {
  const mojibake = "“  ¡or »w´“ü 2Û & ¡ 7b0Ì1Ï 7© 1792871121360-t5b0ùKª";
  const decoded = decodePayload(`2026-10-24:${mojibake}`);

  assert.strictEqual(decoded.envelope.level, "L0", "Corrupted payload must not be promoted to L2");
  assert.strictEqual(decoded.envelope.lifecycle, "contradicted", "Corrupted payload must be marked contradicted");
  assert.ok(decoded.envelope.summary.includes("[Corrupted payload"), "Summary must indicate corruption");
});

Deno.test("human_memory: isInformativeExecution drops memory recall and introspection tools", () => {
  assert.strictEqual(
    isInformativeExecution({
      toolName: "memory_recall",
      content: [{ type: "text", text: "Found 3 relevant memory records" }],
      isError: false,
    }),
    false,
    "memory_recall must not enter episodic memory"
  );

  assert.strictEqual(
    isInformativeExecution({
      toolName: "vcc_recall",
      content: [{ type: "text", text: "Session history entries" }],
      isError: false,
    }),
    false,
    "vcc_recall must not enter episodic memory"
  );

  assert.strictEqual(
    isInformativeExecution({
      toolName: "memory_review",
      content: [{ type: "text", text: "Review Inspection for Ref 195" }],
      isError: false,
    }),
    false,
    "memory_review must not enter episodic memory"
  );
});

Deno.test("human_memory: isMemoryRecallPrompt identifies epistemic inquiries", () => {
  assert.strictEqual(isMemoryRecallPrompt("Do you remember me mentioning my grandfather?"), true);
  assert.strictEqual(isMemoryRecallPrompt("Do you remember grandpa?"), true);
  assert.strictEqual(isMemoryRecallPrompt("What do you recall about the audio engine?"), true);
  assert.strictEqual(isMemoryRecallPrompt("What did I say earlier?"), true);
  assert.strictEqual(isMemoryRecallPrompt("Did I mention my aunt?"), true);
  assert.strictEqual(isMemoryRecallPrompt("Remind me what decision was made"), true);

  // Normal instructions or factual assertions
  assert.strictEqual(isMemoryRecallPrompt("My grandfather was a carpenter"), false);
  assert.strictEqual(isMemoryRecallPrompt("Let's refactor the database connector"), false);
  assert.strictEqual(isMemoryRecallPrompt("Fix the corm_open leak in libcorm"), false);
});

Deno.test("human_memory: isQuestionMemory and filterAndEnrich prune question investigations", () => {
  const cand: FusedCandidate = {
    ref: 195,
    record: "2026-10-24:{}",
    origin: "lemma",
    rrfScore: 0.1,
    envelope: {
      level: "L1",
      type: "investigation",
      lifecycle: "observed",
      summary: "Investigation: Do you remember my grand dad?",
    },
  };

  assert.strictEqual(isQuestionMemory(cand, cand.envelope!), true);

  const filtered = filterAndEnrich([cand], { limit: 10 });
  assert.strictEqual(filtered.length, 0, "Question investigation must be pruned from normal recall");
});

Deno.test("human_memory: shouldTriggerAutoRecall filters workflow prompts", () => {
  assert.strictEqual(shouldTriggerAutoRecall("Review running for quest 1xKiAp — end your turn"), false);
  assert.strictEqual(shouldTriggerAutoRecall("Quest 1xKiAp promoted to implementing"), false);
  assert.strictEqual(shouldTriggerAutoRecall("Setback recorded (advisory, nothing blocked)"), false);
});

Deno.test("human_memory: buildInjectedContext suppresses question-memories and corrupted memories", () => {
  // 1. Question memory candidate (failed investigation)
  const questionCand: FusedCandidate = {
    ref: 195,
    record: "2026-10-24:{}",
    origin: "lemma",
    rrfScore: 0.05,
    envelope: {
      level: "L1",
      type: "investigation",
      lifecycle: "observed",
      summary: "Investigation: Do you remember my grand dad?",
    },
  };

  const contextFromQuestion = buildInjectedContext([questionCand], 1000, undefined, "Suggest fixes for the issues");
  assert.strictEqual(contextFromQuestion, "", "Question investigation must not be injected as background fact");

  // 2. Corrupted candidate
  const corruptedCand: FusedCandidate = {
    ref: 1,
    record: "2026-10-24:{}",
    origin: "lemma",
    rrfScore: 0.05,
    envelope: {
      level: "L2",
      lifecycle: "supported",
      summary: "“  ¡or »w´“ü 2Û & ¡ 7b0Ì1Ï 7© 1792871121360-t5b0ùKª",
    },
  };

  const contextFromCorrupted = buildInjectedContext([corruptedCand], 1000, undefined, "What happened?");
  assert.strictEqual(contextFromCorrupted, "", "Corrupted candidate must not be injected into prompt");

  // 3. Genuine relevant memory
  const validCand: FusedCandidate = {
    ref: 12,
    record: "2026-10-24:{}",
    origin: "lemma",
    rrfScore: 0.08,
    envelope: {
      level: "L1",
      lifecycle: "supported",
      summary: "I once spoke about airplanes with my grandpa under the cherry tree",
    },
  };

  const contextFromValid = buildInjectedContext([validCand], 1000, undefined, "Do you remember me mentioning my grandfather?");
  assert.ok(contextFromValid.includes("cherry tree"), "Valid relevant memory must be injected on explicit recall");
});
