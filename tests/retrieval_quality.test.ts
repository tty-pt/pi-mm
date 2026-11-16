// Retrieval-quality regression gate: recall@k and MRR on query -> expected-ref fixtures.
//
// Hermetic: a temporary cormd store plus a deterministic local mock embedding server.
// Protects against regressions like the one fixed in 59ca5c8, where every L0 task memory
// (e.g. the "seven water realism" design document reads) was silently dropped from recall.
import { existsSync, rmSync } from "node:fs";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { executeHybridScan } from "../src/tools/scan.ts";
import { makeRecallTool } from "../src/tools/recall.ts";
import { encodePayload } from "../src/payload.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildStoreInvocation, filespecFor } from "../src/corm.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";
import type { MemoryEnvelope } from "../src/types.ts";

const home = Deno.env.get("HOME") || "";
const cormBin = existsSync(`${home}/.local/bin/corm`) ? `${home}/.local/bin/corm` : "/usr/bin/corm";
const cormdBin = existsSync(`${home}/.local/bin/cormd`) ? `${home}/.local/bin/cormd` : "/usr/bin/cormd";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;

// Topic-axis projector: deterministic "semantic" embeddings for the fixture corpus.
function embedText(text: string): number[] {
  const t = text.toLowerCase();
  const axes = [
    /(?:water|ocean|wave|fresnel|foam|realism|seven)/.test(t) ? 0.9 : 0.05,
    /(?:approval|gate|subagent|reviewer|quest)/.test(t) ? 0.9 : 0.05,
    /(?:grandpa|grandfather|cherry|airplane)/.test(t) ? 0.9 : 0.05,
    /(?:const|function|import|#include|float)/.test(t) ? 0.9 : 0.05,
  ];
  const norm = Math.sqrt(axes.reduce((s, v) => s + v * v, 0)) || 1;
  return axes.map((v) => v / norm);
}

interface Fixture {
  ref: number;
  envelope: MemoryEnvelope;
}

const FIXTURES: Fixture[] = [
  {
    ref: 1,
    envelope: {
      level: "L0",
      type: "episode",
      lifecycle: "tested",
      summary: "# NeverDark Seven Water Realism — Working Design & Implementation Document",
      context: { project: "site" },
      episode: {
        problem: "# NeverDark Seven Water Realism — Working Design & Implementation Document",
        approaches: [{ approach: "Executed read: docs/handoff-water-realism.md", outcome: "worked", reason: "read" }],
        outcome: "success",
        runId: "run-water",
      },
    },
  },
  {
    ref: 2,
    envelope: {
      level: "L0",
      type: "episode",
      lifecycle: "tested",
      summary: "Seven water realism: Fresnel term and shoreline foam pass in nd-world",
      context: { project: "site" },
      episode: {
        problem: "Seven water realism: Fresnel term and shoreline foam pass in nd-world",
        approaches: [{ approach: "Executed edit: external/nd-world/water.c", outcome: "worked", reason: "edit" }],
        outcome: "success",
        runId: "run-water",
      },
    },
  },
  {
    ref: 3,
    envelope: {
      level: "L1",
      type: "investigation",
      lifecycle: "supported",
      summary: "Seven water realism investigation: Fresnel reflection, foam and wave spectrum implemented for NeverDark",
      context: { project: "site", subsystem: "nd-world" },
      evidence: [1, 2],
    },
  },
  {
    ref: 4,
    envelope: {
      level: "L0",
      type: "note",
      lifecycle: "observed",
      summary: "external/nd-world/water.c:12: float fresnel(float cos_theta) { return 0.02f; }",
      context: { project: "site" },
    },
  },
  {
    ref: 5,
    envelope: {
      level: "L1",
      type: "investigation",
      lifecycle: "supported",
      summary: "Plan approval gate: reviewer subagent fires in background before the approval question",
      context: { project: "site", subsystem: "pi-quest" },
    },
  },
  {
    ref: 6,
    envelope: {
      level: "L1",
      type: "note",
      lifecycle: "supported",
      summary: "I once spoke about airplanes with my grandpa under the cherry tree",
    },
  },
];

interface GoldenQuery {
  query: string;
  relevant: number[];
  forbidden: number[];
  /** Ref that must be ranked first (the higher-level synthesis). */
  top?: number;
}

const GOLDEN: GoldenQuery[] = [
  { query: "seven water realism", relevant: [1, 2, 3], forbidden: [4, 5, 6], top: 3 },
  { query: "approval gate subagent", relevant: [5], forbidden: [1, 2, 6], top: 5 },
  { query: "what did I talk about with my grandpa", relevant: [6], forbidden: [1, 2, 4], top: 6 },
];

export function recallAtK(ranked: number[], relevant: number[], k: number): number {
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}

export function reciprocalRank(ranked: number[], relevant: number[]): number {
  const idx = ranked.findIndex((r) => relevant.includes(r));
  return idx < 0 ? 0 : 1 / (idx + 1);
}

Deno.test("retrieval metrics: recallAtK and reciprocalRank", () => {
  assert.equal(recallAtK([3, 1, 9, 2], [1, 2, 3], 3), 2 / 3);
  assert.equal(recallAtK([], [1], 5), 0);
  assert.equal(reciprocalRank([9, 8, 1], [1]), 1 / 3);
  assert.equal(reciprocalRank([9], [1]), 0);
});

Deno.test("retrieval quality: golden queries reach recall@5=1, MRR>=0.5, synthesis ranked first", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-retrieval-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const body = await req.json();
    const input = typeof body.input === "string" ? body.input : "";
    return new Response(JSON.stringify({
      data: [{ embedding: embedText(input), index: 0, object: "embedding" }],
      model: "mock",
      object: "list",
    }), { headers: { "Content-Type": "application/json" } });
  });
  const embedUrl = `http://127.0.0.1:${server.addr.port}/v1/embeddings`;
  const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: "mock" };
  try {
    const fspec = filespecFor(tmpDir, true);
    const cfg = { ...DEFAULT_CONFIG, cormBin, cormdBin, axisLibs: axisPath, memDir: tmpDir, embedUrl, embedModel: "mock" };
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, embedEnv: eEnv, cwd: tmpDir });
    const runner = new DaemonCormRunner(sockPath, {
      run: () => Promise.resolve({ code: 1, stdout: "", stderr: "daemon required" }),
    });
    for (const f of FIXTURES) {
      const res = await runner.run(buildStoreInvocation(cormBin, fspec, f.ref, encodePayload("2026-11-06", f.envelope), axisPath, tmpDir, eEnv));
      assert.equal(res.code, 0, `store ref ${f.ref}: ${res.stderr}`);
    }
    const env = {
      cfg,
      runner,
      nowProvider: () => new Date("2026-11-06T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-retrieval",
      sessionFile: join(tmpDir, "sess.jsonl"),
    };

    let mrrSum = 0;
    for (const g of GOLDEN) {
      const { records } = await executeHybridScan(env, { topic: g.query, embed: true, includeL0: true, limit: 5 });
      const ranked = records.map((r) => r.ref);
      const r5 = recallAtK(ranked, g.relevant, 5);
      const rr = reciprocalRank(ranked, g.relevant);
      mrrSum += rr;
      assert.equal(r5, 1, `recall@5 for "${g.query}" = ${r5} (ranked ${JSON.stringify(ranked)})`);
      for (const bad of g.forbidden) {
        assert.ok(!ranked.includes(bad), `"${g.query}" must not return ref ${bad} (ranked ${JSON.stringify(ranked)})`);
      }
      if (g.top !== undefined) {
        assert.equal(ranked[0], g.top, `"${g.query}" must rank ref ${g.top} first (ranked ${JSON.stringify(ranked)})`);
      }
    }
    const mrr = mrrSum / GOLDEN.length;
    assert.ok(mrr >= 0.5, `MRR ${mrr} < 0.5`);

    // End-to-end through the public memory_recall tool (level omitted = default path that regressed).
    const tool = makeRecallTool(() => Promise.resolve(env));
    const out = await tool.execute("call-1", { query: "seven water realism" }, undefined, undefined, { cwd: tmpDir, sessionId: "sess-retrieval", hasUI: false, mode: "print" } as never);
    const refs = ((out.details as { results?: Array<{ ref: number }> }).results ?? []).map((r) => r.ref);
    for (const r of [1, 2, 3]) assert.ok(refs.includes(r), `memory_recall must return ref ${r}; got ${JSON.stringify(refs)}`);

    const lock = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    try { Deno.kill(lock.pid, "SIGTERM"); } catch { /* already gone */ }
  } finally {
    await server.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
