import { activeConversationTurn, type PiCtx, type PiToolSpec } from "../hooks/events.ts";
import type { EnvSource, ToolEnv } from "./index.ts";
import { axisPath, memDir, exportDetail, sepalConfigured } from "./index.ts";
import { synthConfigured } from "../config.ts";
import { filespecFor, buildGetInvocation, buildStoreInvocation, buildListInvocation, embedEnv } from "../qmap.ts";
import { decodePayload, encodePayload } from "../payload.ts";
import { parseBareRefs, nextRef } from "../resolve.ts";
import { withLock } from "../lock.ts";
import { debugLog } from "../debug.ts";
import type { MipmapLevel, MemoryEnvelope, MemoryContext, LifecycleState } from "../types.ts";
import {
  readConsolidationJournal,
  writeConsolidationJournal,
  recordNewL1InJournal,
  recordNewL2InJournal,
  pruneProcessedL1InJournal,
  recordScopeOutcomeInJournal,
  recordL3OutcomeInJournal,
  recordInterruptedSuccessorInJournal,
  clearInterruptedSuccessorInJournal,
  recordRunStatsInJournal,
  checkConsolidationEligibility,
  pruneProcessedL0InJournal,
  recordActiveL1ForRunId,
  recordPendingL1Transition,
  clearPendingL1Transition,
  type ConsolidationJournal,
} from "./consolidation_journal.ts";
import { synthesizeL2ScopeKnowledge, synthesizeL3GeneralPrinciple } from "../synth/adapter.ts";
import type { L2SynthesisInput, L3SynthesisInput } from "../synth/types.ts";
import { allocateNextRef, advanceRefSeq, isRefSeqInitialized } from "./ref_allocator.ts";

const LEVEL_RANK: Record<MipmapLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

const CONSOLIDATE_PARAMS = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["manual", "auto", "deferred", "status"], description: "Consolidation mode ('auto', 'deferred', 'status', or 'manual'). Default manual." },
    targetLevel: { type: "string", enum: ["L1", "L2", "L3"], description: "Target mipmap level (L1, L2, L3)." },
    force: { type: "boolean", description: "Force consolidation even if thresholds are not yet met." },
    scope: { type: "string", description: "Specific scope to consolidate." },
    sourceRefs: { type: "array", items: { type: "number" }, description: "Supporting evidence refs for manual consolidation." },
    summary: { type: "string", description: "Consolidated statement." },
    problem: { type: "string", description: "Problem or investigation focus (L1)." },
    context: {
      type: "object",
      properties: { project: { type: "string" }, subsystem: { type: "string" }, module: { type: "string" }, subject: { type: "string" }, path: { type: "string" } },
    },
    tags: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

interface StoredItem {
  ref: number;
  date: string;
  envelope: MemoryEnvelope;
}

export interface ScopeConsolidationResult {
  scope: string;
  status: "consolidated" | "idempotent" | "insufficient_evidence" | "conflicting" | "unavailable" | "failed" | "validation_error" | "deferred";
  createdRef?: number;
  reason?: string;
  representedL1Refs?: number[];
}

export interface OperationStats {
  listCalls: number;
  getCalls: number;
  storeCalls: number;
  synthCalls: number;
  totalWorkUnits: number;
}

export class WorkBudgetTracker {
  limit: number;
  listCalls = 0;
  getCalls = 0;
  storeCalls = 0;
  synthCalls = 0;
  reservedUnits = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  get totalWorkUnits(): number {
    return this.listCalls + this.getCalls + this.storeCalls + this.synthCalls;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.totalWorkUnits);
  }

  get available(): number {
    return Math.max(0, this.limit - this.totalWorkUnits - this.reservedUnits);
  }

  hasBudget(units = 1): boolean {
    return this.totalWorkUnits + units <= this.limit;
  }

  reserve(units: number): boolean {
    if (this.totalWorkUnits + this.reservedUnits + units <= this.limit) {
      this.reservedUnits += units;
      return true;
    }
    return false;
  }

  unreserve(units: number): void {
    this.reservedUnits = Math.max(0, this.reservedUnits - units);
  }

  charge(type: "list" | "get" | "store" | "synth", count = 1): void {
    if (type === "list") this.listCalls += count;
    else if (type === "get") this.getCalls += count;
    else if (type === "store") this.storeCalls += count;
    else if (type === "synth") this.synthCalls += count;

    if (this.reservedUnits > 0) {
      this.reservedUnits = Math.max(0, this.reservedUnits - count);
    }
  }

  toStats(): OperationStats {
    return {
      listCalls: this.listCalls,
      getCalls: this.getCalls,
      storeCalls: this.storeCalls,
      synthCalls: this.synthCalls,
      totalWorkUnits: this.totalWorkUnits,
    };
  }
}

async function checkIdempotency(
  env: ToolEnv, fspec: string, axes: string, cwd: string, eEnv: Record<string, string>,
  candidateRefs: number[], targetLevel: MipmapLevel, sourceRefs: number[], summary: string,
  budget?: WorkBudgetTracker,
): Promise<number | null> {
  const sorted = [...sourceRefs].sort((a, b) => a - b);
  const batchLimit = env.cfg.consolidateBatchLimit ?? 20;
  const limit = Math.min(candidateRefs.length, batchLimit);
  const slice = candidateRefs.slice(-limit);
  for (const r of slice) {
    if (budget && !budget.hasBudget(1)) break;
    const res = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, r, axes, cwd, eEnv));
    if (budget) budget.charge("get", 1);
    if (res.code === 0 && res.stdout.trim()) {
      const { envelope } = decodePayload(res.stdout.trim());
      // Disregard superseded and contradicted abstractions during targeted idempotency checking
      if (envelope.lifecycle === "superseded" || envelope.lifecycle === "contradicted") continue;
      if (envelope.level === targetLevel && envelope.summary === summary) {
        const ev = [...(envelope.evidence || [])].sort((a, b) => a - b);
        if (ev.length === sorted.length && ev.every((v, i) => v === sorted[i])) return r;
      }
    }
  }
  return null;
}

async function validateSources(
  env: ToolEnv, fspec: string, axes: string, cwd: string, eEnv: Record<string, string>,
  sourceRefs: number[], targetLevel: MipmapLevel, targetLifecycle?: LifecycleState,
  budget?: WorkBudgetTracker,
): Promise<{ valid: boolean; error?: string; missing: number[] }> {
  const missing: number[] = [];
  const targetRank = LEVEL_RANK[targetLevel];
  for (const r of sourceRefs) {
    if (budget && !budget.hasBudget(1)) break;
    const res = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, r, axes, cwd, eEnv));
    if (budget) budget.charge("get", 1);
    if (res.code !== 0 || !res.stdout.trim()) {
      missing.push(r);
      continue;
    }
    const { envelope } = decodePayload(res.stdout.trim());
    if ((LEVEL_RANK[envelope.level] ?? 0) >= targetRank) {
      return { valid: false, error: `cannot use ${envelope.level} source (ref ${r}) to create ${targetLevel} abstraction`, missing: [] };
    }
    if ((targetLifecycle === "supported" || !targetLifecycle) && (envelope.lifecycle === "contradicted" || envelope.lifecycle === "superseded")) {
      return { valid: false, error: `cannot promote ${envelope.lifecycle} source (ref ${r}) into supported conclusion`, missing: [] };
    }
  }
  return { valid: missing.length === 0, missing };
}

async function scanAllItems(
  env: ToolEnv, fspec: string, axes: string, cwd: string, eEnv: Record<string, string>,
  budget?: WorkBudgetTracker,
): Promise<StoredItem[]> {
  const list = await env.runner.run(buildListInvocation(env.cfg.qmapBin, fspec, axes, cwd, eEnv));
  if (budget) budget.charge("list", 1);
  const refs = parseBareRefs(list.stdout);
  const items: StoredItem[] = [];
  for (const r of refs) {
    if (budget && !budget.hasBudget(1)) break;
    const res = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, r, axes, cwd, eEnv));
    if (budget) budget.charge("get", 1);
    if (res.code === 0 && res.stdout.trim()) {
      const { date, envelope } = decodePayload(res.stdout.trim());
      items.push({ ref: r, date, envelope });
    }
  }
  return items;
}

async function storeAbs(
  env: ToolEnv, fspec: string, axes: string, cwd: string, eEnv: Record<string, string>,
  envelope: MemoryEnvelope, date: string,
  budget?: WorkBudgetTracker,
): Promise<number | null> {
  const ref = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv, budget);
  const res = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, ref, encodePayload(date, envelope), axes, cwd, eEnv));
  if (budget) budget.charge("store", 1);
  return res.code === 0 ? ref : null;
}

function hasConflictingFindings(investigations: StoredItem[]): boolean {
  let hasAlways = false;
  let hasNever = false;
  for (const inv of investigations) {
    const text = `${inv.envelope.summary} ${inv.envelope.episode?.problem || ""}`.toLowerCase();
    if (text.includes("never") || text.includes("avoid") || text.includes("refute") || text.includes("prohibit")) hasNever = true;
    if (text.includes("always") || text.includes("require") || text.includes("must") || text.includes("enforce")) hasAlways = true;
  }
  return hasAlways && hasNever;
}

