import assert from "node:assert";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as net from "node:net";
import { DaemonCormRunner } from "../src/daemon.ts";
import { buildScanInvocation, buildStoreInvocation, type Invocation } from "../src/corm.ts";

const home = Deno.env.get("HOME") || "";
const cormAxisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

function sendRaw(sockPath: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: sockPath });
    let res = "";
    let bodyLen = -1;
    let headerParsed = false;
    client.on("connect", () => client.write(`${cmd}\n`));
    client.on("data", (d) => {
      res += d.toString();
      if (!headerParsed && res.includes("\n")) {
        const firstNl = res.indexOf("\n");
        const header = res.slice(0, firstNl).trim();
        const parts = header.split(/\s+/);
        if (parts.length >= 3) {
          bodyLen = parseInt(parts[2], 10);
          headerParsed = true;
        }
      }
      if (headerParsed) {
        const firstNl = res.indexOf("\n");
        const body = res.slice(firstNl + 1);
        if (bodyLen <= 0 || body.length >= bodyLen) {
          client.destroy();
          resolve(res);
        }
      }
    });
    client.on("error", reject);
  });
}
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

Deno.test("hardening 1: concurrent standalone CLI mutations serialize safely without false daemon-unreachable error", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-cli-contention-" });
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;
  const lockPath = join(tmpDir, ".cormd.lock");

  // Simulate a competing CLI process that acquires flock on .cormd.lock and marks owner: cli
  const holder = spawn("flock", ["-x", lockPath, "sh", "-c", "printf READY\\n; exec cat"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise<void>((resolve) => {
    holder.stdout?.on("data", (chunk) => {
      if (chunk.toString().includes("READY")) resolve();
    });
  });

  // Write CLI owner metadata into lockfile
  writeFileSync(lockPath, JSON.stringify({ pid: 12345, owner: "cli" }));

  try {
    // Launch CLI mutation in background: it must wait rather than immediately failing with daemon unreachable
    const cliPromise = runCli(["-p", "1:2026-10-15:serialized write", fspec], tmpDir);

    // Let it poll for 150ms while contending
    await new Promise((r) => setTimeout(r, 150));

    // Release the competing holder lock
    holder.kill();

    // The CLI mutation must now acquire the lock and succeed!
    const res = await cliPromise;
    assert.strictEqual(res.code, 0, `CLI failed with stderr: ${res.stderr}`);
    assert.strictEqual(res.stdout.trim(), "1");
    assert.strictEqual(res.stderr.includes("daemon is unreachable"), false);

    // Verify record was written
    const getRes = await runCli(["-rg", "1", fspec], tmpDir);
    assert.strictEqual(getRes.stdout.includes("serialized write"), true);
  } finally {
    try { holder.kill(); } catch { /* ignore */ }
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("hardening 2: database identity verification rejects same-basename databases across different directories", async () => {
  const baseDir = Deno.makeTempDirSync({ prefix: "cormd-db-ident-" });
  const dirA = join(baseDir, "dirA");
  const dirB = join(baseDir, "dirB");
  Deno.mkdirSync(dirA);
  Deno.mkdirSync(dirB);

  const dbA = join(dirA, "mem.db");
  const sockA = join(dirA, "cormd.sock");
  const fspecA = `${dbA}@joint,lemma:a:s`;

  // Start daemon serving dirA/mem.db
  const proc = spawnCormd(fspecA, sockA);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockA)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const runner = new DaemonCormRunner(sockA, {
      run: (_inv: Invocation) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    });

    // 1. Mutation to matching database dirA/mem.db succeeds
    const resMatch = await runner.run({
      command: "corm",
      args: ["-p", "1:2026-10-15:dirA payload", fspecA],
      cwd: dirA,
      env: {},
    });
    assert.strictEqual(resMatch.code, 0);

    // 2. Mutation with same basename "mem.db" but different parent dirB (file does not exist on disk yet)
    const fspecB = `${join(dirB, "mem.db")}@joint,lemma:a:s`;
    const resMismatch = await runner.run({
      command: "corm",
      args: ["-p", "1:2026-10-15:dirB payload", fspecB],
      cwd: dirB,
      env: {},
    });

    // MUST be rejected unambiguously by check_database_match()
    assert.strictEqual(resMismatch.code, 1);
    assert.strictEqual(resMismatch.stderr.includes("database mismatch"), true);
  } finally {
    proc.kill();
    try { Deno.removeSync(baseDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("hardening 3: secondary index failure halts stale query serving and recovers via RECONCILE", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-reconcile-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  // 1. Populate primary with initial record
  const p0 = await runCli(["-p", "1:2026-10-15:reconcile test record", fspec], tmpDir);
  assert.strictEqual(p0.code, 0);

  // 2. Start daemon
  const proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const runner = new DaemonCormRunner(sockPath, {
      run: (_inv: Invocation) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    });

    // Verify query initially works
    const q1 = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=reconcile"]));
    assert.strictEqual(q1.code, 0);
    assert.strictEqual(q1.stdout.includes("reconcile test record"), true);

    // 3. Inject secondary index failure via invalid non-date payload for libjoint
    const failStore = await runner.run(buildStoreInvocation("corm", fspec, 2, "invalid_non_date_payload", cormAxisPath, tmpDir));
    assert.strictEqual(failStore.code, 1);
    assert.strictEqual(failStore.stderr.includes("partial failure: axis index update failed"), true);

    // 4. Query MUST now be refused rather than serving inconsistent index results
    const qDegraded = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=reconcile"]));
    assert.strictEqual(qDegraded.code, 1);
    assert.strictEqual(qDegraded.stderr.includes("index degraded"), true);

    // 5. Send RECONCILE command while invalid payload is in primary DB: must fail explicitly
    const recFail = await sendRaw(sockPath, `RECONCILE 4 ${dbPath} 0`);
    assert.strictEqual(recFail.startsWith("ERR"), true);
    assert.strictEqual(recFail.includes("reconciliation failed"), true);

    // Query must STILL be refused while degraded
    const qStillDegraded = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=reconcile"]));
    assert.strictEqual(qStillDegraded.code, 1);

    // 6. Delete the invalid record from primary database
    const delRes = await sendRaw(sockPath, `DEL 5 ${dbPath} 2 0`);
    assert.strictEqual(delRes.startsWith("OK"), true);

    // 7. Send RECONCILE again: must now succeed!
    const recRes = await sendRaw(sockPath, `RECONCILE 6 ${dbPath} 0`);
    assert.strictEqual(recRes.startsWith("OK"), true);

    // 8. After RECONCILE, query is restored and returns consistent results
    const qAfter = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=reconcile"]));
    assert.strictEqual(qAfter.code, 0);
    assert.strictEqual(qAfter.stdout.includes("reconcile test record"), true);
  } finally {
    proc.kill();
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("hardening 4: failed deletion / stale index entries in nonempty DB are removed by RECONCILE", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-stale-purge-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  // 1. Seed primary database with records 1 ("alpha") and 2 ("beta to delete")
  const p1 = await runCli(["-p", "1:2026-10-15:alpha persistent record", fspec], tmpDir);
  assert.strictEqual(p1.code, 0);
  const p2 = await runCli(["-p", "2:2026-10-15:beta record to delete", fspec], tmpDir);
  assert.strictEqual(p2.code, 0);

  // 2. Start daemon
  const proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const runner = new DaemonCormRunner(sockPath, {
      run: (_inv: Invocation) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    });

    // Verify both records are discoverable in queries
    const qAlpha = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=alpha"]));
    assert.strictEqual(qAlpha.code, 0);
    assert.strictEqual(qAlpha.stdout.includes("alpha persistent record"), true);

    const qBeta = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=beta"]));
    assert.strictEqual(qBeta.code, 0);
    assert.strictEqual(qBeta.stdout.includes("beta record to delete"), true);

    // 3. Stop daemon so we can create a stale-index condition
    proc.kill();
    await new Promise((r) => setTimeout(r, 100));

    // Delete record 2 with only stoma in the roster, leaving mem.db-joint with a stale entry for record 2!
    const pDel = await runCli(["-d", "2", `${dbPath}@lemma:a:s`], tmpDir);
    assert.strictEqual(pDel.code, 0);

    // Restart daemon with both joint and stoma
    const proc2 = spawnCormd(fspec, sockPath);
    for (let i = 0; i < 50; i++) {
      if (existsSync(sockPath)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    try {
      // Execute RECONCILE: must eliminate stale index entry and rebuild cleanly from primary DB
      const recRes = await sendRaw(sockPath, `RECONCILE 10 ${dbPath} 0`);
      assert.strictEqual(recRes.startsWith("OK"), true);

      // Verify queries for "beta" return zero hits
      const qBetaAfter = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=beta"]));
      assert.strictEqual(qBetaAfter.code, 0);
      assert.strictEqual(qBetaAfter.stdout.includes("beta record to delete"), false);

      // Verify queries for "alpha" still return record 1
      const qAlphaAfter = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=alpha"]));
      assert.strictEqual(qAlphaAfter.code, 0);
      assert.strictEqual(qAlphaAfter.stdout.includes("alpha persistent record"), true);
    } finally {
      proc2.kill();
    }
  } finally {
    try { proc.kill(); } catch { /* ignore */ }
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("hardening 5: failure injection during index reset/rebuild returns framed ERR and keeps queries blocked", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-fail-inject-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  // Start daemon
  const proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const runner = new DaemonCormRunner(sockPath, {
      run: (_inv: Invocation) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    });

    // 1. Store valid record 1
    const p1 = await runner.run(buildStoreInvocation("corm", fspec, 1, "2026-10-15:valid record", cormAxisPath, tmpDir));
    assert.strictEqual(p1.code, 0);

    // 2. Inject failure during index recreation by making the directory read-only
    // In Linux, unlinking a file inside a directory requires write permission on the directory.
    // This causes unlink() during reconcile to fail with EACCES (Permission denied)!
    Deno.chmodSync(tmpDir, 0o555);

    try {
      // 3. Send RECONCILE: must fail explicitly and return framed ERR
      const recFail = await sendRaw(sockPath, `RECONCILE 20 ${dbPath} 0`);
      assert.strictEqual(recFail.startsWith("ERR"), true, `Expected ERR but got: ${recFail}`);
      assert.strictEqual(recFail.includes("cannot remove index file"), true);
      assert.strictEqual(recFail.includes("Permission denied"), true);

      // 4. Queries MUST remain blocked with "index degraded"
      const qBlocked = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=valid"]));
      assert.strictEqual(qBlocked.code, 1);
      assert.strictEqual(qBlocked.stderr.includes("index degraded"), true);
    } finally {
      // 5. Restore directory write permissions
      Deno.chmodSync(tmpDir, 0o755);
    }

    // 6. Send RECONCILE again: must now succeed!
    const recRecover = await sendRaw(sockPath, `RECONCILE 21 ${dbPath} 0`);
    assert.strictEqual(recRecover.startsWith("OK"), true);

    // 7. Queries must now be unblocked and return valid data
    const qRecovered = await runner.run(buildScanInvocation("corm", fspec, "lemma", 5, cormAxisPath, tmpDir, undefined, ["--query=valid"]));
    assert.strictEqual(qRecovered.code, 0);
    assert.strictEqual(qRecovered.stdout.includes("valid record"), true);
  } finally {
    proc.kill();
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("hardening 6: repeated reconciliation does not leak handles or obsolete contexts (50 cycles)", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-repeat-rec-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  // Start daemon
  const proc = spawnCormd(fspec, sockPath);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    const runner = new DaemonCormRunner(sockPath, {
      run: (_inv: Invocation) => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    });

    // Store 5 records
    for (let i = 1; i <= 5; i++) {
      const res = await runner.run(buildStoreInvocation("corm", fspec, i, `2026-10-15:item number ${i}`, cormAxisPath, tmpDir));
      assert.strictEqual(res.code, 0);
    }

    // Run RECONCILE 50 times in a loop
    for (let i = 1; i <= 50; i++) {
      const rec = await sendRaw(sockPath, `RECONCILE ${i} ${dbPath} 0`);
      assert.strictEqual(rec.startsWith("OK"), true, `Reconcile iteration ${i} failed: ${rec}`);
    }

    // Verify STATS shows records: 5 and normal operation
    const statsRes = await sendRaw(sockPath, `STATS 100 0`);
    assert.strictEqual(statsRes.startsWith("OK"), true);
    assert.strictEqual(statsRes.includes(`"records":5`), true);

    // Verify all 5 records are returned in query
    const qAll = await runner.run(buildScanInvocation("corm", fspec, "lemma", 10, cormAxisPath, tmpDir, undefined, ["--query=item"]));
    assert.strictEqual(qAll.code, 0);
    for (let i = 1; i <= 5; i++) {
      assert.strictEqual(qAll.stdout.includes(`item number ${i}`), true);
    }

    // Mutate after repeated reconciliations: store record 6 and delete record 1
    const s6 = await runner.run(buildStoreInvocation("corm", fspec, 6, "2026-10-15:item number 6", cormAxisPath, tmpDir));
    assert.strictEqual(s6.code, 0);
    const del1 = await runner.run({
      command: "corm",
      args: ["-d", "1", fspec],
      cwd: tmpDir,
      env: {},
    });
    assert.strictEqual(del1.code, 0);

    // Restart daemon to verify persistence across restart
    proc.kill();
    await new Promise((r) => setTimeout(r, 100));

    const proc2 = spawnCormd(fspec, sockPath);
    for (let i = 0; i < 50; i++) {
      if (existsSync(sockPath)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    try {
      const qAfterRestart = await runner.run(buildScanInvocation("corm", fspec, "lemma", 10, cormAxisPath, tmpDir, undefined, ["--query=item"]));
      assert.strictEqual(qAfterRestart.code, 0);
      assert.strictEqual(qAfterRestart.stdout.includes("item number 1"), false);
      assert.strictEqual(qAfterRestart.stdout.includes("item number 6"), true);
    } finally {
      proc2.kill();
    }
  } finally {
    try { proc.kill(); } catch { /* ignore */ }
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("hardening 7: rejection of RECONCILE requests targeting a different database", async () => {
  const baseDir = Deno.makeTempDirSync({ prefix: "cormd-rec-mismatch-" });
  const dirA = join(baseDir, "dirA");
  const dirB = join(baseDir, "dirB");
  Deno.mkdirSync(dirA);
  Deno.mkdirSync(dirB);

  const dbA = join(dirA, "mem.db");
  const sockA = join(dirA, "cormd.sock");
  const fspecA = `${dbA}@joint,lemma:a:s`;

  // Start daemon serving dirA/mem.db
  const proc = spawnCormd(fspecA, sockA);
  for (let i = 0; i < 50; i++) {
    if (existsSync(sockA)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    // 1. RECONCILE targeting matching database succeeds
    const recMatch = await sendRaw(sockA, `RECONCILE 1 ${dbA} 0`);
    assert.strictEqual(recMatch.startsWith("OK"), true);

    // 2. RECONCILE targeting foreign database in dirB must be rejected
    const dbB = join(dirB, "mem.db");
    const recMismatch = await sendRaw(sockA, `RECONCILE 2 ${dbB} 0`);
    assert.strictEqual(recMismatch.startsWith("ERR"), true);
    assert.strictEqual(recMismatch.includes("database mismatch"), true);
  } finally {
    proc.kill();
    try { Deno.removeSync(baseDir, { recursive: true }); } catch { /* ignore */ }
  }
});
