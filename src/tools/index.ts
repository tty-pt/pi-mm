import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Pi, PiCtx, PiToolSpec } from "../hooks/events";
import type { MmConfig } from "../config";
import { readMmConfig, resolveAxisPath, resolveQmapBin, resolveCormdBin, resolveAdvancedTools, runtimeEnv, sepalConfigured } from "../config";
import type { QmapRunner } from "../qmap";
import { ShellQmapRunner, DaemonQmapRunner, filespecFor, embedEnv } from "../qmap";
import { ensureDaemon } from "../daemon.ts";
import { makeStoreTool } from "./store.ts";
import { makeScanTool } from "./scan.ts";
import { makeThinkTool } from "./think.ts";
import { makeForgetTool } from "./forget.ts";
import { makeResetTool } from "./reset.ts";
import { makeTraverseTool } from "./traverse.ts";
import { makeLifecycleTool } from "./lifecycle.ts";
import { makeFeedbackTool } from "./feedback.ts";
import { makeConsolidateTool } from "./consolidate.ts";
import { makeRecallTool } from "./recall.ts";
import { makeRecordTool } from "./record.ts";
import { makeReviewTool } from "./review.ts";

export {
  makeStoreTool,
  makeScanTool,
  makeThinkTool,
  makeForgetTool,
  makeResetTool,
  makeTraverseTool,
  makeLifecycleTool,
  makeFeedbackTool,
  makeConsolidateTool,
  makeRecallTool,
  makeRecordTool,
  makeReviewTool,
};
export { sepalConfigured };

export interface ToolEnv {
  cwd: string;
  cfg: MmConfig;
  runner: QmapRunner;
  nowProvider: () => Date;
  fetchFn?: typeof fetch;
}

export type EnvSource = (ctx: PiCtx) => Promise<ToolEnv>;

export function give(env: ToolEnv): EnvSource {
  return () => Promise.resolve(env);
}

export async function readToolEnv(cwd: string, runner: QmapRunner): Promise<ToolEnv> {
  const cfg = await readMmConfig(cwd);
  if (cfg.qmapBin === "") {
    const env = runtimeEnv();
    const pathDirs = (env["PATH"] ?? "").split(":");
    cfg.qmapBin = resolveQmapBin(cfg, cwd, pathDirs, existsSync).path;
  }
  try {
    await mkdir(resolveMemDir(cwd, cfg.memDir), { recursive: true });
  } catch {
    // Best-effort directory creation
  }
  return { cwd, cfg, runner, nowProvider: () => new Date() };
}

export function defaultEnvSource(pi: Pi): EnvSource {
  const shellRunner = new ShellQmapRunner((command, args, options) => pi.exec(command, args, options));
  return async (ctx) => {
    const cfg = await readMmConfig(ctx.cwd);
    const mDir = resolveMemDir(ctx.cwd, cfg.memDir);
    const socketPath = join(mDir, "cormd.sock");
    const axes = resolveAxisPath(cfg, ctx.cwd);
    const embed = sepalConfigured(cfg);
    const fspec = filespecFor(mDir, embed);
    const eEnv = embedEnv(cfg);

    const env = runtimeEnv();
    const pathDirs = (env["PATH"] ?? "").split(":");
    const cormdRes = resolveCormdBin(cfg, ctx.cwd, pathDirs, existsSync);

    let runner: QmapRunner = shellRunner;
    const isTestMock = ctx.cwd.includes("fake");
    const isProject = !isTestMock && (existsSync(join(ctx.cwd, ".pi")) || existsSync(join(mDir, "mem.db")) || Boolean(cfg.cormdBin));
    if (cormdRes.path !== "" && isProject) {
      try {
        await ensureDaemon({
          cormdBin: cormdRes.path,
          filespec: fspec,
          socketPath,
          axisPath: axes,
          embedEnv: eEnv,
          cwd: mDir,
        });
        runner = new DaemonQmapRunner(socketPath, shellRunner);
      } catch {
        // Fall back gracefully to daemon runner (which falls back to shell runner)
        runner = new DaemonQmapRunner(socketPath, shellRunner);
      }
    } else {
      runner = new DaemonQmapRunner(socketPath, shellRunner);
    }
    return readToolEnv(ctx.cwd, runner);
  };
}

export function axisPath(env: ToolEnv): string {
  return resolveAxisPath(env.cfg, env.cwd);
}

export function resolveMemDir(cwd: string, dir: string): string {
  return isAbsolute(dir) ? dir : join(cwd, dir);
}

export function memDir(env: ToolEnv): string {
  return resolveMemDir(env.cwd, env.cfg.memDir);
}

export function exportDetail(content: unknown): { content: Array<{ type: string; text?: string }>; details: unknown } {
  return { content: [{ type: "text" }], details: content };
}

export function installTools(
  pi: Pi,
  env: EnvSource = defaultEnvSource(pi),
  options?: { advancedTools?: boolean },
): void {
  const tools: PiToolSpec[] = [
    makeRecallTool(env),
    makeRecordTool(env),
    makeReviewTool(env),
  ];

  const enableAdvanced = options?.advancedTools ?? resolveAdvancedTools();
  if (enableAdvanced) {
    tools.push(
      makeStoreTool(env),
      makeScanTool(env),
      makeThinkTool(env),
      makeForgetTool(env),
      makeResetTool(env),
      makeTraverseTool(env),
      makeLifecycleTool(env),
      makeFeedbackTool(env),
      makeConsolidateTool(env),
    );
  }

  for (const tool of tools) pi.registerTool(tool);
}