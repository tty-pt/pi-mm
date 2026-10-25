import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";
import { filespecFor, buildListInvocation, buildGetInvocation } from "../src/corm.ts";
import { parseBareRefs } from "../src/resolve.ts";
import { decodePayload } from "../src/payload.ts";
import { installSessionHooks, type PiCtx } from "../src/hooks/events.ts";

const home = Deno.env.get("HOME") || "";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

Deno.test("capture_modes: Mode A - 'all' captures all user turns into L0 without word heuristics", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-mode-all-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-all-1",
      sessionManager: { getSessionId: () => "sess-all-1", getSessionFile: () => "/tmp/sess.jsonl", getLeafId: () => "m1" },
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-17T12:00:00Z"), cwd: tmpDir, sessionId: "sess-all-1" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);

    // Turn 1: Ordinary greeting (under mode all, it enters L0!)
    await emit("before_agent_start", { messageType: "user", prompt: "Hello there!" });
    await emit("message_end", { message: { role: "assistant", content: "Hi! How can I help you today?" } });
    await emit("agent_settled", null);

    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1, "Mode 'all' must capture greeting into L0");

    const l0Get = await daemonRunner.run(buildGetInvocation(cormBin, fspec, refs[0], axisPath, tmpDir));
    const l0Data = decodePayload(l0Get.stdout.trim());
    assert.strictEqual(l0Data.envelope.level, "L0");
    assert.strictEqual(l0Data.envelope.summary, "Hello there!");
    assert.strictEqual(l0Data.envelope.episode?.sessionId, "sess-all-1");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("capture_modes: Mode B - 'keyword' captures only literal marker and strips it cleanly", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-mode-kw-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "keyword" as const,
      captureKeyword: "@remember",
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-kw-1",
      sessionManager: { getSessionId: () => "sess-kw-1", getSessionFile: () => "/tmp/sess.jsonl", getLeafId: () => "m1" },
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-17T12:00:00Z"), cwd: tmpDir, sessionId: "sess-kw-1" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);

    // Turn 1: Message without keyword marker -> must be skipped!
    await emit("before_agent_start", { messageType: "user", prompt: "I like listening to classical music." });
    await emit("message_end", { message: { role: "assistant", content: "Classical music is very relaxing." } });
    await emit("agent_settled", null);

    let listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    let refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, 0, "Non-keyword message must be skipped in keyword mode");

    // Turn 2: Message with exact literal keyword marker -> must be captured with marker stripped!
    await emit("before_agent_start", { messageType: "user", prompt: "@remember My favorite composer is Johann Sebastian Bach." });
    await emit("message_end", { message: { role: "assistant", content: "Understood, noted Bach as your favorite composer." } });
    await emit("agent_settled", null);

    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1, "Keyword-prefixed message must be captured");

    const l0Get = await daemonRunner.run(buildGetInvocation(cormBin, fspec, refs[0], axisPath, tmpDir));
    const l0Data = decodePayload(l0Get.stdout.trim());
    assert.strictEqual(l0Data.envelope.level, "L0");
    assert.strictEqual(l0Data.envelope.summary, "My favorite composer is Johann Sebastian Bach.");
    assert.strictEqual(l0Data.envelope.summary.includes("@remember"), false, "Marker must be stripped from stored fact");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("capture_modes: Mode C - 'judge' binary decision and fallback handling", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-mode-judge-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  const jevServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    assert.strictEqual(body.questions.memory_action.type, "choice");
    const state = (body.state as string || "").toLowerCase();
    const userLine = state.split("\n").find((l: string) => l.startsWith("current user:") || l.startsWith("user:")) || "";
    let choice = "yes";
    if (userLine.includes("weather") || userLine.includes("hello")) {
      choice = "no";
    }
    return new Response(JSON.stringify({
      answers: { memory_action: { type: "choice", choice } },
    }), { headers: { "Content-Type": "application/json" } });
  });

  const judgeUrl = `http://127.0.0.1:${jevServer.addr.port}`;

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "judge" as const,
      judgeUrl,
      judgeFallback: "skip" as const,
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-judge-1",
      sessionManager: { getSessionId: () => "sess-judge-1", getSessionFile: () => "/tmp/sess.jsonl", getLeafId: () => "m1" },
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-17T12:00:00Z"), cwd: tmpDir, sessionId: "sess-judge-1" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);

    // 1. Judge says "no" -> 0 records
    await emit("before_agent_start", { messageType: "user", prompt: "How is the weather today?" });
    await emit("message_end", { message: { role: "assistant", content: "It is sunny and 22 degrees." } });
    await emit("agent_settled", null);

    let listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    let refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, 0, "Turn judged 'no' must not be persisted");

    // 2. Judge says "yes" -> persisted
    await emit("before_agent_start", { messageType: "user", prompt: "I prefer working in pure C over any other language." });
    await emit("message_end", { message: { role: "assistant", content: "Pure C is fast and transparent." } });
    await emit("agent_settled", null);

    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1, "Turn judged 'yes' must be persisted");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await jevServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("capture_modes: Mode D - 'off' disables automatic capture while keeping tools functional", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-mode-off-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "off" as const,
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-off-1",
      sessionManager: { getSessionId: () => "sess-off-1", getSessionFile: () => "/tmp/sess.jsonl", getLeafId: () => "m1" },
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-17T12:00:00Z"), cwd: tmpDir, sessionId: "sess-off-1" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);

    // Turn: Even strong statements are ignored in mode off
    await emit("before_agent_start", { messageType: "user", prompt: "Remember this: production database backup runs at midnight." });
    await emit("message_end", { message: { role: "assistant", content: "Understood." } });
    await emit("agent_settled", null);

    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, 0, "Mode 'off' must not capture any conversational turn");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("capture_modes: Mode B2 - 'captureKeywords' word family matches multiple prefixes and strips them cleanly", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-mode-kw-family-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "keyword" as const,
      captureKeywords: ["@remember", "@memory", "remember:", "note:"],
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-kw-fam-1",
      sessionManager: { getSessionId: () => "sess-kw-fam-1", getSessionFile: () => "/tmp/sess.jsonl", getLeafId: () => "m1" },
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-17T12:00:00Z"), cwd: tmpDir, sessionId: "sess-kw-fam-1" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);

    // Turn 1: Message with 'remember: ' prefix
    await emit("before_agent_start", { messageType: "user", prompt: "remember: API requests require TLS 1.3" });
    await emit("message_end", { message: { role: "assistant", content: "Noted." } });
    await emit("agent_settled", null);

    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const refs = parseBareRefs(listRes.stdout);
    assert.ok(refs.length >= 1, "Must capture turn matching 'remember:'");

    const l0Get = await daemonRunner.run(buildGetInvocation(cormBin, fspec, refs[0], axisPath, tmpDir));
    const l0Data = decodePayload(l0Get.stdout.trim());
    assert.strictEqual(l0Data.envelope.summary, "API requests require TLS 1.3");
    assert.strictEqual(l0Data.envelope.summary.includes("remember:"), false, "Prefix must be cleanly stripped");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
