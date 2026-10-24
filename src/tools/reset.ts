import type { PiCtx, PiToolSpec } from "../hooks/events";
import type { EnvSource } from "./index";
import { axisPath, memDir, exportDetail, sepalConfigured } from "./index";
import { filespecFor, buildListInvocation, buildForgetInvocation, embedEnv } from "../corm";
import { parseBareRefs } from "../resolve";

export function makeResetTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_reset",
    label: "Reset Memory",
    description: "Forget every memory: enumerate all refs and delete each on the primary and every roster axis. Idempotent (re-running is a no-op).",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      try {
        const env = await envSource(ctx as PiCtx);
        const bin = env.cfg.cormBin;
        if (!bin) return { content: [{ type: "text", text: "mm unavailable: corm binary not found" }], details: { error: "no-corm" } };

        const axes = axisPath(env);
        const cwd = memDir(env);
        const embed = sepalConfigured(env.cfg);
        const fspec = filespecFor(cwd, embed);
        const list = await env.runner.run(buildListInvocation(bin, fspec, axes, cwd, embedEnv(env.cfg)));
        const refs = parseBareRefs(list.stdout);
        let forgotten = 0;
        for (const ref of refs) {
          const result = await env.runner.run(buildForgetInvocation(bin, fspec, ref, axes, cwd, embedEnv(env.cfg)));
          if (result.code === 0) forgotten += 1;
        }
        return exportDetail({ refsForgotten: forgotten });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `mm unavailable: ${msg}` }], details: { error: msg } };
      }
    },
  };
}