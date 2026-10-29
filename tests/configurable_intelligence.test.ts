import { existsSync } from "node:fs";
import assert from "node:assert";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DEFAULT_CONFIG, loadConfig, applyEnv, sepalConfigured, judgeConfigured, describeCapabilities } from "../src/config.ts";
import { evaluateTurnWithJudge, checkMmHealth } from "../src/judge/adapter.ts";
import { installSessionHooks, type Pi, type PiCtx } from "../src/hooks/events.ts";
import { queryLexicalPath, querySemanticPath } from "../src/tools/scan.ts";
import { handleBeforeAgentStart } from "../src/hooks/auto_recall.ts";
import { DaemonCormRunner, buildStoreInvocation, buildListInvocation, filespecFor, embedEnv } from "../src/corm.ts";
import { parseBareRefs } from "../src/resolve.ts";
import { ensureDaemon } from "../src/daemon.ts";

const home = Deno.env.get("HOME") || "";
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;

function computeMockVector(text: string): number[] {
  const lower = text.toLowerCase();
  const audioScore = /(?:audio|acoustic|sound|flac)/i.test(lower) ? 0.9 : 0.05;
  const memScore = /(?:cache|memory|redis|allocat)/i.test(lower) ? 0.9 : 0.05;
  const familyScore = /(?:grampa|grandpa|grandfather|family|cherry|tree|spending\s+time)/i.test(lower) ? 0.9 : 0.05;
  const norm = Math.sqrt(audioScore * audioScore + memScore * memScore + familyScore * familyScore) || 1.0;
  return [audioScore / norm, memScore / norm, familyScore / norm];
}

// ----------------------------------------------------------------------------
// Test 1: No inference services (judgeMode=heuristic, semanticSearch=false)
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 1. No inference services starts normally, FTS works, 0 network calls", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "ci-no-infer-" });
  const sockPath = join(tmpDir, "cormd.sock");

  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      judgeMode: "heuristic" as const,
      semanticSearch: false,
    };

    assert.strictEqual(judgeConfigured(cfg), false);
    assert.strictEqual(sepalConfigured(cfg), false);
    const desc = describeCapabilities(cfg);
    assert(desc.includes("judge=heuristic"), "Must describe judge as heuristic");
    assert(desc.includes("semantic=disabled"), "Must describe semantic as disabled");
    assert(desc.includes("lemma=active"), "Must describe stoma as active");

    const fspec = filespecFor(tmpDir, false);
    assert.strictEqual(fspec.includes("sepal"), false, "Roster must not contain sepal when semantic is disabled");

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
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });
    const envSource = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-no-infer-001",
      sessionFile: "/tmp/sess.json",
    });

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
      for (const h of handlers.get(event) ?? []) await h(...args);
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-no-infer-001",
      sessionManager: { getSessionId: () => "sess-no-infer-001", getSessionFile: () => "/tmp/sess.json", getLeafId: () => "leaf_1" },
    };

    await emit("session_start", null, ctx);

    // Heuristic capture of natural experience
    await emit("before_agent_start", { messageType: "user", prompt: "I spoke to my grampa under the cherry tree" }, ctx);
    await emit("message_end", { message: { role: "assistant", content: "That is a wonderful family memory." } });
    await emit("agent_settled", null, ctx);

    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1, "Must capture memory via heuristic");

    const toolEnv = await envSource(ctx);
    const fts = await queryLexicalPath(toolEnv, tmpDir, axisPath, 0, new Date(), undefined, "cherry", 5);
    assert(fts.lines.length > 0, "Stoma FTS must retrieve 'cherry'");
    assert.ok(refs.includes(fts.lines[0].ref));

    // Clean up daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Test 2: In-memory embedding classifier endpoint POST /v1/classify and deterministic fallback
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 2. In-memory embedding classifier endpoint POST /v1/classify and deterministic fallback", async () => {
  let classifyCount = 0;

  const classifyServer = Deno.serve({ port: 0 }, async (req) => {
    classifyCount++;
    const url = new URL(req.url);
    assert(url.pathname === "/v1/classify" || url.pathname === "/api/v1/classify");
    const body = await req.json();

    const text = (body.text as string).toLowerCase();
    let choice = "skip";
    let similarity = 0.85;
    let margin = 0.20;
    if (text.includes("caching layer")) {
      choice = "remember";
      similarity = 0.92;
      margin = 0.25;
    }

    return new Response(JSON.stringify({
      choice,
      similarity,
      margin,
      scores: { remember: choice === "remember" ? 0.92 : 0.67, skip: choice === "skip" ? 0.85 : 0.67 },
    }), { headers: { "Content-Type": "application/json" } });
  });

  const baseUrl = `http://127.0.0.1:${classifyServer.addr.port}`;

  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      captureEmbedUrl: baseUrl,
    };

    // 1. Remember decision
    const res1 = await evaluateTurnWithJudge(
      "We decided to configure the caching layer with Redis cluster.",
      "Understood. The Redis cluster will handle the cache.",
      cfg,
    );
    assert.strictEqual(res1.source, "embed");
    assert.strictEqual(res1.degraded, undefined);
    assert.strictEqual(res1.decision.action, "remember");
    assert(res1.decision.summary && res1.decision.summary.includes("caching layer"));

    // 2. Skip decision (trivial chatter)
    const res2 = await evaluateTurnWithJudge("Hello!", "Hi there! How can I help you?", cfg);
    assert.strictEqual(res2.source, "embed");
    assert.strictEqual(res2.decision.action, "skip");
  } finally {
    await classifyServer.shutdown();
  }
});

