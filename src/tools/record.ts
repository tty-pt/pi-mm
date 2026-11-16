import { activeConversationTurn, extractSessionId, type PiCtx, type PiToolSpec } from "../hooks/events.ts";
import { isNaturalAnchor, isStandingDirective } from "../hooks/reinforcement.ts";
import type { EnvSource } from "./index.ts";
import { executeStore } from "./store.ts";
import { validateEvidenceRef } from "./lifecycle.ts";
import { hasAttestedPassingVerification } from "../hooks/verification_ledger.ts";
import type { EpisodeApproach, EpisodeRecord, MemoryEnvelope, MipmapLevel } from "../types.ts";

const RECORD_PARAMS = {
  type: "object",
  properties: {
    problem: { type: "string", description: "Problem, task, rule, decision, or fact description." },
    approaches: {
      type: "array",
      description: "List of attempted approaches, outcomes, and reasons (required for task episodes; optional when recording standing rules, decisions, or anchored facts).",
      items: {
        type: "object",
        properties: {
          approach: { type: "string", description: "Description of what was tried." },
          outcome: { type: "string", enum: ["worked", "failed", "abandoned"] },
          reason: { type: "string", description: "Why this approach succeeded, failed, or was abandoned." },
        },
        required: ["approach", "outcome", "reason"],
      },
    },
    findings: { type: "array", items: { type: "string" }, description: "Key observations, error messages, or causal findings." },
    diffs: { type: "array", items: { type: "string" }, description: "Code diffs, commands, or configuration changes made." },
    verification: {
      type: "object",
      description: "Verification evidence: tests passed or verified diffs.",
      properties: {
        testsPassed: { type: "array", items: { type: "string" }, description: "Test names or commands that verified the fix." },
        verifiedDiff: { type: "boolean", description: "Whether the diff was verified in execution." },
      },
    },
    outcome: { type: "string", enum: ["success", "failure", "inconclusive"], description: "Overall outcome of the task." },
    project: { type: "string", description: "Project name (e.g. site)." },
    subsystem: { type: "string", description: "Subsystem or component name." },
    evidence: { type: "array", items: { type: "number" }, description: "Refs of supporting memories or investigations." },
    supersedes: { type: "number", description: "Ref of an older memory that this record supersedes." },
    tags: { type: "array", items: { type: "string" }, description: "Categorization tags." },
    constraints: { type: "array", items: { type: "string" }, description: "Explicit constraints or prohibitions established during this episode." },
    standing: { type: "boolean", description: "Whether this record expresses a standing operational directive or invariant." },
    anchor: { type: "boolean", description: "Whether this record is a permanent anchored fact or preference to recall automatically." },
    type: { type: "string", enum: ["episode", "invariant", "decision", "note"], description: "Memory record type (defaults to invariant if standing=true, else episode)." },
  },
  required: ["problem"],
  additionalProperties: false,
};

async function resolveRecordLifecycle(
  envSource: EnvSource,
  ctx: PiCtx,
  problem: string,
  worked?: EpisodeApproach,
  evidenceList: number[] = [],
  reportedTests?: string[],
): Promise<{ lifecycle: import("../types.ts").LifecycleState; summary: string; error?: string }> {
  if (evidenceList.length > 0 && worked) {
    const env = await envSource(ctx);
    for (const evRef of evidenceList) {
      const evCheck = await validateEvidenceRef(env, evRef);
      if (!evCheck.valid) return { lifecycle: "observed", summary: "", error: evCheck.reason };
    }
    return { lifecycle: "supported", summary: `Episode: ${problem} — verified: ${worked.approach}` };
  }
  if (worked) {
    const sessionId = extractSessionId(ctx);
    const attested = hasAttestedPassingVerification(sessionId, reportedTests);
    const label = attested ? "execution-attested ✓" : "model-reported tests";
    const note = reportedTests && reportedTests.length > 0 ? ` (${label}: ${reportedTests.join(", ")})` : "";
    return { lifecycle: "tested", summary: `Episode: ${problem} — tested: ${worked.approach}${note}` };
  }
  return { lifecycle: "observed", summary: `Episode: ${problem}` };
}

