import { strict as assert } from "node:assert";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  ensureDaemon,
  probeDaemonIdentity,
  resolveDatabaseDir,
  extractFilespec,
} from "../src/daemon.ts";
import { activeSessionBuffer, flushSessionBuffer } from "../src/hooks/events.ts";
import { decodePayload } from "../src/payload.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const home = Deno.env.get("HOME") || "";
const cormAxisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = "/usr/bin/corm";
const cormdBin = "/usr/bin/cormd";

Deno.test("validation 1: successful automated episode without evidence remains tested, never supported", async () => {
  activeSessionBuffer.clear();
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-val-tested-" });
  activeSessionBuffer.setJournalDir(tmpDir);

  const capturedPayloads: string[] = [];
  const runner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-p") {
        capturedPayloads.push(inv.args[1]);
        return Promise.resolve({ stdout: "1", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const envSource = () => Promise.resolve({
    cfg: { ...DEFAULT_CONFIG, qmapBin: cormBin, memDir: tmpDir },
    runner,
    nowProvider: () => new Date("2026-10-16T12:00:00Z"),
    cwd: tmpDir,
  });

  // Successful verification command without evidence
  activeSessionBuffer.record({
    id: "call_test_success",
    timestamp: "2026-10-16T12:00:00Z",
    toolName: "bash",
    summary: "make test: 226 passed 0 failed",
    isError: false,
    approach: "run full test suite",
    outcome: "worked",
  });

  const ref = await flushSessionBuffer(envSource, { cwd: tmpDir, hasUI: false, mode: "test" });
  assert.strictEqual(ref, 1);
  assert.strictEqual(capturedPayloads.length, 1);

  const payload = capturedPayloads[0].slice(capturedPayloads[0].indexOf(":") + 1);
  const { envelope } = decodePayload(payload);

  // Must be 'tested', NEVER 'supported' without verified external evidence!
  assert.strictEqual(envelope.lifecycle, "tested");
  assert.strictEqual(envelope.episode?.outcome, "success");
  assert.strictEqual(envelope.evidence, undefined);

  // Field deduplication: no redundant request field
  assert.strictEqual(envelope.episode?.request, undefined);
  assert.strictEqual(envelope.episode?.problem, "make test: 226 passed 0 failed");
  assert.strictEqual(envelope.summary, "make test: 226 passed 0 failed");

  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

Deno.test("validation 1b: automated episode with valid evidence ref advances to supported", async () => {
  activeSessionBuffer.clear();
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-val-supported-" });
  activeSessionBuffer.setJournalDir(tmpDir);

  const validEvidenceRef = 42;
  const validEvidenceRecord = "2026-10-15:" + JSON.stringify({
    level: "L1",
    type: "investigation",
    lifecycle: "supported",
    summary: "Verified root cause of corm_open leak",
  });

  const capturedPayloads: string[] = [];
  const runner = {
    run(inv: import("../src/qmap.ts").Invocation) {
      if (inv.args[0] === "-g" && inv.args[1] === ".") {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (inv.args[0] === "-r" && inv.args[1] === "-g" && inv.args[2] === String(validEvidenceRef)) {
        return Promise.resolve({ stdout: validEvidenceRecord, stderr: "", code: 0 });
      }
      if (inv.args[0] === "-p") {
        capturedPayloads.push(inv.args[1]);
        return Promise.resolve({ stdout: "1", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const envSource = () => Promise.resolve({
    cfg: { ...DEFAULT_CONFIG, qmapBin: cormBin, memDir: tmpDir },
    runner,
    nowProvider: () => new Date("2026-10-16T12:00:00Z"),
    cwd: tmpDir,
  });

  // Successful command with validated evidence
  activeSessionBuffer.record({
    id: "call_test_with_evidence",
    timestamp: "2026-10-16T12:00:00Z",
    toolName: "bash",
    summary: "Integration test verified leak fix",
    isError: false,
    approach: "apply fix and test",
    outcome: "worked",
    evidence: [validEvidenceRef],
  });

  const ref = await flushSessionBuffer(envSource, { cwd: tmpDir, hasUI: false, mode: "test" });
  assert.strictEqual(ref, 1);
  assert.strictEqual(capturedPayloads.length, 1);

  const payload = capturedPayloads[0].slice(capturedPayloads[0].indexOf(":") + 1);
  const { envelope } = decodePayload(payload);

  // Valid evidence confirms advancement to 'supported'
  assert.strictEqual(envelope.lifecycle, "supported");
  assert.deepStrictEqual(envelope.evidence, [validEvidenceRef]);

  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

Deno.test("validation 2: resolveDatabaseDir extracts filespec by positional layout, ignoring .db in payload", () => {
  // 1. PUT invocation with misleading .db paths inside the payload text
  const misleadingPut = {
    command: cormBin,
    args: [
      "-p",
      "10:2026-10-16:Fixed critical corruption in /var/lib/other/stale.db and test.db",
      "/actual/canonical/path/mem.db@joint,lemma:a:s",
    ],
    env: {},
    cwd: "/workspace",
  };

  const extractedPut = extractFilespec(misleadingPut);
  assert.strictEqual(extractedPut, "/actual/canonical/path/mem.db@joint,lemma:a:s");
  const dirPut = resolveDatabaseDir(misleadingPut);
  assert.strictEqual(dirPut, "/actual/canonical/path");

  // 2. QUERY invocation with query string mentioning .db
  const misleadingQuery = {
    command: cormBin,
    args: [
      "-X",
      "lemma",
      "-g",
      ".",
      "site/.pi/mm/mem.db@joint,lemma:a:s",
      "-t",
      "10",
      "--query=investigate sqlite.db and db.db failure",
    ],
    env: {},
    cwd: "/home/user/project",
  };

  const extractedQuery = extractFilespec(misleadingQuery);
  assert.strictEqual(extractedQuery, "site/.pi/mm/mem.db@joint,lemma:a:s");
  const dirQuery = resolveDatabaseDir(misleadingQuery);
  assert.strictEqual(dirQuery, "/home/user/project/site/.pi/mm");

  // 3. GET invocation
  const getInv = {
    command: cormBin,
    args: ["-r", "-g", "1", "/tmp/store/mem.db:a:s"],
    env: {},
    cwd: "/tmp",
  };
  assert.strictEqual(extractFilespec(getInv), "/tmp/store/mem.db:a:s");
  assert.strictEqual(resolveDatabaseDir(getInv), "/tmp/store");

  // 4. DEL invocation
  const delInv = {
    command: cormBin,
    args: ["-d", "1", "/tmp/del_dir/mem.db"],
    env: {},
    cwd: "/tmp",
  };
  assert.strictEqual(extractFilespec(delInv), "/tmp/del_dir/mem.db");
  assert.strictEqual(resolveDatabaseDir(delInv), "/tmp/del_dir");
});

Deno.test("validation 3: ensureDaemon rejects active daemon serving different database", async () => {
  const tmpDirA = Deno.makeTempDirSync({ prefix: "cormd-dbA-" });
  const sockPathA = join(tmpDirA, "cormd.sock");
  const dbPathA = join(tmpDirA, "memA.db");
  const fspecA = `${dbPathA}@joint,lemma:a:s`;

  const tmpDirB = Deno.makeTempDirSync({ prefix: "cormd-dbB-" });
  const dbPathB = join(tmpDirB, "memB.db");
  const fspecB = `${dbPathB}@joint,lemma:a:s`;

  try {
    // 1. Start daemon for Database A
    await ensureDaemon({
      cormdBin,
      filespec: fspecA,
      socketPath: sockPathA,
      axisPath: cormAxisPath,
      cwd: tmpDirA,
    });

    // 2. Direct probe for Database B targeting Daemon A's socket
    const probe = await probeDaemonIdentity(sockPathA, fspecB);
    assert.strictEqual(probe.live, true);
    assert.strictEqual(probe.matches, false);
    assert.strictEqual(probe.error?.includes("database mismatch"), true);

    // 3. ensureDaemon with Database B targeting Daemon A's socket must fail closed!
    let threw = false;
    try {
      await ensureDaemon({
        cormdBin,
        filespec: fspecB,
        socketPath: sockPathA, // Point to Daemon A's socket
        axisPath: cormAxisPath,
        cwd: tmpDirB,
      });
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert.strictEqual(msg.includes("incompatible database"), true);
      assert.strictEqual(msg.includes("database mismatch"), true);
    }
    assert.strictEqual(threw, true, "ensureDaemon must fail closed on database mismatch");

    // Clean up Daemon A
    const lockPath = join(tmpDirA, ".cormd.lock");
    const lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDirA, { recursive: true }); } catch { /* ignore */ }
    try { rmSync(tmpDirB, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("validation 4: genuine multi-process concurrent startup coordinates safely onto single daemon", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "cormd-multiprocess-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const dbPath = join(tmpDir, "mem.db");
  const fspec = `${dbPath}@joint,lemma:a:s`;

  try {
    // Spawn 3 independent external OS processes concurrently attempting ensureDaemon
    const daemonModule = new URL("../src/daemon.ts", import.meta.url).pathname;
    const workerScript = `
      import { ensureDaemon } from "${daemonModule}";
      const sock = await ensureDaemon({
        cormdBin: "${cormdBin}",
        filespec: "${fspec}",
        socketPath: "${sockPath}",
        axisPath: "${cormAxisPath}",
        cwd: "${tmpDir}",
        timeoutMs: 5000,
      });
      console.log("READY:" + sock);
    `;

    const runProcess = (): Promise<{ code: number; stdout: string }> => {
      return new Promise((resolve) => {
        const p = spawn("deno", ["eval", "--allow-all", "--sloppy-imports", workerScript], {
          cwd: tmpDir,
          env: { ...process.env, CORM_AXIS_PATH: cormAxisPath },
        });
        let stdout = "";
        p.stdout?.on("data", (d) => { stdout += d.toString(); });
        p.on("close", (code) => resolve({ code: code ?? 0, stdout }));
      });
    };

    const results = await Promise.all([runProcess(), runProcess(), runProcess()]);

    for (const r of results) {
      assert.strictEqual(r.code, 0, `Process failed: ${r.stdout}`);
      assert.strictEqual(r.stdout.includes(`READY:${sockPath}`), true);
    }

    // Verify exactly one daemon owns .cormd.lock
    const lockPath = join(tmpDir, ".cormd.lock");
    assert.strictEqual(existsSync(lockPath), true);
    const lockData = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.strictEqual(lockData.owner, "daemon");

    // Clean up
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
