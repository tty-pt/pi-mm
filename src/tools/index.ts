import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Pi, PiCtx, PiToolSpec } from "../hooks/events";
import type { MmConfig } from "../config";
import { readMmConfig, resolveAxisPath, resolveCormBin, resolveCormdBin, resolveSocketPath, resolveAdvancedTools, runtimeEnv, sepalConfigured } from "../config";
import type { CormRunner } from "../corm";
import { ShellCormRunner, DaemonCormRunner, filespecFor, embedEnv } from "../corm";
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
  runner: CormRunner;
  nowProvider: () => Date;
  fetchFn?: typeof fetch;
}

export type EnvSource = (ctx: PiCtx) => Promise<ToolEnv>;

export function give(env: ToolEnv): EnvSource {
  return () => Promise.resolve(env);
}

export function cormBin(env: ToolEnv): string {
  return env.cfg.cormBin || env.cfg.qmapBin || "";
}

export async function readToolEnv(cwd: string, runner: CormRunner): Promise<ToolEnv> {
  const cfg = await readMmConfig(cwd);
  if (!cfg.cormBin) {
    const env = runtimeEnv();
    const pathDirs = (env["PATH"] ?? "").split(":");
    const resolved = resolveCormBin(cfg, cwd, pathDirs, existsSync).path;
    cfg.cormBin = resolved;
  }
  try {
    await mkdir(resolveMemDir(cwd, cfg.memDir), { recursive: true });
  } catch {
    // Best-effort directory creation
  }
  return { cwd, cfg, runner, nowProvider: () => new Date() };
}

export function defaultEnvSource(pi: Pi): EnvSource {
  const shellRunner = new ShellCormRunner((command, args, options) => pi.exec(command, args, options));
  return async (ctx) => {
    const cfg = await readMmConfig(ctx.cwd);
    const mDir = resolveMemDir(ctx.cwd, cfg.memDir);
    const socketPath = resolveSocketPath(cfg, mDir);
    const axes = resolveAxisPath(cfg, ctx.cwd);
    const embed = sepalConfigured(cfg);
    const fspec = filespecFor(mDir, embed);
    const eEnv = embedEnv(cfg);

    const env = runtimeEnv();
    const pathDirs = (env["PATH"] ?? "").split(":");
    const cormdRes = resolveCormdBin(cfg, ctx.cwd, pathDirs, existsSync);

    let runner: CormRunner = shellRunner;
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
        runner = new DaemonCormRunner(socketPath, shellRunner);
      } catch {
        // Fall back gracefully to daemon runner (which falls back to shell runner)
        runner = new DaemonCormRunner(socketPath, shellRunner);
      }
    } else {
      runner = new DaemonCormRunner(socketPath, shellRunner);
    }
    return readToolEnv(ctx.cwd, runner);
  };
}

export function axisPath(env: ToolEnv): string {
  return resolveAxisPath(env.cfg, env.cwd);
}

export function socketPath(env: ToolEnv): string {
  return resolveSocketPath(env.cfg, memDir(env));
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