async function autoL0ToL1(
  env: ToolEnv, fspec: string, axes: string, cwd: string, eEnv: Record<string, string>,
  items: StoredItem[], cited: Set<number>, date: string,
  budget?: WorkBudgetTracker,
  activeL1Updates?: Record<string, number>,
  journal?: ConsolidationJournal,
): Promise<{ created: number[]; representedL0Refs: number[] }> {
  const batchLimit = env.cfg.consolidateBatchLimit ?? 20;
  const uncited = items.filter((i) => i.envelope.level === "L0" && !cited.has(i.ref)).slice(0, batchLimit);
  const created: number[] = [];
  const representedL0Refs: number[] = [];
  const l1Candidates = items.filter((i) => i.envelope.level === "L1").map((i) => i.ref);

  // Separate technical episodes and session-grouped conversational turns
  const technicalL0: StoredItem[] = [];
  const bySession = new Map<string, StoredItem[]>();
  const unassigned: StoredItem[] = [];

  for (const l0 of uncited) {
    if (l0.envelope.lifecycle === "superseded" || l0.envelope.lifecycle === "contradicted") continue;
    const isToolEpisode = l0.envelope.type === "episode" || (l0.envelope.episode?.approaches && l0.envelope.episode.approaches.length > 0);
    if (isToolEpisode) {
      technicalL0.push(l0);
      continue;
    }
    const sessId = l0.envelope.episode?.sessionId;
    if (sessId) {
      const g = bySession.get(sessId) ?? [];
      g.push(l0);
      bySession.set(sessId, g);
    } else {
      unassigned.push(l0);
    }
  }

  // 1. Process technical investigation episodes: group by explicit runId when available
  const technicalGroups: StoredItem[][] = [];
  const byRunId = new Map<string, StoredItem[]>();
  for (const l0 of technicalL0) {
    const runId = l0.envelope.episode?.runId;
    if (runId) {
      const g = byRunId.get(runId) ?? [];
      g.push(l0);
      byRunId.set(runId, g);
    } else {
      technicalGroups.push([l0]);
    }
  }
  for (const g of byRunId.values()) {
    technicalGroups.push(g);
  }

  for (const group of technicalGroups) {
    if (budget && !budget.hasBudget(1)) break;
    const groupEvidence = group.map((g) => g.ref);
    const runId = group[0].envelope.episode?.runId;

    // If predecessor reconciliation has not yet succeeded for this runId,
    // bypass L0 consolidation and subsumption for this runId so source L0 references
    // remain pending and no duplicate successors are allocated.
    if (runId && journal?.pendingL1Transitions?.[runId]) {
      continue;
    }

    const existingL1 = runId
      ? items.find((i) =>
          i.envelope.level === "L1" &&
          i.envelope.type === "investigation" &&
          i.envelope.episode?.runId === runId &&
          i.envelope.lifecycle !== "superseded" &&
          i.envelope.lifecycle !== "contradicted"
        )
      : undefined;

    // Check subsumption (Advisory 1): if existingL1 already cites all groupEvidence, do nothing
    if (existingL1 && groupEvidence.every((r) => (existingL1.envelope.evidence || []).includes(r))) {
      for (const r of groupEvidence) {
        cited.add(r);
        representedL0Refs.push(r);
      }
      continue;
    }

    const allApproaches = group.flatMap((g) => g.envelope.episode?.approaches || []);
    const worked = allApproaches.find((a) => a.outcome === "worked");
    const isSuccess = Boolean(worked) || group.some((g) => g.envelope.episode?.outcome === "success" || g.envelope.lifecycle === "supported");
    const hasFail = group.some((g) => g.envelope.episode?.outcome === "failure" || (g.envelope.episode?.approaches || []).some((a) => a.outcome === "failed"));
    const allFindings = Array.from(new Set(group.flatMap((g) => g.envelope.episode?.findings ?? [g.envelope.summary])));
    const allDiffs = Array.from(new Set(group.flatMap((g) => g.envelope.episode?.diffs || [])));
    const groupContext = group.find((g) => g.envelope.context)?.envelope.context;

    if (existingL1) {
      // Reconcile into evolving investigation via successor L1
      const mergedEvidence = Array.from(new Set([...(existingL1.envelope.evidence || []), ...groupEvidence]));
      const priorFindings = existingL1.envelope.episode?.findings ?? [existingL1.envelope.summary];
      const mergedFindings = Array.from(new Set([...priorFindings, ...allFindings]));
      const priorApproaches = existingL1.envelope.episode?.approaches ?? [];
      const mergedApproaches = [...priorApproaches, ...allApproaches];
      const priorDiffs = existingL1.envelope.episode?.diffs ?? [];
      const mergedDiffs = Array.from(new Set([...priorDiffs, ...allDiffs]));

      const workedApproach = mergedApproaches.find((a) => a.outcome === "worked");
      const hasFailure = existingL1.envelope.episode?.outcome === "failure" || hasFail;
      const isSuccessMonotonic = Boolean(workedApproach) || existingL1.envelope.episode?.outcome === "success" || isSuccess;
      const outcome = isSuccessMonotonic ? "success" : (hasFailure ? "failure" : "observed");
      const hasSupportedEvidence = existingL1.envelope.lifecycle === "supported" || group.some((g) => g.envelope.lifecycle === "supported");
      const lifecycle: LifecycleState = isSuccessMonotonic
        ? (hasSupportedEvidence ? "supported" : "tested")
        : (existingL1.envelope.lifecycle === "tested" || group.some((g) => g.envelope.lifecycle === "tested") ? "tested" : "observed");

      const baseProblem = existingL1.envelope.episode?.problem || group[0].envelope.episode?.request || group[0].envelope.episode?.problem || group[0].envelope.summary;
      const updatedSummary = workedApproach?.approach
        ? `Investigation: ${baseProblem} — verified: ${workedApproach.approach}`
        : `Investigation: ${baseProblem}`;

      const successorRef = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv, budget);

      if (runId) {
        await recordPendingL1Transition(cwd, {
          runId,
          predecessorRef: existingL1.ref,
          successorRef,
          sourceL0Refs: groupEvidence,
          timestamp: new Date().toISOString(),
        });
      }

      const successorEnvelope: MemoryEnvelope = {
        level: "L1",
        type: "investigation",
        lifecycle,
        summary: updatedSummary,
        supersedes: existingL1.ref,
        context: existingL1.envelope.context ?? groupContext,
        evidence: mergedEvidence,
        episode: {
          request: existingL1.envelope.episode?.request || group[0].envelope.episode?.request,
          problem: baseProblem,
          findings: mergedFindings,
          approaches: mergedApproaches.length > 0 ? mergedApproaches : undefined,
          diffs: mergedDiffs.length > 0 ? mergedDiffs : undefined,
          outcome,
          sessionId: existingL1.envelope.episode?.sessionId || group[0].envelope.episode?.sessionId,
          sessionFile: existingL1.envelope.episode?.sessionFile || group[0].envelope.episode?.sessionFile,
          leafId: group[group.length - 1].envelope.episode?.leafId || existingL1.envelope.episode?.leafId,
          runId,
        },
      };

      const res = await env.runner.run(
        buildStoreInvocation(env.cfg.qmapBin, fspec, successorRef, encodePayload(date, successorEnvelope), axes, cwd, eEnv),
      );
      if (budget) budget.charge("store", 1);
      if (res.code === 0) {
        // Mark predecessor superseded
        const priorLifecycle = existingL1.envelope.lifecycle;
        const priorSupersededBy = existingL1.envelope.supersededBy;
        existingL1.envelope.lifecycle = "superseded";
        existingL1.envelope.supersededBy = successorRef;
        const predStoreRes = await env.runner.run(
          buildStoreInvocation(env.cfg.qmapBin, fspec, existingL1.ref, encodePayload(existingL1.date, existingL1.envelope), axes, cwd, eEnv),
        );
        if (budget) budget.charge("store", 1);

        if (predStoreRes.code === 0) {
          if (runId && activeL1Updates) {
            activeL1Updates[runId] = successorRef;
          }

          created.push(successorRef);
          for (const r of groupEvidence) {
            cited.add(r);
            representedL0Refs.push(r);
          }
          items.push({ ref: successorRef, date, envelope: successorEnvelope });
          l1Candidates.push(successorRef);
        } else {
          // Predecessor store failed! Revert in-memory predecessor state.
          // Do NOT add to activeL1Updates or representedL0Refs.
          // The transition remains durable in journal.pendingL1Transitions.
          existingL1.envelope.lifecycle = priorLifecycle;
          existingL1.envelope.supersededBy = priorSupersededBy;
          debugLog("consolidation", "Predecessor store failed during successor creation", {
            runId,
            predecessorRef: existingL1.ref,
            successorRef,
            code: predStoreRes.code,
            stderr: predStoreRes.stderr,
          });
        }
      }
    } else {
      // Create initial L1 investigation
      const outcome = isSuccess ? "success" : (hasFail ? "failure" : "observed");
      const hasSupportedEvidence = group.some((g) => g.envelope.lifecycle === "supported");
      const lifecycle: LifecycleState = isSuccess
        ? (hasSupportedEvidence ? "supported" : "tested")
        : (group.some((g) => g.envelope.lifecycle === "tested") ? "tested" : "observed");
      const problem = group[0].envelope.episode?.request || group[0].envelope.episode?.problem || group[0].envelope.summary;
      const summary = worked?.approach
        ? `Investigation: ${problem} — verified: ${worked.approach}`
        : `Investigation: ${problem}`;

      // Check general idempotency
      const existingRep = items.find((i) =>
        i.envelope.level === "L1" &&
        i.envelope.lifecycle !== "superseded" &&
        i.envelope.lifecycle !== "contradicted" &&
        groupEvidence.every((r) => (i.envelope.evidence || []).includes(r))
      );
      if (existingRep || (await checkIdempotency(env, fspec, axes, cwd, eEnv, l1Candidates, "L1", groupEvidence, summary, budget) !== null)) {
        for (const r of groupEvidence) {
          cited.add(r);
          representedL0Refs.push(r);
        }
        continue;
      }

      const envl: MemoryEnvelope = {
        level: "L1",
        type: "investigation",
        lifecycle,
        summary,
        context: groupContext,
        evidence: groupEvidence,
        episode: {
          request: group[0].envelope.episode?.request,
          problem,
          findings: allFindings,
          approaches: allApproaches.length > 0 ? allApproaches : undefined,
          diffs: allDiffs.length > 0 ? allDiffs : undefined,
          outcome,
          sessionId: group[0].envelope.episode?.sessionId,
          sessionFile: group[0].envelope.episode?.sessionFile,
          leafId: group[group.length - 1].envelope.episode?.leafId,
          runId,
        },
      };

      let ref: number | null = null;
      if (runId) {
        const allocatedRef = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv, budget);
        await recordPendingL1Transition(cwd, {
          runId,
          successorRef: allocatedRef,
          sourceL0Refs: groupEvidence,
          timestamp: new Date().toISOString(),
        });
        const res = await env.runner.run(
          buildStoreInvocation(env.cfg.qmapBin, fspec, allocatedRef, encodePayload(date, envl), axes, cwd, eEnv),
        );
        if (budget) budget.charge("store", 1);
        if (res.code === 0) {
          ref = allocatedRef;
        }
      } else {
        ref = await storeAbs(env, fspec, axes, cwd, eEnv, envl, date, budget);
      }

      if (ref !== null) {
        if (runId && activeL1Updates) {
          activeL1Updates[runId] = ref;
        }
        created.push(ref);
        for (const r of groupEvidence) {
          cited.add(r);
          representedL0Refs.push(r);
        }
        items.push({ ref, date, envelope: envl });
        l1Candidates.push(ref);
      }
    }
  }

  // 2. Process session-grouped L0 conversational turns
  for (const [sessId, group] of bySession.entries()) {
    if (budget && !budget.hasBudget(1)) break;
    const existingL1 = items.find((i) =>
      i.envelope.level === "L1" &&
      i.envelope.type !== "investigation" &&
      i.envelope.episode?.sessionId === sessId &&
      i.envelope.lifecycle !== "superseded" &&
      i.envelope.lifecycle !== "contradicted"
    );

    const groupFacts = group.map((g) => g.envelope.summary).filter((s): s is string => Boolean(s && s.trim()));
    const groupEvidence = group.map((g) => g.ref);

    if (existingL1) {
      // Create successor L1 memory incorporating new L0 facts
      const priorFindings = existingL1.envelope.episode?.findings ?? [existingL1.envelope.summary];
      const mergedFindings = Array.from(new Set([...priorFindings, ...groupFacts]));
      const priorEvidence = existingL1.envelope.evidence ?? [];
      const mergedEvidence = Array.from(new Set([...priorEvidence, ...groupEvidence]));

      let updatedSummary = existingL1.envelope.summary;
      for (const newFact of groupFacts) {
        if (!updatedSummary.toLowerCase().includes(newFact.toLowerCase())) {
          updatedSummary = `${updatedSummary} — ${newFact}`;
        }
      }
      if (updatedSummary.length > 250) {
        updatedSummary = updatedSummary.slice(0, 247) + "...";
      }

      if (await checkIdempotency(env, fspec, axes, cwd, eEnv, l1Candidates, "L1", mergedEvidence, updatedSummary, budget) !== null) {
        for (const r of groupEvidence) {
          cited.add(r);
          representedL0Refs.push(r);
        }
        continue;
      }

      const successorRef = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv, budget);

      const successorEnvelope: MemoryEnvelope = {
        level: "L1",
        type: existingL1.envelope.type ?? "note",
        lifecycle: "observed",
        summary: updatedSummary,
        supersedes: existingL1.ref,
        evidence: mergedEvidence,
        context: existingL1.envelope.context,
        episode: {
          problem: existingL1.envelope.episode?.problem || group[0].envelope.episode?.problem || updatedSummary,
          findings: mergedFindings,
          outcome: "success",
          sessionId: sessId,
          sessionFile: existingL1.envelope.episode?.sessionFile || group[0].envelope.episode?.sessionFile,
          leafId: group[group.length - 1].envelope.episode?.leafId || existingL1.envelope.episode?.leafId,
        },
      };

      const res = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, successorRef, encodePayload(date, successorEnvelope), axes, cwd, eEnv));
      if (budget) budget.charge("store", 1);
      if (res.code === 0) {
        // Mark predecessor superseded
        existingL1.envelope.lifecycle = "superseded";
        existingL1.envelope.supersededBy = successorRef;
        const predRes = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, existingL1.ref, encodePayload(existingL1.date, existingL1.envelope), axes, cwd, eEnv));
        if (budget) budget.charge("store", 1);
        if (predRes.code !== 0) {
          await recordInterruptedSuccessorInJournal(cwd, {
            level: "L1",
            predecessorRef: existingL1.ref,
            successorRef,
            timestamp: new Date().toISOString(),
          });
        }

        // Update active in-memory session reference
        activeConversationTurn.activeMemoryRef = successorRef;
        activeConversationTurn.activeSessionId = sessId;

        created.push(successorRef);
        for (const r of groupEvidence) {
          cited.add(r);
          representedL0Refs.push(r);
        }
        items.push({ ref: successorRef, date, envelope: successorEnvelope });
        l1Candidates.push(successorRef);
      }
    } else {
      // Create new L1 episodic memory for this session
      const summary = groupFacts.length === 1 ? groupFacts[0] : groupFacts.join(" — ").slice(0, 250);

      if (await checkIdempotency(env, fspec, axes, cwd, eEnv, l1Candidates, "L1", groupEvidence, summary, budget) !== null) {
        for (const r of groupEvidence) {
          cited.add(r);
          representedL0Refs.push(r);
        }
        continue;
      }

      const l1Ref = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv, budget);

      const l1Envelope: MemoryEnvelope = {
        level: "L1",
        type: "note",
        lifecycle: "observed",
        summary,
        evidence: groupEvidence,
        context: group[0].envelope.context,
        episode: {
          problem: group[0].envelope.episode?.problem || summary,
          findings: groupFacts,
          outcome: "success",
          sessionId: sessId,
          sessionFile: group[0].envelope.episode?.sessionFile,
          leafId: group[group.length - 1].envelope.episode?.leafId,
        },
      };

      const res = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, l1Ref, encodePayload(date, l1Envelope), axes, cwd, eEnv));
      if (budget) budget.charge("store", 1);
      if (res.code === 0) {
        activeConversationTurn.activeMemoryRef = l1Ref;
        activeConversationTurn.activeSessionId = sessId;

        created.push(l1Ref);
        for (const r of groupEvidence) {
          cited.add(r);
          representedL0Refs.push(r);
        }
        items.push({ ref: l1Ref, date, envelope: l1Envelope });
        l1Candidates.push(l1Ref);
      }
    }
  }

  // 3. Process standalone L0 turns (no sessionId)
  for (const l0 of unassigned) {
    if (budget && !budget.hasBudget(1)) break;
    if (await checkIdempotency(env, fspec, axes, cwd, eEnv, l1Candidates, "L1", [l0.ref], l0.envelope.summary, budget) !== null) {
      cited.add(l0.ref);
      representedL0Refs.push(l0.ref);
      continue;
    }
    const l1Ref = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv, budget);
    const l1Envelope: MemoryEnvelope = {
      level: "L1",
      type: l0.envelope.type ?? "note",
      lifecycle: l0.envelope.lifecycle,
      summary: l0.envelope.summary,
      evidence: [l0.ref],
      context: l0.envelope.context,
      episode: l0.envelope.episode,
    };
    const res = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, l1Ref, encodePayload(date, l1Envelope), axes, cwd, eEnv));
    if (budget) budget.charge("store", 1);
    if (res.code === 0) {
      created.push(l1Ref);
      cited.add(l0.ref);
      representedL0Refs.push(l0.ref);
      items.push({ ref: l1Ref, date, envelope: l1Envelope });
      l1Candidates.push(l1Ref);
    }
  }

  return { created, representedL0Refs };
}

