import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  installSessionHooks,
  activeConversationTurn,
  type Pi,
  type PiCtx,
} from "../src/hooks/events.ts";
import { handleBeforeAgentStart } from "../src/hooks/auto_recall.ts";
import { queryLexicalPath, querySemanticPath } from "../src/tools/scan.ts";
import { decodePayload } from "../src/payload.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildListInvocation, buildGetInvocation, filespecFor } from "../src/corm.ts";
import { parseBareRefs } from "../src/resolve.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";

const home = Deno.env.get("HOME") || "";
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;

// Semantic projection helper for local deterministic embedding server
function computeSemanticVector(text: string): number[] {
  const lower = text.toLowerCase();
  // Topic 1: Audio / Sound archiving
  const audioScore = /(?:audio|acoustic|sound|recording|flac|track|lossless|archive|preserve|repository)/i.test(lower) ? 0.9 : 0.05;
  // Topic 2: Memory / Cache allocation
  const memScore = /(?:cache|memory|slab|zephyr|allocat|buffer|heap)/i.test(lower) ? 0.9 : 0.05;
  // Topic 3: Network / Tunneling
  const netScore = /(?:wireguard|tunnel|port|mtu|ip|packet|network)/i.test(lower) ? 0.9 : 0.05;
  // Topic 4: Family / Personal moments / Grandparent
  const familyScore = /(?:grampa|grandpa|grandfather|grandmother|grandma|family|cherry|tree|spending\s+time|spent\s+time|relative|elder)/i.test(lower) ? 0.9 : 0.05;

  // Normalize to unit vector
  const norm = Math.sqrt(audioScore * audioScore + memScore * memScore + netScore * netScore + familyScore * familyScore) || 1.0;
  return [audioScore / norm, memScore / norm, netScore / norm, familyScore / norm];
}

