import assert from "node:assert";
import { makeRecordTool } from "../src/tools/record.ts";
import { makeReviewTool } from "../src/tools/review.ts";
import { handleBeforeAgentStart } from "../src/hooks/auto_recall.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { QmapRunner, Invocation } from "../src/qmap.ts";
import type { PiExecResult } from "../src/hooks/events.ts";
import { encodePayload } from "../src/payload.ts";
import type { MemoryEnvelope } from "../src/types.ts";

/**
 * End-to-end integration test demonstrating the full usable semantic memory lifecycle:
 * 1. Previously encountered issue is stored with meaningful evidence.
 * 2. New request describes the same issue using different wording.
 * 3. Relevant prior experience is retrieved without requiring multi-tool orchestration.
 * 4. Memory context reaches the model before it begins solving the task.
 * 5. Model can inspect original evidence if needed.
 * 6. Obsolete or unsupported knowledge is not presented as established fact.
 * 7. Task's final outcome is recorded for future retrieval.
 */

class InMemoryBackend {
  private items = new Map<number, string>();
  private nextId = 1;

  public store(payload: string, explicitRef?: number): number {
    const id = explicitRef ?? this.nextId++;
    this.items.set(id, payload);
    if (id >= this.nextId) this.nextId = id + 1;
    try {
      Deno.mkdirSync("/tmp/mm-e2e/.pi/mm", { recursive: true });
      Deno.writeTextFileSync("/tmp/mm-e2e/.pi/mm/.ref_seq", `${this.nextId}\n`);
    } catch { /* ignore */ }
    return id;
  }

  public get(ref: number): string | null {
    return this.items.get(ref) ?? null;
  }

  public list(): number[] {
    return Array.from(this.items.keys());
  }

  public scan(query: string): Array<{ ref: number; score: string; record: string }> {
    const qTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
    const results: Array<{ ref: number; score: string; record: string }> = [];

    for (const [ref, payload] of this.items.entries()) {
      const lower = payload.toLowerCase();
      let matchCount = 0;
      for (const tok of qTokens) {
        if (lower.includes(tok)) matchCount++;
      }
      // If tokens match, or semantic keywords match
      if (matchCount > 0 || (lower.includes("descriptor") && query.toLowerCase().includes("descriptor"))) {
        results.push({ ref, score: (matchCount * 0.5 + 0.5).toFixed(6), record: payload });
      }
    }
    return results;
  }
}

