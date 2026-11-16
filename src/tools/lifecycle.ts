import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import { reinforcementScheduler } from "../hooks/events.ts";
import type { EnvSource, ToolEnv } from "./index.ts";
import { axisPath, memDir, exportDetail, sepalConfigured } from "./index.ts";
import { filespecFor, buildGetInvocation, buildListInvocation, buildStoreInvocation, embedEnv } from "../corm.ts";
import { decodeResult, encodePayload } from "../payload.ts";
import { parseBareRefs } from "../resolve.ts";
import type { LifecycleState, LifecycleTransition } from "../types.ts";
import { updateLoreBindingLifecycle } from "../code/lore_binding.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  const bin = env.cfg.cormBin;
  if (!bin) {
    return { valid: false, reason: "corm binary unavailable" };
  }
  const embed = sepalConfigured(env.cfg);
  const cwd = memDir(env);
  const fspec = filespecFor(cwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);

  const res = await env.runner.run(buildGetInvocation(bin, fspec, ref, axes, cwd, eEnv));
  if (res.code !== 0 || !res.stdout.trim()) {
    return { valid: false, reason: `evidence reference ${ref} not found in database` };
  }
  const { envelope } = decodeResult(res);
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

async function syncBindingAndDirectives(env: ToolEnv, ctx: PiCtx, ref: number, state: LifecycleState): Promise<void> {
  try {
    const codeDir = join(ctx?.cwd || env.cwd, ".pi", "mm", "code");
    updateLoreBindingLifecycle(codeDir, ref, state);
  } catch { /* best effort */ }
  if (state === "contradicted" || state === "superseded" || state === "hypothesized" || state === "observed") {
    if (reinforcementScheduler.unregisterDirective(ref)) {
      try {
        const dirs = reinforcementScheduler.getDirectives();
        await writeFile(join(memDir(env), "standing_directives.json"), JSON.stringify(dirs, null, 2), "utf8").catch(() => {});
      } catch { /* best effort */ }
    }
  }
}

async function propagateTruthMaintenanceCascade(
  env: ToolEnv,
  ctx: PiCtx,
  invalidatedRef: number,
  invalidatedState: "contradicted" | "superseded",
): Promise<number[]> {
  const bin = env.cfg.cormBin;
  if (!bin) return [];
  const embed = sepalConfigured(env.cfg);
  const cwd = memDir(env);
  const fspec = filespecFor(cwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);
  const cascadedRefs: number[] = [];

  const list = await env.runner.run(buildListInvocation(bin, fspec, axes, cwd));
  if (list.code !== 0 || !list.stdout.trim()) return [];
  const candidateRefs = parseBareRefs(list.stdout).filter((r) => r > invalidatedRef).slice(-120);

  for (const depRef of candidateRefs) {
    const getRes = await env.runner.run(buildGetInvocation(bin, fspec, depRef, axes, cwd, eEnv));
    if (getRes.code !== 0 || !getRes.stdout.trim()) continue;
    const { date, envelope } = decodeResult(getRes);
    if (!Array.isArray(envelope.evidence) || !envelope.evidence.includes(invalidatedRef)) continue;
    if (envelope.lifecycle !== "supported" && envelope.lifecycle !== "tested") continue;

    let anyRemainingValid = false;
    for (const ev of envelope.evidence) {
      if (ev === invalidatedRef) continue;
      const check = await validateEvidenceRef(env, ev);
      if (check.valid) { anyRemainingValid = true; break; }
    }
    if (anyRemainingValid && invalidatedState === "superseded") continue;

    const prevState = envelope.lifecycle;
    envelope.lifecycle = "hypothesized";
    envelope.history = envelope.history ?? [];
    envelope.history.push({
      from: prevState,
      to: "hypothesized",
      timestamp: env.nowProvider().toISOString(),
      reason: `Auto-downgraded by Truth Maintenance: supporting evidence Ref ${invalidatedRef} became ${invalidatedState}`,
      evidenceRef: invalidatedRef,
    });
    const storeRes = await env.runner.run(buildStoreInvocation(bin, fspec, depRef, encodePayload(date, envelope), axes, cwd, eEnv));
    if (storeRes.code === 0) {
      cascadedRefs.push(depRef);
      await syncBindingAndDirectives(env, ctx, depRef, "hypothesized");
    }
  }
  return cascadedRefs;
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
    const bin = env.cfg.cormBin;
    if (!bin) {
      return { content: [{ type: "text", text: "mm unavailable: corm binary not found" }], details: { error: "no-corm" } };
    }

    const cwd = memDir(env);
    const fspec = filespecFor(cwd, sepalConfigured(env.cfg));
    const axes = axisPath(env);
    const eEnv = embedEnv(env.cfg);

    const getRes = await env.runner.run(buildGetInvocation(bin, fspec, ref, axes, cwd, eEnv));
    if (getRes.code !== 0 || !getRes.stdout.trim()) {
      return { content: [{ type: "text", text: `mm lifecycle: ref ${ref} not found` }], details: { error: "not-found", ref } };
    }

    const { date, envelope } = decodeResult(getRes);
    const fromState = envelope.lifecycle;
    const err = validateTransition(fromState, nextState, reason, evidenceRef, envelope.evidence);
    if (err) return { content: [{ type: "text", text: `mm lifecycle error: ${err}` }], details: { error: err, ref } };

    if (nextState === "supported") {
      const targetErr = await validateEvidenceTargets(env, evidenceRef, envelope.evidence);
      if (targetErr) return { content: [{ type: "text", text: `mm lifecycle error: ${targetErr}` }], details: { error: targetErr, ref } };
    }

    if (evidenceRef !== undefined) {
      envelope.evidence = envelope.evidence ?? [];
      if (!envelope.evidence.includes(evidenceRef)) envelope.evidence.push(evidenceRef);
    }

    envelope.lifecycle = nextState;
    envelope.history = envelope.history ?? [];
    envelope.history.push({ from: fromState, to: nextState, timestamp: env.nowProvider().toISOString(), reason, evidenceRef });

    const storeRes = await env.runner.run(buildStoreInvocation(bin, fspec, ref, encodePayload(date, envelope), axes, cwd, eEnv));
    if (storeRes.code !== 0) {
      return { content: [{ type: "text", text: `mm lifecycle update failed: ${storeRes.stderr}` }], details: { error: storeRes.stderr, ref } };
    }

    await syncBindingAndDirectives(env, ctx, ref, nextState);
    const cascadedRefs = (nextState === "contradicted" || nextState === "superseded")
      ? await propagateTruthMaintenanceCascade(env, ctx, ref, nextState)
      : [];

    return exportDetail({
      ref, previousState: fromState, currentState: nextState, historyCount: envelope.history.length,
      ...(cascadedRefs.length > 0 ? { cascadedRefs } : {}),
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