async function executeRecord(
  envSource: EnvSource,
  params: Record<string, unknown>,
  ctx: PiCtx,
) {
  const problem = typeof params["problem"] === "string" ? params["problem"].trim() : "";
  if (!problem) {
    return { content: [{ type: "text", text: "mm record: missing problem description" }], details: { error: "missing-problem" } };
  }

  const rawApproaches = Array.isArray(params["approaches"]) ? (params["approaches"] as EpisodeApproach[]) : [];
  const explicitType = typeof params["type"] === "string" ? (params["type"] as MemoryEnvelope["type"]) : undefined;
  const isStanding = typeof params["standing"] === "boolean"
    ? params["standing"]
    : (explicitType === "invariant" ? true : undefined);
  const isAnchor = Boolean(
    params["anchor"] ||
    isStanding ||
    explicitType === "decision" ||
    explicitType === "note" ||
    isNaturalAnchor(problem) ||
    isStandingDirective(problem),
  );
  const allowsNoApproaches = Boolean(
    isStanding ||
    params["anchor"] === true ||
    explicitType === "invariant" ||
    explicitType === "decision" ||
    explicitType === "note",
  );

  if (rawApproaches.length === 0 && !allowsNoApproaches) {
    return { content: [{ type: "text", text: "mm record: at least one approach is required" }], details: { error: "missing-approaches" } };
  }

  const worked = rawApproaches.find((a) => a.outcome === "worked");
  const overallOutcome = (typeof params["outcome"] === "string" ? params["outcome"] : (worked || allowsNoApproaches ? "success" : "failure"));

  const verification = params["verification"] as { testsPassed?: string[]; verifiedDiff?: boolean } | undefined;
  const reportedTests = verification?.testsPassed ?? (Array.isArray(params["testsPassed"]) ? (params["testsPassed"] as string[]) : undefined);
  const evidenceList = Array.isArray(params["evidence"]) ? (params["evidence"] as number[]) : [];

  let lifecycle: import("../types.ts").LifecycleState = "supported";
  let summary = problem;

  if (rawApproaches.length > 0) {
    const resolved = await resolveRecordLifecycle(
      envSource, ctx, problem, worked, evidenceList, reportedTests,
    );
    if (resolved.error) {
      return { content: [{ type: "text", text: `mm record error: invalid evidence reference: ${resolved.error}` }], details: { error: resolved.error } };
    }
    lifecycle = resolved.lifecycle;
    summary = resolved.summary;
  } else if (evidenceList.length > 0) {
    const env = await envSource(ctx);
    for (const evRef of evidenceList) {
      const evCheck = await validateEvidenceRef(env, evRef);
      if (!evCheck.valid) {
        return { content: [{ type: "text", text: `mm record error: invalid evidence reference: ${evCheck.reason}` }], details: { error: evCheck.reason } };
      }
    }
  }

  const findings = Array.isArray(params["findings"])
    ? (params["findings"] as string[])
    : (rawApproaches.length === 0 ? [problem] : undefined);

  const episode: EpisodeRecord = {
    problem,
    request: problem,
    approaches: rawApproaches.length > 0 ? rawApproaches : undefined,
    findings,
    diffs: Array.isArray(params["diffs"]) ? (params["diffs"] as string[]) : undefined,
    constraints: Array.isArray(params["constraints"]) ? (params["constraints"] as string[]) : undefined,
    outcome: overallOutcome,
  };

  const context = (params["project"] || params["subsystem"]) ? {
    project: typeof params["project"] === "string" ? params["project"].trim() : undefined,
    subsystem: typeof params["subsystem"] === "string" ? params["subsystem"].trim() : undefined,
  } : undefined;

  const targetLevel: MipmapLevel = isStanding
    ? "L2"
    : (rawApproaches.length === 0 ? "L1" : "L0");
  const targetType: MemoryEnvelope["type"] = isStanding
    ? "invariant"
    : (explicitType ?? (rawApproaches.length === 0 ? "note" : "episode"));
  const targetLifecycle: import("../types.ts").LifecycleState = isStanding
    ? "supported"
    : lifecycle;

  const storeRes = await executeStore(envSource, {
    level: targetLevel,
    type: targetType,
    lifecycle: targetLifecycle,
    summary,
    episode,
    context,
    evidence: params["evidence"],
    supersedes: params["supersedes"],
    tags: params["tags"],
    constraints: params["constraints"],
    standing: isStanding,
    anchor: isAnchor || undefined,
  }, ctx);

  const d = storeRes.details as { ref?: number; key?: string } | undefined;
  if (d?.ref) {
    activeConversationTurn.explicitlyRecordedInTurn = true;
    return {
      content: [{ type: "text", text: `Recorded episode at Ref ${d.ref} (${overallOutcome}): ${summary}` }],
      details: { ref: d.ref, summary, outcome: overallOutcome, approachesCount: rawApproaches.length },
    };
  }
  return storeRes;
}

export function makeRecordTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_record",
    label: "Record Structured Experience",
    description: "Record a structured task episode (problem, approaches with reasons, findings, diffs, outcome) or a standing rule / permanent fact (problem + standing:true or anchor:true).",
    parameters: RECORD_PARAMS,
    execute: (_id, params, _sig, _upd, ctx) => executeRecord(envSource, params, ctx as PiCtx),
  };
}
