import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildForgetInvocation,
  buildGetInvocation,
  buildGetJsonInvocation,
  buildListInvocation,
  buildScanInvocation,
  buildStoreInvocation,
  buildStoreJsonInvocation,
  type CormRunner,
  loadCormAddonModule,
  NativeAddonCormRunner,
} from "../src/corm.ts";
import { resolveAxisPath } from "../src/config.ts";

Deno.test("NativeAddonCormRunner: executes PUT_JSON, GET_JSON, LIST, QUERY, and DEL in-process without shell fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mm-napi-runner-"));
  const fspec = `${dir}/mem.db@joint,lemma:a:b`;
  const addon = await loadCormAddonModule();
  try {
    let fallbackCalls = 0;
    const failFallback: CormRunner = {
      async run() {
        fallbackCalls++;
        return { code: 99, stdout: "", stderr: "unexpected shell fallback" };
      },
    };

    const runner = new NativeAddonCormRunner(failFallback);
    assert.ok(addon, "@tty-pt/corm native addon module must load");

    const axisPath = resolveAxisPath(
      { cormBin: "corm", axisLibs: null, memDir: dir, scanLimit: 10 } as any,
      Deno.cwd(),
    );

    const jsonDoc = JSON.stringify({
      text: "alpha beta in-process napi runner test",
      topic: "napi-test",
      timestamp: "2023-11-14T22:15:00Z",
    });

    const putRes = await runner.run(
      buildStoreJsonInvocation("corm", fspec, 0, jsonDoc, axisPath, dir),
    );
    assert.equal(putRes.code, 0, `PUT_JSON failed: ${putRes.stderr}`);
    assert.equal(fallbackCalls, 0);

    const getRes = await runner.run(
      buildGetJsonInvocation("corm", fspec, 0, axisPath, dir),
    );
    assert.equal(getRes.code, 0, `GET_JSON failed: ${getRes.stderr}`);
    const parsed = JSON.parse(getRes.stdout);
    assert.equal(parsed.summary ?? parsed.text, "alpha beta in-process napi runner test");

    const listRes = await runner.run(
      buildListInvocation("corm", fspec, axisPath, dir),
    );
    assert.equal(listRes.code, 0);
    assert.equal(listRes.stdout.trim(), "0");

    const scanRes = await runner.run(
      buildScanInvocation(
        "corm",
        fspec,
        "(lemma AND joint)",
        5,
        axisPath,
        dir,
        undefined,
        ["--query=alpha beta", "--since=2023-11-14T00:00:00Z", "--until=2023-11-15T00:00:00Z"],
      ),
    );
    assert.equal(scanRes.code, 0, `QUERY failed: ${scanRes.stderr}`);
    assert.ok(scanRes.stdout.startsWith("0 "), `Expected hit for ref 0, got: ${scanRes.stdout}`);

    const delRes = await runner.run(
      buildForgetInvocation("corm", fspec, 0, axisPath, dir),
    );
    assert.equal(delRes.code, 0, `DEL failed: ${delRes.stderr}`);
    assert.equal(fallbackCalls, 0);
  } finally {
    addon?.closeCormEngine?.(fspec);
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test("NativeAddonCormRunner: refuses mutations when .cormd.lock is held by another process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mm-napi-lock-"));
  const lockPath = join(dir, ".cormd.lock");
  const child = new Deno.Command("flock", {
    args: ["-x", lockPath, "sleep", "5"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();

  // Wait briefly for flock to acquire
  await new Promise((r) => setTimeout(r, 100));

  try {
    const runner = new NativeAddonCormRunner({
      async run() {
        return { code: 0, stdout: "FALLBACK", stderr: "" };
      },
    });
    const fspec = `${dir}/mem.db@joint,lemma:a:b`;
    const res = await runner.run(
      buildStoreInvocation("corm", fspec, 0, "hello", "", dir),
    );
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes("leased by resident cormd"));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    await child.status.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test("NativeAddonCormRunner: falls back to ShellCormRunner when addon is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mm-napi-fallback-"));
  try {
    let fallbackCalled = false;
    const runner = new NativeAddonCormRunner(
      {
        async run() {
          fallbackCalled = true;
          return { code: 0, stdout: "FROM_FALLBACK", stderr: "" };
        },
      },
      async () => null,
    );
    const fspec = `${dir}/mem.db@joint,lemma:a:b`;
    const res = await runner.run(
      buildGetInvocation("corm", fspec, 0, "", dir),
    );
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "FROM_FALLBACK");
    assert.equal(fallbackCalled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test("NativeAddonCormRunner: re-entrant withLock inside executeStore completes without self-deadlock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mm-napi-reentrant-"));
  const fspec = `${dir}/mem.db@joint,lemma:a:b`;
  const addon = await loadCormAddonModule();
  try {
    const runner = new NativeAddonCormRunner({
      async run() {
        return { code: 99, stdout: "", stderr: "unexpected fallback" };
      },
    });
    const axisPath = resolveAxisPath(
      { cormBin: "corm", axisLibs: null, memDir: dir, scanLimit: 10 } as any,
      Deno.cwd(),
    );
    const { withLock } = await import("../src/lock.ts");
    const res = await withLock(
      dir,
      async () => {
        return await runner.run(
          buildStoreInvocation("corm", fspec, 1, "2026-11-15:reentrant lock test", axisPath, dir),
        );
      },
      { timeoutMs: 500 },
    );
    assert.equal(res.code, 0, `Nested mutation inside withLock failed: ${res.stderr}`);
  } finally {
    addon?.closeCormEngine?.(fspec);
    rmSync(dir, { recursive: true, force: true });
  }
});
