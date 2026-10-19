import { strict as assert } from "node:assert";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DaemonQmapRunner, ensureDaemon } from "../src/daemon.ts";
import { filespecFor, buildListInvocation, buildGetInvocation } from "../src/qmap.ts";
import { parseBareRefs } from "../src/resolve.ts";
import { decodePayload } from "../src/payload.ts";
import { installSessionHooks, activeConversationTurn, type PiCtx } from "../src/hooks/events.ts";
import {
  makeConsolidateTool,
} from "../src/tools/consolidate.ts";
import {
  readConsolidationJournal,
} from "../src/tools/consolidation_journal.ts";

const home = Deno.env.get("HOME") || "";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = "/usr/bin/corm";
const cormdBin = "/usr/bin/cormd";

Deno.test("incremental_consolidation: ordinary turns capture L0/L1 without running L2/L3 synchronously", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-incr-ord-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateL2Threshold: 3,
      consolidateL3Threshold: 2,
    };

    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: "sess-incr-1",
      sessionManager: { getSessionId: () => "sess-incr-1", getSessionFile: () => "/tmp/sess.jsonl", getLeafId: () => "m1" },
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-18T12:00:00Z"), cwd: tmpDir, sessionId: "sess-incr-1" }));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);

    // Turn 1: User statement in 'database' scope
    activeConversationTurn.topicSubject = "database";
    await emit("before_agent_start", { messageType: "user", prompt: "PostgreSQL read replicas handle analytical queries." });
    await emit("message_end", { message: { role: "assistant", content: "Offloading analytics to replicas prevents primary lock contention." } });
    await emit("agent_settled", null);

    // Verify L0 and L1 were created
    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, 2, "Turn 1 must create L0 and L1");

    // Verify ZERO L2 or L3 memories exist after turn settlement
    for (const r of refs) {
      const g = await daemonRunner.run(buildGetInvocation(cormBin, fspec, r, axisPath, tmpDir));
      const { envelope } = decodePayload(g.stdout.trim());
      assert.notStrictEqual(envelope.level, "L2", "L2 synthesis must NOT execute on turn settlement");
      assert.notStrictEqual(envelope.level, "L3", "L3 synthesis must NOT execute on turn settlement");
    }

    // Verify dirty journal recorded 1 new L1 in 'database' scope, below threshold of 3
    const journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.dirtyScopes["database"]?.count, 1);
    assert.strictEqual(journal.pendingL2Scopes.includes("database"), false, "Threshold 3 not yet reached");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("incremental_consolidation: threshold gating marks L2 pending and executes at lifecycle boundary", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-incr-thresh-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const synthServer = Deno.serve({ port: 0 }, async (req) => {
      const body = await req.json();
      const userPrompt = body.messages[1].content as string;
      const matches = [...userPrompt.matchAll(/\[Ref (\d+)\]/g)].map((m) => Number(m[1]));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "Synthesized networking invariants: keepalive, MTU clamp, and DNS TTL",
              explanation: "Synthesized from networking evidence",
              citedRefs: matches,
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    });

    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateL2Threshold: 3,
      consolidateL3Threshold: 2,
      synthUrl: `http://127.0.0.1:${synthServer.addr.port}`,
      synthModel: "mock-synthesis-model",
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };

    const envSource = (c: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-18T14:00:00Z"),
      cwd: tmpDir,
      sessionId: c.sessionId,
    });
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, envSource);

    const emit = async (ev: string, data: unknown, c: PiCtx) => {
      for (const h of listeners[ev] || []) await h(data, c);
    };

    // Session 1: Turn 1 in 'networking' scope
    const ctx1: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-net-1" };
    await emit("session_start", null, ctx1);
    activeConversationTurn.topicSubject = "networking";
    await emit("before_agent_start", { messageType: "user", prompt: "TCP keepalive interval set to 30 seconds." }, ctx1);
    await emit("message_end", { message: { role: "assistant", content: "Configured TCP keepalive." } }, ctx1);
    await emit("agent_settled", null, ctx1);

    // Session 2: Turn 2 in 'networking' scope
    const ctx2: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-net-2" };
    await emit("session_start", null, ctx2);
    activeConversationTurn.topicSubject = "networking";
    await emit("before_agent_start", { messageType: "user", prompt: "MTU clamped to 1420 bytes on WireGuard tunnels." }, ctx2);
    await emit("message_end", { message: { role: "assistant", content: "Clamped MTU to avoid packet fragmentation." } }, ctx2);
    await emit("agent_settled", null, ctx2);

    // After 2 turns: dirty count = 2, threshold = 3 -> L2 NOT pending
    let journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.dirtyScopes["networking"]?.count, 2);
    assert.strictEqual(journal.pendingL2Scopes.includes("networking"), false);

    // Session 3: Turn 3 in 'networking' scope (crosses threshold of 3!)
    const ctx3: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-net-3" };
    await emit("session_start", null, ctx3);
    activeConversationTurn.topicSubject = "networking";
    await emit("before_agent_start", { messageType: "user", prompt: "DNS caching TTL configured for 60 seconds locally." }, ctx3);
    await emit("message_end", { message: { role: "assistant", content: "DNS caching reduces outbound lookup latency." } }, ctx3);
    await emit("agent_settled", null, ctx3);

    // After turn 3: threshold 3 is reached -> marked pending in journal!
    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.dirtyScopes["networking"]?.count, 3);
    assert.ok(journal.pendingL2Scopes.includes("networking"), "Networking scope must be marked pending L2");

    // BUT L2 record is NOT yet created during turn settlement:
    let listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    let allRefs = parseBareRefs(listRes.stdout);
    for (const r of allRefs) {
      const g = await daemonRunner.run(buildGetInvocation(cormBin, fspec, r, axisPath, tmpDir));
      const { envelope } = decodePayload(g.stdout.trim());
      assert.notStrictEqual(envelope.level, "L2", "L2 must not be created during ordinary turn settlement");
    }

    // Now trigger lifecycle boundary: session_before_compact
    await emit("session_before_compact", null, ctx3);

    // Verify L2 abstraction WAS created at the lifecycle boundary:
    listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    allRefs = parseBareRefs(listRes.stdout);
    let l2Found = false;
    for (const r of allRefs) {
      const g = await daemonRunner.run(buildGetInvocation(cormBin, fspec, r, axisPath, tmpDir));
      const { envelope } = decodePayload(g.stdout.trim());
      if (envelope.level === "L2") {
        l2Found = true;
        assert.strictEqual(envelope.context?.subject, "networking");
        assert.strictEqual(envelope.lifecycle, "observed", "Newly consolidated L2 must have 'observed' lifecycle, never 'supported'");
        assert.strictEqual(envelope.evidence?.length, 3, "L2 must cite all 3 supporting L1s as evidence");
      }
    }
    assert.ok(l2Found, "L2 abstraction must be synthesized at lifecycle boundary");

    // Verify journal cleared the processed pending scope
    journal = await readConsolidationJournal(tmpDir);
    assert.strictEqual(journal.pendingL2Scopes.includes("networking"), false, "Processed scope must be cleared");

    // Clean up
    await synthServer.shutdown();
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("incremental_consolidation: status observability and explicit force execution", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-incr-status-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonQmapRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const cfg = {
      ...DEFAULT_CONFIG,
      qmapBin: cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "all" as const,
      consolidateL2Threshold: 5, // higher threshold
    };

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-stat-1" };
    const toolEnv = { cfg, runner: daemonRunner, nowProvider: () => new Date("2026-10-18T16:00:00Z"), cwd: tmpDir, sessionId: "sess-stat-1" };

    const consolidateTool = makeConsolidateTool(() => Promise.resolve(toolEnv));

    // 1. Inspect status on clean database
    const statusRes = await consolidateTool.execute("c1", { mode: "status" }, undefined, undefined, ctx);
    const statusDetails = statusRes.details as { status: string; pendingScopes: string[]; thresholds: { l2: number } };
    assert.strictEqual(statusDetails.status, "ok");
    assert.strictEqual(statusDetails.thresholds.l2, 5);
    assert.strictEqual(statusDetails.pendingScopes.length, 0);

    // 2. Perform manual consolidation with force: true
    const forceRes = await consolidateTool.execute("c2", { mode: "auto", force: true }, undefined, undefined, ctx);
    const forceDetails = forceRes.details as { mode: string; totalCreated: number };
    assert.strictEqual(forceDetails.mode, "auto");
    assert.strictEqual(forceDetails.totalCreated, 0, "Empty database forces 0 records safely");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