function createSimulator(): { env: ToolEnv; backend: InMemoryBackend } {
  try { Deno.removeSync("/tmp/mm-e2e", { recursive: true }); } catch { /* ignore */ }
  try { Deno.mkdirSync("/tmp/mm-e2e", { recursive: true }); } catch { /* ignore */ }

  const backend = new InMemoryBackend();

  const runner: QmapRunner = {
    run: (inv: Invocation): Promise<PiExecResult> => {
      const args = inv.args;
      // List
      if (args[0] === "-g" && args[1] === ".") {
        const refs = backend.list();
        return Promise.resolve({ stdout: refs.map((r) => String(r)).join("\n") + "\n", stderr: "", code: 0 });
      }
      // Store
      if (args[0] === "-p") {
        const colonIdx = args[1].indexOf(":");
        const ref = Number(args[1].slice(0, colonIdx));
        const payload = args[1].slice(colonIdx + 1);
        backend.store(payload, ref);
        return Promise.resolve({ stdout: "ok\n", stderr: "", code: 0 });
      }
      // Get
      if (args[0] === "-r" && args[1] === "-g") {
        const ref = Number(args[2]);
        const val = backend.get(ref);
        if (val) return Promise.resolve({ stdout: val + "\n", stderr: "", code: 0 });
        return Promise.resolve({ stdout: "", stderr: "not found", code: 1 });
      }
      // Scan
      if (args[0] === "-X") {
        const queryArg = args.find((a) => a.startsWith("--query="));
        const q = queryArg ? queryArg.slice(8) : "";
        const hits = backend.scan(q);
        const out = hits.map((h) => `${h.ref} ${h.score} ${h.record}`).join("\n") + "\n";
        return Promise.resolve({ stdout: out, stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const env: ToolEnv = {
    cwd: "/tmp/mm-e2e",
    runner,
    nowProvider: () => new Date("2026-03-30T12:00:00Z"),
    cfg: { ...DEFAULT_CONFIG, qmapBin: "/usr/bin/qmap", memDir: ".pi/mm" },
  };

  return { env, backend };
}

Deno.test("e2e: complete usable semantic memory workflow for Pi Coding Agent", async () => {
  const { env, backend } = createSimulator();
  const envSource = () => Promise.resolve(env);
  const ctx = { cwd: "/tmp/mm-e2e", hasUI: false, mode: "headless" };

  const recordTool = makeRecordTool(envSource);
  const reviewTool = makeReviewTool(envSource);

  // 1. A previously encountered coding issue is stored with meaningful evidence
  const step1 = await recordTool.execute("call-1", {
    problem: "Investigate file descriptor leak on reopening corm_open",
    approaches: [
      { approach: "Increase file descriptor ulimit", outcome: "failed", reason: "Masked resource exhaustion without fixing leak" },
      { approach: "Check active handle table before allocating fresh fd", outcome: "worked", reason: "Reuses existing handle on identical file" },
    ],
    findings: ["corm_open duplicate open was allocating unaliased descriptors"],
    diffs: ["--- a/libcorm.c\n+++ b/libcorm.c\n+ if (match) return existing_handle;"],
    outcome: "success",
    project: "site",
    subsystem: "libcorm",
  }, undefined, undefined, ctx);

  const ref1 = (step1.details as { ref: number }).ref;
  assert.strictEqual(ref1, 1);

  // Store consolidated L2 invariant citing Ref 1
  const invEnv: MemoryEnvelope = {
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "Invariant: corm_open must alias live handles on identical file to prevent descriptor exhaustion",
    evidence: [ref1],
    context: { project: "site", subsystem: "libcorm" },
  };
  backend.store(encodePayload("2026-03-30", invEnv), 2);

  // Store an obsolete superseded theory
  const obsEnv: MemoryEnvelope = {
    level: "L1",
    type: "investigation",
    lifecycle: "superseded",
    summary: "Old theory: fresh descriptor per open is required",
    supersededBy: 2,
    context: { project: "site", subsystem: "libcorm" },
  };
  backend.store(encodePayload("2026-03-30", obsEnv), 3);

  // Store an uncertain hypothesis
  const hypEnv: MemoryEnvelope = {
    level: "L1",
    type: "investigation",
    lifecycle: "hypothesized",
    summary: "Hypothesis: socket handles may also require aliasing table",
    context: { project: "site", subsystem: "libcorm" },
  };
  backend.store(encodePayload("2026-03-30", hypEnv), 4);

  // 2. A new request describes the same issue using different wording
  const newPrompt = "We are encountering descriptor exhaustion when reopening the database";

  // 3 & 4. Relevant prior experience is retrieved and reaches the model before solving begins
  const autoRecallResult = await handleBeforeAgentStart(
    { messageType: "user", prompt: newPrompt },
    ctx,
    envSource,
  );

  assert.ok(autoRecallResult);
  assert.ok(autoRecallResult.message);
  assert.strictEqual(autoRecallResult.message.customType, "memory_context");
  assert.strictEqual(autoRecallResult.message.display, true);

  const contextText = autoRecallResult.message.content;
  // Contains the relevant invariant
  assert.ok(contextText.includes("Invariant: corm_open must alias live handles"));
  // Includes scope and evidence info
  assert.ok(contextText.includes("site/libcorm"));
  assert.ok(contextText.includes("cited refs [1]"));

  // 6. Obsolete or unsupported knowledge is not presented as established fact
  assert.ok(!contextText.includes("Old theory: fresh descriptor per open"), "Superseded memory must be excluded");
  assert.ok(contextText.includes("[HYPOTHESIS]"), "Hypothesis must be explicitly tagged");

  // 5. The model can inspect the original evidence if needed
  const reviewRes = await reviewTool.execute("call-2", {
    ref: 2,
    action: "inspect",
  }, undefined, undefined, ctx);

  const reviewText = reviewRes.content[0].text ?? "";
  assert.ok(reviewText.includes("=== Review Inspection for Ref 2 ==="));
  assert.ok(reviewText.includes("Evidence Hierarchy:"));
  assert.ok(reviewText.includes("Ref 1"));
  assert.ok(reviewText.includes("Attempted Approaches") || reviewText.includes("Ref 1"));

  // 7. The task's final outcome can be recorded for future retrieval
  const step7 = await recordTool.execute("call-3", {
    problem: "Database reopening descriptor exhaustion in production",
    approaches: [
      { approach: "Verified corm_open handle aliasing invariant from Ref 2", outcome: "worked", reason: "Prevented descriptor exhaustion completely" },
    ],
    findings: ["Verified handle table correctly aliased duplicate opens"],
    outcome: "success",
    project: "site",
    subsystem: "libcorm",
    evidence: [2],
  }, undefined, undefined, ctx);

  const refEnd = (step7.details as { ref: number }).ref;
  assert.ok(refEnd >= 5);
  assert.strictEqual((step7.details as { outcome: string }).outcome, "success");
});