function extractMemoryScope(l1: StoredItem): { scope: string; isConversational: boolean } | null {
  const ctx = l1.envelope.context;
  if (ctx?.project || ctx?.subsystem || ctx?.module) {
    return { scope: (ctx.project || ctx.subsystem || ctx.module)!, isConversational: false };
  }
  if (ctx?.subject) {
    return { scope: ctx.subject, isConversational: true };
  }
  if (l1.envelope.tags && l1.envelope.tags.length > 0) {
    return { scope: l1.envelope.tags[0], isConversational: true };
  }
  return null;
}

async function reconcilePendingL1Transitions(
  env: ToolEnv,
  cwd: string,
  fspec: string,
  axes: string,
  eEnv: Record<string, string>,
  journal: ConsolidationJournal,
  budget?: WorkBudgetTracker,
): Promise<void> {
  if (!journal.pendingL1Transitions || Object.keys(journal.pendingL1Transitions).length === 0) return;
  for (const [runId, tr] of Object.entries(journal.pendingL1Transitions)) {
    if (budget && !budget.hasBudget(2)) break;
    try {
      const succRes = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, tr.successorRef, axes, cwd, eEnv));
      if (budget) budget.charge("get", 1);
      const isMissing = succRes.code === 0 && succRes.stdout.trim() === "-1";
      const isSuccessfulRead = succRes.code === 0 && succRes.stdout.trim() !== "" && succRes.stdout.trim() !== "-1";

      if (isMissing) {
        // Confirmed missing (-1 sentinel returned by CORM with code 0).
        // Successor was never stored before the crash/abort; clear aborted transition
        // while preserving source L0 references in pendingL0Refs for reprocessing.
        debugLog("consolidation", "Successor confirmed absent via -1 sentinel; clearing aborted transition", {
          runId,
          successorRef: tr.successorRef,
        });
        const curJ = await readConsolidationJournal(cwd);
        if (curJ.pendingL1Transitions) {
          delete curJ.pendingL1Transitions[runId];
          await writeConsolidationJournal(cwd, curJ);
        }
        continue;
      }

      if (!isSuccessfulRead) {
        // Inconclusive or failed read (nonzero code, timeout, transport error, or empty stdout).
        // MUST preserve the transition and source references!
        debugLog("consolidation", "Successor read inconclusive or failed; preserving transition", {
          runId,
          successorRef: tr.successorRef,
          code: succRes.code,
          stdout: succRes.stdout,
          stderr: succRes.stderr,
        });
        continue;
      }

      const succDecoded = decodePayload(succRes.stdout.trim());
      const succEnv = succDecoded.envelope;

      // Validate recovered successor identity and evidence representation
      const isL1Investigation = succEnv.level === "L1" && succEnv.type === "investigation";
      const runIdMatch = tr.runId ? succEnv.episode?.runId === tr.runId : (!succEnv.episode?.runId);
      const predecessorMatch = tr.predecessorRef !== undefined
        ? succEnv.supersedes === tr.predecessorRef
        : succEnv.supersedes === undefined || succEnv.supersedes === null;
      const evidenceRepresentsSource = Array.isArray(tr.sourceL0Refs) && tr.sourceL0Refs.length > 0
        ? tr.sourceL0Refs.every((r) => (succEnv.evidence || []).includes(r))
        : true;

      if (!isL1Investigation || !runIdMatch || !predecessorMatch || !evidenceRepresentsSource) {
        debugLog("consolidation", "Recovered successor identity or evidence inconsistent; preserving transition", {
          runId,
          successorRef: tr.successorRef,
          isL1Investigation,
          runIdMatch,
          predecessorMatch,
          evidenceRepresentsSource,
          expectedPredecessor: tr.predecessorRef,
          actualSupersedes: succEnv.supersedes,
          expectedSourceL0: tr.sourceL0Refs,
          actualEvidence: succEnv.evidence,
        });
        continue;
      }

      // Successor was persisted! Verify/reconcile predecessor link if needed
      let predReconciled = true;
      if (tr.predecessorRef) {
        const predRes = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, tr.predecessorRef, axes, cwd, eEnv));
        if (budget) budget.charge("get", 1);
        if (predRes.code !== 0 || !predRes.stdout.trim() || predRes.stdout.trim() === "-1") {
          predReconciled = false;
          debugLog("consolidation", "Predecessor read failed during transition reconciliation", {
            runId,
            predecessorRef: tr.predecessorRef,
            code: predRes.code,
            stderr: predRes.stderr,
          });
        } else {
          const predDecoded = decodePayload(predRes.stdout.trim());
          if (predDecoded.envelope.lifecycle === "superseded" && predDecoded.envelope.supersededBy === tr.successorRef) {
            predReconciled = true;
          } else {
            predDecoded.envelope.lifecycle = "superseded";
            predDecoded.envelope.supersededBy = tr.successorRef;
            const predStoreRes = await env.runner.run(
              buildStoreInvocation(env.cfg.qmapBin, fspec, tr.predecessorRef, encodePayload(predDecoded.date, predDecoded.envelope), axes, cwd, eEnv),
            );
            if (budget) budget.charge("store", 1);
            if (predStoreRes.code !== 0) {
              predReconciled = false;
              debugLog("consolidation", "Predecessor store failed during transition reconciliation", {
                runId,
                predecessorRef: tr.predecessorRef,
                code: predStoreRes.code,
                stderr: predStoreRes.stderr,
              });
            } else {
              predReconciled = true;
            }
          }
        }
      }

      if (!predReconciled) {
        // Predecessor update or read failed! Keep transition and source references pending.
        debugLog("consolidation", "Predecessor reconciliation incomplete; preserving transition", {
          runId,
          predecessorRef: tr.predecessorRef,
          successorRef: tr.successorRef,
        });
        continue;
      }

      // Predecessor confirmed reconciled!
      // Safe to update activeL1ByRunId, prune sourceL0Refs, clear transition, and restore dirty-scope registration.
      const succItem: StoredItem = { ref: tr.successorRef, date: succDecoded.date ?? "", envelope: succEnv };
      const scopeInfo = extractMemoryScope(succItem);

      const curJ = await readConsolidationJournal(cwd);
      curJ.activeL1ByRunId = curJ.activeL1ByRunId || {};
      curJ.activeL1ByRunId[runId] = tr.successorRef;
      if (curJ.pendingL0Refs && curJ.pendingL0Refs.length > 0) {
        const pruneSet = new Set(tr.sourceL0Refs);
        curJ.pendingL0Refs = curJ.pendingL0Refs.filter((r) => !pruneSet.has(r));
      }
      if (curJ.pendingL1Transitions) {
        delete curJ.pendingL1Transitions[runId];
      }

      if (scopeInfo) {
        const scope = scopeInfo.scope;
        curJ.dirtyScopes = curJ.dirtyScopes || {};
        const entry = curJ.dirtyScopes[scope] || {
          scope,
          count: 0,
          l1Refs: [],
          lastUpdated: new Date().toISOString(),
          isConversational: scopeInfo.isConversational,
        };

        // If successor supersedes an older L1, remove the superseded reference from l1Refs
        const oldRef = succEnv.supersedes ?? tr.predecessorRef;
        if (oldRef) {
          entry.l1Refs = entry.l1Refs.filter((x) => x !== oldRef);
        }

        // Idempotently add successor ref
        if (!entry.l1Refs.includes(tr.successorRef)) {
          entry.l1Refs.push(tr.successorRef);
        }
        entry.count = entry.l1Refs.length;
        entry.lastUpdated = new Date().toISOString();
        curJ.dirtyScopes[scope] = entry;

        // Check threshold for L2 eligibility
        const l2Threshold = env.cfg.consolidateL2Threshold ?? 3;
        if (entry.count >= l2Threshold) {
          curJ.pendingL2Scopes = curJ.pendingL2Scopes || [];
          if (!curJ.pendingL2Scopes.includes(scope)) {
            curJ.pendingL2Scopes.push(scope);
          }
        }
      }

      await writeConsolidationJournal(cwd, curJ);
    } catch (err) {
      debugLog("consolidation", "Transition reconciliation error", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function reconcileInterruptedSuccessors(
  env: ToolEnv,
  cwd: string,
  fspec: string,
  axes: string,
  eEnv: Record<string, string>,
  journal: ConsolidationJournal,
  budget?: WorkBudgetTracker,
): Promise<void> {
  if (!journal.interruptedSuccessors || journal.interruptedSuccessors.length === 0) return;
  for (const item of [...journal.interruptedSuccessors]) {
    if (budget && !budget.hasBudget(2)) break;
    try {
      const predRes = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, item.predecessorRef, axes, cwd, eEnv));
      if (budget) budget.charge("get", 1);
      if (predRes.code === 0 && predRes.stdout.trim()) {
        const decoded = decodePayload(predRes.stdout.trim());
        decoded.envelope.lifecycle = "superseded";
        decoded.envelope.supersededBy = item.successorRef;
        const updateRes = await env.runner.run(
          buildStoreInvocation(env.cfg.qmapBin, fspec, item.predecessorRef, encodePayload(decoded.date, decoded.envelope), axes, cwd, eEnv),
        );
        if (budget) budget.charge("store", 1);
        if (updateRes.code === 0) {
          await clearInterruptedSuccessorInJournal(cwd, item.successorRef);
          if (item.level === "L2" && item.scope) {
            const j = await readConsolidationJournal(cwd);
            if (j.dirtyScopes[item.scope]) {
              j.dirtyScopes[item.scope].activeL2Ref = item.successorRef;
              await writeConsolidationJournal(cwd, j);
            }
          } else if (item.level === "L3") {
            const j = await readConsolidationJournal(cwd);
            j.activeL3Ref = item.successorRef;
            await writeConsolidationJournal(cwd, j);
          }
        }
      }
    } catch { /* best-effort reconciliation */ }
  }
}

