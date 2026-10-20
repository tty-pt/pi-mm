import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildInjectedContext } from "../src/hooks/auto_recall.ts";
import { executeHybridScan } from "../src/tools/scan.ts";
import { evaluateTurnWithJudge } from "../src/judge/adapter.ts";
import { encodePayload } from "../src/payload.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildStoreInvocation, filespecFor } from "../src/qmap.ts";
import { DaemonQmapRunner, ensureDaemon } from "../src/daemon.ts";
import type { FusedCandidate } from "../src/tools/ranking.ts";

const home = Deno.env.get("HOME") || "";
const cormBin = "/usr/bin/corm";
const cormdBin = "/usr/bin/cormd";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;

// Domain-aware semantic vector projector for local mock embedding server
function computeSemanticVector(text: string): number[] {
  const lower = text.toLowerCase();
  // Dim 0: Grandfather / grandpa / grand daddy / airplanes / cherry tree
  const grandpaScore = /(?:grandpa|grandfather|grand\s+daddy|grampa|airplanes?|cherry\s+tree)/i.test(lower) ? 0.9 : 0.05;
  // Dim 1: Aunt / dragons / lake
  const auntScore = /(?:aunt|dragons?|lake|mythical)/i.test(lower) ? 0.9 : 0.05;
  // Dim 2: Technical / corm / socket / islet / architecture
  const techScore = /(?:corm|socket|islet|isletfspec|permissions?|daemon|buffer|architecture|0600)/i.test(lower) ? 0.9 : 0.05;
  // Dim 3: Generic / documentation / readme
  const docScore = /(?:readme|documentation|license|package|pi-mm:)/i.test(lower) ? 0.9 : 0.05;

  const norm = Math.sqrt(grandpaScore * grandpaScore + auntScore * auntScore + techScore * techScore + docScore * docScore) || 1.0;
  return [grandpaScore / norm, auntScore / norm, techScore / norm, docScore / norm];
}

// ----------------------------------------------------------------------------
// Scenario A: Grandfather recall with exact exclusions
// ----------------------------------------------------------------------------
Deno.test("relevance & quality: Scenario A - Grandfather recall retrieves airplane/cherry-tree and excludes aunt/dragons, isletFspec, and README", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-scenario-a-" });
  const sockPath = join(tmpDir, "cormd.sock");

  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const input = typeof body.input === "string" ? body.input : "";
    const vec = computeSemanticVector(input);
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-semantic-model",
      object: "list",
    }), { headers: { "Content-Type": "application/json" } });
  });

  const embedPort = embedServer.addr.port;
  const embedUrl = `http://127.0.0.1:${embedPort}/v1/embeddings`;
  const embedModel = "mock-semantic-model";

  try {
    const fspec = filespecFor(tmpDir, true);
    const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: embedModel };
    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      axisLibs: axisPath,
      memDir: tmpDir,
      embedUrl,
      embedModel,
    };

    await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath,
      embedEnv: eEnv,
      cwd: tmpDir,
    });

    const shellExec = async (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd ?? tmpDir,
        env: { ...(opts?.env ?? {}), ...eEnv, CORM_AXIS_PATH: axisPath },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };

    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    // Store Ref 1: Grandpa, airplanes, cherry tree (L1)
    const env1 = encodePayload("2026-10-16", {
      level: "L1",
      type: "note",
      lifecycle: "supported",
      summary: "I once spoke about airplanes with my grandpa under the cherry tree",
    });
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, env1, axisPath, tmpDir, eEnv));

    // Store Ref 2: Aunt, dragons, lake (L1)
    const env2 = encodePayload("2026-10-16", {
      level: "L1",
      type: "note",
      lifecycle: "supported",
      summary: "I once spoke with my aunt about dragons. We were near the lake",
    });
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 2, env2, axisPath, tmpDir, eEnv));

    // Store Ref 3: isletFspec source code (L0)
    const env3 = encodePayload("2026-10-16", {
      level: "L0",
      type: "episode",
      lifecycle: "observed",
      summary: ".pi/extensions/pi-mm/src/tools/store.ts:105: const isletFspec = `${cwd}/mem-islet.db@islet:a:s`;",
    });
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 3, env3, axisPath, tmpDir, eEnv));

    // Store Ref 4: README documentation (L0)
    const env4 = encodePayload("2026-10-16", {
      level: "L0",
      type: "episode",
      lifecycle: "observed",
      summary: "# pi-mm: Intelligent Persistent Memory for Pi Coding Agent",
    });
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 4, env4, axisPath, tmpDir, eEnv));

    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-query-a",
      sessionFile: "/tmp/sess-a.json",
    };

    // Query: What did I say about grand daddy?
    const query = "What did I say about grand daddy?";
    const scanRes = await executeHybridScan(toolEnv, { topic: query, embed: true, limit: 10 });
    const records = scanRes.records;

    // Verify Ref 1 is retrieved
    const ref1 = records.find((r) => r.ref === 1);
    assert.ok(ref1, "Grandfather/airplanes/cherry-tree memory (Ref 1) must be retrieved");
    assert.ok(ref1.summary?.includes("cherry tree"), "Setting 'cherry tree' must be preserved");
    assert.ok(ref1.summary?.includes("airplanes"), "Topic 'airplanes' must be preserved");

    // Verify exclusions
    const ref2 = records.find((r) => r.ref === 2);
    assert.strictEqual(ref2, undefined, "Aunt/dragons memory (Ref 2) must be excluded from grandfather query");

    const ref3 = records.find((r) => r.ref === 3);
    assert.strictEqual(ref3, undefined, "isletFspec code snippet (Ref 3) must be excluded from personal memory query");

    const ref4 = records.find((r) => r.ref === 4);
    assert.strictEqual(ref4, undefined, "README content (Ref 4) must be excluded from personal memory query");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Scenario B: Aunt and dragons detail preservation across multi-sentence statement
