import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";
import { filespecFor, buildListInvocation, buildGetInvocation } from "../src/corm.ts";
import { parseBareRefs } from "../src/resolve.ts";
import { decodePayload } from "../src/payload.ts";
import { installSessionHooks, activeConversationTurn, type PiCtx } from "../src/hooks/events.ts";
import { handleBeforeAgentStart } from "../src/hooks/auto_recall.ts";
import { runAutoConsolidation, runDeferredConsolidation } from "../src/tools/consolidate.ts";
import { traverseDown } from "../src/tools/traverse.ts";

const home = Deno.env.get("HOME") || "";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

function computeSemanticVector(text: string): number[] {
  const vec = new Array(384).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let hash = 0;
    for (let c = 0; c < w.length; c++) hash = (hash * 31 + w.charCodeAt(c)) | 0;
    const idx = Math.abs(hash) % 384;
    vec[idx] = (vec[idx] || 0) + 1.0;
  }
  let mag = 0;
  for (let i = 0; i < 384; i++) mag += vec[i] * vec[i];
  mag = Math.sqrt(mag) || 1.0;
  for (let i = 0; i < 384; i++) vec[i] /= mag;
  return vec;
}

// ----------------------------------------------------------------------------
// Scenario A & B: Conversational Capture, Skip, and Successor Updates
// ----------------------------------------------------------------------------
Deno.test("conversational_capture_and_mipmaps: Scenario A & B - Two-stage capture, skip, update, and cross-session recall", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-scen-ab-" });
  const sockPath = join(tmpDir, "cormd.sock");

  const sessionA_Id = "01a14b01-sess-a";
  const sessionA_Dir = join(tmpDir, "sessions");
  mkdirSync(sessionA_Dir, { recursive: true });
  const sessionA_File = join(sessionA_Dir, `${sessionA_Id}.jsonl`);

  const sessionB_Id = "01a14b02-sess-b";
  const sessionB_File = join(sessionA_Dir, `${sessionB_Id}.jsonl`);

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

  const classifyServer = Deno.serve({ port: 0 }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname.includes("/v1/systemone") || url.pathname === "/v1/classify" || url.pathname === "/api/v1/classify") {
      const body = await req.json();
      const text = (body.text as string || "").toLowerCase();
      let choice = "remember";
      if (text.includes("do you remember") || text.includes("bye")) {
        choice = "skip";
      }
      return new Response(JSON.stringify({
        choice,
        similarity: choice === "remember" ? 0.95 : 0.70,
        margin: 0.25,
        scores: { remember: choice === "remember" ? 0.95 : 0.60, skip: choice === "skip" ? 0.90 : 0.60 },
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  });

  const classifyUrl = `http://127.0.0.1:${classifyServer.addr.port}`;

  try {
    const fspec = filespecFor(tmpDir, true);
    const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: embedModel };

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

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      axisLibs: axisPath,
      memDir: tmpDir,
      embedUrl,
      embedModel,
      captureEmbedUrl: classifyUrl,
      captureMode: "judge" as const,
    };

    const ctxA: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionA_Id,
      sessionManager: {
        getSessionId: () => sessionA_Id,
        getSessionFile: () => sessionA_File,
        getLeafId: () => "leaf_a1",
      },
    };

    const envSource = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-17T15:00:00Z"),
      cwd: tmpDir,
      sessionId: sessionA_Id,
      sessionFile: sessionA_File,
    });

    // Create event bus and register hooks
    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (event: string, handler: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
      },
      events: { on: () => {} },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, envSource);

    const emit = async (ev: string, data: unknown, c = ctxA) => {
      for (const h of listeners[ev] || []) await h(data, c);
    };

    // Initialize session A
    await emit("session_start", null, ctxA);

    // =========================================================================
    // Turn 1: "I once spoke with my grandpa about airplanes under the cherry tree."
    // =========================================================================
    const prompt1 = "I once spoke with my grandpa about airplanes under the cherry tree.";
    const resp1 = "That sounds like a wonderful memory! Which airplanes did you discuss?";
    await emit("before_agent_start", { messageType: "user", prompt: prompt1 }, ctxA);
    await emit("message_end", { message: { role: "assistant", content: resp1 } });
    await emit("agent_settled", null, ctxA);

    let listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    let refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, 2, "Turn 1 must create L0 experience (Ref 1) and L1 episodic memory (Ref 2)");

    const l0Get1 = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 1, axisPath, tmpDir, eEnv));
    const l0_1 = decodePayload(l0Get1.stdout.trim());
    assert.strictEqual(l0_1.envelope.level, "L0", "Ref 1 must be L0 experience");
    assert.strictEqual(l0_1.envelope.summary, prompt1);
    assert.strictEqual(l0_1.envelope.episode?.sessionId, sessionA_Id);

    const l1Get1 = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 2, axisPath, tmpDir, eEnv));
    const l1_1 = decodePayload(l1Get1.stdout.trim());
    assert.strictEqual(l1_1.envelope.level, "L1", "Ref 2 must be L1 episodic memory");
    assert.deepStrictEqual(l1_1.envelope.evidence, [1], "L1 memory must cite L0 experience ref 1 as evidence");

    // =========================================================================
    // Turn 2: Follow-up "Boing 747."
    // =========================================================================
    const prompt2 = "Boing 747.";
    const resp2 = "The Queen of the Skies! What routes did he fly?";
    await emit("before_agent_start", { messageType: "user", prompt: prompt2 }, ctxA);
    await emit("message_end", { message: { role: "assistant", content: resp2 } });
    await emit("agent_settled", null, ctxA);

    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    refs = parseBareRefs(listRes.stdout);
    // Ref 3: L0 for "Boing 747."
    // Ref 4: L1 successor updating Ref 2
    assert.strictEqual(refs.length, 4, "Turn 2 must store L0 (Ref 3) and L1 successor (Ref 4)");

    const oldL1 = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 2, axisPath, tmpDir, eEnv));
    const oldL1Data = decodePayload(oldL1.stdout.trim());
    assert.strictEqual(oldL1Data.envelope.lifecycle, "superseded", "Predecessor Ref 2 must be superseded");
    assert.strictEqual(oldL1Data.envelope.supersededBy, 4, "Predecessor must point to successor Ref 4");

    const newL1 = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 4, axisPath, tmpDir, eEnv));
    const newL1Data = decodePayload(newL1.stdout.trim());
    assert.strictEqual(newL1Data.envelope.lifecycle, "observed");
    assert.strictEqual(newL1Data.envelope.supersedes, 2, "Successor Ref 4 must cite supersedes 2");
    assert.ok(newL1Data.envelope.summary.includes("Boing 747"), "Successor summary must incorporate Boing 747");
    assert.ok(newL1Data.envelope.episode?.findings?.some((f) => f.includes("grandpa")), "Findings must preserve prior user statement");

    // =========================================================================
    // Turn 3: Follow-up "He flew from Lisbon to Madeira and back."
    // =========================================================================
    const prompt3 = "He flew from Lisbon to Madeira and back.";
    const resp3 = "An incredible Atlantic route! Funchal airport is famously challenging.";
    await emit("before_agent_start", { messageType: "user", prompt: prompt3 }, ctxA);
    await emit("message_end", { message: { role: "assistant", content: resp3 } });
    await emit("agent_settled", null, ctxA);

    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    refs = parseBareRefs(listRes.stdout);
    // Ref 5: L0 for prompt 3
    // Ref 6: L1 successor updating Ref 4
    assert.strictEqual(refs.length, 6, "Turn 3 must store L0 (Ref 5) and L1 successor (Ref 6)");

    const finalActiveL1 = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 6, axisPath, tmpDir, eEnv));
    const finalActiveData = decodePayload(finalActiveL1.stdout.trim());
    assert.strictEqual(finalActiveData.envelope.supersedes, 4);
    assert.ok(finalActiveData.envelope.summary.includes("Lisbon to Madeira"), "Summary must incorporate route");

    // =========================================================================
    // Scenario B Filter Checks: Farewell & Memory Inquiry create NO L1 memory
    // =========================================================================
    const initialCount = refs.length;

    await emit("before_agent_start", { messageType: "user", prompt: "Do you remember what we talked about?" }, ctxA);
    await emit("message_end", { message: { role: "assistant", content: "Yes, you mentioned your grandfather." } });
    await emit("agent_settled", null, ctxA);

    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    assert.strictEqual(parseBareRefs(listRes.stdout).length, initialCount, "Memory inquiry must create 0 memories");

    await emit("before_agent_start", { messageType: "user", prompt: "Bye. I need to go." }, ctxA);
    await emit("message_end", { message: { role: "assistant", content: "Goodbye! Have a great day." } });
    await emit("agent_settled", null, ctxA);

    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    assert.strictEqual(parseBareRefs(listRes.stdout).length, initialCount, "Farewell must create 0 memories");

    // Write authentic session A file for history recovery
    const sessionALines = [
      JSON.stringify({ type: "session", id: sessionA_Id, timestamp: "2026-10-17T15:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: prompt1 }] } }),
      JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [{ type: "text", text: resp1 }] } }),
      JSON.stringify({ type: "message", id: "m3", parentId: "m2", message: { role: "user", content: [{ type: "text", text: prompt2 }] } }),
      JSON.stringify({ type: "message", id: "m4", parentId: "m3", message: { role: "assistant", content: [{ type: "text", text: resp2 }] } }),
      JSON.stringify({ type: "message", id: "m5", parentId: "m4", message: { role: "user", content: [{ type: "text", text: prompt3 }] } }),
      JSON.stringify({ type: "message", id: "m6", parentId: "m5", message: { role: "assistant", content: [{ type: "text", text: resp3 }] } }),
      JSON.stringify({ type: "message", id: "m7", parentId: "m6", message: { role: "user", content: [{ type: "text", text: "Bye. I need to go." }] } }),
    ];
    writeFileSync(sessionA_File, sessionALines.join("\n") + "\n", "utf8");

    // =========================================================================
    // SESSION B: Fresh session queries
    // =========================================================================
    const ctxB: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionB_Id,
      sessionManager: {
        getSessionId: () => sessionB_Id,
        getSessionFile: () => sessionB_File,
        getLeafId: () => "leaf_b1",
      },
    };

    const envSourceB = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-17T16:00:00Z"),
      cwd: tmpDir,
      sessionId: sessionB_Id,
      sessionFile: sessionB_File,
    });

    // Query 1: "Do you remember me speaking about my grandpa?"
    const resB1 = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Do you remember me speaking about my grandpa?",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);

    assert.ok(resB1, "Session B Query 1 must return injected context");
    const contentB1 = resB1.message?.content || "";
    assert.ok(contentB1.includes("[Ref 6]"), "Must recall latest active L1 memory (Ref 6)");
    assert.strictEqual(contentB1.includes("[Ref 2]"), false, "Superseded Ref 2 must never appear");
    assert.strictEqual(contentB1.includes("[Ref 4]"), false, "Superseded Ref 4 must never appear");

    // Query 2: "Which airplane did he fly, and which route?"
    const resB2 = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Which airplane did he fly, and which route?",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);

    assert.ok(resB2, "Session B Query 2 must return injected context in 1 cycle");
    const contentB2 = resB2.message?.content || "";
    assert.ok(contentB2.includes("[Ref 6]"), "Must recall active Ref 6");
    assert.ok(contentB2.includes("Boing 747"), "Context must contain Boeing 747 in 1 cycle");
    assert.ok(contentB2.includes("Lisbon to Madeira"), "Context must contain Lisbon to Madeira in 1 cycle");

    // Clean up daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await classifyServer.shutdown();
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Scenario C: Conversational Mipmap Consolidation & Evidence Traversal
// ----------------------------------------------------------------------------
Deno.test("conversational_capture_and_mipmaps: Scenario C - Conversational L1->L2 consolidation and evidence traversal", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-scen-c-" });
  const sockPath = join(tmpDir, "cormd.sock");

  try {
    const fspec = filespecFor(tmpDir, false);

    await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath,
      cwd: tmpDir,
    });

    const shellExec = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd ?? tmpDir,
        env: { CORM_AXIS_PATH: axisPath },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    const synthServer = Deno.serve({ port: 0 }, async (req) => {
      const body = await req.json();
      const userPrompt = body.messages[1].content as string;
      const matches = [...userPrompt.matchAll(/\[Ref (\d+)\]/g)].map((m) => Number(m[1]));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Family knowledge: grandparents research history and memories",
              explanation: "Synthesized from family memories",
              citedRefs: matches,
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      axisLibs: axisPath,
      memDir: tmpDir,
      synthUrl: `http://127.0.0.1:${synthServer.addr.port}`,
      synthModel: "mock-synthesis-model",
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-scen-c",
    };

    const envSource = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-17T17:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-scen-c",
    });

    // 1. Create two related conversational active L1 memories in the "family" subject
    // Ref 1: L0 experience for grandpa
    // Ref 2: L1 episodic memory for grandpa (evidence: [1])
    // Ref 3: L0 experience for grandma
    // Ref 4: L1 episodic memory for grandma (evidence: [3])
    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (event: string, handler: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
      },
      events: { on: () => {} },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, envSource);
    const emit = async (ev: string, data: unknown, c = ctx) => {
      for (const h of listeners[ev] || []) await h(data, c);
    };

    const ctxC1: PiCtx = { ...ctx, sessionId: "sess-scen-c1" };
    const ctxC2: PiCtx = { ...ctx, sessionId: "sess-scen-c2" };

    await emit("session_start", null, ctxC1);

    activeConversationTurn.topicSubject = "family";
    // Grandpa memory in Session C1
    await emit("before_agent_start", { messageType: "user", prompt: "My grandfather was a commercial pilot who flew across the Atlantic." }, ctxC1);
    await emit("message_end", { message: { role: "assistant", content: "A remarkable aviation career!" } }, ctxC1);
    await emit("agent_settled", null, ctxC1);

    // Switch to Session C2
    await emit("session_start", null, ctxC2);

    activeConversationTurn.topicSubject = "family";
    // Grandma memory in Session C2
    await emit("before_agent_start", { messageType: "user", prompt: "My grandmother was a botanical researcher who studied cherry blossoms." }, ctxC2);
    await emit("message_end", { message: { role: "assistant", content: "Fascinating botanical study!" } }, ctxC2);
    await emit("agent_settled", null, ctxC2);

    const toolEnv = await envSource(ctx);

    const listCheck = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const allRefsCheck = parseBareRefs(listCheck.stdout);
    let l2Ref: number | undefined;
    for (const r of allRefsCheck) {
      const g = await daemonRunner.run(buildGetInvocation(cormBin, fspec, r, axisPath, tmpDir));
      if (g.code === 0 && g.stdout.trim()) {
        const d = decodePayload(g.stdout.trim());
        if (d.envelope.level === "L2") {
          l2Ref = r;
          break;
        }
      }
    }

    // If not already created on incremental settlement, run consolidation explicitly
    if (l2Ref === undefined) {
      const autoRes = await runDeferredConsolidation(toolEnv, ctx, { force: true });
      const autoDetails = autoRes.details as { createdL2: number[]; l3Status: string };
      if (autoDetails.createdL2.length > 0) {
        l2Ref = autoDetails.createdL2[0];
      }
    }

    assert.ok(l2Ref !== undefined, "Auto-consolidation must create an L2 abstraction for 'family'");

    const l2Get = await daemonRunner.run(buildGetInvocation(cormBin, fspec, l2Ref, axisPath, tmpDir));
    const l2Data = decodePayload(l2Get.stdout.trim());
    assert.strictEqual(l2Data.envelope.level, "L2", "Must be L2 abstraction");
    assert.strictEqual(l2Data.envelope.context?.subject, "family", "Context subject must be family");
    assert.ok(l2Data.envelope.evidence && l2Data.envelope.evidence.length >= 2, "L2 must cite supporting L1 refs as evidence");

    // 2. Multilevel Traversal: traverseDown from L2 must reach L1 and L0
    const tree = await traverseDown(toolEnv, fspec, axisPath, tmpDir, {}, l2Ref, 0, 3, new Set());
    assert.ok(tree, "Must traverse down from L2");
    assert.strictEqual(tree.ref, l2Ref);
    assert.ok(tree.children && tree.children.length >= 2, "L2 tree must have L1 children");

    // Children must have L0 sub-children
    const l1Child = tree.children[0];
    assert.ok(l1Child.children && l1Child.children.length >= 1, "L1 child must have L0 evidence child");

    // 3. Idempotency test: running auto consolidation again produces ZERO new records
    const listBefore = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const countBefore = parseBareRefs(listBefore.stdout).length;

    const repeatRes = await runAutoConsolidation(toolEnv, ctx);
    const repeatDetails = repeatRes.details as { createdL2: number[]; totalCreated: number };
    assert.strictEqual(repeatDetails.totalCreated, 0, "Repeated consolidation must be completely idempotent");

    const listAfter = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const countAfter = parseBareRefs(listAfter.stdout).length;
    assert.strictEqual(countAfter, countBefore, "Total records must not change on repeated run");

    // Clean up daemon
    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