async function autoL1ToL2(
  env: ToolEnv, fspec: string, axes: string, cwd: string, eEnv: Record<string, string>,
  items: StoredItem[], cited: Set<number>, date: string,
  targetScopes: string[],
  journal: ConsolidationJournal,
  budget?: WorkBudgetTracker,
): Promise<{ created: number[]; results: ScopeConsolidationResult[] }> {
  const created: number[] = [];
  const results: ScopeConsolidationResult[] = [];

  const byScope = new Map<string, StoredItem[]>();
  for (const it of items) {
    if (it.envelope.level !== "L1") continue;
    if (it.envelope.lifecycle === "contradicted" || it.envelope.lifecycle === "superseded") continue;
    const scopeInfo = extractMemoryScope(it);
    if (!scopeInfo) continue;
    if (!targetScopes.includes(scopeInfo.scope)) continue;
    const g = byScope.get(scopeInfo.scope) ?? [];
    g.push(it);
    byScope.set(scopeInfo.scope, g);
  }

  for (const scope of targetScopes) {
    if (budget && !budget.hasBudget(1)) break;
    const scopeItems = byScope.get(scope) ?? [];
    const activeItems = scopeItems.filter(
      (g) => g.envelope.lifecycle === "supported" || g.envelope.lifecycle === "observed" || g.envelope.lifecycle === "tested",
    );

    if (activeItems.length < 2) {
      results.push({
        scope,
        status: "insufficient_evidence",
        reason: `Scope has ${activeItems.length} active L1 memories (needs at least 2)`,
      });
      continue;
    }

    // Epistemic check: contradictory findings cannot form a scope abstraction
    if (hasConflictingFindings(activeItems)) {
      results.push({
        scope,
        status: "conflicting",
        reason: "Contradictory findings in evidence items prevent consolidation",
      });
      continue;
    }

    if (!synthConfigured(env.cfg)) {
      results.push({
        scope,
        status: "unavailable",
        reason: "synthesis capability not configured",
      });
      continue;
    }

    // Look for existing active L2 abstraction for this scope (via journal or items)
    const activeL2Ref = journal.dirtyScopes[scope]?.activeL2Ref;
    let existingL2Item = activeL2Ref ? items.find((i) => i.ref === activeL2Ref) : undefined;
    if (!existingL2Item) {
      existingL2Item = items.find(
        (i) => i.envelope.level === "L2" &&
               extractMemoryScope(i)?.scope === scope &&
               i.envelope.lifecycle !== "superseded" &&
               i.envelope.lifecycle !== "contradicted",
      );
    }

    // Idempotency check: does existing L2 already cite all active L1 items?
    if (existingL2Item) {
      const existingEvidence = new Set(existingL2Item.envelope.evidence || []);
      if (activeItems.every((it) => existingEvidence.has(it.ref))) {
        results.push({
          scope,
          status: "idempotent",
          createdRef: existingL2Item.ref,
          reason: "Existing L2 abstraction already cites all current L1 evidence",
          representedL1Refs: activeItems.map((it) => it.ref),
        });
        continue;
      }
    }

    // Genuine L2 Synthesis via provider-neutral client
    const isConversational = activeItems.some((it) => extractMemoryScope(it)?.isConversational);
    const synthInput: L2SynthesisInput = {
      scope,
      isConversational,
      priorAbstraction: existingL2Item ? {
        ref: existingL2Item.ref,
        summary: existingL2Item.envelope.summary,
        evidence: existingL2Item.envelope.evidence || [],
      } : undefined,
      evidence: activeItems.map((it) => ({
        ref: it.ref,
        level: it.envelope.level,
        summary: it.envelope.summary,
        lifecycle: it.envelope.lifecycle,
        problem: it.envelope.episode?.problem,
        findings: it.envelope.episode?.findings,
        outcome: it.envelope.episode?.outcome,
        approaches: it.envelope.episode?.approaches,
        diffs: it.envelope.episode?.diffs,
        context: it.envelope.context,
        evidence: it.envelope.evidence,
      })),
    };

    // Pre-flight complete work budget check: need 1 synth + 1 store + optional pred store + potential allocator recovery list
    const seqInit = await isRefSeqInitialized(cwd);
    const neededUnits = (existingL2Item ? 1 : 0) + 2 + (seqInit ? 0 : 1);
    if (budget && !budget.hasBudget(neededUnits)) {
      results.push({
        scope,
        status: "deferred",
        reason: "insufficient_budget_for_minimal_operation",
      });
      break;
    }

    const synthOutcome = await synthesizeL2ScopeKnowledge(
      synthInput,
      env.cfg,
      env.fetchFn ?? globalThis.fetch,
    );
    if (budget) budget.charge("synth", 1);

    if (synthOutcome.status !== "ok" || !synthOutcome.summary || !synthOutcome.citedRefs) {
      results.push({
        scope,
        status: synthOutcome.status === "ok" ? "failed" : synthOutcome.status,
        reason: synthOutcome.reason || "Synthesis did not produce valid output",
      });
      continue;
    }

    // Allocate new ref from persistent sequence
    const newRef = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv, budget);

    const envl: MemoryEnvelope = {
      level: "L2",
      type: isConversational ? "concept" : "invariant",
      lifecycle: "observed", // Epistemic safety: NEVER supported on synthesis
      summary: synthOutcome.summary,
      context: isConversational ? { subject: scope } : { project: scope },
      evidence: synthOutcome.citedRefs,
      supersedes: existingL2Item ? existingL2Item.ref : undefined,
    };

    const storeRes = await env.runner.run(
      buildStoreInvocation(env.cfg.qmapBin, fspec, newRef, encodePayload(date, envl), axes, cwd, eEnv),
    );
    if (budget) budget.charge("store", 1);

    if (storeRes.code !== 0) {
      results.push({ scope, status: "failed", reason: "CORM store invocation failed" });
      continue;
    }

    // Update predecessor L2 with reciprocal supersededBy link and verify return code
    if (existingL2Item) {
      existingL2Item.envelope.lifecycle = "superseded";
      existingL2Item.envelope.supersededBy = newRef;
      const predRes = await env.runner.run(
        buildStoreInvocation(
          env.cfg.qmapBin,
          fspec,
          existingL2Item.ref,
          encodePayload(existingL2Item.date, existingL2Item.envelope),
          axes,
          cwd,
          eEnv,
        ),
      );
      if (budget) budget.charge("store", 1);
      if (predRes.code !== 0) {
        await recordInterruptedSuccessorInJournal(cwd, {
          level: "L2",
          scope,
          predecessorRef: existingL2Item.ref,
          successorRef: newRef,
          timestamp: new Date().toISOString(),
        });
        results.push({ scope, status: "failed", reason: "Predecessor update failed" });
        continue;
      }
    }

    created.push(newRef);
    for (const r of synthOutcome.citedRefs) cited.add(r);
    items.push({ ref: newRef, date, envelope: envl });

    results.push({
      scope,
      status: "consolidated",
      createdRef: newRef,
      representedL1Refs: synthOutcome.citedRefs,
    });
  }

  return { created, results };
}