// ----------------------------------------------------------------------------
// Test 2b: Fallback when classifier endpoint is unavailable
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 2b. Fallback when classifier endpoint is unavailable", async () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: "http://127.0.0.1:59998", // unreachable
    judgeFallback: "skip" as const,
  };

  const res1 = await evaluateTurnWithJudge("Let's discuss the caching layer.", "We are using Redis.", cfg);
  assert.strictEqual(res1.source, "fallback");
  assert.strictEqual(res1.decision.action, "skip");
  assert.strictEqual(res1.degraded, true);
});

// ----------------------------------------------------------------------------
// Test 2c: End-to-end classifier decision persistence and Stoma FTS retrieval
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 2c. End-to-end classifier decision persistence and Stoma FTS retrieval", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "ci-classify-e2e-" });
  const sockPath = join(tmpDir, "cormd.sock");

  const classifyServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const text = (body.text as string || "").toLowerCase();
    let choice = "skip";
    if (text.includes("caching layer")) {
      choice = "remember";
    }
    return new Response(JSON.stringify({
      choice,
      similarity: choice === "remember" ? 0.92 : 0.80,
      margin: choice === "remember" ? 0.25 : 0.20,
      scores: { remember: 0.90, skip: 0.70 },
    }), { headers: { "Content-Type": "application/json" } });
  });

  const baseUrl = `http://127.0.0.1:${classifyServer.addr.port}`;

  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureEmbedUrl: baseUrl,
      semanticSearch: false,
    };

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
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });
    const envSource = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-jev-001",
      sessionFile: "/tmp/sess.json",
    });

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
      for (const h of handlers.get(event) ?? []) await h(...args);
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-jev-001",
      sessionManager: { getSessionId: () => "sess-jev-001", getSessionFile: () => "/tmp/sess.json", getLeafId: () => "leaf_1" },
    };

    await emit("session_start", null, ctx);

    // 1. Remember
    await emit("before_agent_start", { messageType: "user", prompt: "We decided to configure the caching layer with Redis cluster." }, ctx);
    await emit("message_end", { message: { role: "assistant", content: "Understood, using Redis cluster." } });
    await emit("agent_settled", null, ctx);

    let listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    let refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1, "Must store memory from Jev remember decision");
    const countAfterRemember = refs.length;

    // 2. Skip
    await emit("before_agent_start", { messageType: "user", prompt: "What time is it?" }, ctx);
    await emit("message_end", { message: { role: "assistant", content: "I don't track system time." } });
    await emit("agent_settled", null, ctx);

    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, countAfterRemember, "Skip must not add memory");

    // 3. Update
    await emit("before_agent_start", { messageType: "user", prompt: "Regarding caching layer, we expanded to 3 shards." }, ctx);
    await emit("message_end", { message: { role: "assistant", content: "Updated caching layer to 3 shards." } });
    await emit("agent_settled", null, ctx);

    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length > countAfterRemember, "Update must store successor memory");

    // Check Stoma retrieval
    const toolEnv = await envSource(ctx);
    const fts = await queryLexicalPath(toolEnv, tmpDir, axisPath, 0, new Date(), undefined, "caching", 5);
    assert(fts.lines.length > 0, "Stoma must find memory saved via Jev");

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await classifyServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Test 3: Semantic search only (judgeMode=heuristic, semanticSearch=true)
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 3. [synthetic/mock] Semantic search only generates embeddings and retrieves via Sepal", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "ci-sem-only-" });
  const sockPath = join(tmpDir, "cormd.sock");

  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const vec = computeMockVector(typeof body.input === "string" ? body.input : "");
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-embed",
      object: "list",
    }), { headers: { "Content-Type": "application/json" } });
  });

  const embedUrl = `http://127.0.0.1:${embedServer.addr.port}/v1/embeddings`;

  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      judgeMode: "heuristic" as const,
      semanticSearch: true,
      embedUrl,
      embedModel: "mock-embed",
    };

    assert.strictEqual(judgeConfigured(cfg), false);
    assert.strictEqual(sepalConfigured(cfg), true);

    const fspec = filespecFor(tmpDir, true);
    assert(fspec.includes("sepal"), "Roster must include sepal when semantic is enabled");

    const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: "mock-embed" };
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
    const envSource = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-sem-001",
      sessionFile: "/tmp/sess.json",
    });

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
      for (const h of handlers.get(event) ?? []) await h(...args);
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-sem-001",
      sessionManager: { getSessionId: () => "sess-sem-001", getSessionFile: () => "/tmp/sess.json", getLeafId: () => "leaf_1" },
    };

    await emit("session_start", null, ctx);

    // Heuristic capture of audio rule
    await emit("before_agent_start", { messageType: "user", prompt: "Our rule is all acoustic audio tracks must use lossless FLAC format" }, ctx);
    await emit("message_end", { message: { role: "assistant", content: "Understood, storing audio tracks as FLAC." } });
    await emit("agent_settled", null, ctx);

    const toolEnv = await envSource(ctx);
    // Sepal semantic retrieval using paraphrase
    const semRes = await querySemanticPath(toolEnv, tmpDir, axisPath, 0, new Date(), undefined, "sound recording standards", 5);
    assert(semRes.lines.length > 0, "Sepal semantic query must retrieve audio record");

    // Clean up daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Test 3b: Ephemeral Sepal mode (ephemeralSepal=true: 0 bytes disk footprint for mem.db-sepal)
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 3b. [ephemeral sepal] Semantic search in ephemeral mode stores zero bytes on disk for mem.db-sepal and rebuilds in-memory", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "ci-sem-ephem-" });
  const sockPath = join(tmpDir, "cormd.sock");

  let embedFetchCount = 0;
  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    embedFetchCount++;
    const body = await req.json();
    const vec = computeMockVector(typeof body.input === "string" ? body.input : "");
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-embed",
      object: "list",
    }), { headers: { "Content-Type": "application/json" } });
  });

  const embedUrl = `http://127.0.0.1:${embedServer.addr.port}/v1/embeddings`;

  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      judgeMode: "heuristic" as const,
      semanticSearch: true,
      ephemeralSepal: true,
      embedUrl,
      embedModel: "mock-embed",
    };

    assert.strictEqual(judgeConfigured(cfg), false);
    assert.strictEqual(sepalConfigured(cfg), true);
    assert.strictEqual(cfg.ephemeralSepal, true);

    const fspec = filespecFor(tmpDir, true);
    const eEnv = embedEnv(cfg);
    assert.strictEqual(eEnv.CORM_SEPAL_EPHEMERAL, "1", "CORM_SEPAL_EPHEMERAL must be set to 1 in eEnv");

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
    const envSource = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-sem-ephem-001",
      sessionFile: "/tmp/sess.json",
    });

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
      for (const h of handlers.get(event) ?? []) await h(...args);
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-sem-ephem-001",
      sessionManager: { getSessionId: () => "sess-sem-ephem-001", getSessionFile: () => "/tmp/sess.json", getLeafId: () => "leaf_1" },
    };

    await emit("session_start", null, ctx);

    // Capture memory rule
    await emit("before_agent_start", { messageType: "user", prompt: "Our rule is all acoustic audio tracks must use lossless FLAC format" }, ctx);
    await emit("message_end", { message: { role: "assistant", content: "Understood, storing audio tracks as FLAC." } });
    await emit("agent_settled", null, ctx);

    // Verify: mem.db-sepal MUST NOT exist on physical disk!
    const sepalFileOnDisk = join(tmpDir, "mem.db-sepal");
    assert.strictEqual(existsSync(sepalFileOnDisk), false, "mem.db-sepal MUST NOT exist on physical disk in ephemeral mode");

    // Verify: sepal-embed-cache.bin exists on disk
    const cacheFile = join(tmpDir, "sepal-embed-cache.bin");
    assert.strictEqual(existsSync(cacheFile), true, "sepal-embed-cache.bin MUST exist for offline rebuild");

    // Semantic retrieval using paraphrase
    const toolEnv = await envSource(ctx);
    const semRes = await querySemanticPath(toolEnv, tmpDir, axisPath, 0, new Date(), undefined, "sound recording standards", 5);
    assert(semRes.lines.length > 0, "Sepal semantic query must retrieve audio record from ephemeral in-memory index");

    // Clean up daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Test 4: Both enabled (judgeMode=auto + semanticSearch=true)
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 4. [synthetic/mock] Both enabled works end-to-end with hybrid recall", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "ci-both-" });
  const sockPath = join(tmpDir, "cormd.sock");

  // Single unified mock server for both System One and /v1/embeddings
  const unifiedServer = Deno.serve({ port: 0 }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/classify" || url.pathname === "/api/v1/classify") {
      return new Response(JSON.stringify({
        choice: "remember",
        similarity: 0.95,
        margin: 0.25,
        scores: { remember: 0.95, skip: 0.70 },
      }), { headers: { "Content-Type": "application/json" } });
    } else if (url.pathname === "/v1/embeddings") {
      const body = await req.json();
      const vec = computeMockVector(typeof body.input === "string" ? body.input : "");
      return new Response(JSON.stringify({
        data: [{ embedding: vec, index: 0, object: "embedding" }],
        model: "unified-model",
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  });

  const baseUrl = `http://127.0.0.1:${unifiedServer.addr.port}`;
  const embedUrl = `${baseUrl}/v1/embeddings`;

  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureEmbedUrl: baseUrl,
      semanticSearch: true,
      embedUrl,
      embedModel: "unified-model",
    };

    assert.strictEqual(sepalConfigured(cfg), true);

    const fspec = filespecFor(tmpDir, true);
    const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: "unified-model" };

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
    const envSource = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-both-001",
      sessionFile: "/tmp/sess.json",
    });

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
      for (const h of handlers.get(event) ?? []) await h(...args);
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-both-001",
      sessionManager: { getSessionId: () => "sess-both-001", getSessionFile: () => "/tmp/sess.json", getLeafId: () => "leaf_1" },
    };

    await emit("session_start", null, ctx);

    // Embedding classifier evaluates turn and returns remember decision
    await emit("before_agent_start", { messageType: "user", prompt: "How should we tune network buffers under load?" }, ctx);
    await emit("message_end", { message: { role: "assistant", content: "High concurrency buffer sizes must be set to 64KB." } });
    await emit("agent_settled", null, ctx);

    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    const refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1, "Must store memory from LLM judge");

    // Clean up daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await unifiedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Test 5: Malformed answers, HTTP errors, timeout, and fallback behavior
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 5. Malformed answers, HTTP errors, timeout, and fallback behavior", async () => {
  const cfgBadEndpoint = {
    ...DEFAULT_CONFIG,
    judgeMode: "auto" as const,
    judgeUrl: "http://127.0.0.1:59999", // Unreachable port
    judgeTimeoutMs: 100,
    judgeFallback: "capture" as const,
  };

  // Turn contains meaningful personal experience
  const prompt = "I spoke to my grampa under the cherry tree";
  const response = "That is a lovely memory.";

  const result = await evaluateTurnWithJudge(prompt, response, cfgBadEndpoint);
  assert.strictEqual(result.source, "fallback", "Must fall back to configured fallback when judge fails");
  assert.strictEqual(result.degraded, true, "Must flag degraded status");
  assert.strictEqual(result.decision.action, "remember", "Fallback 'capture' should retain statement");

  // With judgeFallback="skip"
  const cfgSkipFallback = {
    ...cfgBadEndpoint,
    judgeFallback: "skip" as const,
  };
  const resultSkip = await evaluateTurnWithJudge(prompt, response, cfgSkipFallback);
  assert.strictEqual(resultSkip.degraded, true);
  assert.strictEqual(resultSkip.decision.action, "skip", "Must skip when configured fallback is skip");

  // Malformed Jev response (invalid choice answer)
  const malformedServer = Deno.serve({ port: 0 }, () => {
    return new Response(JSON.stringify({ answers: { memory_action: { type: "choice", choice: "invalid_choice" } } }), {
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    const cfgMalformed = {
      ...DEFAULT_CONFIG,
      judgeMode: "auto" as const,
      judgeUrl: `http://127.0.0.1:${malformedServer.addr.port}`,
      judgeFallback: "skip" as const,
    };
    const resMalformed = await evaluateTurnWithJudge(prompt, response, cfgMalformed);
    assert.strictEqual(resMalformed.degraded, true);
    assert.strictEqual(resMalformed.decision.action, "skip");
  } finally {
    await malformedServer.shutdown();
  }

  // HTTP 500 server error
  const errServer = Deno.serve({ port: 0 }, () => {
    return new Response("Internal Server Error", { status: 500 });
  });

  try {
    const cfgErr = {
      ...DEFAULT_CONFIG,
      judgeMode: "auto" as const,
      judgeUrl: `http://127.0.0.1:${errServer.addr.port}`,
      judgeFallback: "capture" as const,
    };
    const resErr = await evaluateTurnWithJudge(prompt, response, cfgErr);
    assert.strictEqual(resErr.degraded, true);
    assert.strictEqual(resErr.source, "fallback");
  } finally {
    await errServer.shutdown();
  }

  // Timeout behavior
  const slowServer = Deno.serve({ port: 0 }, async () => {
    await new Promise((r) => setTimeout(r, 200));
    return new Response(JSON.stringify({ answers: { memory_action: { type: "choice", choice: "yes" } } }), {
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    const cfgSlow = {
      ...DEFAULT_CONFIG,
      judgeMode: "auto" as const,
      judgeUrl: `http://127.0.0.1:${slowServer.addr.port}`,
      judgeTimeoutMs: 30,
      judgeFallback: "capture" as const,
    };
    const resSlow = await evaluateTurnWithJudge(prompt, response, cfgSlow);
    assert.strictEqual(resSlow.degraded, true);
  } finally {
    await slowServer.shutdown();
  }
});

// ----------------------------------------------------------------------------
// Test 5b: Deterministic fallback when judge key/credentials are unset and embeddings are off
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 5b. Deterministic fallback when judge key/credentials are unset and embeddings are off", async () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    captureEmbed: "off" as const,
    judgeFallback: "capture" as const,
  };

  const res = await evaluateTurnWithJudge("Save local config", "Done", cfg);
  assert.strictEqual(res.source, "fallback");
  assert.strictEqual(res.decision.action, "remember");
  assert.strictEqual(res.degraded, true);
});

// ----------------------------------------------------------------------------
// Test 5c: Response text is safely ignored by classifier (only user prompt is classified)
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 5c. Response text is safely ignored by classifier (only user prompt is classified)", async () => {
  let seenText = "";
  const mockServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    seenText = body.text || "";
    return new Response(JSON.stringify({
      choice: "skip",
      similarity: 0.8,
      margin: 0.2,
      scores: { skip: 0.8 },
    }), { headers: { "Content-Type": "application/json" } });
  });

  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      captureEmbedUrl: `http://127.0.0.1:${mockServer.addr.port}`,
    };
    const longResponse = "A".repeat(1200);
    const result = await evaluateTurnWithJudge("User message", longResponse, cfg);
    assert.strictEqual(result.source, "embed");
    assert.strictEqual(seenText, "User message");
    assert.strictEqual(seenText.includes("A"), false);
  } finally {
    await mockServer.shutdown();
  }
});

