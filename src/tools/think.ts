import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { EnvSource } from "./index.ts";
import { axisPath, memDir, exportDetail, sepalConfigured } from "./index.ts";
import { filespecFor, buildGetInvocation, embedEnv } from "../qmap.ts";
import { isNumericRef } from "../resolve.ts";
import { scanTopRef } from "./scan.ts";
import { decodePayload, splitRawPayload } from "../payload.ts";

export { splitRawPayload as splitPayload };

export function makeThinkTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_think",
    label: "Think Memory",
    description: "Recall the stored payload for a key (numeric ref or topic resolved by a top-1 scan). extract ∈ date|text|whole|episode|evidence|context|lifecycle (default whole).",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Numeric ref or a topic to resolve." },
        extract: { type: "string", description: "date | text | whole | episode | evidence | context | lifecycle (default whole)." },
      },
      required: ["key"],
      additionalProperties: false,
    },
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const env = await envSource(ctx as PiCtx);
        const key = typeof params["key"] === "string" ? params["key"].trim() : "";
        if (key === "") return { content: [{ type: "text", text: "mm think: empty key (degradation: soft)" }], details: { error: "empty-key" } };
        if (env.cfg.qmapBin === "") return { content: [{ type: "text", text: "mm unavailable: qmap binary not found" }], details: { error: "no-qmap" } };

        const ref = isNumericRef(key)
          ? Number(key)
          : await scanTopRef(envSource, ctx as PiCtx, key);
        if (ref === null) return { content: [{ type: "text", text: `mm think: no memory matches ${key}` }], details: { error: "no-match" } };

        const embed = sepalConfigured(env.cfg);
        const result = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, filespecFor(memDir(env), embed), ref, axisPath(env), memDir(env), embedEnv(env.cfg)));
        const payload = result.code === 0 ? result.stdout.trim() : "";
        if (payload === "") {
          return { content: [{ type: "text", text: `mm think: ref ${ref} returned nothing` }], details: { ref, error: "empty-get" } };
        }

        const { date, envelope } = decodePayload(payload);
        const extract = typeof params["extract"] === "string" ? params["extract"] : "whole";
        const detail: Record<string, unknown> = { ref, date };

        if (extract === "date") {
          detail["date"] = date;
        } else if (extract === "text" || extract === "summary") {
          detail["text"] = envelope.summary;
          detail["summary"] = envelope.summary;
        } else if (extract === "episode") {
          detail["episode"] = envelope.episode;
        } else if (extract === "evidence") {
          detail["evidence"] = envelope.evidence ?? [];
        } else if (extract === "context") {
          detail["context"] = envelope.context;
        } else if (extract === "lifecycle") {
          detail["lifecycle"] = envelope.lifecycle;
        } else {
          detail["date"] = date;
          detail["text"] = envelope.summary;
          detail["payload"] = payload;
          detail["level"] = envelope.level;
          detail["lifecycle"] = envelope.lifecycle;
          detail["summary"] = envelope.summary;
          detail["envelope"] = envelope;
        }

        return exportDetail(detail);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `mm unavailable: ${msg}` }], details: { error: msg } };
      }
    },
  };
}