export async function runAutoConsolidation(
  env: ToolEnv,
  _ctx: PiCtx,
  opts?: { newL0Refs?: number[]; incrementalOnly?: boolean },
): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> {
  const embed = sepalConfigured(env.cfg);
  const cwd = memDir(env);
  const fspec = filespecFor(cwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);

  return await withLock(cwd, async () => {
    let items: StoredItem[] = [];

    const initialJournal = await readConsolidationJournal(cwd);
    if (initialJournal.pendingL1Transitions && Object.keys(initialJournal.pendingL1Transitions).length > 0) {
      await reconcilePendingL1Transitions(env, cwd, fspec, axes, eEnv, initialJournal);
      const refreshed = await readConsolidationJournal(cwd);
      Object.assign(initialJournal, refreshed);
    }
    const pendingL0FromJournal = initialJournal.pendingL0Refs || [];
    const combinedL0Refs = Array.from(new Set([...pendingL0FromJournal, ...(opts?.newL0Refs || [])]));

    if (opts?.incrementalOnly && combinedL0Refs.length === 0) {
      const eligibility = checkConsolidationEligibility(env.cfg, initialJournal, env.nowProvider());
      return exportDetail({
        mode: "auto",
        createdL1: [],
        createdL2: [],
        createdL3: [],
        totalCreated: 0,
        unscopedL1Count: 0,
        pendingL2Scopes: eligibility.eligibleL2Scopes,
        pendingL3: eligibility.eligibleL3,
        status: "L0->L1 clean no-op; 0 pending references",
      });
    }

    if (combinedL0Refs.length > 0) {
      // INCREMENTAL & BOUNDED: Fetch ONLY the pending L0 references without full list!
      const batchLimit = env.cfg.consolidateBatchLimit ?? 20;
      const targetRefs = combinedL0Refs.slice(0, batchLimit);
      for (const r of targetRefs) {
        const res = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, r, axes, cwd, eEnv));
        if (res.code === 0 && res.stdout.trim() && res.stdout.trim() !== "-1") {
          const { date, envelope } = decodePayload(res.stdout.trim());
          items.push({ ref: r, date, envelope });
        }
      }

      // Also fetch the active session's existing L1 (if known) to allow successor updates
      if (activeConversationTurn.activeMemoryRef && activeConversationTurn.activeSessionId && activeConversationTurn.activeSessionId === _ctx.sessionId) {
        const activeRes = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, activeConversationTurn.activeMemoryRef, axes, cwd, eEnv));
        if (activeRes.code === 0 && activeRes.stdout.trim() && activeRes.stdout.trim() !== "-1") {
          const { date, envelope } = decodePayload(activeRes.stdout.trim());
          items.push({ ref: activeConversationTurn.activeMemoryRef, date, envelope });
        }
      }

      // Fetch active L1 investigations for any runId present in this batch
      const runIdsInBatch = Array.from(new Set(
        items
          .map((it) => it.envelope.episode?.runId)
          .filter((id): id is string => Boolean(id)),
      ));
      for (const runId of runIdsInBatch) {
        const candidateL1Ref = initialJournal.pendingL1Transitions?.[runId]?.successorRef ?? initialJournal.activeL1ByRunId?.[runId];
        if (candidateL1Ref && !items.some((it) => it.ref === candidateL1Ref)) {
          const l1Res = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, candidateL1Ref, axes, cwd, eEnv));
          if (l1Res.code === 0 && l1Res.stdout.trim() && l1Res.stdout.trim() !== "-1") {
            const { date, envelope } = decodePayload(l1Res.stdout.trim());
            items.push({ ref: candidateL1Ref, date, envelope });
          }
        }
      }
    } else if (!opts) {
      // Manual auto-consolidation without specific new refs and without pending journal refs:
      items = await scanAllItems(env, fspec, axes, cwd, eEnv);
    }

    const cited = new Set<number>();
    for (const it of items) for (const ev of it.envelope.evidence || []) cited.add(ev);

    // Recognize any pending L0 references that are already represented by an existing active L1
    const alreadyRepresentedL0: number[] = [];
    for (const it of items) {
      if (it.envelope.level === "L0") {
        const representingL1 = items.find((l1) =>
          l1.envelope.level === "L1" &&
          l1.envelope.lifecycle !== "superseded" &&
          l1.envelope.lifecycle !== "contradicted" &&
          (l1.envelope.evidence || []).includes(it.ref),
        );
        const itemRunId = it.envelope.episode?.runId;
        const hasUnresolvedTransition = itemRunId && initialJournal.pendingL1Transitions?.[itemRunId];
        if (representingL1 && !hasUnresolvedTransition) {
          cited.add(it.ref);
          alreadyRepresentedL0.push(it.ref);
        }
      }
    }

    const date = env.nowProvider().toISOString().slice(0, 10);

    // 1. Run incremental L0 -> L1 consolidation for the active session
    const activeL1Updates: Record<string, number> = {};
    const { created: createdL1, representedL0Refs } = await autoL0ToL1(
      env, fspec, axes, cwd, eEnv, items, cited, date, undefined, activeL1Updates, initialJournal,
    );

    // 2. Track dirty scopes in the consolidation journal
    let unscopedL1Count = 0;
    for (const r of createdL1) {
      const item = items.find((it) => it.ref === r);
      if (item) {
        const scopeInfo = extractMemoryScope(item);
        if (scopeInfo) {
          // If this item supersedes an older L1, remove the older L1 from dirtyScopes
          if (item.envelope.supersedes) {
            const j = await readConsolidationJournal(cwd);
            if (j.dirtyScopes[scopeInfo.scope]) {
              j.dirtyScopes[scopeInfo.scope].l1Refs = j.dirtyScopes[scopeInfo.scope].l1Refs.filter((x) => x !== item.envelope.supersedes);
              j.dirtyScopes[scopeInfo.scope].count = j.dirtyScopes[scopeInfo.scope].l1Refs.length;
              await writeConsolidationJournal(cwd, j);
            }
          }
          await recordNewL1InJournal(cwd, scopeInfo.scope, [r], env.cfg.consolidateL2Threshold ?? 3);
        } else {
          unscopedL1Count++;
        }
      }
    }

    // Save activeL1ByRunId updates in journal
    for (const [runId, l1Ref] of Object.entries(activeL1Updates)) {
      await recordActiveL1ForRunId(cwd, runId, l1Ref);
    }

    // 3. Prune represented L0 references from journal
    const combinedRepresentedL0 = Array.from(new Set([...representedL0Refs, ...alreadyRepresentedL0]));
    if (combinedRepresentedL0.length > 0) {
      await pruneProcessedL0InJournal(cwd, combinedRepresentedL0);
    }

    // 4. Clear committed pendingL1Transitions
    for (const runId of Object.keys(activeL1Updates)) {
      await clearPendingL1Transition(cwd, runId);
    }

    const journal = await readConsolidationJournal(cwd, {
      runner: env.runner,
      qmapBin: env.cfg.qmapBin,
      fspec,
      axes,
      eEnv,
      l2Threshold: env.cfg.consolidateL2Threshold,
      l3Threshold: env.cfg.consolidateL3Threshold,
    });
    const eligibility = checkConsolidationEligibility(env.cfg, journal, env.nowProvider());

    // On ordinary turns: DO NOT run autoL1ToL2 or autoL2ToL3 synchronously!
    return exportDetail({
      mode: "auto",
      createdL1,
      createdL2: [],
      createdL3: [],
      totalCreated: createdL1.length,
      unscopedL1Count,
      pendingL2Scopes: eligibility.eligibleL2Scopes,
      pendingL3: eligibility.eligibleL3,
      status: "L0->L1 incremental complete; higher levels deferred",
      note: unscopedL1Count > 0 ? "higher-level consolidation waiting for scope information" : undefined,
    });
  });
}

