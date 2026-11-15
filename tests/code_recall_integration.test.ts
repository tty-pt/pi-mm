import assert from "node:assert";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { makeRecallTool } from "../src/tools/recall.ts";
import { makeStoreTool } from "../src/tools/store.ts";
import { give, type ToolEnv } from "../src/tools/index.ts";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { ShellCormRunner } from "../src/corm.ts";
import { clearCodeInstances } from "../src/code/manager.ts";

const cormBinPath = (await Deno.stat("/home/quirinpa/.local/bin/corm").then(() => true, () => false))
  ? "/home/quirinpa/.local/bin/corm"
  : "/usr/bin/corm";

Deno.test("code_recall_integration: unified memory_recall code scope, auto-preview, trace, batch symbols, and episodic lore fusion", async () => {
  clearCodeInstances();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-code-recall-int-" });

  try {
    const audioFile = join(tmpDir, "audio.c");
    writeFileSync(audioFile, [
      '#include "audio.h"',
      "",
      "/** Decode incoming FLAC frame */",
      "static int decodeFrame(int sampleRate) {",
      "  return sampleRate * 2;",
      "}",
      "",
      "/** Process audio ringbuffer chunk */",
      "int processAudioChunk(int frames) {",
      "  int decoded = decodeFrame(frames);",
      "  return decoded;",
      "}",
    ].join("\n"), "utf-8");

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
        stdoutBytes: out.stdout,
        stderr: dec.decode(out.stderr),
        code: out.code,
      };
    });

    const home = Deno.env.get("HOME") || "";
    const axisLibs = [`${home}/.local/lib`, "/usr/local/lib", "/usr/lib"].join(":");

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
      nowProvider: () => new Date("2026-10-15T12:00:00Z"),
    };

    const ctx = { cwd: tmpDir, hasUI: false, mode: "test" };
    const storeTool = makeStoreTool(give(env));
    const recallTool = makeRecallTool(give(env));

    // 1. Store an L2 Standing Invariant about processAudioChunk in persistent memory
    await storeTool.execute("1", {
      level: "L2",
      type: "invariant",
      standing: true,
      summary: "processAudioChunk must keep ringbuffer chunk size aligned to 256 samples to prevent underrun",
      context: { project: "site", subsystem: "audio" },
    }, undefined, undefined, ctx);

    // 2. Call memory_recall with symbol="processAudioChunk" (auto-routes to code recall + fuses lore!)
    const symRes = await recallTool.execute("2", {
      symbol: "processAudioChunk",
    }, undefined, undefined, ctx);

    const symText = symRes.content[0].text || "";
    assert.ok(symText.includes("Function audio.c:processAudioChunk"), "should include symbol header");
    assert.ok(symText.includes("Direct Callees (1): decodeFrame"), "should include direct callees");
    assert.ok(symText.includes("int decoded = decodeFrame(frames);"), "should slice exact function source");
    assert.ok(
      symText.includes("=== Linked Engineering Lore & Invariants (pi-mm) ==="),
      "should fuse persistent pi-mm lore into code symbol inspection",
    );
    assert.ok(
      symText.includes("processAudioChunk must keep ringbuffer chunk size aligned to 256 samples"),
      "should display the matching L2 standing invariant",
    );

    // 3. Call memory_recall with trace="decodeFrame" (inbound caller should be processAudioChunk)
    const traceRes = await recallTool.execute("3", {
      trace: "decodeFrame",
      direction: "inbound",
    }, undefined, undefined, ctx);
    const traceText = traceRes.content[0].text || "";
    assert.ok(traceText.includes("Call Graph Trace: audio.c:decodeFrame"));
    assert.ok(traceText.includes("audio.c:processAudioChunk"));

    // 4. Call memory_recall with batch symbols=["decodeFrame", "processAudioChunk"]
    const batchRes = await recallTool.execute("4", {
      symbols: ["decodeFrame", "processAudioChunk"],
    }, undefined, undefined, ctx);
    const batchText = batchRes.content[0].text || "";
    assert.ok(batchText.includes("audio.c:decodeFrame"));
    assert.ok(batchText.includes("audio.c:processAudioChunk"));

    // 5. Call memory_recall with scope="code", overview=true
    const ovRes = await recallTool.execute("5", {
      scope: "code",
      overview: true,
    }, undefined, undefined, ctx);
    const ovText = ovRes.content[0].text || "";
    assert.ok(ovText.includes("Codebase Architecture Overview (L3/L2 Mipmap)"));
    assert.ok(ovText.includes("Indexed Files: 1 | Total Symbols: 2"));
  } finally {
    clearCodeInstances();
    await Deno.remove(tmpDir, { recursive: true });
  }
});
