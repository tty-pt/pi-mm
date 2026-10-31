import assert from "node:assert";
import { distillQuestArchiveEvent, installSessionHooks, type PiCtx, type PiExecResult, type ToolResultEvent } from "../src/hooks/events.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { CormRunner, Invocation } from "../src/corm.ts";
import { decodePayload } from "../src/payload.ts";

function fakeRunner(results: PiExecResult[]): { runner: CormRunner; invocations: Invocation[] } {
  let idx = 0;
  const invocations: Invocation[] = [];
  const runner: CormRunner = {
    run: (inv: Invocation): Promise<PiExecResult> => {
      invocations.push(inv);
      if (idx < results.length) {
        return Promise.resolve(results[idx++]);
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };
  return { runner, invocations };
}

function makeEnv(runner: CormRunner): ToolEnv {
  try { Deno.removeSync("/tmp/fake-symbiosis/.pi/mm/.ref_seq"); } catch { /* ignore */ }
  try { Deno.removeSync("/tmp/fake-symbiosis/.ref_seq"); } catch { /* ignore */ }
  return {
    cwd: "/tmp/fake-symbiosis",
    runner,
    nowProvider: () => new Date("2026-03-30T12:00:00"),
    cfg: { ...DEFAULT_CONFIG, cormBin: "/usr/bin/corm", memDir: ".pi/mm" },
  };
}

const ctx: PiCtx = { cwd: "/tmp/fake-symbiosis", hasUI: false, mode: "headless" };

Deno.test("quest_symbiosis: distillQuestArchiveEvent ignores irrelevant or failed events", async () => {
  const { runner } = fakeRunner([]);
  const envSource = () => Promise.resolve(makeEnv(runner));

  // Non-quest tool
  const r1 = await distillQuestArchiveEvent({
    toolName: "bash",
    details: { outcome: "completed" },
  }, envSource, ctx);
  assert.strictEqual(r1, null);

  // Tool error
  const r2 = await distillQuestArchiveEvent({
    toolName: "quest_archive",
    isError: true,
    details: { outcome: "completed" },
  }, envSource, ctx);
  assert.strictEqual(r2, null);

  // Outcome failed
  const r3 = await distillQuestArchiveEvent({
    toolName: "quest_archive",
    details: { outcome: "failed" },
  }, envSource, ctx);
  assert.strictEqual(r3, null);
});

Deno.test("quest_symbiosis: distillQuestArchiveEvent distills completed quest with passing tests to supported L1 episode", async () => {
  const { runner, invocations } = fakeRunner([
    { stdout: "1\n2\n", stderr: "", code: 0 }, // list refs
    { stdout: "", stderr: "", code: 0 },       // store
  ]);
  const envSource = () => Promise.resolve(makeEnv(runner));

  const event: ToolResultEvent = {
    toolName: "quest_archive",
    details: {
      archived: "1xAbCd",
      outcome: "completed",
      objective: "Decouple vanilla modules and add regional extensibility framework",
      kind: "standard",
      difficulty: "major",
      modifiedFiles: ["src/kernel.c", "src/regional.c", "include/kernel.h"],
      setbacks: [
        { reason: "Linker collision on regional symbol", evidence: ["duplicate symbol _regional_init in ld"] },
        { reason: "Header circular reference", error: "kernel.h:42: unknown type name 'regional_t'" },
      ],
      findings: ["Extensibility framework isolated into hooks array with O(1) invocation"],
      lastTestReceipt: { command: "make test", exitCode: 0, tailOutput: "All 42 tests passed" },
      summary: "Shipped cleanly with 100% passing tests",
    },
  };

  const ref = await distillQuestArchiveEvent(event, envSource, ctx);
  assert.strictEqual(ref, 3); // nextRef after 1, 2

  // Verify store invocation
  assert.strictEqual(invocations.length, 2);
  const storeInv = invocations[1];
  assert.strictEqual(storeInv.command, "/usr/bin/corm");
  assert.strictEqual(storeInv.args[0], "-p");

  // Inspect the stored HTOK payload
  const rawPayload = storeInv.payloadBytes ?? storeInv.args[1];
  const { envelope } = decodePayload(rawPayload);

  assert.strictEqual(envelope.level, "L1");
  assert.strictEqual(envelope.type, "episode");
  assert.strictEqual(envelope.lifecycle, "supported");
  assert.ok(envelope.summary.includes("1xAbCd"));
  assert.ok(envelope.summary.includes("Decouple vanilla modules"));
  assert.ok(envelope.tags?.includes("quest"));
  assert.ok(envelope.tags?.includes("standard"));
  assert.ok(envelope.tags?.includes("difficulty:major"));
  assert.ok(envelope.tags?.includes("qid:1xAbCd"));

  // Check episode details
  const ep = envelope.episode!;
  assert.strictEqual(ep.problem, "Decouple vanilla modules and add regional extensibility framework");
  assert.strictEqual(ep.outcome, "success");
  assert.deepStrictEqual(ep.diffs, ["src/kernel.c", "src/regional.c", "include/kernel.h"]);

  // Approaches: 2 failed setbacks + 1 worked approach
  assert.strictEqual(ep.approaches?.length, 3);
  assert.strictEqual(ep.approaches?.[0].outcome, "failed");
  assert.strictEqual(ep.approaches?.[0].approach, "Linker collision on regional symbol");
  assert.ok(ep.approaches?.[0]?.reason?.includes("duplicate symbol _regional_init"));

  assert.strictEqual(ep.approaches?.[1].outcome, "failed");
  assert.strictEqual(ep.approaches?.[1].approach, "Header circular reference");
  assert.ok(ep.approaches?.[1]?.reason?.includes("unknown type name 'regional_t'"));

  assert.strictEqual(ep.approaches?.[2].outcome, "worked");
  assert.ok(ep.approaches?.[2]?.approach?.includes("Extensibility framework isolated"));
  assert.ok(ep.approaches?.[2]?.reason?.includes("make test"));
});

Deno.test("quest_symbiosis: quest without passing test receipt is stored as tested L1", async () => {
  const { runner, invocations } = fakeRunner([
    { stdout: "", stderr: "", code: 0 }, // list refs (empty)
    { stdout: "", stderr: "", code: 0 }, // store
  ]);
  const envSource = () => Promise.resolve(makeEnv(runner));

  const event: ToolResultEvent = {
    toolName: "quest_archive",
    details: {
      archived: "2xYzW9",
      outcome: "completed",
      objective: "Update architecture documentation for module conventions",
      kind: "docs",
      difficulty: "trivial",
      modifiedFiles: ["docs/ARCHITECTURE.md"],
      setbacks: [],
      findings: ["Documentation updated with XY module rules"],
      summary: "Updated docs",
    },
  };

  const ref = await distillQuestArchiveEvent(event, envSource, ctx);
  assert.strictEqual(ref, 1);

  const rawPayload = invocations[1].payloadBytes ?? invocations[1].args[1];
  const { envelope } = decodePayload(rawPayload);

  assert.strictEqual(envelope.level, "L1");
  assert.strictEqual(envelope.lifecycle, "tested");
  assert.strictEqual(envelope.episode?.problem, "Update architecture documentation for module conventions");
});

Deno.test("quest_symbiosis: end-to-end pi.on('tool_result') hook dispatches quest distillation", async () => {
  const { runner } = fakeRunner([
    { stdout: "", stderr: "", code: 0 },
    { stdout: "", stderr: "", code: 0 },
  ]);
  const envSource = () => Promise.resolve(makeEnv(runner));

  const handlers = new Map<string, Array<(e: unknown, ctx?: unknown) => Promise<unknown>>>();
  const fakePi = {
    on(event: string, handler: (e: unknown, ctx?: unknown) => Promise<unknown>) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    sendMessage: () => {},
  };

  installSessionHooks(fakePi as unknown as import("../src/hooks/events.ts").Pi, envSource);

  const toolResultHandlers = handlers.get("tool_result") || [];
  assert.ok(toolResultHandlers.length > 0, "tool_result hook registered");

  const event: ToolResultEvent = {
    toolName: "quest_archive",
    details: {
      archived: "3xHjK1",
      outcome: "completed",
      objective: "Hook integration test",
      kind: "bugfix",
      difficulty: "minor",
      modifiedFiles: ["test.c"],
      lastTestReceipt: { command: "test", exitCode: 0 },
    },
  };

  // Trigger tool_result
  for (const h of toolResultHandlers) {
    await h(event, ctx);
  }
});
