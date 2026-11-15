import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Pi, PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { MmConfig } from "../config.ts";
import { readMmConfig, resolveAxisPath, resolveCormBin, resolveCormdBin, resolveSocketPath, resolveAdvancedTools, runtimeEnv, sepalConfigured } from "../config.ts";
import type { CormRunner } from "../corm.ts";
import { NativeAddonCormRunner, ShellCormRunner, DaemonCormRunner, filespecFor, embedEnv, loadCormAddonModule, isDaemonLockHeld } from "../corm.ts";
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
import { buildMemoryOverview, type MemoryOverviewResult, type MemoryOverviewOptions } from "./overview.ts";

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
  buildMemoryOverview,
  type MemoryOverviewResult,
  type MemoryOverviewOptions,
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
    cfg.cormBin = resolved || ((await loadCormAddonModule()) !== null ? "corm" : "");
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
  const localRunner = new NativeAddonCormRunner(shellRunner);
  const runnerCache = new Map<string, Promise<CormRunner>>();

  return async (ctx) => {
    const cfg = await readMmConfig(ctx.cwd);
    const mDir = resolveMemDir(ctx.cwd, cfg.memDir);
    const socketPath = resolveSocketPath(cfg, mDir);
    const axes = resolveAxisPath(cfg, ctx.cwd);
    const embed = sepalConfigured(cfg);
    const fspec = filespecFor(mDir, embed);
    const eEnv = embedEnv(cfg);

    const isTestMock = ctx.cwd.includes("fake");
    const isProject = !isTestMock && (existsSync(join(ctx.cwd, ".pi")) || existsSync(join(mDir, "mem.db")) || Boolean(cfg.cormdBin));
    const fallbackRunner = isTestMock ? shellRunner : localRunner;

    // Zero-config axil-auren: start/provision in the background (singleton, never blocks a tool call),
    // and adopt the local server for judge/embeddings as soon as it answers.
    if (isProject && (!cfg.captureEmbedUrl || !cfg.judgeUrl || !cfg.embedUrl)) {
      try {
        const { ensureAuren, isAurenRunning, findSepalLib, DEFAULT_AUREN_URL, DEFAULT_AUREN_JUDGE_MODEL, DEFAULT_AUREN_EMBED_MODEL } = await import("../auren.ts");
        void ensureAuren({
          cwd: ctx.cwd,
          settings: { autoStart: cfg.autoStartAuren, autoDownloadModels: cfg.autoDownloadModels },
        });
        if (await isAurenRunning(DEFAULT_AUREN_URL, 250)) {
          if (!cfg.captureEmbedUrl) cfg.captureEmbedUrl = DEFAULT_AUREN_URL;
          if (!cfg.judgeUrl && cfg.judgeMode !== "off") {
            cfg.judgeUrl = DEFAULT_AUREN_URL;
            if (!cfg.judgeModel) cfg.judgeModel = DEFAULT_AUREN_JUDGE_MODEL;
          }
          if (!cfg.embedUrl && cfg.semanticSearch !== false && findSepalLib(ctx.cwd)) {
            cfg.embedUrl = DEFAULT_AUREN_URL;
            if (!cfg.embedModel) cfg.embedModel = DEFAULT_AUREN_EMBED_MODEL;
          }
        }
      } catch {
        // Best-effort auto-discovery
      }
    }

    const hasNativeAddon = !isTestMock && (await loadCormAddonModule()) !== null;
    const lockHeld = await isDaemonLockHeld(join(mDir, ".cormd.lock"));

    const env = runtimeEnv();
    const pathDirs = (env["PATH"] ?? "").split(":");
    const cormdRes = cfg.cormdBin
      ? { path: cfg.cormdBin }
      : resolveCormdBin(cfg, ctx.cwd, pathDirs, existsSync);

    let runner: CormRunner;
    // Prefer resident cormd for project stores when cormd is installed so the in-memory
    // lemma/sepal indices stay warm across turns/processes and queries remain non-blocking.
    if (cormdRes.path !== "" && (Boolean(cfg.cormdBin) || lockHeld || isProject)) {
      let runnerPromise = runnerCache.get(socketPath);
      if (!runnerPromise) {
        runnerPromise = (async () => {
          try {
            await ensureDaemon({
              cormdBin: cormdRes.path,
              filespec: fspec,
              socketPath,
              axisPath: axes,
              embedEnv: eEnv,
              cwd: mDir,
            });
            return new DaemonCormRunner(socketPath, fallbackRunner);
          } catch {
            return new DaemonCormRunner(socketPath, fallbackRunner);
          }
        })();
        runnerCache.set(socketPath, runnerPromise);
      }
      const fastReady = await Promise.race([
        runnerPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
      ]);
      runner = fastReady ?? new DaemonCormRunner(socketPath, fallbackRunner);
    } else if (hasNativeAddon) {
      runner = localRunner;
    } else {
      runner = new DaemonCormRunner(socketPath, fallbackRunner);
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