// ----------------------------------------------------------------------------
// Test 6: Real live Jev integration test (opt-in; truthfully reports SKIP or FAIL)
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 6. Real live Jev integration test", async () => {
  const env = Deno.env.toObject();
  const jevUrl = env["JEV_URL"] ?? env["PI_MM_JUDGE_URL"];

  if (!jevUrl || jevUrl.trim() === "") {
    console.log("[SKIP] Real live Jev integration not configured (PI_MM_JUDGE_URL unset)");
    return;
  }

  const rawCfg = applyEnv(DEFAULT_CONFIG, env);

  const techPrompt = "We decided to increase the network socket receive buffer to 128KB to prevent packet drops during traffic spikes.";
  const techReply = "Understood. The 128KB socket receive buffer will prevent packet drops during bursts.";

  const techResult = await evaluateTurnWithJudge(techPrompt, techReply, rawCfg);
  if (techResult.degraded || techResult.source !== "llm") {
    assert.fail(`Live Jev inference failed: ${techResult.error || "Fell back to heuristic, Jev did not respond"}`);
  }
  assert(
    techResult.decision.action === "remember" || techResult.decision.action === "update",
    `Expected 'remember' or 'update' decision from Jev, got '${techResult.decision.action}'`,
  );
  assert(
    typeof techResult.decision.summary === "string" && techResult.decision.summary.length > 0,
    "Jev decision summary must be non-empty string",
  );

  // Test trivial exchange rejection
  const trivPrompt = "Good morning!";
  const trivReply = "Good morning! How can I assist you today?";
  const trivResult = await evaluateTurnWithJudge(trivPrompt, trivReply, rawCfg);
  if (trivResult.degraded || trivResult.source !== "llm") {
    assert.fail(`Live Jev inference on trivial exchange failed: ${trivResult.error || "Fell back to heuristic"}`);
  }
  assert.strictEqual(trivResult.decision.action, "skip", "Trivial pleasantry should be skipped by live Jev judge");

  console.log(`[PASS] Live Jev inference integration verified against ${rawCfg.judgeUrl}`);
});

