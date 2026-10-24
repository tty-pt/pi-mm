import assert from "node:assert";
import { existsSync } from "node:fs";
import { formatProtocolCommand, DaemonCormRunner, isDaemonLockHeld } from "../src/daemon.ts";
import { buildListInvocation, buildGetInvocation, buildStoreInvocation, buildForgetInvocation, buildScanInvocation, ShellCormRunner, type Invocation } from "../src/corm.ts";
import type { PiExecResult } from "../src/hooks/events.ts";
import { join } from "node:path";
import { spawn } from "node:child_process";

Deno.test("daemon protocol formatting: maps all 5 invocation types", () => {
  const fspec = "/tmp/test/mem.db@joint,lemma:a:s";
  const cwd = "/tmp/test";
  const bin = "corm";
  const axes = "/tmp/axes";

  // 1. LIST
  const listInv = buildListInvocation(bin, fspec, axes, cwd);
  const listCmd = formatProtocolCommand(listInv, "101");
  assert.strictEqual(listCmd?.header, `LIST 101 ${fspec} 0`);
  assert.strictEqual(listCmd?.body, "");
  assert.strictEqual(listCmd?.isMutation, false);

  // 2. GET
  const getInv = buildGetInvocation(bin, fspec, 42, axes, cwd);
  const getCmd = formatProtocolCommand(getInv, "102");
  assert.strictEqual(getCmd?.header, `GET 102 ${fspec} 42 0`);
  assert.strictEqual(getCmd?.body, "");
  assert.strictEqual(getCmd?.isMutation, false);

  // 3. PUT
  const payload = '2026-10-15:{"level":"L0","summary":"hello"}';
  const putInv = buildStoreInvocation(bin, fspec, 42, payload, axes, cwd);
  const putCmd = formatProtocolCommand(putInv, "103");
  assert.strictEqual(putCmd?.header, `PUT 103 ${fspec} 42 ${new TextEncoder().encode(payload).length}`);
  assert.strictEqual(putCmd?.body, payload);
  assert.strictEqual(putCmd?.isMutation, true);

  // 3b. PUT with raw binary payloadBytes
  const binBytes = new Uint8Array([0x48, 0x54, 0x4f, 0x4b, 0x04, 0x01, 0x02]);
  const putBinInv = buildStoreInvocation(bin, fspec, 99, binBytes, axes, cwd);
  assert.strictEqual(putBinInv.ref, 99);
  assert.strictEqual(putBinInv.filespec, fspec);
  assert.strictEqual(putBinInv.payloadBytes, binBytes);
  assert.deepStrictEqual(putBinInv.args, ["-p", "99:-", fspec]);
  const putBinCmd = formatProtocolCommand(putBinInv, "103b");
  assert.strictEqual(putBinCmd?.header, `PUT 103b ${fspec} 99 ${binBytes.length}`);
  assert.strictEqual(putBinCmd?.body, "");
  assert.strictEqual(putBinCmd?.bodyBytes, binBytes);
  assert.strictEqual(putBinCmd?.isMutation, true);

  // 4. DEL
  const delInv = buildForgetInvocation(bin, fspec, 42, axes, cwd);
  const delCmd = formatProtocolCommand(delInv, "104");
  assert.strictEqual(delCmd?.header, `DEL 104 ${fspec} 42 0`);
  assert.strictEqual(delCmd?.body, "");
  assert.strictEqual(delCmd?.isMutation, true);

  // 5. QUERY
  const scanInv = buildScanInvocation(bin, fspec, "(joint AND lemma)", 20, axes, cwd, undefined, ["--query=foo", "--since=1000"]);
  const scanCmd = formatProtocolCommand(scanInv, "105");
  assert.strictEqual(scanCmd?.header, `QUERY 105 ${fspec} 20 ${new TextEncoder().encode("(joint AND lemma)\n--query=foo\n--since=1000").length}`);
  assert.strictEqual(scanCmd?.body, "(joint AND lemma)\n--query=foo\n--since=1000");
  assert.strictEqual(scanCmd?.isMutation, false);
});

Deno.test("daemon fallback: absent socket falls back immediately to shell runner", async () => {
  let fallbackRan = false;
  const mockFallback = {
    run(_inv: Invocation): Promise<PiExecResult> {
      fallbackRan = true;
      return Promise.resolve({ stdout: "from-fallback", stderr: "", code: 0 });
    }
  };

  const runner = new DaemonCormRunner("/tmp/nonexistent-socket.sock", mockFallback);
  const inv = buildListInvocation("corm", "/tmp/mem.db:a:s", "", "/tmp");
  const res = await runner.run(inv);
  assert.strictEqual(fallbackRan, true);
  assert.strictEqual(res.stdout, "from-fallback");
  assert.strictEqual(res.code, 0);
});

