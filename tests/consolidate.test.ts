import assert from "node:assert";
import { join } from "node:path";
import { makeConsolidateTool } from "../src/tools/consolidate.ts";
import { fakeRunner, runTool, okResult } from "./fake-qmap.ts";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { encodePayload, decodePayload } from "../src/payload.ts";
import { give, type ToolEnv } from "../src/tools/index.ts";
import type { QmapRunner } from "../src/qmap.ts";

const CWD = await Deno.makeTempDir({ prefix: "mm-consolidate-cwd-" });
const ctx = { cwd: CWD, hasUI: false, mode: "agent" };

function now(): Date {
  return new Date("2026-10-14T12:00:00Z");
}

function env(runner: QmapRunner, cfg: Partial<MmConfig> = {}, fetchFn?: typeof fetch): ToolEnv {
  try { Deno.removeSync(join(CWD, ".ref_seq")); } catch { /* ignore */ }
  try { Deno.removeSync(join(CWD, ".pi", "mm", ".ref_seq")); } catch { /* ignore */ }
  try { Deno.removeSync(join(CWD, ".consolidation.json")); } catch { /* ignore */ }
  try { Deno.removeSync(join(CWD, ".pi", "mm", ".consolidation.json")); } catch { /* ignore */ }
  return {
    cwd: CWD,
    runner,
    nowProvider: now,
    cfg: { ...DEFAULT_CONFIG, qmapBin: "/usr/bin/qmap", ...cfg },
    fetchFn,
  };
}

Deno.test("consolidate: extracts L1 investigation from L0 episode", async () => {
  const l0 = {
    level: "L0" as const,
    lifecycle: "supported" as const,
    summary: "Cursor debug session",
  };

  const runner = fakeRunner([
    okResult(encodePayload("2026-10-14", l0)), // validateSources: get 1
    okResult("1\n"),                           // list all refs
    okResult(encodePayload("2026-10-14", l0)), // checkIdempotency: get 1
    okResult(""),                              // store invocation
  ]);

  const tool = makeConsolidateTool(give(env(runner)));
  const res = await runTool(tool, {
    targetLevel: "L1",
    sourceRefs: [1],
    summary: "Investigation: Cursor offset caused by VT100 relative escape codes",
    problem: "Cursor jumps to row 0 unexpectedly",
  }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.ref, 2);
  assert.strictEqual(details.level, "L1");
  assert.strictEqual(details.idempotent, false);
  assert.deepStrictEqual(details.evidence, [1]);

  const storedArg = runner.invocations[3].args[1];
  const { envelope } = decodePayload(storedArg.slice(storedArg.indexOf(":") + 1));
  assert.strictEqual(envelope.level, "L1");
  assert.strictEqual(envelope.type, "investigation");
  assert.deepStrictEqual(envelope.evidence, [1]);
});

Deno.test("consolidate: enforces explicit scope on L2 project knowledge", async () => {
  const runner = fakeRunner([]);
  const tool = makeConsolidateTool(give(env(runner)));

  const res = await runTool(tool, {
    targetLevel: "L2",
    sourceRefs: [1],
    summary: "Invariant: view rendering must not use absolute reset",
    // No context scope provided!
  }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.error, "scope-required");
});

Deno.test("consolidate: rejects when source evidence refs are missing", async () => {
  const runner = fakeRunner([
    okResult(""), // validateSources: get 99 fails
  ]);
  const tool = makeConsolidateTool(give(env(runner)));

  const res = await runTool(tool, {
    targetLevel: "L1",
    sourceRefs: [99],
    summary: "Investigation citing missing evidence",
  }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.error, "missing-sources");
  assert.deepStrictEqual(details.missing, [99]);
});

