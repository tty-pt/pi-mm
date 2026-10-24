import assert from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DaemonCormRunner } from "../src/daemon.ts";
import { buildScanInvocation, type Invocation } from "../src/corm.ts";

const home = Deno.env.get("HOME") || "";
const cormAxisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

function spawnCormd(dbFilespec: string, sockPath: string) {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    CORM_AXIS_PATH: cormAxisPath,
    LD_LIBRARY_PATH: `${home}/.local/lib:/usr/lib:${Deno.env.get("LD_LIBRARY_PATH") ?? ""}`,
  };
  return spawn(cormdBin, ["-d", dbFilespec, "-s", sockPath], {
    env,
    stdio: "pipe",
  });
}

function runCli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    CORM_AXIS_PATH: cormAxisPath,
    LD_LIBRARY_PATH: `${home}/.local/lib:/usr/lib:${Deno.env.get("LD_LIBRARY_PATH") ?? ""}`,
  };
  return new Promise((resolve) => {
    const c = spawn(cormBin, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    c.stdout?.on("data", (d) => stdout += d);
    c.stderr?.on("data", (d) => stderr += d);
    c.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

Deno.test("forwarding 1: CLI PUT, DELETE, and DELETE ALL execute through resident cormd", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-fwd-test1-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  const proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const runner = new DaemonCormRunner(sockPath, {
      run: (_inv: Invocation) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    });

    // 1. CLI PUT record 1
    const p1 = await runCli(["-p", "1:2026-10-15:alpha memory entry", fspec], tmpDir);
    assert.strictEqual(p1.code, 0);
    assert.strictEqual(p1.stdout.trim(), "1");

    // 2. CLI PUT record 2
    const p2 = await runCli(["-p", "2:2026-10-15:beta memory entry", fspec], tmpDir);
    assert.strictEqual(p2.code, 0);
    assert.strictEqual(p2.stdout.trim(), "2");

    // 3. Search via daemon to verify cormd's resident search index received both records
    const scan1 = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=alpha"]));
    assert.strictEqual(scan1.code, 0);
    assert.strictEqual(scan1.stdout.includes("alpha memory entry"), true);

    const scan2 = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=beta"]));
    assert.strictEqual(scan2.code, 0);
    assert.strictEqual(scan2.stdout.includes("beta memory entry"), true);

    // 4. CLI DELETE record 1
    const d1 = await runCli(["-d", "1", fspec], tmpDir);
    assert.strictEqual(d1.code, 0);

    // Verify record 1 is gone from resident cormd search
    const scanAfterDel = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=alpha"]));
    assert.strictEqual(scanAfterDel.stdout.includes("alpha memory entry"), false);

    // 5. CLI DELETE ALL
    const dAll = await runCli(["-D", "all", fspec], tmpDir);
    assert.strictEqual(dAll.code, 0);

    // Verify all records gone from resident cormd search
    const scanAfterDelAll = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=beta"]));
    assert.strictEqual(scanAfterDelAll.stdout.includes("beta memory entry"), false);
  } finally {
    proc.kill();
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("forwarding 2: forwarded mutations persist cleanly across daemon restarts", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-fwd-persist-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  // Start initial daemon
  let proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    // Write via forwarded CLI
    const p1 = await runCli(["-p", "1:2026-10-15:durable across restart", fspec], tmpDir);
    assert.strictEqual(p1.code, 0);

    // Stop daemon cleanly
    proc.kill("SIGTERM");
    await new Promise((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 100));

    // Restart fresh daemon against the same database
    proc = spawnCormd(fspec, sockPath);
    for (let i = 0; i < 50; i++) {
      if (existsSync(sockPath)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const runner = new DaemonCormRunner(sockPath, {
      run: (_inv: Invocation) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    });

    // Query newly restarted daemon: record and index must be present
    const scanRes = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=durable"]));
    assert.strictEqual(scanRes.code, 0);
    assert.strictEqual(scanRes.stdout.includes("durable across restart"), true);
  } finally {
    proc.kill();
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("forwarding 3: standalone CLI mutations work when no daemon is running", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-standalone-" });
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  try {
    // 1. PUT standalone
    const p1 = await runCli(["-p", "1:2026-10-15:pure standalone write", fspec], tmpDir);
    assert.strictEqual(p1.code, 0);
    assert.strictEqual(p1.stdout.trim(), "1");

    // 2. GET standalone
    const g1 = await runCli(["-rg", "1", fspec], tmpDir);
    assert.strictEqual(g1.code, 0);
    assert.strictEqual(g1.stdout.includes("pure standalone write"), true);

    // 3. DEL standalone
    const d1 = await runCli(["-d", "1", fspec], tmpDir);
    assert.strictEqual(d1.code, 0);

    // 4. Verify deleted
    const g2 = await runCli(["-rg", "1", fspec], tmpDir);
    assert.strictEqual(g2.stdout.trim(), "-1");
  } finally {
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("forwarding 4: unreachable leased daemon fails closed without falling back to direct write", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-unreachable-" });
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;
  const lockPath = join(tmpDir, ".cormd.lock");

  // Hold flock on .cormd.lock with a non-existent socket to simulate dead/unreachable daemon
  const child = spawn("flock", ["-x", lockPath, "sh", "-c", "printf READY\\n; exec cat"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise<void>((resolve) => {
    child.stdout?.on("data", (chunk) => {
      if (chunk.toString().includes("READY")) resolve();
    });
  });

  // Write fake lock payload with unreachable daemon owner and socket
  writeFileSync(lockPath, JSON.stringify({ pid: 99999, owner: "daemon", socket: "/tmp/nonexistent_socket_path.sock" }));

  try {
    const res = await runCli(["-p", "1:2026-10-15:should fail closed", fspec], tmpDir);
    assert.strictEqual(res.code, 1);
    assert.strictEqual(res.stderr.includes("daemon is unreachable; direct mutation refused"), true);
  } finally {
    child.kill();
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("forwarding 5: database mismatch is rejected explicitly by cormd", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-db-mismatch-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  const proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const otherDb = join(tmpDir, "other.db@joint,lemma:a:s");
    // Forwarding request with mismatching target db must be rejected by cormd
    const runner = new DaemonCormRunner(sockPath, {
      run: (_inv: Invocation) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    });

    const res = await runner.run({
      command: "corm",
      args: ["-p", "1:2026-10-15:payload", otherDb],
      cwd: tmpDir,
      env: {},
    });
    assert.strictEqual(res.code, 1);
    assert.strictEqual(res.stderr.includes("database mismatch"), true);
  } finally {
    proc.kill();
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