Deno.test("daemon fail-closed: mutation error on live connection does not blindly replay via CLI", async () => {
  // Create a mock server that closes connection abruptly during mutation
  const testSock = `/tmp/test-abrupt-${Date.now()}.sock`;
  const server = Deno.listen({ transport: "unix", path: testSock });

  (async () => {
    for await (const conn of server) {
      // Read header
      const buf = new Uint8Array(1024);
      await conn.read(buf);
      // Abrupt close without reply
      conn.close();
      break;
    }
  })();

  let fallbackAttempted = false;
  const mockFallback = {
    run(_inv: Invocation): Promise<PiExecResult> {
      fallbackAttempted = true;
      return Promise.resolve({ stdout: "replayed", stderr: "", code: 0 });
    }
  };

  try {
    const runner = new DaemonCormRunner(testSock, mockFallback, 500);
    const putInv = buildStoreInvocation("corm", "/tmp/mem.db:a:s", 1, "test-data", "", "/tmp");
    const res = await runner.run(putInv);

    // CRITICAL: fallback MUST NOT be attempted for dropped mutation!
    assert.strictEqual(fallbackAttempted, false);
    assert.strictEqual(res.code, 1);
    assert.strictEqual(res.stderr.includes("ambiguous outcome"), true);
  } finally {
    try { server.close(); } catch { /* ignore */ }
    try { Deno.removeSync(testSock); } catch { /* ignore */ }
  }
});

Deno.test("daemon lease protection: direct CLI mutation rejected when .cormd.lock is held", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-lease-test-" });
  const lockFile = join(tmpDir, ".cormd.lock");

  // Acquire flock on lockFile using background process
  const child = spawn("flock", ["-x", lockFile, "sh", "-c", "printf READY\\n; exec cat"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise<void>((resolve) => {
    child.stdout?.on("data", (chunk) => {
      if (chunk.toString().includes("READY")) resolve();
    });
  });

  try {
    const isHeld = await isDaemonLockHeld(lockFile);
    assert.strictEqual(isHeld, true);

    let cliExecuted = false;
    const shellRunner = new ShellCormRunner((_cmd, _args, _opts) => {
      cliExecuted = true;
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const putInv = buildStoreInvocation("corm", join(tmpDir, "mem.db:a:s"), 1, "payload", "", tmpDir);
    const res = await shellRunner.run(putInv);

    assert.strictEqual(cliExecuted, false);
    assert.strictEqual(res.code, 1);
    assert.strictEqual(res.stderr.includes("database is leased by resident cormd"), true);
  } finally {
    child.kill();
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("daemon live integration: end-to-end round trip against real cormd", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-live-test-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;
  const home = Deno.env.get("HOME") || "";
  const axesPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;

  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    CORM_AXIS_PATH: axesPath,
    LD_LIBRARY_PATH: `${home}/.local/lib:/usr/lib:${Deno.env.get("LD_LIBRARY_PATH") ?? ""}`,
  };

  const cormdPath = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";
  const proc = spawn(cormdPath, ["-d", fspec, "-s", sockPath], {
    env,
    stdio: "pipe",
  });

  // Wait for socket to become active
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const shellRunner = new ShellCormRunner((cmd, args, opts) => {
      return new Promise((resolve) => {
        const c = spawn(cmd, args, { ...opts, env: { ...opts?.env, ...env } });
        let out = "";
        let err = "";
        c.stdout?.on("data", (d) => out += d);
        c.stderr?.on("data", (d) => err += d);
        c.on("close", (code) => resolve({ stdout: out, stderr: err, code: code ?? 0 }));
      });
    });

    const daemonRunner = new DaemonCormRunner(sockPath, shellRunner);

    // 1. LIST initially empty
    const listRes1 = await daemonRunner.run(buildListInvocation("corm", fspec, axesPath, tmpDir));
    assert.strictEqual(listRes1.code, 0);
    assert.strictEqual(listRes1.stdout.trim(), "");

    // 2. PUT record
    const doc = '2026-10-15:{"level":"L0","summary":"daemon integration testing"}';
    const putRes = await daemonRunner.run(buildStoreInvocation("corm", fspec, 10, doc, axesPath, tmpDir));
    assert.strictEqual(putRes.code, 0);

    // 3. GET record
    const getRes = await daemonRunner.run(buildGetInvocation("corm", fspec, 10, axesPath, tmpDir));
    assert.strictEqual(getRes.code, 0);
    assert.strictEqual(getRes.stdout.trim(), doc);

    // 4. LIST has 10
    const listRes2 = await daemonRunner.run(buildListInvocation("corm", fspec, axesPath, tmpDir));
    assert.strictEqual(listRes2.code, 0);
    assert.strictEqual(listRes2.stdout.trim(), "10");

    // 5. QUERY by stoma
    const queryRes = await daemonRunner.run(
      buildScanInvocation("corm", fspec, "lemma", 5, axesPath, tmpDir, undefined, ["--query=integration"])
    );
    assert.strictEqual(queryRes.code, 0);
    assert.strictEqual(queryRes.stdout.includes("daemon integration testing"), true);

    // 6. DEL record
    const delRes = await daemonRunner.run(buildForgetInvocation("corm", fspec, 10, axesPath, tmpDir));
    assert.strictEqual(delRes.code, 0);

    // 7. GET after DEL returns -1
    const getRes2 = await daemonRunner.run(buildGetInvocation("corm", fspec, 10, axesPath, tmpDir));
    assert.strictEqual(getRes2.code, 0);
    assert.strictEqual(getRes2.stdout.trim(), "-1");
  } finally {
    proc.kill();
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