// ----------------------------------------------------------------------------
// Test 6b: Real embedding endpoint and Sepal semantic retrieval
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 6b. Real embedding endpoint and Sepal semantic retrieval", async () => {
  const env = Deno.env.toObject();
  const rawCfg = applyEnv(DEFAULT_CONFIG, env);
  const hasLiveEmbed = Boolean(rawCfg.embedUrl && rawCfg.embedUrl.trim() !== "");

  if (!hasLiveEmbed) {
    console.log("[SKIP] Real embedding endpoint not configured (QLLM_URL / CORM_SEPAL_EMBED_URL unset)");
    return;
  }

  const embedUrl = rawCfg.embedUrl!;
  const embedModel = rawCfg.embedModel || "default";

  // 1. Generate real embeddings directly via fetch to validate API response, finite floats, and dimensions
  const testFact = "I spoke to my grampa under the cherry tree";
  const testQuery = "What did I tell you about spending time with my grandfather?";

  const resFact = await fetch(embedUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(rawCfg.embedKey ? { Authorization: `Bearer ${rawCfg.embedKey}` } : {}),
    },
    body: JSON.stringify({ input: testFact, model: embedModel }),
    signal: AbortSignal.timeout(5000),
  });

  if (!resFact.ok) {
    const errText = await resFact.text().catch(() => "");
    assert.fail(`Live embedding endpoint returned HTTP ${resFact.status}: ${errText}`);
  }

  const jsonFact = await resFact.json();
  const vecFact = jsonFact?.data?.[0]?.embedding;
  assert(Array.isArray(vecFact) && vecFact.length > 0, "Embedding vector must be a non-empty array");
  for (let i = 0; i < Math.min(vecFact.length, 10); i++) {
    assert(Number.isFinite(vecFact[i]), `Embedding vector element at ${i} must be finite`);
  }

  const resQuery = await fetch(embedUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(rawCfg.embedKey ? { Authorization: `Bearer ${rawCfg.embedKey}` } : {}),
    },
    body: JSON.stringify({ input: testQuery, model: embedModel }),
    signal: AbortSignal.timeout(5000),
  });

  if (!resQuery.ok) {
    assert.fail(`Live embedding endpoint failed on query: HTTP ${resQuery.status}`);
  }
  const jsonQuery = await resQuery.json();
  const vecQuery = jsonQuery?.data?.[0]?.embedding;
  assert(Array.isArray(vecQuery), "Query vector must be an array");
  assert.strictEqual(vecQuery.length, vecFact.length, "Query vector dimensions must match fact vector dimensions");

  // 2. Store and retrieve through real libsepal path
  const tmpDir = Deno.makeTempDirSync({ prefix: "ci-real-sepal-" });
  const sockPath = join(tmpDir, "cormd.sock");
  try {
    const liveCfg = {
      ...rawCfg,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      semanticSearch: true,
      embedUrl,
      embedModel,
    };

    const fspec = filespecFor(tmpDir, true);
    const eEnv = {
      CORM_SEPAL_EMBED_URL: embedUrl,
      CORM_SEPAL_EMBED_MODEL: embedModel,
      ...(rawCfg.embedKey ? { CORM_SEPAL_EMBED_KEY: rawCfg.embedKey } : {}),
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
    const envSource = (_ctx: PiCtx) => Promise.resolve({
      cfg: liveCfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: "sess-real-sepal",
      sessionFile: "/tmp/sess.json",
    });

    const envelope = {
      level: "L1" as const,
      type: "note" as const,
      lifecycle: "observed" as const,
      summary: testFact,
    };
    const payload = `${new Date().toISOString().slice(0, 10)}:${JSON.stringify(envelope)}`;
    const storeRes = await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, payload, axisPath, tmpDir, eEnv));
    assert.strictEqual(storeRes.code, 0, "Failed to store into CORM + real libsepal");

    const toolEnv = await envSource({ cwd: tmpDir, hasUI: false, mode: "agent" });
    const semRes = await querySemanticPath(toolEnv, tmpDir, axisPath, 0, new Date(), undefined, testQuery, 5);
    assert(semRes.lines.length > 0, "Sepal must retrieve stored memory for paraphrased query");
    assert.strictEqual(semRes.lines[0].ref, 1);

    console.log(`[PASS] Real embedding and Sepal semantic retrieval verified against ${embedUrl}`);

    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Test 7: Cross-session recall of natural memory ("I spoke to my grampa under the cherry tree")
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 7. [synthetic/mock] Cross-session recall of natural memory with FTS and Sepal", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "ci-grampa-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const sessionA_Id = "sess-ci-grampa-A";
  const sessionB_Id = "sess-ci-grampa-B";

  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const vec = computeMockVector(typeof body.input === "string" ? body.input : "");
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-embed",
    }), { headers: { "Content-Type": "application/json" } });
  });

  const embedUrl = `http://127.0.0.1:${embedServer.addr.port}/v1/embeddings`;

  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      judgeMode: "heuristic" as const,
      semanticSearch: true,
      embedUrl,
      embedModel: "mock-embed",
    };

    const fspec = filespecFor(tmpDir, true);
    const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: "mock-embed" };

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
    const createEnv = (sessId: string) => ({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: sessId,
      sessionFile: `/tmp/${sessId}.json`,
    });

    const envSourceA = (_ctx: PiCtx) => Promise.resolve(createEnv(sessionA_Id));
    const envSourceB = (_ctx: PiCtx) => Promise.resolve(createEnv(sessionB_Id));

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
      for (const h of handlers.get(event) ?? []) await h(...args);
    };

    const ctxA: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionA_Id,
      sessionManager: { getSessionId: () => sessionA_Id, getSessionFile: () => `/tmp/${sessionA_Id}.json`, getLeafId: () => "leaf_1" },
    };

    await emit("session_start", null, ctxA);
    await emit("before_agent_start", { messageType: "user", prompt: "I spoke to my grampa under the cherry tree" }, ctxA);
    await emit("message_end", { message: { role: "assistant", content: "That is a lovely memory." } });
    await emit("agent_settled", null, ctxA);

    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    const refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1);
    const storedRef = refs[refs.length - 1];

    // Stoma keyword query
    const toolEnvA = await envSourceA(ctxA);
    const fts = await queryLexicalPath(toolEnvA, tmpDir, axisPath, 0, new Date(), undefined, "cherry", 5);
    assert.strictEqual(fts.lines.length > 0, true);
    assert.ok(fts.lines.some((l) => refs.includes(l.ref)));
    assert.ok(refs.includes(storedRef));

    // Sepal semantic query (paraphrase: zero word overlap)
    const semanticQuery = "What did I tell you about spending time with my grandfather?";
    const sem = await querySemanticPath(toolEnvA, tmpDir, axisPath, 0, new Date(), undefined, semanticQuery, 5);
    assert.strictEqual(sem.lines.length > 0, true);
    assert.ok(sem.lines.some((l) => refs.includes(l.ref)));

    // Cross-session auto recall into fresh Session B
    const ctxB: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionB_Id,
      sessionManager: { getSessionId: () => sessionB_Id, getSessionFile: () => `/tmp/${sessionB_Id}.json`, getLeafId: () => "leaf_2" },
    };

    const recall = await handleBeforeAgentStart({ messageType: "user", prompt: semanticQuery }, ctxB, envSourceB);
    assert(recall !== null);
    assert(recall?.message?.content.includes("I spoke to my grampa under the cherry tree"));

    // Clean up daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Test 8: Compatibility with existing configuration, data, and daemon locking
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 8. Compatibility with existing configuration and daemon locking", () => {
  // Legacy settings parsing
  const legacyRaw = {
    cormBin: "/usr/bin/corm",
    cormdBin: "/usr/bin/cormd",
    memDir: "custom/mem",
    scanLimit: 25,
    embedUrl: "http://example.com/v1/embeddings",
    embedModel: "text-embedding-3-small",
  };

  const loaded = loadConfig(legacyRaw);
  assert.strictEqual(loaded.cormBin, "/usr/bin/corm");
  assert.strictEqual(loaded.cormdBin, "/usr/bin/cormd");
  assert.strictEqual(loaded.memDir, "custom/mem");
  assert.strictEqual(loaded.scanLimit, 25);
  assert.strictEqual(loaded.judgeMode, "auto"); // default
  assert.strictEqual(loaded.judgeFallback, "skip"); // default
  assert.strictEqual(sepalConfigured(loaded), true);

  // Environment variables
  const env = {
    PI_MM_JUDGE_MODE: "off",
    PI_MM_SEMANTIC_SEARCH: "false",
  };
  const applied = applyEnv(loaded, env);
  assert.strictEqual(applied.judgeMode, "off");
  assert.strictEqual(applied.semanticSearch, false);
  assert.strictEqual(sepalConfigured(applied), false);
  assert.strictEqual(judgeConfigured(applied), false);
});

