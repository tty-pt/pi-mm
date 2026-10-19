import type { PiCtx, PiToolSpec } from "../hooks/events";
import type { EnvSource } from "./index";
import { axisPath, memDir, exportDetail, sepalConfigured } from "./index";
import { filespecFor, buildForgetInvocation, embedEnv } from "../qmap";
import { isNumericRef } from "../resolve";
import { scanTopRef } from "./scan";

export function makeForgetTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_forget",
    label: "Forget Memory",
    description: "Delete a memory by key (numeric ref or topic resolved by a top-1 scan), on the primary and every roster axis. Idempotent.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Numeric ref or a topic to resolve." },
      },
      required: ["key"],
      additionalProperties: false,
    },
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const env = await envSource(ctx as PiCtx);
        const key = typeof params["key"] === "string" ? params["key"].trim() : "";
        if (key === "") return { content: [{ type: "text", text: "mm forget: empty key (degradation: soft)" }], details: { error: "empty-key" } };
        if (env.cfg.qmapBin === "") return { content: [{ type: "text", text: "mm unavailable: qmap binary not found" }], details: { error: "no-qmap" } };

        const ref = isNumericRef(key)
          ? Number(key)
          : await scanTopRef(envSource, ctx as PiCtx, key);
        if (ref === null) return { content: [{ type: "text", text: `mm forget: no memory matches ${key}` }], details: { error: "no-match" } };

        const embed = sepalConfigured(env.cfg);
        const result = await env.runner.run(buildForgetInvocation(env.cfg.qmapBin, filespecFor(memDir(env), embed), ref, axisPath(env), memDir(env), embedEnv(env.cfg)));
        if (result.code !== 0) {
          return { content: [{ type: "text", text: `mm forget: ${ref} reported (exit ${result.code}): ${result.stderr || result.stdout}` }], details: { ref, removed: true, error: result.stderr || result.stdout } };
        }
        return exportDetail({ ref, removed: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `mm unavailable: ${msg}` }], details: { error: msg } };
      }
    },
  };
}