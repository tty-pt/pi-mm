import assert from "node:assert";
import { makeStoreTool } from "../src/tools/store.ts";
import { makeScanTool } from "../src/tools/scan.ts";
import { ShellCormRunner } from "../src/corm.ts";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { give, type ToolEnv } from "../src/tools/index.ts";

const cormBinPath = (await Deno.stat("/home/quirinpa/.local/bin/corm").then(() => true, () => false))
  ? "/home/quirinpa/.local/bin/corm"
  : "/usr/bin/corm";

const hasCorm = await (async () => {
  try {
    const s = await Deno.stat(cormBinPath);
    return s.isFile;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "spatial: real libcorm + libislet integration candidate join filters by bbox",
  ignore: !hasCorm,
  fn: async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "mm-spatial-test-" });

    const runner = new ShellCormRunner(async (cmd, args, options) => {
      const p = new Deno.Command(cmd, {
        args,
        cwd: options?.cwd,
        env: options?.env,
        stdin: options?.stdin ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
      });
      let out;
      if (options?.stdin) {
        const child = p.spawn();
        const w = child.stdin.getWriter();
        await w.write(options.stdin);
        await w.close();
        out = await child.output();
      } else {
        out = await p.output();
      }
      const dec = new TextDecoder();
      return {
        stdout: dec.decode(out.stdout),
        stderr: dec.decode(out.stderr),
        code: out.code,
      };
    });

    const home = Deno.env.get("HOME") || "";
    const axisLibs = [
      `${home}/.local/lib`,
      "/usr/local/lib",
      "/usr/lib",
    ].join(":");

    const cfg: MmConfig = {
      ...DEFAULT_CONFIG,
      cormBin: cormBinPath,
      axisLibs,
      memDir: ".pi/mm",
    };

    const env: ToolEnv = {
      cwd: tmpDir,
      cfg,
      runner,
      nowProvider: () => new Date("2026-10-14T12:00:00Z"),
    };

    const ctx = { cwd: tmpDir, hasUI: false, mode: "test" };
    const storeTool = makeStoreTool(give(env));
    const scanTool = makeScanTool(give(env));

    try {
      // Store item 1 at grid (10, 20)
      const res1 = await storeTool.execute("1", {
        summary: "Cache invalidation in subsystem alpha",
        context: { grid: { x: 10, y: 20 } },
      }, undefined, undefined, ctx);
      assert.strictEqual((res1.details as Record<string, unknown>).ref, 1);

      // Store item 2 at grid (100, 200)
      const res2 = await storeTool.execute("2", {
        summary: "Cache invalidation in subsystem beta",
        context: { grid: { x: 100, y: 200 } },
      }, undefined, undefined, ctx);
      assert.strictEqual((res2.details as Record<string, unknown>).ref, 2);

      // 1. Scan without bbox -> should find both items
      const scanAll = await scanTool.execute("3", { topic: "cache" }, undefined, undefined, ctx);
      const allRecords = (scanAll.details as { records: Array<{ ref: number }> }).records;
      assert.strictEqual(allRecords.length, 2);

      // 2. Scan with bbox covering (0,0) to (50,50) -> should match ref 1 only
      const scanBox1 = await scanTool.execute("4", {
        topic: "cache",
        bbox: { dim: 2, s: "0,0", l: "50,50" },
      }, undefined, undefined, ctx);
      const records1 = (scanBox1.details as { records: Array<{ ref: number }> }).records;
      assert.strictEqual(records1.length, 1);
      assert.strictEqual(records1[0].ref, 1);

      // 3. Scan with bbox covering (50,50) to (250,250) -> should match ref 2 only
      const scanBox2 = await scanTool.execute("5", {
        topic: "cache",
        bbox: { dim: 2, s: "50,50", l: "200,200" },
      }, undefined, undefined, ctx);
      const records2 = (scanBox2.details as { records: Array<{ ref: number }> }).records;
      assert.strictEqual(records2.length, 1);
      assert.strictEqual(records2[0].ref, 2);

      // 4. Scan with bbox covering (500,500) to (550,550) -> should match 0 items
      const scanBoxNone = await scanTool.execute("6", {
        topic: "cache",
        bbox: { dim: 2, s: "500,500", l: "50,50" },
      }, undefined, undefined, ctx);
      const recordsNone = (scanBoxNone.details as { records: Array<{ ref: number }> }).records;
      assert.strictEqual(recordsNone.length, 0);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