export interface DeferredConsolidateOptions {
  force?: boolean;
  targetLevel?: "L1" | "L2" | "L3";
  scope?: string;
}

export async function runDeferredConsolidation(
  env: ToolEnv,
  _ctx: PiCtx,
  opts?: DeferredConsolidateOptions,
): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }> {
  const embed = sepalConfigured(env.cfg);
  const cwd = memDir(env);
  const fspec = filespecFor(cwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);

  return await withLock(cwd, async () => {
    const batchLimit = env.cfg.consolidateBatchLimit ?? 20;
    const budget = new WorkBudgetTracker(batchLimit);

    const journal = await readConsolidationJournal(cwd, {
      runner: env.runner,
      qmapBin: env.cfg.qmapBin,
      fspec,
      axes,
      eEnv,
      l2Threshold: env.cfg.consolidateL2Threshold,
      l3Threshold: env.cfg.consolidateL3Threshold,
    });

    // Reconcile any interrupted successor updates from previous crashes/failures
    if (journal.interruptedSuccessors && journal.interruptedSuccessors.length > 0) {
      await reconcileInterruptedSuccessors(env, cwd, fspec, axes, eEnv, journal, budget);
      const refreshedJournal = await readConsolidationJournal(cwd);
      Object.assign(journal, refreshedJournal);
    }

    const eligibility = checkConsolidationEligibility(env.cfg, journal, env.nowProvider(), Boolean(opts?.force));

    // Check whether the reference sequence allocator needs one-time roster listing
    const seqInit = await isRefSeqInitialized(cwd);
    let uninitializedSeqCost = seqInit ? 0 : 1;

    // Select eligible scopes
    let candidateScopes: string[] = [];
    if (opts?.scope) {
      candidateScopes = [opts.scope];
    } else if (opts?.force) {
      candidateScopes = Object.keys(journal.dirtyScopes);
    } else {
      candidateScopes = eligibility.eligibleL2Scopes;
    }

    // Starvation-free fairness: prioritize scopes that have never run or ran longest ago
    candidateScopes.sort((a, b) => {
      const ea = journal.dirtyScopes[a];
      const eb = journal.dirtyScopes[b];
      const timeA = ea?.lastAttempt ? new Date(ea.lastAttempt).getTime() : 0;
      const timeB = eb?.lastAttempt ? new Date(eb.lastAttempt).getTime() : 0;
      if (timeA !== timeB) return timeA - timeB;
      return (ea?.attemptCount ?? 0) - (eb?.attemptCount ?? 0);
    });

    // WORK-CONSERVING CAPACITY-AWARE PRE-FLIGHT SCHEDULING:
    // Reserve full compound cost (reads + synth + store + pred store + allocator list)
    // BEFORE selecting and fetching evidence records.
    const targetRefsToFetch: number[] = [];
    const scopesToConsolidate: string[] = [];

    for (const scope of candidateScopes) {
      const entry = journal.dirtyScopes[scope];
      if (!entry || !entry.l1Refs || entry.l1Refs.length === 0) continue;

      const hasPred = Boolean(entry.activeL2Ref);
      const fixedPostRead = 2 + (hasPred ? 1 : 0) + uninitializedSeqCost;
      const predRead = hasPred ? 1 : 0;
      const fixedOverhead = fixedPostRead + predRead;
      const minEvidence = Math.min(entry.l1Refs.length, 2);
      const minUnitsNeeded = fixedOverhead + minEvidence;

      if (budget.available < minUnitsNeeded) {
        await recordScopeOutcomeInJournal(cwd, scope, {
          status: "deferred",
          reason: "insufficient_budget_for_minimal_operation",
        });
        continue;
      }

      const maxEvidence = budget.available - fixedOverhead;
      const evidenceToFetchCount = Math.min(entry.l1Refs.length, maxEvidence);
      const l1RefsToFetch = entry.l1Refs.slice(0, evidenceToFetchCount);
      const scopePlannedUnits = fixedOverhead + evidenceToFetchCount;

      budget.reserve(scopePlannedUnits);
      uninitializedSeqCost = 0; // First planned store accounts for sequence reconciliation

      scopesToConsolidate.push(scope);
      targetRefsToFetch.push(...l1RefsToFetch);
      if (entry.activeL2Ref) targetRefsToFetch.push(entry.activeL2Ref);
    }

    const shouldRunL3 = opts?.targetLevel === "L3" || (opts?.targetLevel === undefined && (opts?.force || eligibility.eligibleL3));
    if (shouldRunL3 && journal.dirtyL2 && journal.dirtyL2.l2Refs.length >= 2) {
      const hasPredL3 = Boolean(journal.activeL3Ref);
      const fixedPostReadL3 = 2 + (hasPredL3 ? 1 : 0) + uninitializedSeqCost;
      const predReadL3 = hasPredL3 ? 1 : 0;
      const fixedOverheadL3 = fixedPostReadL3 + predReadL3;
      const minL3Units = fixedOverheadL3 + 2;

      if (budget.available >= minL3Units) {
        const maxL2Count = budget.available - fixedOverheadL3;
        const scopeMap = journal.dirtyL2.scopeByRef ?? {};
        const byScopeL2 = new Map<string, number[]>();
        for (const r of journal.dirtyL2.l2Refs) {
          const sc = scopeMap[r] ?? "unknown";
          const g = byScopeL2.get(sc) ?? [];
          g.push(r);
          byScopeL2.set(sc, g);
        }
        const selectedL2Refs: number[] = [];
        const scopeL2Arrays = Array.from(byScopeL2.values());
        let rIdx = 0;
        while (selectedL2Refs.length < maxL2Count) {
          let addedAny = false;
          for (const arr of scopeL2Arrays) {
            if (rIdx < arr.length && selectedL2Refs.length < maxL2Count) {
              selectedL2Refs.push(arr[rIdx]);
              addedAny = true;
            }
          }
          if (!addedAny) break;
          rIdx++;
        }

        if (selectedL2Refs.length >= 2) {
          const l3PlannedUnits = fixedOverheadL3 + selectedL2Refs.length;
          budget.reserve(l3PlannedUnits);
          uninitializedSeqCost = 0;
          targetRefsToFetch.push(...selectedL2Refs);
          if (journal.activeL3Ref) targetRefsToFetch.push(journal.activeL3Ref);
        }
      } else if (opts?.targetLevel === "L3") {
        journal.l3Status = "deferred";
        journal.l3Reason = "insufficient_budget_for_minimal_operation";
        await writeConsolidationJournal(cwd, journal);
      }
    }

    const uniqueRefs = Array.from(new Set(targetRefsToFetch));
    const items: StoredItem[] = [];
    for (const r of uniqueRefs) {
      if (!budget.hasBudget(1)) break;
      const res = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, r, axes, cwd, eEnv));
      budget.charge("get", 1);
      if (res.code === 0 && res.stdout.trim()) {
        const { date, envelope } = decodePayload(res.stdout.trim());
        items.push({ ref: r, date, envelope });
      }
    }

    const cited = new Set<number>();
    for (const it of items) for (const ev of it.envelope.evidence || []) cited.add(ev);
    const date = env.nowProvider().toISOString().slice(0, 10);

    let createdL2: number[] = [];
    if (opts?.targetLevel !== "L3" && scopesToConsolidate.length > 0 && budget.hasBudget(1)) {
      const l2Result = await autoL1ToL2(env, fspec, axes, cwd, eEnv, items, cited, date, scopesToConsolidate, journal, budget);
      createdL2 = l2Result.created;

      for (const res of l2Result.results) {
        if ((res.status === "consolidated" || res.status === "idempotent") && res.representedL1Refs && res.representedL1Refs.length > 0) {
          await pruneProcessedL1InJournal(cwd, res.scope, res.representedL1Refs, res.createdRef, res.status, env.cfg.consolidateL2Threshold ?? 3);
        } else {
          // Failure, unavailable, insufficient, or unestablished representation: PRESERVE dirty state!
          await recordScopeOutcomeInJournal(cwd, res.scope, { status: res.status, reason: res.reason }, res.createdRef);
        }
      }

      if (createdL2.length > 0) {
        const l2ScopeMap: Record<number, string> = {};
        for (const res of l2Result.results) {
          if (res.createdRef) l2ScopeMap[res.createdRef] = res.scope;
        }
        await recordNewL2InJournal(cwd, createdL2, env.cfg.consolidateL3Threshold ?? 2, l2ScopeMap);
      }
    }

    let createdL3: number[] = [];
    let l3Status = "not requested";
    if (shouldRunL3 && budget.hasBudget(1)) {
      const l3Res = await autoL2ToL3(env, fspec, axes, cwd, eEnv, items, cited, date, journal.activeL3Ref, budget);
      createdL3 = l3Res.created;
      l3Status = l3Res.status;
      if (createdL3.length > 0) {
        await recordL3OutcomeInJournal(cwd, { status: "synthesized" }, createdL3[0], l3Res.representedL2Refs, env.cfg.consolidateL3Threshold);
      } else if (l3Status === "idempotent") {
        await recordL3OutcomeInJournal(cwd, { status: "idempotent" }, undefined, l3Res.representedL2Refs, env.cfg.consolidateL3Threshold);
      } else {
        await recordL3OutcomeInJournal(cwd, { status: l3Status, reason: l3Res.reason }, undefined, undefined, env.cfg.consolidateL3Threshold);
      }
    }

    budget.reservedUnits = 0;
    const totalCreated = createdL2.length + createdL3.length;
    await recordRunStatsInJournal(cwd, {
      createdL2,
      createdL3,
      totalCreated,
      l3Status,
      timestamp: date,
      operations: budget.toStats(),
    });

    return exportDetail({
      mode: "deferred",
      createdL1: [],
      createdL2,
      createdL3,
      totalCreated,
      l3Status,
      operations: budget.toStats(),
    });
  });
}