Deno.test("consolidate: idempotent repeat returns existing ref with zero duplicates", async () => {
  const existingL1 = {
    level: "L1" as const,
    lifecycle: "supported" as const,
    summary: "Investigation: Cursor offset caused by VT100 relative escape codes",
    evidence: [1],
  };

  const runner = fakeRunner([
    okResult(encodePayload("2026-10-14", { level: "L0", lifecycle: "supported", summary: "ep1" })), // validateSources: get 1
    okResult("1\n2\n"), // list all refs
    okResult(encodePayload("2026-10-14", { level: "L0", lifecycle: "supported", summary: "ep1" })), // checkIdempotency: get 1
    okResult(encodePayload("2026-10-14", existingL1)), // checkIdempotency: get 2
  ]);

  const tool = makeConsolidateTool(give(env(runner)));
  const res = await runTool(tool, {
    targetLevel: "L1",
    sourceRefs: [1],
    summary: "Investigation: Cursor offset caused by VT100 relative escape codes",
  }, ctx);

  const details = res.details as Record<string, unknown>;
  assert.strictEqual(details.ref, 2);
  assert.strictEqual(details.idempotent, true);
  // Store invocation should NOT have been called!
  assert.strictEqual(runner.invocations.length, 4);
});

Deno.test("consolidate: end-to-end full hierarchy (L0->L1->L2->L3) and traversal from L3 to L0", async () => {
  const { makeStoreTool } = await import("../src/tools/store.ts");
  const { makeTraverseTool } = await import("../src/tools/traverse.ts");

  const store = new Map<number, string>();
  const memoryRunner: QmapRunner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-p") {
        const firstColon = inv.args[1].indexOf(":");
        const ref = Number(inv.args[1].slice(0, firstColon));
        const payload = inv.args[1].slice(firstColon + 1);
        store.set(ref, payload);
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        const refs = [...store.keys()].join("\n");
        return Promise.resolve({ stdout: refs ? refs + "\n" : "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-r" && inv.args[1] === "-g") {
        const ref = Number(inv.args[2]);
        const val = store.get(ref);
        return Promise.resolve({ stdout: val ?? "", stderr: "", code: val ? 0 : 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const storeTool = makeStoreTool(give(env(memoryRunner)));
  const consolidateTool = makeConsolidateTool(give(env(memoryRunner)));

  // 1. Store L0 Episode
  const epRes = await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "Observed cursor reset glitch",
    episode: {
      problem: "Cursor jumps on redraw",
      diffs: ["--- view.c\n+++ view.c\n+ relative moves"],
      outcome: "success",
    },
    context: { project: "site" },
  }, ctx);
  const epRef = (epRes.details as Record<string, unknown>).ref as number;
  assert.strictEqual(epRef, 1);

  // 2. Consolidate L0 -> L1 Investigation
  const invRes = await runTool(consolidateTool, {
    targetLevel: "L1",
    sourceRefs: [epRef],
    summary: "Investigation: Cursor offset caused by VT100 relative escape codes",
  }, ctx);
  const invRef = (invRes.details as Record<string, unknown>).ref as number;
  assert.strictEqual(invRef, 2);

  // 3. Consolidate L1 -> L2 Project Invariant
  const ruleRes = await runTool(consolidateTool, {
    targetLevel: "L2",
    sourceRefs: [invRef],
    summary: "Invariant: view rendering must not use absolute reset",
    context: { project: "site", subsystem: "view" },
  }, ctx);
  const ruleRef = (ruleRes.details as Record<string, unknown>).ref as number;
  assert.strictEqual(ruleRef, 3);

  // 4. Consolidate L2 -> L3 General Lesson
  const lessonRes = await runTool(consolidateTool, {
    targetLevel: "L3",
    sourceRefs: [ruleRef],
    summary: "General Lesson: Terminal UI rendering should avoid hard reset sequences",
  }, ctx);
  const lessonRef = (lessonRes.details as Record<string, unknown>).ref as number;
  assert.strictEqual(lessonRef, 4);

  // 5. Fresh client / traverse downward from L3 to L0
  const traverseTool = makeTraverseTool(give(env(memoryRunner)));
  const travRes = await runTool(traverseTool, { ref: lessonRef, direction: "down", depth: 5 }, ctx);
  const details = travRes.details as Record<string, unknown>;

  assert.strictEqual(details.root, 4);
  assert.strictEqual(details.visitedCount, 4);

  const tree = details.tree as {
    ref: number;
    level: string;
    children: Array<{
      ref: number;
      level: string;
      children: Array<{
        ref: number;
        level: string;
        children: Array<{ ref: number; level: string }>;
      }>;
    }>;
  };

  assert.strictEqual(tree.ref, 4);
  assert.strictEqual(tree.level, "L3");
  assert.strictEqual(tree.children[0].ref, 3);
  assert.strictEqual(tree.children[0].level, "L2");
  assert.strictEqual(tree.children[0].children[0].ref, 2);
  assert.strictEqual(tree.children[0].children[0].level, "L1");
  assert.strictEqual(tree.children[0].children[0].children[0].ref, 1);
  assert.strictEqual(tree.children[0].children[0].children[0].level, "L0");
});

Deno.test("consolidate: automated workflow discovers unconsolidated L0 and creates L1", async () => {
  const store = new Map<number, string>();
  const memoryRunner: QmapRunner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-p") {
        const firstColon = inv.args[1].indexOf(":");
        const ref = Number(inv.args[1].slice(0, firstColon));
        const payload = inv.args[1].slice(firstColon + 1);
        store.set(ref, payload);
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        const refs = [...store.keys()].join("\n");
        return Promise.resolve({ stdout: refs ? refs + "\n" : "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-r" && inv.args[1] === "-g") {
        const ref = Number(inv.args[2]);
        const val = store.get(ref);
        return Promise.resolve({ stdout: val ?? "", stderr: "", code: val ? 0 : 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const { makeStoreTool } = await import("../src/tools/store.ts");
  const storeTool = makeStoreTool(give(env(memoryRunner)));
  const consolidateTool = makeConsolidateTool(give(env(memoryRunner)));

  // Store 2 episodes: ref 1 and ref 2
  await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "Fix memory leak in stoma",
    episode: { problem: "Leaking 24 bytes per query" },
  }, ctx);

  // Auto consolidation run 1
  const autoRes1 = await runTool(consolidateTool, { mode: "auto" }, ctx);
  const details1 = autoRes1.details as { createdL1: number[]; totalCreated: number };
  assert.strictEqual(details1.createdL1.length, 1);
  assert.strictEqual(details1.createdL1[0], 2);

  // Verify the created L1 links to L0 ref 1
  const createdL1Raw = store.get(2)!;
  const { envelope: l1Env } = decodePayload(createdL1Raw);
  assert.strictEqual(l1Env.level, "L1");
  assert.strictEqual(l1Env.type, "investigation");
  assert.deepStrictEqual(l1Env.evidence, [1]);

  // Auto consolidation run 2 (repeating should produce zero duplicate memories)
  const autoRes2 = await runTool(consolidateTool, { mode: "auto" }, ctx);
  const details2 = autoRes2.details as { totalCreated: number };
  assert.strictEqual(details2.totalCreated, 0);
});

Deno.test("consolidate: rejects invalid level transitions (e.g. L3 source to create L1)", async () => {
  const store = new Map<number, string>();
  store.set(1, `2026-10-15:{"level":"L3","type":"pattern","summary":"High level lesson","lifecycle":"supported"}`);

  const memoryRunner: QmapRunner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-r" && inv.args[1] === "-g") {
        const ref = Number(inv.args[2]);
        const val = store.get(ref);
        return Promise.resolve({ stdout: val ?? "", stderr: "", code: val ? 0 : 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const consolidateTool = makeConsolidateTool(give(env(memoryRunner)));

  // Attempt to use L3 source (ref 1) to create L1 investigation
  const res = await runTool(consolidateTool, {
    targetLevel: "L1",
    sourceRefs: [1],
    summary: "Invalid backwards abstraction",
  }, ctx);

  const details = res.details as { error: string };
  assert.strictEqual(details.error, "invalid-level-transition");
  assert.strictEqual(res.content[0].text?.includes("cannot use L3 source"), true);
});

Deno.test("consolidate: end-to-end automatic L0->L1->L2->L3 hierarchy with scope grouping and traversal", async () => {
  const store = new Map<number, string>();
  const memoryRunner: QmapRunner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-p") {
        const firstColon = inv.args[1].indexOf(":");
        const ref = Number(inv.args[1].slice(0, firstColon));
        const payload = inv.args[1].slice(firstColon + 1);
        store.set(ref, payload);
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        const refs = [...store.keys()].join("\n");
        return Promise.resolve({ stdout: refs ? refs + "\n" : "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-r" && inv.args[1] === "-g") {
        const ref = Number(inv.args[2]);
        const val = store.get(ref);
        return Promise.resolve({ stdout: val ?? "", stderr: "", code: val ? 0 : 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const mockSynthFetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string);
    const userPrompt = body.messages[1].content as string;
    const isL3 = body.messages[0].content.includes("generalization engine");
    if (isL3) {
      return Promise.resolve(new Response(JSON.stringify({ error: "L3 disabled in mock" }), { status: 500 }));
    }
    const matches = [...userPrompt.matchAll(/\[Ref (\d+)\]/g)].map((m) => Number(m[1]));
    const scopeMatch = userPrompt.match(/Scope: ([^\n\s]+)/);
    const scope = scopeMatch ? scopeMatch[1] : "scope";
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: `Synthesized knowledge for ${scope}`,
            explanation: "Derived from valid evidence",
            citedRefs: matches,
          }),
        },
      }],
    })));
  };

  const { makeStoreTool } = await import("../src/tools/store.ts");
  const { makeTraverseTool } = await import("../src/tools/traverse.ts");
  const toolEnv = env(memoryRunner, { synthUrl: "http://mock-synth", synthModel: "mock-model" }, mockSynthFetch);
  const storeTool = makeStoreTool(give(toolEnv));
  const consolidateTool = makeConsolidateTool(give(toolEnv));
  const traverseTool = makeTraverseTool(give(toolEnv));

  // Seed two verified episodes in project A, two in project B
  await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "A1: buffer overflow in parser",
    episode: { problem: "parser buffer overflow", approaches: [{ approach: "bounds check", outcome: "worked" }], outcome: "success" },
    context: { project: "project-a" },
  }, ctx); // ref 1
  await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "A2: off-by-one in parser lexer",
    episode: { problem: "parser off-by-one lexer", approaches: [{ approach: "zero-index check", outcome: "worked" }], outcome: "success" },
    context: { project: "project-a" },
  }, ctx); // ref 2
  await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "B1: socket timeout on connect",
    episode: { problem: "socket timeout connect", approaches: [{ approach: "keepalive flag", outcome: "worked" }], outcome: "success" },
    context: { project: "project-b" },
  }, ctx); // ref 3
  await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "B2: socket connection reset on close",
    episode: { problem: "socket connection reset", approaches: [{ approach: "graceful shutdown", outcome: "worked" }], outcome: "success" },
    context: { project: "project-b" },
  }, ctx); // ref 4

  // Run auto-consolidation: automatically synthesizes L1s and L2s grouped by scope (project-a vs project-b)
  const autoRes = await runTool(consolidateTool, { mode: "auto" }, ctx);
  const details = autoRes.details as {
    createdL1: number[];
    createdL2: number[];
    createdL3: number[];
    totalCreated: number;
  };

  // 4 L0s -> 4 L1 investigations
  assert.strictEqual(details.createdL1.length, 4);
  // 4 L1s grouped strictly into 2 scopes -> 2 L2 project invariants
  assert.strictEqual(details.createdL2.length, 2);
  // L3 unpromoted when offline without semantic model synthesis
  assert.strictEqual(details.createdL3.length, 0);
  assert.strictEqual(details.totalCreated, 6);

  // Verify L2 project invariants group only their own project
  const l2Ref1 = details.createdL2[0];
  const l2Raw1 = store.get(l2Ref1)!;
  const { envelope: l2Env1 } = decodePayload(l2Raw1);
  assert.strictEqual(l2Env1.level, "L2");
  assert.strictEqual(l2Env1.context?.project, "project-a");
  assert.strictEqual(l2Env1.evidence?.length, 2);

  // Traverse downward from automatically generated L2 to L1 and L0
  const travRes = await runTool(traverseTool, { ref: l2Ref1, direction: "down", depth: 3 }, ctx);
  const travDetails = travRes.details as { visitedCount: number; tree: { level: string } };
  assert.strictEqual(travDetails.tree.level, "L2");
  assert.strictEqual(travDetails.visitedCount, 5); // 1 L2 -> 2 L1s -> 2 L0s

  // Repeat auto consolidation: must create 0 new records (strict idempotency)
  const autoRes2 = await runTool(consolidateTool, { mode: "auto" }, ctx);
  const details2 = autoRes2.details as { totalCreated: number };
  assert.strictEqual(details2.totalCreated, 0);
});

