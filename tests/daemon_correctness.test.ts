import assert from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { DaemonCormRunner, isDaemonLockHeld } from "../src/daemon.ts";
import { buildStoreInvocation, buildScanInvocation, type Invocation } from "../src/corm.ts";

const home = Deno.env.get("HOME") || "";
const cormAxisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

function spawnCormd(dbFilespec: string, sockPath: string, envOverrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    CORM_AXIS_PATH: cormAxisPath,
    LD_LIBRARY_PATH: `${home}/.local/lib:/usr/lib:${Deno.env.get("LD_LIBRARY_PATH") ?? ""}`,
    ...envOverrides,
  };
  return spawn(cormdBin, ["-d", dbFilespec, "-s", sockPath], {
    env,
    stdio: "pipe",
  });
}

Deno.test("regression 1: ERR response framing advertises exact length and preserves pipelined stream", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-framing-test-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  const proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const client = net.createConnection({ path: sockPath });
    await new Promise((r) => client.on("connect", r));

    // Pipeline 2 requests: Request 1 is invalid (ERR), Request 2 is valid PING
    const req1 = "BADOP 101 arg1 0\n";
    const req2 = "PING 102 0\n";
    client.write(req1 + req2);

    let inBuf = "";
    await new Promise<void>((resolve) => {
      client.on("data", (chunk) => {
        inBuf += new TextDecoder().decode(chunk);
        if (inBuf.includes("PONG 102 0\n")) {
          resolve();
        }
      });
    });

    client.destroy();

    // Verify response 1
    assert.strictEqual(inBuf.includes("ERR 101"), true);
    // Extract ERR body length
    const m = /ERR 101 (\d+)\n([\s\S]*?)PONG 102 0\n/.exec(inBuf);
    assert.ok(m, "Failed to parse pipelined response boundaries");
    const advertisedLen = parseInt(m[1], 10);
    const actualBodyBytes = new TextEncoder().encode(m[2]).length;
    // CRITICAL: advertised body length must match the transmitted body bytes EXACTLY!
    assert.strictEqual(advertisedLen, actualBodyBytes);
  } finally {
    proc.kill();
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("regression 2: QUERY error recovery cleanly unwinds without double-free or leak", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-query-error-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  const proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const fallback = {
      run: (_inv: Invocation) => Promise.resolve({ stdout: "", stderr: "", code: 0 })
    };
    const runner = new DaemonCormRunner(sockPath, fallback);

    // 1. Seed a record
    const putRes = await runner.run(buildStoreInvocation("corm", fspec, 1, "2026-10-15:query error recovery test", cormAxisPath, tmpDir));
    assert.strictEqual(putRes.code, 0);

    // 2. Syntax error in expression: unclosed paren
    const badScan1 = await runner.run(buildScanInvocation("corm", fspec, "(lemma AND", 5, cormAxisPath, tmpDir));
    assert.strictEqual(badScan1.code, 1);
    assert.strictEqual(badScan1.stderr.includes("expected"), true);

    // 3. Unknown axis error in expression
    const badScan2 = await runner.run(buildScanInvocation("corm", fspec, "nonexistent_axis", 5, cormAxisPath, tmpDir));
    assert.strictEqual(badScan2.code, 1);
    assert.strictEqual(badScan2.stderr.includes("not loaded") || badScan2.stderr.includes("Producing"), true);

    // 4. Verify valid query immediately succeeds afterwards (no double free, no corrupted state)
    const goodScan = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=recovery"]));
    assert.strictEqual(goodScan.code, 0);
    assert.strictEqual(goodScan.stdout.includes("query error recovery test"), true);
  } finally {
    proc.kill();
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("regression 3: database lease guard blocks CLI mutation while active and permits after release", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-lease-guard-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    CORM_AXIS_PATH: cormAxisPath,
    LD_LIBRARY_PATH: `${home}/.local/lib:/usr/lib:${Deno.env.get("LD_LIBRARY_PATH") ?? ""}`,
  };

  const proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    // 1. Verify lock path derivation
    const lockPath = join(tmpDir, ".cormd.lock");
    assert.strictEqual(existsSync(lockPath), true);
    assert.strictEqual(await isDaemonLockHeld(lockPath), true);

    // 2. Direct CLI mutation forwards to cormd while lease is active
    const cliResActive = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const c = spawn(cormBin, ["-p", "1:2026-10-15:cli_forwarded", fspec], { env });
      let out = "";
      let err = "";
      c.stdout?.on("data", (d) => out += d);
      c.stderr?.on("data", (d) => err += d);
      c.on("close", (code) => resolve({ code: code ?? 0, stdout: out, stderr: err }));
    });
    assert.strictEqual(cliResActive.code, 0);
    assert.strictEqual(cliResActive.stdout.trim(), "1");

    // 3. Stop cormd daemon to release lease
    proc.kill("SIGTERM");
    await new Promise((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 100));

    // 4. Verify lease is released
    assert.strictEqual(await isDaemonLockHeld(lockPath), false);

    // 5. Standalone direct CLI mutation MUST now succeed
    const cliResReleased = await new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
      const c = spawn(cormBin, ["-p", "2:2026-10-15:cli_standalone", fspec], { env });
      let err = "";
      let out = "";
      c.stdout?.on("data", (d) => out += d);
      c.stderr?.on("data", (d) => err += d);
      c.on("close", (code) => resolve({ code: code ?? 0, stderr: err, stdout: out }));
    });
    assert.strictEqual(cliResReleased.code, 0);
    assert.strictEqual(cliResReleased.stdout.trim(), "2");
  } finally {
    try { proc.kill(); } catch { /* ignore */ }
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("regression 4: startup coordination aborts on prolonged .mm.lock contention", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-startup-contention-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;
  const mmLockPath = join(tmpDir, ".mm.lock");

  // Create an active .mm.lock holding current process pid
  writeFileSync(mmLockPath, JSON.stringify({ pid: Deno.pid, token: "test-token", createdAt: Date.now() }));

  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    CORM_AXIS_PATH: cormAxisPath,
    LD_LIBRARY_PATH: `${home}/.local/lib:/usr/lib:${Deno.env.get("LD_LIBRARY_PATH") ?? ""}`,
  };

  // Launch cormd - should poll .mm.lock and timeout after 2 seconds
  const start = Date.now();
  const res = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const c = spawn(cormdBin, ["-d", fspec, "-s", sockPath], { env });
    let err = "";
    c.stderr?.on("data", (d) => err += d);
    c.on("close", (code) => resolve({ code: code ?? 0, stderr: err }));
  });
  const duration = Date.now() - start;

  try {
    // Verified: duration >= 1900ms (timed out) and return code is failure!
    assert.ok(duration >= 1900, `Expected contention wait >= 1900ms, got ${duration}ms`);
    assert.strictEqual(res.code, 1);
    assert.strictEqual(res.stderr.includes("startup aborted"), true);
  } finally {
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("regression 5: secondary index failure is detected and returned as explicit error", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-index-fail-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  const proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const fallback = {
      run: (_inv: Invocation) => Promise.resolve({ stdout: "", stderr: "", code: 0 })
    };
    const runner = new DaemonCormRunner(sockPath, fallback);

    // Storing a payload without a valid date/timestamp prefix causes libjoint to reject the store
    // cormd must detect nfail > 0 from corm_fanout_store and return an ERR response!
    const res = await runner.run(buildStoreInvocation("corm", fspec, 1, "invalid_non_date_payload", cormAxisPath, tmpDir));
    assert.strictEqual(res.code, 1);
    assert.strictEqual(res.stderr.includes("partial failure: axis index update failed"), true);
  } finally {
    proc.kill();
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