async function autoL2ToL3(
  env: ToolEnv,
  fspec: string,
  axes: string,
  cwd: string,
  eEnv: Record<string, string>,
  items: StoredItem[],
  cited: Set<number>,
  date: string,
  activeL3Ref?: number,
  budget?: WorkBudgetTracker,
): Promise<{ created: number[]; status: string; reason?: string; representedL2Refs?: number[] }> {
  if (!synthConfigured(env.cfg)) {
    return { created: [], status: "unavailable", reason: "synthesis capability not configured" };
  }

  const batchLimit = env.cfg.consolidateBatchLimit ?? 20;
  const activeL2Candidates = items.filter((i) =>
    i.envelope.level === "L2" &&
    i.envelope.lifecycle !== "superseded" &&
    i.envelope.lifecycle !== "contradicted",
  );

  if (activeL2Candidates.length < 2) {
    return { created: [], status: "deferred", reason: "needs at least 2 active L2 memories" };
  }

  // Group candidate L2s by scope to prevent single-scope starvation
  const byScope = new Map<string, StoredItem[]>();
  for (const it of activeL2Candidates) {
    const scope = (it.envelope.context?.project || it.envelope.context?.subsystem || it.envelope.context?.subject) || "general";
    const g = byScope.get(scope) ?? [];
    g.push(it);
    byScope.set(scope, g);
  }

  // Unconditional evidence requirement: L3 generalization strictly requires at least 2 distinct scopes under all modes
  if (byScope.size < 2) {
    return { created: [], status: "deferred", reason: "requires evidence across at least 2 distinct scopes" };
  }

  // Round-robin selection across distinct scopes up to batchLimit
  const activeL2: StoredItem[] = [];
  const scopeArrays = Array.from(byScope.values());
  let round = 0;
  while (activeL2.length < batchLimit) {
    let addedThisRound = false;
    for (const arr of scopeArrays) {
      if (round < arr.length && activeL2.length < batchLimit) {
        activeL2.push(arr[round]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
    round++;
  }

  // Check existing active L3 abstraction
  let existingL3Item: StoredItem | undefined = undefined;
  if (activeL3Ref) {
    existingL3Item = items.find((i) => i.ref === activeL3Ref);
  }
  if (!existingL3Item) {
    existingL3Item = items.find((i) =>
      i.envelope.level === "L3" &&
      i.envelope.lifecycle !== "superseded" &&
      i.envelope.lifecycle !== "contradicted",
    );
  }

  // Idempotency check: does existing L3 already cite all active L2 memories?
  if (existingL3Item) {
    const existingEvidence = new Set(existingL3Item.envelope.evidence || []);
    if (activeL2.every((it) => existingEvidence.has(it.ref))) {
      return {
        created: [],
        status: "idempotent",
        reason: "Existing L3 abstraction already cites all current L2 evidence",
        representedL2Refs: activeL2.map((it) => it.ref),
      };
    }
  }

  const synthInput: L3SynthesisInput = {
    priorAbstraction: existingL3Item ? {
      ref: existingL3Item.ref,
      summary: existingL3Item.envelope.summary,
      evidence: existingL3Item.envelope.evidence || [],
    } : undefined,
    l2Items: activeL2.map((it) => ({
      ref: it.ref,
      scope: (it.envelope.context?.project || it.envelope.context?.subsystem || it.envelope.context?.subject) || "general",
      summary: it.envelope.summary,
      evidence: it.envelope.evidence || [],
    })),
  };

  const seqInitL3 = await isRefSeqInitialized(cwd);
  const neededUnits = (existingL3Item ? 1 : 0) + 2 + (seqInitL3 ? 0 : 1);
  if (budget && !budget.hasBudget(neededUnits)) {
    return { created: [], status: "deferred", reason: "insufficient_budget_for_minimal_operation" };
  }

  const synthOutcome = await synthesizeL3GeneralPrinciple(
    synthInput,
    env.cfg,
    env.fetchFn ?? globalThis.fetch,
  );
  if (budget) budget.charge("synth", 1);

  if (synthOutcome.status !== "ok" || !synthOutcome.summary || !synthOutcome.citedRefs) {
    return { created: [], status: synthOutcome.status, reason: synthOutcome.reason };
  }

  // Allocate new ref from persistent sequence
  const ref = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv, budget);

  const envl: MemoryEnvelope = {
    level: "L3",
    type: "pattern",
    lifecycle: "hypothesized", // Epistemic safety
    summary: synthOutcome.summary,
    evidence: synthOutcome.citedRefs,
    supersedes: existingL3Item ? existingL3Item.ref : undefined,
    episode: {
      problem: synthOutcome.applicability,
      findings: [synthOutcome.principle || synthOutcome.summary],
      principle: synthOutcome.principle,
      applicability: synthOutcome.applicability,
      outcome: "success",
    },
  };

  const storeRes = await env.runner.run(
    buildStoreInvocation(env.cfg.qmapBin, fspec, ref, encodePayload(date, envl), axes, cwd, eEnv),
  );
  if (budget) budget.charge("store", 1);

  if (storeRes.code !== 0) {
    return { created: [], status: "failed", reason: "failed to store L3 abstraction" };
  }

  // Update predecessor L3 with reciprocal supersededBy link and verify return code
  if (existingL3Item) {
    existingL3Item.envelope.lifecycle = "superseded";
    existingL3Item.envelope.supersededBy = ref;
    const predRes = await env.runner.run(
      buildStoreInvocation(
        env.cfg.qmapBin,
        fspec,
        existingL3Item.ref,
        encodePayload(existingL3Item.date, existingL3Item.envelope),
        axes,
        cwd,
        eEnv,
      ),
    );
    if (budget) budget.charge("store", 1);
    if (predRes.code !== 0) {
      await recordInterruptedSuccessorInJournal(cwd, {
        level: "L3",
        predecessorRef: existingL3Item.ref,
        successorRef: ref,
        timestamp: new Date().toISOString(),
      });
      return { created: [], status: "failed", reason: "Predecessor L3 update failed" };
    }
  }

  for (const r of synthOutcome.citedRefs) cited.add(r);
  items.push({ ref, date, envelope: envl });
  return { created: [ref], status: "synthesized", representedL2Refs: synthOutcome.citedRefs };
}

async function validateL3Generalization(
  env: ToolEnv, fspec: string, axes: string, cwd: string, eEnv: Record<string, string>,
  sourceRefs: number[],
  budget?: WorkBudgetTracker,
): Promise<{ valid: boolean; error?: string }> {
  if (sourceRefs.length === 0) {
    return { valid: false, error: "L3 general lesson requires at least 1 validated project knowledge source" };
  }
  const sourceEnvelopes: MemoryEnvelope[] = [];
  for (const r of sourceRefs) {
    if (budget && !budget.hasBudget(1)) break;
    const item = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, r, axes, cwd, eEnv));
    if (budget) budget.charge("get", 1);
    if (item.code === 0 && item.stdout.trim()) {
      const { envelope } = decodePayload(item.stdout.trim());
      if (envelope.level !== "L2" || envelope.lifecycle !== "supported") {
        return { valid: false, error: `source ref ${r} is not a supported L2 project invariant` };
      }
      sourceEnvelopes.push(envelope);
    }
  }
  if (sourceRefs.length >= 2) {
    const distinctScopes = new Set(sourceEnvelopes.map((e) => e.context?.project || e.context?.subsystem).filter(Boolean));
    if (distinctScopes.size < 2) {
      return { valid: false, error: "cannot generalize L3 across a single project scope" };
    }
  }
  return { valid: true };
}