Deno.test("consolidate: rejects promoting contradicted or superseded source memories into supported conclusions", async () => {
  const store = new Map<number, string>();
  store.set(1, `2026-10-15:{"level":"L0","type":"episode","summary":"Old refuted theory","lifecycle":"contradicted"}`);
  store.set(2, `2026-10-15:{"level":"L0","type":"episode","summary":"Obsolete approach","lifecycle":"superseded"}`);

  const memoryRunner: QmapRunner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-r" && inv.args[1] === "-g") {
        const ref = Number(inv.args[2]);
        const val = store.get(ref);
        return Promise.resolve({ stdout: val ?? "", stderr: "", code: val ? 0 : 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const consolidateTool = makeConsolidateTool(give(env(memoryRunner)));

  // 1. Attempt manual consolidation from contradicted source memory
  const res1 = await runTool(consolidateTool, {
    targetLevel: "L1",
    sourceRefs: [1],
    summary: "Investigation claiming disproven theory as true",
  }, ctx);
  assert.strictEqual((res1.details as { error: string }).error, "invalid-source");
  assert.strictEqual(res1.content[0].text?.includes("cannot promote contradicted source"), true);

  // 2. Attempt manual consolidation from superseded source memory
  const res2 = await runTool(consolidateTool, {
    targetLevel: "L1",
    sourceRefs: [2],
    summary: "Investigation claiming superseded approach",
  }, ctx);
  assert.strictEqual((res2.details as { error: string }).error, "invalid-source");
  assert.strictEqual(res2.content[0].text?.includes("cannot promote superseded source"), true);
});

Deno.test("consolidate: auto mode skips contradicted and superseded memories", async () => {
  const store = new Map<number, string>();
  store.set(1, `2026-10-15:{"level":"L0","type":"episode","summary":"Valid working fix","lifecycle":"observed","episode":{"outcome":"success"}}`);
  store.set(2, `2026-10-15:{"level":"L0","type":"episode","summary":"Refuted fix","lifecycle":"contradicted"}`);
  store.set(3, `2026-10-15:{"level":"L0","type":"episode","summary":"Superseded fix","lifecycle":"superseded"}`);

  const memoryRunner: QmapRunner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-p") {
        const firstColon = inv.args[1].indexOf(":");
        const ref = Number(inv.args[1].slice(0, firstColon));
        const payload = inv.args[1].slice(firstColon + 1);
        store.set(ref, payload);
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        const refs = [...store.keys()].join("\n");
        return Promise.resolve({ stdout: refs ? refs + "\n" : "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-r" && inv.args[1] === "-g") {
        const ref = Number(inv.args[2]);
        const val = store.get(ref);
        return Promise.resolve({ stdout: val ?? "", stderr: "", code: val ? 0 : 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const consolidateTool = makeConsolidateTool(give(env(memoryRunner)));

  // Auto consolidation should only process ref 1, completely ignoring ref 2 and ref 3
  const autoRes = await runTool(consolidateTool, { mode: "auto" }, ctx);
  const details = autoRes.details as { createdL1: number[]; totalCreated: number };

  assert.strictEqual(details.createdL1.length, 1);
  assert.strictEqual(details.createdL1[0], 4); // Created L1 at ref 4

  const createdL1Raw = store.get(4)!;
  const { envelope } = decodePayload(createdL1Raw);
  assert.deepStrictEqual(envelope.evidence, [1]);
});

Deno.test("consolidate: unrelated investigations in the same scope are NOT conjoined into invariants", async () => {
  const store = new Map<number, string>();
  const memoryRunner: QmapRunner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-p") {
        const firstColon = inv.args[1].indexOf(":");
        const ref = Number(inv.args[1].slice(0, firstColon));
        const payload = inv.args[1].slice(firstColon + 1);
        store.set(ref, payload);
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        const refs = [...store.keys()].join("\n");
        return Promise.resolve({ stdout: refs ? refs + "\n" : "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-r" && inv.args[1] === "-g") {
        const ref = Number(inv.args[2]);
        const val = store.get(ref);
        return Promise.resolve({ stdout: val ?? "", stderr: "", code: val ? 0 : 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const { makeStoreTool } = await import("../src/tools/store.ts");
  const storeTool = makeStoreTool(give(env(memoryRunner)));
  const consolidateTool = makeConsolidateTool(give(env(memoryRunner)));

  // Two completely unrelated episodes in the same project
  await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "Investigation: binary parser segmentation fault",
    episode: { problem: "binary parser segmentation fault", approaches: [{ approach: "null check", outcome: "worked" }], outcome: "success" },
    context: { project: "project-a" },
  }, ctx); // ref 1

  await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "Investigation: css header styling margin alignment",
    episode: { problem: "css header styling margin alignment", approaches: [{ approach: "flexbox adjust", outcome: "worked" }], outcome: "success" },
    context: { project: "project-a" },
  }, ctx); // ref 2

  const autoRes = await runTool(consolidateTool, { mode: "auto" }, ctx);
  const details = autoRes.details as { createdL1: number[]; createdL2: number[]; totalCreated: number };

  // Two L1 investigations were created
  assert.strictEqual(details.createdL1.length, 2);
  // BUT ZERO L2 invariants were created because the investigations are unrelated!
  assert.strictEqual(details.createdL2.length, 0);
  assert.strictEqual(details.totalCreated, 2);
});

Deno.test("consolidate: rejects unsupported L3 generalizations (single source or single scope)", async () => {
  const store = new Map<number, string>();
  // L2 in project-a
  store.set(1, `2026-10-15:{"level":"L2","type":"invariant","summary":"Invariant A1","lifecycle":"supported","context":{"project":"project-a"},"evidence":[10]}`);
  store.set(2, `2026-10-15:{"level":"L2","type":"invariant","summary":"Invariant A2","lifecycle":"supported","context":{"project":"project-a"},"evidence":[11]}`);
  // L2 in project-b
  store.set(3, `2026-10-15:{"level":"L2","type":"invariant","summary":"Invariant B1","lifecycle":"supported","context":{"project":"project-b"},"evidence":[12]}`);
  // Unverified L2 in project-c
  store.set(4, `2026-10-15:{"level":"L2","type":"invariant","summary":"Unverified C1","lifecycle":"observed","context":{"project":"project-c"},"evidence":[13]}`);

  const memoryRunner: QmapRunner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-p") {
        const firstColon = inv.args[1].indexOf(":");
        const ref = Number(inv.args[1].slice(0, firstColon));
        const payload = inv.args[1].slice(firstColon + 1);
        store.set(ref, payload);
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        const refs = [...store.keys()].join("\n");
        return Promise.resolve({ stdout: refs ? refs + "\n" : "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-r" && inv.args[1] === "-g") {
        const ref = Number(inv.args[2]);
        const val = store.get(ref);
        return Promise.resolve({ stdout: val ?? "", stderr: "", code: val ? 0 : 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const consolidateTool = makeConsolidateTool(give(env(memoryRunner)));

  // 1. Attempt L3 from an unverified (observed) L2 source -> rejected
  const resUnverified = await runTool(consolidateTool, {
    targetLevel: "L3",
    sourceRefs: [4],
    summary: "General Lesson from unverified source",
  }, ctx);
  assert.strictEqual((resUnverified.details as { error: string }).error, "unsupported-generalization");
  assert.strictEqual(resUnverified.content[0].text?.includes("is not a supported L2 project invariant"), true);

  // 2. Attempt L3 from multiple refs in the same single project scope -> rejected
  const resSameScope = await runTool(consolidateTool, {
    targetLevel: "L3",
    sourceRefs: [1, 2],
    summary: "General Lesson from single project",
  }, ctx);
  assert.strictEqual((resSameScope.details as { error: string }).error, "unsupported-generalization");
  assert.strictEqual(resSameScope.content[0].text?.includes("cannot generalize L3 across a single project scope"), true);

  // 3. Attempt L3 from multiple refs across distinct project scopes (project-a and project-b) -> SUCCEEDS
  const resMultiScope = await runTool(consolidateTool, {
    targetLevel: "L3",
    sourceRefs: [1, 3],
    summary: "Genuine General Lesson across project-a and project-b",
  }, ctx);
  assert.strictEqual((resMultiScope.details as { level: string }).level, "L3");
});

Deno.test("consolidate: investigations sharing vocabulary but expressing contradictory conclusions are NOT merged", async () => {
  const store = new Map<number, string>();
  const memoryRunner: QmapRunner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-p") {
        const firstColon = inv.args[1].indexOf(":");
        const ref = Number(inv.args[1].slice(0, firstColon));
        const payload = inv.args[1].slice(firstColon + 1);
        store.set(ref, payload);
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        const refs = [...store.keys()].join("\n");
        return Promise.resolve({ stdout: refs ? refs + "\n" : "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-r" && inv.args[1] === "-g") {
        const ref = Number(inv.args[2]);
        const val = store.get(ref);
        return Promise.resolve({ stdout: val ?? "", stderr: "", code: val ? 0 : 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const { makeStoreTool } = await import("../src/tools/store.ts");
  const storeTool = makeStoreTool(give(env(memoryRunner)));
  const consolidateTool = makeConsolidateTool(give(env(memoryRunner)));

  // Two episodes in the same project and topic, but with contradictory conclusions
  await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "Investigation: parser must always require strict buffer bounds",
    episode: { problem: "parser bounds check", approaches: [{ approach: "always check bounds", outcome: "worked" }], outcome: "success" },
    context: { project: "project-a" },
  }, ctx); // ref 1

  await runTool(storeTool, {
    level: "L0",
    type: "episode",
    summary: "Investigation: parser should never enforce buffer bounds on raw streams",
    episode: { problem: "parser bounds check", approaches: [{ approach: "never enforce bounds", outcome: "worked" }], outcome: "success" },
    context: { project: "project-a" },
  }, ctx); // ref 2

  const autoRes = await runTool(consolidateTool, { mode: "auto" }, ctx);
  const details = autoRes.details as { createdL1: number[]; createdL2: number[]; totalCreated: number };

  // 2 L1 investigations created
  assert.strictEqual(details.createdL1.length, 2);
  // BUT 0 L2 invariants created because the findings contradict each other!
  assert.strictEqual(details.createdL2.length, 0);
});