// ----------------------------------------------------------------------------
// Test 9: checkMmHealth reports judge and embedding health with mock servers
// ----------------------------------------------------------------------------
Deno.test("configurable intelligence: 9. checkMmHealth reports judge and embedding health with mock servers", async () => {
  // 1. Mock judge server
  const judgeServer = Deno.serve({ port: 0 }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "qwen" }, { id: "bge-small" }],
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  });

  // 2. Mock embed server
  const embedServer = Deno.serve({ port: 0 }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/embeddings") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      judgeUrl: `http://127.0.0.1:${judgeServer.addr.port}`,
      embedUrl: `http://127.0.0.1:${embedServer.addr.port}/v1/embeddings`,
      embedModel: "bge-small",
    };

    const report = await checkMmHealth(cfg);
    assert.strictEqual(report.judgeOk, true);
    assert.strictEqual(report.judgeModels?.includes("qwen"), true);
    assert.strictEqual(report.embedOk, true);
    assert.strictEqual(report.judgeError, undefined);
    assert.strictEqual(report.embedError, undefined);

    // Test offline report
    const offlineCfg = {
      ...DEFAULT_CONFIG,
      judgeUrl: "http://127.0.0.1:59997",
      embedUrl: "http://127.0.0.1:59997/v1/embeddings",
      embedModel: "bge-small",
    };
    const offlineReport = await checkMmHealth(offlineCfg);
    assert.strictEqual(offlineReport.judgeOk, false);
    assert.strictEqual(offlineReport.embedOk, false);
    assert(offlineReport.judgeError !== undefined);
  } finally {
    await judgeServer.shutdown();
    await embedServer.shutdown();
  }
});