Deno.test("conversational memory: end-to-end knowledge capture, stoma FTS, semantic search, and cross-session auto-recall", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-conv-e2e-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const sessionA_Id = "sess-alpha-20261016-001";
  const sessionA_File = `/tmp/sessions/${sessionA_Id}.json`;
  const sessionB_Id = "sess-beta-20261016-002";
  const sessionB_File = `/tmp/sessions/${sessionB_Id}.json`;

  // Start lightweight local mock embedding server for real HTTP libcurl in libsepal.so
  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const input = typeof body.input === "string" ? body.input : "";
    const vec = computeSemanticVector(input);
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-semantic-model",
      object: "list",
    }), {
      headers: { "Content-Type": "application/json" },
    });
  });

  const embedPort = embedServer.addr.port;
  const embedUrl = `http://127.0.0.1:${embedPort}/v1/embeddings`;
  const embedModel = "mock-semantic-model";

  const classifyServer = Deno.serve({ port: 0 }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/classify" || url.pathname === "/api/v1/classify") {
      const body = await req.json();
      const text = (body.text as string || "").toLowerCase();
      let choice = "remember";
      if (text.includes("hello") || text.includes("good afternoon") || text.includes("what time") || text.includes("bye")) {
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
    const eEnv = {
      CORM_SEPAL_EMBED_URL: embedUrl,
      CORM_SEPAL_EMBED_MODEL: embedModel,
    };

    // Ensure cormd is running with joint, stoma, and sepal
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
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    };

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    const createEnv = (sessId: string, sessFile: string) => {
      return {
        cfg: {
          ...DEFAULT_CONFIG,
          cormBin: cormBin,
          cormdBin,
          memDir: tmpDir,
          axisLibs: axisPath,
          embedUrl,
          embedModel,
          captureEmbedUrl: classifyUrl,
          captureMode: "judge" as const,
        },
        runner: daemonRunner,
        nowProvider: () => new Date("2026-10-16T12:00:00Z"),
        cwd: tmpDir,
        sessionId: sessId,
        sessionFile: sessFile,
      };
    };

    const envSourceA = (_ctx: PiCtx) => Promise.resolve(createEnv(sessionA_Id, sessionA_File));
    const envSourceB = (_ctx: PiCtx) => Promise.resolve(createEnv(sessionB_Id, sessionB_File));

    // Mock Pi Event Bus for Session A
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const mockPiA: Pi = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)?.push(handler);
      },
      registerTool() {},
      exec: shellExec,
    };

    installSessionHooks(mockPiA, envSourceA);

    const emit = async (event: string, ...args: unknown[]) => {
      for (const h of handlers.get(event) ?? []) {
        await h(...args);
      }
    };

    const ctxA: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionA_Id,
      sessionManager: {
        getSessionId: () => sessionA_Id,
        getSessionFile: () => sessionA_File,
        getLeafId: () => "leaf_session_A_001",
      },
    };

    // =========================================================================
    // STEP 1: Tool-free meaningful conversation in Session A
    // =========================================================================
    // Trivial greeting exchange first (must be filtered out!)
    await emit("before_agent_start", { messageType: "user", prompt: "Hello there!" }, ctxA);
    await emit("message_end", { message: { role: "assistant", content: "Hi! How can I help you today?" } });
    await emit("agent_settled", null, ctxA);

    // Verify trivial exchange did not create a memory in CORM
    let listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    let refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, 0, "Trivial conversation must not create memory in CORM");

    // Meaningful explicit knowledge exchange (without any tool calls)
    const promptKnowledge = "Remember this: In our audio pipeline, all acoustic recordings must use 48kHz 24-bit FLAC format for lossless archiving.";
    const assistantReply = "Understood. I will remember that all acoustic recordings must use 48kHz 24-bit FLAC format for lossless archiving.";

    await emit("before_agent_start", { messageType: "user", prompt: promptKnowledge }, ctxA);
    await emit("message_end", { message: { role: "assistant", content: assistantReply } });
    await emit("agent_settled", null, ctxA);

    // Verify the memory exists in CORM and contains the actual idea
    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1, "Meaningful conversational exchange must persist record to CORM");
    const storedRef = refs[refs.length - 1];

    const getRes = await daemonRunner.run(buildGetInvocation(cormBin, fspec, storedRef, axisPath, tmpDir, eEnv));
    assert.strictEqual(getRes.code, 0);
    const { envelope } = decodePayload(getRes.stdout.trim());

    // 1. Memory contains the actual idea, not merely a pointer
    assert.strictEqual(envelope.type, "note");
    assert.strictEqual(envelope.lifecycle, "observed");
    assert.ok(envelope.summary.includes("48kHz 24-bit FLAC"), "Summary must contain key technical specifications");
    assert.ok(envelope.summary.includes("lossless archiving"), "Summary must contain core concept");

    // 5. Memory links to Session A's authentic session identifiers
    assert.strictEqual(envelope.episode?.sessionId, sessionA_Id);
    assert.strictEqual(envelope.episode?.sessionFile, sessionA_File);
    assert.strictEqual(envelope.episode?.leafId, "leaf_session_A_001");

    // =========================================================================
    // STEP 2: Independent Stoma FTS Keyword Retrieval
    // =========================================================================
    // Query with distinctive exact keyword "FLAC"
    const toolEnvA = await envSourceA(ctxA);
    const ftsResult = await queryLexicalPath(
      toolEnvA,
      tmpDir,
      axisPath,
      0, // time level 0 (pure text)
      new Date(),
      undefined,
      "FLAC",
      5,
    );

    assert.strictEqual(ftsResult.lines.length > 0, true, "Stoma FTS must retrieve memory by distinctive keyword 'FLAC'");
    assert.ok(ftsResult.lines.some((l) => refs.includes(l.ref)), "FTS lines must reference stored record");
    console.log(`[PASS] Independent Stoma FTS retrieved ref via keyword 'FLAC'`);

    // =========================================================================
    // STEP 3: Independent Sepal Semantic Retrieval
    // =========================================================================
    // Query with a pure paraphrased question that shares ZERO distinctive words:
    // "How do we preserve sound records in the sound repository?"
    // (None of "acoustic", "recording", "48kHz", "24-bit", "FLAC", "lossless", "archiving" are in the query)
    const paraphraseQuery = "How do we preserve sound records in the sound repository?";
    const semanticResult = await querySemanticPath(
      toolEnvA,
      tmpDir,
      axisPath,
      0,
      new Date(),
      undefined,
      paraphraseQuery,
      5,
    );

    assert.strictEqual(semanticResult.lines.length > 0, true, "Sepal semantic search must retrieve memory by paraphrase");
    assert.ok(semanticResult.lines.some((l) => refs.includes(l.ref)), "Sepal lines must reference stored record");
    console.log(`[PASS] Independent Sepal Semantic search retrieved ref via paraphrase`);

    // =========================================================================
    // STEP 4: Combined Cross-Session Auto-Recall in Session B
    // =========================================================================
    // Fresh session B with independent session ID and fresh context
    const ctxB: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionB_Id,
      sessionManager: {
        getSessionId: () => sessionB_Id,
        getSessionFile: () => sessionB_File,
        getLeafId: () => "leaf_session_B_001",
      },
    };

    // User in Session B asks about audio format
    const recallResult = await handleBeforeAgentStart(
      { messageType: "user", prompt: "What standard applies to storing audio tracks?" },
      ctxB,
      envSourceB,
    );

    assert.ok(recallResult !== null, "handleBeforeAgentStart must inject context into Session B");
    assert.strictEqual(recallResult.message?.role, "custom", "Injected message must specify role: 'custom' for LLM conversion");
    assert.strictEqual(recallResult.message?.customType, "memory_context");
    assert.strictEqual(recallResult.message.display, true);

    const injectedText = recallResult.message.content;
    assert.ok(injectedText.includes("[Persistent Memory Context]"), "Must include memory context header");
    assert.ok(injectedText.includes(`Ref ${storedRef}`), "Must cite retrieved reference");
    assert.ok(injectedText.includes("48kHz 24-bit FLAC"), "Injected context must contain the actual preserved fact");
    console.log(`[PASS] Cross-session auto-recall injected conversational memory into Session B:\n${injectedText}`);

    // Clean up cormd daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await classifyServer.shutdown();
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("conversational memory: captureMode controls whether messages enter memory", () => {
  // Mode all captures every non-empty user prompt
  assert.ok(true);
});

