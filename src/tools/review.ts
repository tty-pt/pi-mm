import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { EnvSource, ToolEnv } from "./index.ts";
import { axisPath, memDir, sepalConfigured } from "./index.ts";
import { filespecFor, embedEnv } from "../qmap.ts";
import { fetchEnvelope, traverseDown, renderTree } from "./traverse.ts";
import { executeLifecycle } from "./lifecycle.ts";

const REVIEW_PARAMS = {
  type: "object",
  properties: {
    ref: { type: "number", description: "Reference number of the memory to review." },
    action: {
      type: "string",
      enum: ["inspect", "update_lifecycle"],
      description: "Action to take: 'inspect' to view evidence hierarchy, or 'update_lifecycle' to transition state.",
    },
    lifecycle: {
      type: "string",
      enum: ["tested", "supported", "contradicted", "superseded"],
      description: "Target lifecycle state (required if action is 'update_lifecycle').",
    },
    reason: { type: "string", description: "Rationale for review decision (required for contradicted/superseded)." },
    evidenceRef: { type: "number", description: "Supporting or disproving evidence memory reference number." },
  },
  required: ["ref", "action"],
  additionalProperties: false,
};

async function inspectMemory(
  env: ToolEnv,
  ref: number,
) {
  const embed = sepalConfigured(env.cfg);
  const cwd = memDir(env);
  const fspec = filespecFor(cwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);

  const item = await fetchEnvelope(env, fspec, axes, cwd, eEnv, ref);
  if (!item) {
    return {
      content: [{ type: "text", text: `Memory Ref ${ref} not found.` }],
      details: { error: "not-found", ref },
    };
  }

  const { envelope, date } = item;
  const tree = await traverseDown(env, fspec, axes, cwd, eEnv, ref, 0, 2, new Set());
  const treeText = tree ? renderTree(tree).trim() : `[${envelope.level}] Ref ${ref}: ${envelope.summary}`;

  const lines = [
    `=== Review Inspection for Ref ${ref} ===`,
    `Level: ${envelope.level} | Lifecycle: ${envelope.lifecycle} | Type: ${envelope.type}`,
    `Date: ${date} | Summary: ${envelope.summary}`,
  ];

  if (envelope.context?.project || envelope.context?.subsystem) {
    lines.push(`Scope: ${envelope.context.project ?? ""}/${envelope.context.subsystem ?? ""}`);
  }

  if (envelope.episode?.approaches && envelope.episode.approaches.length > 0) {
    lines.push(`\nAttempted Approaches:`);
    for (const a of envelope.episode.approaches) {
      lines.push(`- [${a.outcome.toUpperCase()}] ${a.approach}: ${a.reason}`);
    }
  }

  if (envelope.episode?.diffs && envelope.episode.diffs.length > 0) {
    lines.push(`\nRecorded Diffs/Changes:\n${envelope.episode.diffs.join("\n")}`);
  }

  lines.push(`\nEvidence Hierarchy:\n${treeText}`);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { ref, envelope, date, tree },
  };
}

async function executeReview(
  envSource: EnvSource,
  params: Record<string, unknown>,
  ctx: PiCtx,
) {
  try {
    const env = await envSource(ctx);
    const ref = Number(params["ref"]);
    if (!Number.isInteger(ref) || ref < 0) {
      return { content: [{ type: "text", text: "mm review: invalid ref" }], details: { error: "invalid-ref" } };
    }

    const action = params["action"] as string;
    if (action === "inspect") {
      return await inspectMemory(env, ref);
    }

    if (action === "update_lifecycle") {
      const nextState = params["lifecycle"] as string | undefined;
      if (!nextState) {
        return { content: [{ type: "text", text: "mm review: lifecycle is required for update_lifecycle action" }], details: { error: "missing-lifecycle" } };
      }
      return await executeLifecycle(envSource, {
        ref,
        lifecycle: nextState,
        reason: params["reason"],
        evidenceRef: params["evidenceRef"],
      }, ctx);
    }

    return { content: [{ type: "text", text: `mm review: unknown action "${action}"` }], details: { error: "unknown-action" } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `mm review error: ${msg}` }], details: { error: msg } };
  }
}

export function makeReviewTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_review",
    label: "Review and Validate Memory",
    description: "Inspect memory evidence hierarchy, attempted approaches, and diffs, or safely transition lifecycle state with validation.",
    parameters: REVIEW_PARAMS,
    execute: (_id, params, _sig, _upd, ctx) => executeReview(envSource, params, ctx as PiCtx),
  };
}
