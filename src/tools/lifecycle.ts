import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { EnvSource } from "./index.ts";
import { axisPath, memDir, exportDetail, sepalConfigured } from "./index.ts";
import { filespecFor, buildGetInvocation, buildStoreInvocation, embedEnv } from "../qmap.ts";
import { decodePayload, encodePayload } from "../payload.ts";
import type { LifecycleState, LifecycleTransition } from "../types.ts";

const PERMITTED_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  observed: ["hypothesized", "tested", "supported", "contradicted", "superseded"],
  hypothesized: ["tested", "supported", "contradicted", "superseded"],
  tested: ["supported", "contradicted", "superseded"],
  supported: ["tested", "contradicted", "superseded"],
  contradicted: ["hypothesized", "tested", "supported", "superseded"],
  superseded: [], // terminal state
};

const LIFECYCLE_PARAMS = {
  type: "object",
  properties: {
    ref: { type: "number", description: "Target memory numeric ref." },
    lifecycle: {
      type: "string",
      enum: ["observed", "hypothesized", "tested", "supported", "contradicted", "superseded"],
      description: "New lifecycle state.",
    },
    reason: { type: "string", description: "Rationale for state transition." },
    evidenceRef: { type: "number", description: "Supporting or contradicting evidence ref." },
  },
  required: ["ref", "lifecycle"],
  additionalProperties: false,
};

function validateTransition(
  from: LifecycleState,
  to: LifecycleState,
  reason?: string,
  evRef?: number,
  existingEvidence?: number[],
): string | null {
  if (from === to) return null;
  const allowed = PERMITTED_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return `invalid transition from ${from} to ${to}`;
  }
  if ((to === "contradicted" || to === "superseded") && !reason && evRef === undefined) {
    return `transition to ${to} requires a reason or evidenceRef`;
  }
  if (to === "supported" && evRef === undefined && (!existingEvidence || existingEvidence.length === 0)) {
    return `transition to supported requires supporting evidenceRef or existing evidence`;
  }
  return null;
}

export async function validateEvidenceRef(
  env: import("./index.ts").ToolEnv,
  ref: number,
): Promise<{ valid: boolean; reason?: string }> {
  if (!Number.isInteger(ref) || ref <= 0) {
    return { valid: false, reason: `invalid evidence reference ${ref}` };
  }
  if (env.cfg.qmapBin === "") {
    return { valid: false, reason: "qmap binary unavailable" };
  }
  const embed = sepalConfigured(env.cfg);
  const cwd = memDir(env);
  const fspec = filespecFor(cwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);

  const res = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, ref, axes, cwd, eEnv));
  if (res.code !== 0 || !res.stdout.trim()) {
    return { valid: false, reason: `evidence reference ${ref} not found in database` };
  }
  const { envelope } = decodePayload(res.stdout.trim());
  if (envelope.lifecycle === "contradicted" || envelope.lifecycle === "superseded") {
    return { valid: false, reason: `evidence reference ${ref} is ${envelope.lifecycle} and cannot support new conclusions` };
  }
  return { valid: true };
}

async function validateEvidenceTargets(
  env: import("./index.ts").ToolEnv,
  evidenceRef?: number,
  existingEvidence?: number[],
): Promise<string | null> {
  if (evidenceRef !== undefined) {
    const evCheck = await validateEvidenceRef(env, evidenceRef);
    if (!evCheck.valid) return evCheck.reason ?? "invalid evidence";
  } else if (Array.isArray(existingEvidence) && existingEvidence.length > 0) {
    for (const ev of existingEvidence) {
      const evCheck = await validateEvidenceRef(env, ev);
      if (!evCheck.valid) return evCheck.reason ?? "invalid evidence";
    }
  }
  return null;
}

export async function executeLifecycle(
  envSource: EnvSource,
  params: Record<string, unknown>,
  ctx: PiCtx,
): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }> {
  try {
    const env = await envSource(ctx);
    const ref = Number(params["ref"]);
    const nextState = params["lifecycle"] as LifecycleState;
    const reason = typeof params["reason"] === "string" ? params["reason"].trim() : undefined;
    const evidenceRef = typeof params["evidenceRef"] === "number" ? params["evidenceRef"] : undefined;

    if (!Number.isInteger(ref) || ref < 0) {
      return { content: [{ type: "text", text: "mm lifecycle: invalid ref" }], details: { error: "invalid-ref" } };
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
      return { content: [{ type: "text", text: `mm lifecycle: ref ${ref} not found` }], details: { error: "not-found", ref } };
    }

    const { date, envelope } = decodePayload(getRes.stdout.trim());
    const fromState = envelope.lifecycle;
    const err = validateTransition(fromState, nextState, reason, evidenceRef, envelope.evidence);
    if (err) {
      return { content: [{ type: "text", text: `mm lifecycle error: ${err}` }], details: { error: err, ref } };
    }

    if (nextState === "supported") {
      const targetErr = await validateEvidenceTargets(env, evidenceRef, envelope.evidence);
      if (targetErr) {
        return { content: [{ type: "text", text: `mm lifecycle error: ${targetErr}` }], details: { error: targetErr, ref } };
      }
    }

    if (evidenceRef !== undefined) {
      envelope.evidence = envelope.evidence ?? [];
      if (!envelope.evidence.includes(evidenceRef)) envelope.evidence.push(evidenceRef);
    }

    const transition: LifecycleTransition = {
      from: fromState,
      to: nextState,
      timestamp: env.nowProvider().toISOString(),
      reason,
      evidenceRef,
    };

    envelope.lifecycle = nextState;
    envelope.history = envelope.history ?? [];
    envelope.history.push(transition);

    const updatedPayload = encodePayload(date, envelope);
    const storeRes = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, ref, updatedPayload, axes, cwd, eEnv));
    if (storeRes.code !== 0) {
      return { content: [{ type: "text", text: `mm lifecycle update failed: ${storeRes.stderr}` }], details: { error: storeRes.stderr, ref } };
    }

    return exportDetail({
      ref,
      previousState: fromState,
      currentState: nextState,
      historyCount: envelope.history.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `mm unavailable: ${msg}` }], details: { error: msg } };
  }
}

export function makeLifecycleTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_lifecycle",
    label: "Update Memory Lifecycle",
    description: "Update the lifecycle state of a memory (observed -> hypothesized -> tested -> supported -> contradicted -> superseded).",
    parameters: LIFECYCLE_PARAMS,
    execute: (_id, params, _sig, _upd, ctx) => executeLifecycle(envSource, params, ctx as PiCtx),
  };
}