async function executeConsolidate(
  envSource: EnvSource, params: Record<string, unknown>, ctx: PiCtx,
): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }> {
  try {
    const env = await envSource(ctx);
    if (env.cfg.qmapBin === "") return { content: [{ type: "text", text: "mm unavailable: qmap binary not found" }], details: { error: "no-qmap" } };
    const mode = typeof params["mode"] === "string" ? params["mode"] : "manual";
    if (mode === "status") {
      const cwd = memDir(env);
      const journal = await readConsolidationJournal(cwd);
      const eligibility = checkConsolidationEligibility(env.cfg, journal, env.nowProvider());
      return exportDetail({
        status: "ok",
        pendingScopes: eligibility.eligibleL2Scopes,
        pendingL3: eligibility.eligibleL3,
        dirtyScopes: journal.dirtyScopes,
        dirtyL2: journal.dirtyL2,
        thresholds: {
          l2: env.cfg.consolidateL2Threshold ?? 3,
          l3: env.cfg.consolidateL3Threshold ?? 2,
          maxAgeHours: env.cfg.consolidateMaxAgeHours,
          batchLimit: env.cfg.consolidateBatchLimit ?? 20,
        },
        lastRun: journal.lastRun ?? null,
        lastStats: journal.lastStats ?? null,
      });
    }
    if (mode === "auto") {
      const l0Res = await runAutoConsolidation(env, ctx);
      const defRes = await runDeferredConsolidation(env, ctx, {
        force: params["force"] !== false,
        targetLevel: params["targetLevel"] as "L1" | "L2" | "L3" | undefined,
        scope: typeof params["scope"] === "string" ? params["scope"] : undefined,
      });
      const l0Details = l0Res.details as { createdL1?: number[] };
      const defDetails = defRes.details as { createdL2?: number[]; createdL3?: number[]; l3Status?: string; operations?: OperationStats };
      const createdL1 = l0Details.createdL1 || [];
      const createdL2 = defDetails.createdL2 || [];
      const createdL3 = defDetails.createdL3 || [];
      return exportDetail({
        mode: "auto",
        createdL1,
        createdL2,
        createdL3,
        totalCreated: createdL1.length + createdL2.length + createdL3.length,
        l3Status: defDetails.l3Status || "deferred",
        operations: defDetails.operations,
      });
    }
    if (mode === "deferred") {
      return await runDeferredConsolidation(env, ctx, {
        force: params["force"] === true,
        targetLevel: params["targetLevel"] as "L1" | "L2" | "L3" | undefined,
        scope: typeof params["scope"] === "string" ? params["scope"] : undefined,
      });
    }

    const targetLevel = params["targetLevel"] as MipmapLevel;
    const sourceRefs = (params["sourceRefs"] as number[]) || [];
    const summary = typeof params["summary"] === "string" ? params["summary"].trim() : "";
    const problem = typeof params["problem"] === "string" ? params["problem"].trim() : undefined;
    const context = params["context"] as MemoryContext | undefined;
    const tags = params["tags"] as string[] | undefined;

    if (!summary || sourceRefs.length === 0) return { content: [{ type: "text", text: "mm consolidate: summary and non-empty sourceRefs required" }], details: { error: "invalid-params" } };
    if (targetLevel === "L2" && (!context || (!context.project && !context.module && !context.subsystem && !context.subject))) {
      return { content: [{ type: "text", text: "mm consolidate: L2 knowledge requires explicit scope (context.project/subsystem/module/subject)" }], details: { error: "scope-required" } };
    }

    const cwd = memDir(env);
    const fspec = filespecFor(cwd, sepalConfigured(env.cfg));
    const axes = axisPath(env);
    const eEnv = embedEnv(env.cfg);

    return await withLock(cwd, async () => {
      const { valid, error, missing } = await validateSources(env, fspec, axes, cwd, eEnv, sourceRefs, targetLevel, "supported");
      if (!valid) {
        const errType = error?.includes("cannot use") ? "invalid-level-transition" : "invalid-source";
        if (error) return { content: [{ type: "text", text: `mm consolidate: ${error}` }], details: { error: errType } };
        return { content: [{ type: "text", text: `mm consolidate: supporting evidence refs missing: ${missing.join(", ")}` }], details: { error: "missing-sources", missing } };
      }

      if (targetLevel === "L3") {
        const l3Val = await validateL3Generalization(env, fspec, axes, cwd, eEnv, sourceRefs);
        if (!l3Val.valid) {
          return { content: [{ type: "text", text: `mm consolidate: ${l3Val.error}` }], details: { error: "unsupported-generalization" } };
        }
      }

      const list = await env.runner.run(buildListInvocation(env.cfg.qmapBin, fspec, axes, cwd, eEnv));
      const allRefs = parseBareRefs(list.stdout);
      const existingRef = await checkIdempotency(env, fspec, axes, cwd, eEnv, allRefs, targetLevel, sourceRefs, summary);
      if (existingRef !== null) return exportDetail({ ref: existingRef, idempotent: true, level: targetLevel, summary, evidence: sourceRefs });

      const date = env.nowProvider().toISOString().slice(0, 10);
      const envelope: MemoryEnvelope = {
        level: targetLevel,
        type: targetLevel === "L1" ? "investigation" : targetLevel === "L2" ? "invariant" : "pattern",
        lifecycle: "supported",
        summary,
        context,
        evidence: sourceRefs,
        tags,
        episode: problem ? { problem, request: problem } : undefined,
      };
      const ref = nextRef(allRefs);
      await advanceRefSeq(cwd, ref + 1);
      const storeRes = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, ref, encodePayload(date, envelope), axes, cwd, eEnv));
      if (storeRes.code !== 0) return { content: [{ type: "text", text: `mm consolidate failed: store error` }], details: { error: "store-error" } };
      return exportDetail({ ref, idempotent: false, level: targetLevel, summary, evidence: sourceRefs });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `mm unavailable: ${msg}` }], details: { error: msg } };
  }
}

export function makeConsolidateTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_consolidate",
    label: "Consolidate Memory Mipmap",
    description: "Consolidate lower-level memories into higher-level abstractions (L1 Investigation, L2 Project Knowledge, L3 General Lesson). Supports manual synthesis and 'auto' discovery.",
    parameters: CONSOLIDATE_PARAMS,
    execute: (_id, params, _sig, _upd, ctx) => executeConsolidate(envSource, params, ctx as PiCtx),
  };
}