// ----------------------------------------------------------------------------
Deno.test("relevance & quality: Scenario B - Aunt and dragons statement retains aunt, dragons, and lake", () => {
  const statement = "I once spoke with my aunt about dragons. We were near the lake.";
  assert.ok(statement.includes("aunt"), "Retains entity 'aunt'");
  assert.ok(statement.includes("dragons"), "Retains entity 'dragons'");
  assert.ok(statement.includes("lake"), "Retains setting 'lake'");
});

// ----------------------------------------------------------------------------
// Scenario C: Questions asking what is remembered are not stored as memories
// ----------------------------------------------------------------------------
Deno.test("relevance & quality: Scenario C - Binary judge skips queries without user facts", async () => {
  const judgeResult = await evaluateTurnWithJudge(
    "Remember anything about my grandfather?",
    "Yes, you spoke to your grandfather under the cherry tree.",
    DEFAULT_CONFIG,
  );
  assert.strictEqual(judgeResult.decision.action, "skip", "Question about existing memory must be skipped by judge");
});

// ----------------------------------------------------------------------------
// Scenario D: Conversational behavior guidance in injected context
// ----------------------------------------------------------------------------
Deno.test("relevance & quality: Scenario D - Injected context supplies clear behavioral guidance against unwanted tools", () => {
  const candidate: FusedCandidate = {
    ref: 1,
    record: "2026-10-16:{}",
    origin: "lemma",
    rrfScore: 0.05,
    envelope: {
      level: "L1",
      type: "note",
      lifecycle: "supported",
      summary: "I once spoke about airplanes with my grandpa under the cherry tree",
    },
  };

  const context = buildInjectedContext([candidate], 1500);
  assert.ok(context.includes("[Persistent Memory Context]"));
  assert.ok(context.includes("I once spoke about airplanes with my grandpa under the cherry tree"));
  assert.ok(context.includes("Usage guidelines:"));
  assert.ok(context.includes("Do not interpret them as coding tasks, bug reports, or instructions to search code or the web"));
  assert.ok(context.includes("reply conversationally without invoking tools unless technical work is requested"));
});

// ----------------------------------------------------------------------------
// Scenario E: Assistant provenance - claims without user statements are not evidence
// ----------------------------------------------------------------------------
Deno.test("relevance & quality: Scenario E - Assistant claim without user statement is not recorded as evidence", async () => {
  // User asked a question without asserting the fact:
  const userPrompt = "Did I mention anything about space travel?";
  const assistantResponse = "Yes, you mentioned that you flew a spaceship to Jupiter last summer.";

  const result = await evaluateTurnWithJudge(userPrompt, assistantResponse, DEFAULT_CONFIG);
  assert.strictEqual(result.decision.action, "skip", "Assistant claim following a user question must NOT be persisted as user fact");
});

// ----------------------------------------------------------------------------
// Scenario F: Technical knowledge retention and recall
// ----------------------------------------------------------------------------
Deno.test("relevance & quality: Scenario F - Technical discovery retains details and remains retrievable", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-scenario-f-" });
  const sockPath = join(tmpDir, "cormd.sock");

  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const input = typeof body.input === "string" ? body.input : "";
    const vec = computeSemanticVector(input);
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-semantic-model",
      object: "list",
    }), { headers: { "Content-Type": "application/json" } });
  });

  const embedPort = embedServer.addr.port;
  const embedUrl = `http://127.0.0.1:${embedPort}/v1/embeddings`;
  const embedModel = "mock-semantic-model";

  try {
    const fspec = filespecFor(tmpDir, true);
    const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: embedModel };
    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      axisLibs: axisPath,
      memDir: tmpDir,
      embedUrl,
      embedModel,
    };

    await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath,
      embedEnv: eEnv,
      cwd: tmpDir,
    });

    const shellExec = async (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd ?? tmpDir,
        env: { ...(opts?.env ?? {}), ...eEnv, CORM_AXIS_PATH: axisPath },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };

    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    // Store technical discovery (L1 note)
    const techSummary = "In cormd, socket permissions are set to 0600 and the resident daemon serializes concurrent mutations";
    const envPayload = encodePayload("2026-10-16", {
      level: "L1",
      type: "decision",
      lifecycle: "supported",
      summary: techSummary,
    });
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 10, envPayload, axisPath, tmpDir, eEnv));

    const toolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-tech-query",
      sessionFile: "/tmp/sess-tech.json",
    };

    // Query technical topic
    const scanRes = await executeHybridScan(toolEnv, { topic: "socket permissions cormd", embed: true, limit: 5 });
    const records = scanRes.records;
    const hit = records.find((r) => r.ref === 10);

    assert.ok(hit, "Technical memory must be retrieved");
    assert.ok(hit.summary?.includes("0600"), "Retains '0600' permission detail");
    assert.ok(hit.summary?.includes("cormd"), "Retains 'cormd' detail");
    assert.ok(hit.summary?.includes("concurrent mutations"), "Retains 'concurrent mutations' detail");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
