import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { EnvSource } from "./index.ts";
import { axisPath, memDir, exportDetail, sepalConfigured } from "./index.ts";
import { filespecFor, buildGetInvocation, buildStoreInvocation, embedEnv } from "../qmap.ts";
import { decodePayload, encodePayload } from "../payload.ts";
import type { UtilityFeedback } from "../types.ts";

export function makeFeedbackTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_feedback",
    label: "Record Retrieval Utility",
    description: "Record whether a recalled memory was useful, irrelevant, or obsolete to inform future retrieval weighting.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "number", description: "Target memory numeric ref." },
        utility: {
          type: "string",
          enum: ["useful", "irrelevant", "obsolete"],
          description: "Outcome of using the memory in the task.",
        },
        note: { type: "string", description: "Optional explanation." },
      },
      required: ["ref", "utility"],
      additionalProperties: false,
    },
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const env = await envSource(ctx as PiCtx);
        const ref = Number(params["ref"]);
        const outcome = params["utility"] as "useful" | "irrelevant" | "obsolete";
        const note = typeof params["note"] === "string" ? params["note"].trim() : undefined;

        if (!Number.isInteger(ref) || ref < 0) {
          return { content: [{ type: "text", text: "mm feedback: invalid ref" }], details: { error: "invalid-ref" } };
        }
        if (env.cfg.qmapBin === "") {
          return { content: [{ type: "text", text: "mm unavailable: qmap binary not found" }], details: { error: "no-qmap" } };
        }

        const embed = sepalConfigured(env.cfg);
        const cwd = memDir(env);
        const fspec = filespecFor(cwd, embed);
        const axes = axisPath(env);
        const eEnv = embedEnv(env.cfg);

        const getRes = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, ref, axes, cwd, eEnv));
        if (getRes.code !== 0 || !getRes.stdout.trim()) {
          return { content: [{ type: "text", text: `mm feedback: ref ${ref} not found` }], details: { error: "not-found", ref } };
        }

        const { date, envelope } = decodePayload(getRes.stdout.trim());
        const util: UtilityFeedback = envelope.utility ?? {
          usedCount: 0,
          irrelevantCount: 0,
          obsoleteCount: 0,
        };

        if (outcome === "useful") util.usedCount += 1;
        else if (outcome === "irrelevant") util.irrelevantCount += 1;
        else if (outcome === "obsolete") util.obsoleteCount += 1;

        util.lastOutcome = outcome;
        util.lastNote = note;
        envelope.utility = util;

        const updatedPayload = encodePayload(date, envelope);
        const storeRes = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, ref, updatedPayload, axes, cwd, eEnv));
        if (storeRes.code !== 0) {
          return { content: [{ type: "text", text: `mm feedback update failed: ${storeRes.stderr}` }], details: { error: storeRes.stderr, ref } };
        }

        return exportDetail({
          ref,
          utility: util,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `mm unavailable: ${msg}` }], details: { error: msg } };
      }
    },
  };
}