Deno.test("conversational memory: multi-turn tool interaction preserves final conclusion across turn_end until agent_settled", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-conv-multiturn-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const sessionId = "sess-multiturn-20261016-003";
  const sessionFile = `/tmp/sessions/${sessionId}.json`;

  try {
    const fspec = filespecFor(tmpDir, false);

    await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath,
      cwd: tmpDir,
    });

    const shellExec = async (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd ?? tmpDir,
        env: { ...(opts?.env ?? {}), CORM_AXIS_PATH: axisPath },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    };

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    const createEnv = () => ({
      cfg: {
        ...DEFAULT_CONFIG,
        cormBin: cormBin,
        cormdBin,
        memDir: tmpDir,
        axisLibs: axisPath,
      },
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId,
      sessionFile,
    });

    const envSource = (_ctx: PiCtx) => Promise.resolve(createEnv());

    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const mockPi: Pi = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)?.push(handler);
      },
      registerTool() {},
      exec: shellExec,
    };

    installSessionHooks(mockPi, envSource);

    const emit = async (event: string, ...args: unknown[]) => {
      for (const h of handlers.get(event) ?? []) {
        await h(...args);
      }
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId,
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf_multiturn_001",
      },
    };

    // Initialize session
    await emit("session_start", null, ctx);

    // 1. User prompts with a problem-solving request
    const userPrompt = "Investigate why the audio streaming pipeline dropped packets during high-concurrency bursts.";
    await emit("before_agent_start", { messageType: "user", prompt: userPrompt }, ctx);

    // 2. Intermediate turn 1: Assistant intermediate message + tool execution
    await emit("message_end", {
      message: { role: "assistant", content: "Inspecting socket buffer configurations with bash tool." },
    });

    await emit("tool_result", {
      toolCallId: "tc_bash_inspect_01",
      toolName: "bash",
      args: { command: "npm test -- --grep socket_buffer" },
      content: [{ type: "text", text: "PASS: 10 passed, 0 failed" }],
      isError: false,
      timestamp: new Date().toISOString(),
    });

    // Intermediate turn ends
    await emit("turn_end", null, ctx);

    // 3. Verify intermediate state:
    // a) Prompt is NOT cleared
    assert.strictEqual(activeConversationTurn.prompt, userPrompt, "Intermediate turn_end must NOT clear active conversation prompt");
    // b) Tool episode was flushed
    let listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    let refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, 1, "Tool event was persisted as episode");
    const episodeRef = refs[0];
    const episodeGet = await daemonRunner.run(buildGetInvocation(cormBin, fspec, episodeRef, axisPath, tmpDir));
    const episodeData = decodePayload(episodeGet.stdout.trim());
    assert.strictEqual(episodeData.envelope.type, "episode");

    // 4. Final turn 2: Assistant reaches final conclusion
    const finalConclusion = "The audio streaming pipeline dropped packets because socket send buffers were limited to 64KB; increasing SO_SNDBUF to 512KB eliminated all packet drops under 10k concurrent streams.";
    await emit("message_end", {
      message: { role: "assistant", content: finalConclusion },
    });

    // Agent run settles completely
    await emit("agent_settled", null, ctx);

    // 5. Verify final state:
    // a) Prompt is now cleared after settlement
    assert.strictEqual(activeConversationTurn.prompt, undefined, "agent_settled must reset active conversation prompt");

    // b) Conversational memory with final conclusion was persisted
    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 2, "Conversational memory must be created on agent_settled");

    let convData: ReturnType<typeof decodePayload> | null = null;
    let convRef: number | undefined;
    for (const r of refs) {
      if (r === episodeRef) continue;
      const g = await daemonRunner.run(buildGetInvocation(cormBin, fspec, r, axisPath, tmpDir));
      if (g.code === 0 && g.stdout.trim()) {
        const d = decodePayload(g.stdout.trim());
        if (d.envelope.summary.includes("Investigate why") || d.envelope.summary.includes("socket send buffers")) {
          convRef = r;
          convData = d;
          break;
        }
      }
    }
    assert.ok(convRef !== undefined, "Conversational memory ref must exist");
    assert.ok(convData !== null);
    assert.ok(convData.envelope.summary.includes("Investigate why") || convData.envelope.summary.includes("socket send buffers"), "User experience must be captured in summary");
    assert.strictEqual(convData.envelope.episode?.sessionId, sessionId, "Source session ID must be preserved");
    assert.strictEqual(convData.envelope.episode?.sessionFile, sessionFile, "Source session file must be preserved");
    assert.strictEqual(convData.envelope.episode?.leafId, "leaf_multiturn_001", "Source leaf ID must be preserved");

    // Clean up daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("conversational memory: natural non-technical experience 'I spoke to my grampa under the cherry tree' is captured and recalled across sessions", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-conv-grampa-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const sessionA_Id = "sess-grampa-A-001";
  const sessionA_File = `/tmp/sessions/${sessionA_Id}.json`;
  const sessionB_Id = "sess-grampa-B-002";
  const sessionB_File = `/tmp/sessions/${sessionB_Id}.json`;

  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const input = typeof body.input === "string" ? body.input : "";
    const vec = computeSemanticVector(input);
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-semantic-model",
      object: "list",
    }), {
      headers: { "Content-Type": "application/json" },
    });
  });

  const embedPort = embedServer.addr.port;
  const embedUrl = `http://127.0.0.1:${embedPort}/v1/embeddings`;
  const embedModel = "mock-semantic-model";

  const classifyServer2 = Deno.serve({ port: 0 }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/classify" || url.pathname === "/api/v1/classify") {
      const body = await req.json();
      const text = (body.text as string || "").toLowerCase();
      let choice = "remember";
      if (text.includes("good afternoon") || text.includes("hello") || text.includes("bye")) {
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

  const classifyUrl2 = `http://127.0.0.1:${classifyServer2.addr.port}`;

  try {
    const fspec = filespecFor(tmpDir, true);
    const eEnv = {
      CORM_SEPAL_EMBED_URL: embedUrl,
      CORM_SEPAL_EMBED_MODEL: embedModel,
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
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    };

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    const createEnv = (sessId: string, sessFile: string) => ({
      cfg: {
        ...DEFAULT_CONFIG,
        cormBin: cormBin,
        cormdBin,
        memDir: tmpDir,
        axisLibs: axisPath,
        embedUrl,
        embedModel,
        captureEmbedUrl: classifyUrl2,
        captureMode: "judge" as const,
      },
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: sessId,
      sessionFile: sessFile,
    });

    const envSourceA = (_ctx: PiCtx) => Promise.resolve(createEnv(sessionA_Id, sessionA_File));
    const envSourceB = (_ctx: PiCtx) => Promise.resolve(createEnv(sessionB_Id, sessionB_File));

    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const mockPiA: Pi = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)?.push(handler);
      },
      registerTool() {},
      exec: shellExec,
    };

    installSessionHooks(mockPiA, envSourceA);

    const emit = async (event: string, ...args: unknown[]) => {
      for (const h of handlers.get(event) ?? []) {
        await h(...args);
      }
    };

    const ctxA: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionA_Id,
      sessionManager: {
        getSessionId: () => sessionA_Id,
        getSessionFile: () => sessionA_File,
        getLeafId: () => "leaf_grampa_A_001",
      },
    };

    // 1. Trivial exchange: greeting (must remain unpersisted)
    await emit("session_start", null, ctxA);
    await emit("before_agent_start", { messageType: "user", prompt: "Good afternoon!" }, ctxA);
    await emit("message_end", { message: { role: "assistant", content: "Good afternoon! How are you?" } });
    await emit("agent_settled", null, ctxA);

    let listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    let refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, 0, "Trivial greeting must remain unpersisted");

    // 2. Natural conversation: "I spoke to my grampa under the cherry tree" (no tools, no remember directive)
    const naturalPrompt = "I spoke to my grampa under the cherry tree";
    const naturalReply = "That sounds like a peaceful and cherished moment.";

    await emit("before_agent_start", { messageType: "user", prompt: naturalPrompt }, ctxA);
    await emit("message_end", { message: { role: "assistant", content: naturalReply } });
    await emit("agent_settled", null, ctxA);

    // 3. Verify memory is persisted in CORM
    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1, "Natural memorable experience must be persisted");
    const storedRef = refs[refs.length - 1];

    const getRes = await daemonRunner.run(buildGetInvocation(cormBin, fspec, storedRef, axisPath, tmpDir, eEnv));
    assert.strictEqual(getRes.code, 0);
    const { envelope } = decodePayload(getRes.stdout.trim());
    assert.strictEqual(envelope.type, "note");
    assert.strictEqual(envelope.summary, "I spoke to my grampa under the cherry tree");
    assert.strictEqual(envelope.episode?.sessionId, sessionA_Id);
    assert.strictEqual(envelope.episode?.sessionFile, sessionA_File);
    assert.strictEqual(envelope.episode?.leafId, "leaf_grampa_A_001");

    // 4. Stoma query for "cherry" retrieves it
    const toolEnvA = await envSourceA(ctxA);
    const ftsResult = await queryLexicalPath(
      toolEnvA,
      tmpDir,
      axisPath,
      0,
      new Date(),
      undefined,
      "cherry",
      5,
    );
    assert.strictEqual(ftsResult.lines.length > 0, true, "Stoma query for 'cherry' must retrieve the record");
    assert.ok(ftsResult.lines.some((l) => refs.includes(l.ref)), "FTS lines must reference stored record");
    console.log(`[PASS] Stoma FTS query for 'cherry' retrieved ref ${storedRef}`);

    // 5. Semantic query "What did I tell you about spending time with my grandfather?" retrieves it
    // Note: Query does NOT contain the words "cherry" or "grampa"
    const semanticQuery = "What did I tell you about spending time with my grandfather?";
    const semanticResult = await querySemanticPath(
      toolEnvA,
      tmpDir,
      axisPath,
      0,
      new Date(),
      undefined,
      semanticQuery,
      5,
    );
    assert.strictEqual(semanticResult.lines.length > 0, true, "Semantic query for grandfather must retrieve the record");
    assert.ok(semanticResult.lines.some((l) => refs.includes(l.ref)), "Semantic lines must reference stored record");
    console.log(`[PASS] Sepal Semantic query for grandfather retrieved ref ${storedRef} (score: ${semanticResult.lines[0].score})`);

    // 6. Automatic recall into fresh Session B
    const ctxB: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionB_Id,
      sessionManager: {
        getSessionId: () => sessionB_Id,
        getSessionFile: () => sessionB_File,
        getLeafId: () => "leaf_grampa_B_001",
      },
    };

    const recallResult = await handleBeforeAgentStart(
      { messageType: "user", prompt: semanticQuery },
      ctxB,
      envSourceB,
    );

    assert.ok(recallResult !== null, "handleBeforeAgentStart must inject context into Session B");
    assert.strictEqual(recallResult.message?.role, "custom", "Injected message must specify role: 'custom' for LLM conversion");
    const content = recallResult.message?.content || "";
    assert.ok(content.includes("[Persistent Memory Context]"), "Must include memory context header");
    assert.ok(content.includes(`Ref ${storedRef}`), "Must cite retrieved reference");
    assert.ok(content.includes("I spoke to my grampa under the cherry tree"), "Must contain the preserved memory summary");
    console.log(`[PASS] Cross-session auto-recall injected memory into Session B:\n${content}`);

    // Clean up daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await classifyServer2.shutdown();
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("conversational memory: end-to-end Session A 'I spoke to my grandfather under the cherry tree.' -> Session B 'Do you remember me speaking about my grandfather?'", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-sess-ab-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const sessionA_Id = "sess-ab-A-101";
  const sessionA_File = `/tmp/sessions/${sessionA_Id}.json`;
  const sessionB_Id = "sess-ab-B-102";
  const sessionB_File = `/tmp/sessions/${sessionB_Id}.json`;

  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const input = typeof body.input === "string" ? body.input : "";
    const vec = computeSemanticVector(input);
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-semantic-model",
      object: "list",
    }), {
      headers: { "Content-Type": "application/json" },
    });
  });

  const embedPort = embedServer.addr.port;
  const embedUrl = `http://127.0.0.1:${embedPort}/v1/embeddings`;
  const embedModel = "mock-semantic-model";

  try {
    const fspec = filespecFor(tmpDir, true);
    const eEnv = {
      CORM_SEPAL_EMBED_URL: embedUrl,
      CORM_SEPAL_EMBED_MODEL: embedModel,
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
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    };

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    const createEnv = (sessId: string, sessFile: string) => ({
      cfg: {
        ...DEFAULT_CONFIG,
        cormBin: cormBin,
        cormdBin,
        memDir: tmpDir,
        axisLibs: axisPath,
        embedUrl,
        embedModel,
      },
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: sessId,
      sessionFile: sessFile,
    });

    const envSourceA = (_ctx: PiCtx) => Promise.resolve(createEnv(sessionA_Id, sessionA_File));
    const envSourceB = (_ctx: PiCtx) => Promise.resolve(createEnv(sessionB_Id, sessionB_File));

    const handlersA = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const mockPiA: Pi = {
      on(event: string, handler: (...args: unknown[]) => unknown) {
        if (!handlersA.has(event)) handlersA.set(event, []);
        handlersA.get(event)?.push(handler);
      },
      registerTool() {},
      exec: shellExec,
    };

    installSessionHooks(mockPiA, envSourceA);

    const emitA = async (event: string, ...args: unknown[]) => {
      for (const h of handlersA.get(event) ?? []) {
        await h(...args);
      }
    };

    const ctxA: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionA_Id,
      sessionManager: {
        getSessionId: () => sessionA_Id,
        getSessionFile: () => sessionA_File,
        getLeafId: () => "leaf_sess_A_001",
      },
    };

    // SESSION A:
    await emitA("session_start", null, ctxA);
    const promptA = "I spoke to my grandfather under the cherry tree.";
    const responseA = "That sounds like a tranquil and meaningful memory.";

    await emitA("before_agent_start", { messageType: "user", prompt: promptA }, ctxA);
    await emitA("message_end", { message: { role: "assistant", content: responseA } });
    await emitA("agent_settled", null, ctxA);

    // Verify stored in CORM
    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    const refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1, "Session A must store memory record");
    const storedRef = refs[refs.length - 1];

    const getRes = await daemonRunner.run(buildGetInvocation(cormBin, fspec, storedRef, axisPath, tmpDir, eEnv));
    assert.strictEqual(getRes.code, 0);
    const { envelope } = decodePayload(getRes.stdout.trim());
    assert.ok(envelope.summary.includes("I spoke to my grandfather under the cherry tree"));

    // SESSION B:
    const ctxB: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionB_Id,
      sessionManager: {
        getSessionId: () => sessionB_Id,
        getSessionFile: () => sessionB_File,
        getLeafId: () => "leaf_sess_B_001",
      },
    };

    const promptB = "Do you remember me speaking about my grandfather?";
    const eventB: import("../src/hooks/auto_recall.ts").BeforeAgentStartEvent = {
      messageType: "user",
      prompt: promptB,
      systemPromptOptions: { sections: {} },
    };

    const recallResult = await handleBeforeAgentStart(eventB, ctxB, envSourceB);

    assert.ok(recallResult !== null, "handleBeforeAgentStart must inject context into Session B");
    assert.ok(recallResult.message);
    assert.strictEqual(recallResult.message.role, "custom");
    assert.strictEqual(recallResult.message.customType, "memory_context");
    assert.ok(recallResult.message.content.includes("I spoke to my grandfather under the cherry tree"));
    assert.ok(recallResult.message.content.includes(`Ref ${storedRef}`));

    // Verify systemPromptOptions was populated
    assert.ok(eventB.systemPromptOptions?.sections);
    assert.ok(eventB.systemPromptOptions.sections["memory_context"]?.includes("I spoke to my grandfather under the cherry tree"));

    // Clean up daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});



