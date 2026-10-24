import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type PiCtx,
} from "../src/hooks/events.ts";
import {
  handleBeforeAgentStart,
  buildInjectedContext,
} from "../src/hooks/auto_recall.ts";
import { encodePayload, decodePayload } from "../src/payload.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildStoreInvocation, buildGetInvocation, buildScanInvocation, filespecFor, parseResultLines } from "../src/corm.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";
import { executeHybridScan } from "../src/tools/scan.ts";
import type { FusedCandidate } from "../src/tools/ranking.ts";

const home = Deno.env.get("HOME") || "";
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;

function computeSemanticVector(text: string): number[] {
  const lower = text.toLowerCase();
  const dogScore = /(?:barnaby|border\s+collie|rescue|mountains?|dog|puppy)/i.test(lower) ? 0.9 : 0.05;
  const toolScore = /(?:bash|test|fixtures?|script|exec)/i.test(lower) ? 0.9 : 0.05;
  const norm = Math.sqrt(dogScore * dogScore + toolScore * toolScore) || 1.0;
  return [dogScore / norm, toolScore / norm, 0.1];
}

// ----------------------------------------------------------------------------
// Test 1: L0 tool episodes are strictly filtered out of conversational context
// ----------------------------------------------------------------------------
Deno.test("regression: buildInjectedContext strictly filters out L0 tool episodes", () => {
  const candidates: FusedCandidate[] = [
    {
      ref: 1,
      record: "2026-10-16:{}",
      origin: "lemma",
      rrfScore: 0.05,
      score: "1.0",
      envelope: {
        level: "L0",
        type: "episode",
        lifecycle: "tested",
        summary: "Executed bash: .pi/extensions/pi-mm/tests/quality_and_relevance.test.ts: // Dim 0: Grandfather",
      },
    },
    {
      ref: 2,
      record: "2026-10-16:{}",
      origin: "lemma",
      rrfScore: 0.05,
      score: "0.9",
      envelope: {
        level: "L1",
        type: "note",
        lifecycle: "observed",
        summary: "I talked to my grandfather about airplanes under the cherry tree",
      },
    },
  ];

  const context = buildInjectedContext(candidates, 1000);
  assert.ok(context.includes("I talked to my grandfather about airplanes under the cherry tree"), "Must include L1 conversational memory");
  assert.strictEqual(context.includes("quality_and_relevance.test.ts"), false, "Must strictly exclude L0 code/tool paths");
  assert.strictEqual(context.includes("Executed bash"), false, "Must strictly exclude L0 bash commands");
  assert.ok(context.includes("Do NOT search the codebase"), "Must include explicit anti-tool directive");
});

// ----------------------------------------------------------------------------
// Test 2: Two-session test: Direct storage, direct stoma retrieval, and auto-recall
// ----------------------------------------------------------------------------
Deno.test("regression: Two-session test with fresh unique statement", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-reg-barnaby-" });
  const sockPath = join(tmpDir, "cormd.sock");

  const sessionA_Id = "01a146d9-sess-a-barnaby";
  const sessionA_Dir = join(tmpDir, "sessions");
  mkdirSync(sessionA_Dir, { recursive: true });
  const sessionA_File = join(sessionA_Dir, `${sessionA_Id}.jsonl`);

  const sessionB_Id = "01a146da-sess-b-barnaby";

  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const input = typeof body.input === "string" ? body.input : "";
    const vec = computeSemanticVector(input);
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-model",
      object: "list",
    }), { headers: { "Content-Type": "application/json" } });
  });

  const embedPort = embedServer.addr.port;
  const embedUrl = `http://127.0.0.1:${embedPort}/v1/embeddings`;
  const embedModel = "mock-model";

  try {
    const fspec = filespecFor(tmpDir, true);
    const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: embedModel };
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
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

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    // 1. Session A: Direct storage of conversational memory
    const uniqueFact = "I adopted a rescue border collie named Barnaby in the mountains";
    const payload = encodePayload("2026-10-16", {
      level: "L1",
      type: "note",
      lifecycle: "observed",
      summary: uniqueFact,
      episode: {
        problem: uniqueFact,
        findings: [uniqueFact],
        outcome: "success",
        sessionId: sessionA_Id,
        sessionFile: sessionA_File,
        leafId: "leaf_a1",
      },
    });

    const storeRes = await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, payload, axisPath, tmpDir, eEnv));
    assert.strictEqual(storeRes.code, 0, "Direct store must succeed");

    // Verify direct record retrieval
    const getRes = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 1, axisPath, tmpDir, eEnv));
    const { envelope } = decodePayload(getRes.stdout.trim());
    assert.strictEqual(envelope.summary, uniqueFact);

    // 2. Direct Stoma retrieval
    const stomaInv = buildScanInvocation(cormBin, fspec, "lemma", 5, axisPath, tmpDir, eEnv, ["--query=Barnaby"]);
    const stomaRes = await daemonRunner.run(stomaInv);
    assert.strictEqual(stomaRes.code, 0, "Stoma query must succeed");
    const stomaLines = parseResultLines(stomaRes.stdout);
    assert.ok(stomaLines.length > 0, "Stoma scan must locate Ref 1 by keyword");
    const stomaDecoded = decodePayload(stomaLines[0].record);
    assert.ok(stomaDecoded.envelope.summary.includes("Barnaby"), "Stoma scan must locate Ref 1 by keyword");

    // 3. Direct Hybrid Scan
    const hybridRes = await executeHybridScan({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date(),
      cwd: tmpDir,
    }, { topic: "Do you remember what dog I adopted in the mountains?", limit: 5, embed: true });

    assert.ok(hybridRes.records.length > 0, "Hybrid scan must retrieve the memory");
    assert.strictEqual(hybridRes.records[0].ref, 1);

    // 4. Session B: Automatic context injection
    const ctxB: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionB_Id,
    };
    const envSourceB = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date(),
      cwd: tmpDir,
    });

    const recallEvent = {
      messageType: "user" as const,
      prompt: "Do you remember what dog I adopted in the mountains?",
      systemPromptOptions: { sections: {} },
    };

    const recallResult = await handleBeforeAgentStart(recallEvent, ctxB, envSourceB);
    assert.ok(recallResult, "handleBeforeAgentStart must return memory context");
    const injected = recallResult.message?.content || "";

    assert.ok(injected.includes("Barnaby"), "Injected context must contain Barnaby");
    assert.ok(injected.includes("border collie"), "Injected context must contain border collie");
    assert.ok(injected.includes("Do NOT search the codebase"), "Injected context must include passive guidance");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
