import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MmConfig } from "../config.ts";
import type { QmapRunner } from "../qmap.ts";
import { buildListInvocation, buildGetInvocation } from "../qmap.ts";
import { parseBareRefs } from "../resolve.ts";
import { decodePayload } from "../payload.ts";
import type { MemoryEnvelope } from "../types.ts";

export interface DirtyScopeEntry {
  count: number;
  l1Refs: number[];
  lastUpdated: string;
  activeL2Ref?: number;
  lastStatus?: string;
  lastReason?: string;
  attemptCount?: number;
  lastAttempt?: string;
}

export interface DirtyL2Entry {
  count: number;
  l2Refs: number[];
  lastUpdated: string;
  scopeByRef?: Record<number, string>;
}

export interface InterruptedSuccessor {
  level: string;
  scope?: string;
  predecessorRef: number;
  successorRef: number;
  timestamp: string;
}

export interface PendingL1Transition {
  runId: string;
  predecessorRef?: number;
  successorRef: number;
  sourceL0Refs: number[];
  timestamp: string;
}

export interface ConsolidationJournal {
  version: 1;
  dirtyScopes: Record<string, DirtyScopeEntry>;
  dirtyL2: DirtyL2Entry;
  pendingL0Refs?: number[];
  activeL1ByRunId?: Record<string, number>;
  pendingL1Transitions?: Record<string, PendingL1Transition>;
  pendingL2Scopes: string[];
  pendingL3: boolean;
  activeL3Ref?: number;
  l3Status?: string;
  l3Reason?: string;
  lastRun?: string;
  lastStats?: Record<string, unknown>;
  interruptedSuccessors?: InterruptedSuccessor[];
  recoveryRequired?: boolean;
  recoveryError?: string;
}

export function defaultJournal(): ConsolidationJournal {
  return {
    version: 1,
    dirtyScopes: {},
    dirtyL2: {
      count: 0,
      l2Refs: [],
      lastUpdated: new Date().toISOString(),
    },
    pendingL0Refs: [],
    activeL1ByRunId: {},
    pendingL1Transitions: {},
    pendingL2Scopes: [],
    pendingL3: false,
  };
}

export function journalFilePath(memDir: string): string {
  return join(memDir, ".consolidation.json");
}

export interface JournalRecoveryContext {
  runner: QmapRunner;
  qmapBin: string;
  fspec: string;
  axes: string;
  eEnv?: Record<string, string>;
  l2Threshold?: number;
  l3Threshold?: number;
}

async function handleCorruptedJournal(
  memDir: string,
  reason: string,
  rawContent: string,
  recoveryCtx?: JournalRecoveryContext,
): Promise<ConsolidationJournal> {
  const targetPath = journalFilePath(memDir);
  const corruptPath = `${targetPath}.corrupt.${Date.now()}`;
  try {
    await writeFile(corruptPath, rawContent, "utf8");
  } catch { /* best effort */ }

  console.warn(`[pi-mm] Warning: corrupted consolidation journal detected (${reason}). Preserved at ${corruptPath}. Reconstructing pending work.`);

  const journal = defaultJournal();

  if (!recoveryCtx || !recoveryCtx.qmapBin) {
    journal.recoveryRequired = true;
    journal.recoveryError = `Corrupted journal (${reason}) preserved; waiting for recovery context`;
    await writeConsolidationJournal(memDir, journal).catch(() => {});
    return journal;
  }

  try {
    const listRes = await recoveryCtx.runner.run(buildListInvocation(recoveryCtx.qmapBin, recoveryCtx.fspec, recoveryCtx.axes, memDir, recoveryCtx.eEnv));
    if (listRes.code !== 0) {
      journal.recoveryRequired = true;
      journal.recoveryError = `Roster list failed during recovery: ${listRes.stderr || "exit " + listRes.code}`;
      await writeConsolidationJournal(memDir, journal).catch(() => {});
      return journal;
    }

    const refs = parseBareRefs(listRes.stdout);
    const items: Array<{ ref: number; envelope: MemoryEnvelope }> = [];
    let hadPartialReadError = false;

    for (const r of refs) {
      const getRes = await recoveryCtx.runner.run(buildGetInvocation(recoveryCtx.qmapBin, recoveryCtx.fspec, r, recoveryCtx.axes, memDir, recoveryCtx.eEnv));
      if (getRes.code === 0 && getRes.stdout.trim()) {
        const { envelope } = decodePayload(getRes.stdout.trim());
        items.push({ ref: r, envelope });
      } else {
        hadPartialReadError = true;
      }
    }

    // Gather all cited L1 and L2 refs
    const citedRefs = new Set<number>();
    for (const it of items) {
      if (it.envelope.lifecycle !== "superseded" && it.envelope.lifecycle !== "contradicted") {
        for (const ev of it.envelope.evidence || []) citedRefs.add(ev);
      }
    }

    // Find active uncited L0s to reconstruct pendingL0Refs
    journal.pendingL0Refs = [];
    for (const it of items) {
      if (it.envelope.level === "L0" && it.envelope.lifecycle !== "superseded" && it.envelope.lifecycle !== "contradicted" && !citedRefs.has(it.ref)) {
        if (!journal.pendingL0Refs.includes(it.ref)) {
          journal.pendingL0Refs.push(it.ref);
        }
      }
    }

    // Find active uncited L1s to reconstruct dirtyScopes
    const l2Thresh = recoveryCtx.l2Threshold ?? 3;
    for (const it of items) {
      if (it.envelope.level === "L1" && it.envelope.lifecycle !== "superseded" && it.envelope.lifecycle !== "contradicted" && !citedRefs.has(it.ref)) {
        const scope = it.envelope.context?.project || it.envelope.context?.subsystem || it.envelope.context?.subject || it.envelope.tags?.[0];
        if (scope) {
          const entry = journal.dirtyScopes[scope] ?? { count: 0, l1Refs: [], lastUpdated: new Date().toISOString() };
          if (!entry.l1Refs.includes(it.ref)) {
            entry.l1Refs.push(it.ref);
            entry.count = entry.l1Refs.length;
          }
          journal.dirtyScopes[scope] = entry;
          if (entry.count >= l2Thresh && !journal.pendingL2Scopes.includes(scope)) {
            journal.pendingL2Scopes.push(scope);
          }
        }
      }
    }

    // Find active uncited L2s to reconstruct dirtyL2
    const l3Thresh = recoveryCtx.l3Threshold ?? 2;
    for (const it of items) {
      if (it.envelope.level === "L2" && it.envelope.lifecycle !== "superseded" && it.envelope.lifecycle !== "contradicted" && !citedRefs.has(it.ref)) {
        if (!journal.dirtyL2.l2Refs.includes(it.ref)) {
          journal.dirtyL2.l2Refs.push(it.ref);
          journal.dirtyL2.count = journal.dirtyL2.l2Refs.length;
        }
      }
    }
    if (journal.dirtyL2.count >= l3Thresh) {
      journal.pendingL3 = true;
    }

    if (hadPartialReadError) {
      journal.recoveryRequired = true;
      journal.recoveryError = "Partial record retrieval failure during recovery; unread records may still be pending";
    }
  } catch (err) {
    journal.recoveryRequired = true;
    journal.recoveryError = `Unexpected recovery error: ${err instanceof Error ? err.message : String(err)}`;
  }

  await writeConsolidationJournal(memDir, journal).catch(() => {});
  return journal;
}

/**
 * Reads the persistent consolidation journal.
 * Distinguishes missing journal (clean initialization) from existing corrupted files.
 * Preserves corrupted files for diagnosis and reconstructs pending work.
 */
export async function readConsolidationJournal(
  memDir: string,
  recoveryCtx?: JournalRecoveryContext,
): Promise<ConsolidationJournal> {
  const path = journalFilePath(memDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      return defaultJournal();
    }
    raw = "";
  }

  if (!raw.trim()) {
    return await handleCorruptedJournal(memDir, "empty file", raw, recoveryCtx);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return await handleCorruptedJournal(memDir, `parse error: ${err instanceof Error ? err.message : String(err)}`, raw, recoveryCtx);
  }

  if (typeof parsed !== "object" || parsed === null || (parsed as Record<string, unknown>).version !== 1) {
    return await handleCorruptedJournal(memDir, "schema mismatch", raw, recoveryCtx);
  }

  const rec = parsed as Record<string, unknown>;
  return {
    version: 1,
    dirtyScopes: typeof rec.dirtyScopes === "object" && rec.dirtyScopes !== null ? rec.dirtyScopes as Record<string, DirtyScopeEntry> : {},
    dirtyL2: typeof rec.dirtyL2 === "object" && rec.dirtyL2 !== null ? {
      count: typeof (rec.dirtyL2 as Record<string, unknown>).count === "number" ? (rec.dirtyL2 as Record<string, unknown>).count as number : 0,
      l2Refs: Array.isArray((rec.dirtyL2 as Record<string, unknown>).l2Refs) ? (rec.dirtyL2 as Record<string, unknown>).l2Refs as number[] : [],
      lastUpdated: typeof (rec.dirtyL2 as Record<string, unknown>).lastUpdated === "string" ? (rec.dirtyL2 as Record<string, unknown>).lastUpdated as string : new Date().toISOString(),
      scopeByRef: typeof (rec.dirtyL2 as Record<string, unknown>).scopeByRef === "object" && (rec.dirtyL2 as Record<string, unknown>).scopeByRef !== null
        ? (rec.dirtyL2 as Record<string, unknown>).scopeByRef as Record<number, string>
        : undefined,
    } : defaultJournal().dirtyL2,
    pendingL2Scopes: Array.isArray(rec.pendingL2Scopes) ? rec.pendingL2Scopes as string[] : [],
    pendingL0Refs: Array.isArray(rec.pendingL0Refs) ? rec.pendingL0Refs as number[] : [],
    activeL1ByRunId: typeof rec.activeL1ByRunId === "object" && rec.activeL1ByRunId !== null
      ? rec.activeL1ByRunId as Record<string, number>
      : undefined,
    pendingL1Transitions: typeof rec.pendingL1Transitions === "object" && rec.pendingL1Transitions !== null
      ? rec.pendingL1Transitions as Record<string, PendingL1Transition>
      : undefined,
    pendingL3: Boolean(rec.pendingL3),
    activeL3Ref: typeof rec.activeL3Ref === "number" ? rec.activeL3Ref : undefined,
    l3Status: typeof rec.l3Status === "string" ? rec.l3Status : undefined,
    l3Reason: typeof rec.l3Reason === "string" ? rec.l3Reason : undefined,
    lastRun: typeof rec.lastRun === "string" ? rec.lastRun : undefined,
    lastStats: typeof rec.lastStats === "object" && rec.lastStats !== null ? rec.lastStats as Record<string, unknown> : undefined,
    interruptedSuccessors: Array.isArray(rec.interruptedSuccessors) ? rec.interruptedSuccessors as InterruptedSuccessor[] : undefined,
    recoveryRequired: Boolean(rec.recoveryRequired),
    recoveryError: typeof rec.recoveryError === "string" ? rec.recoveryError : undefined,
  };
}

/**
 * Writes the consolidation journal atomically via temp file.
 */
export async function writeConsolidationJournal(memDir: string, journal: ConsolidationJournal): Promise<void> {
  const targetPath = journalFilePath(memDir);
  const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await mkdir(memDir, { recursive: true });
    const content = JSON.stringify(journal, null, 2);
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Records or updates the active L1 reference for an agent runId in the journal.
 */
export async function recordActiveL1ForRunId(
  memDir: string,
  runId: string,
  l1Ref: number,
): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  journal.activeL1ByRunId = journal.activeL1ByRunId ?? {};
  journal.activeL1ByRunId[runId] = l1Ref;
  await writeConsolidationJournal(memDir, journal);
}

/**
 * Records or updates an active transition for a runId in the journal.
 */
export async function recordPendingL1Transition(
  memDir: string,
  transition: PendingL1Transition,
): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  journal.pendingL1Transitions = journal.pendingL1Transitions ?? {};
  journal.pendingL1Transitions[transition.runId] = transition;
  await writeConsolidationJournal(memDir, journal);
}

/**
 * Clears a resolved transition for a runId from the journal.
 */
export async function clearPendingL1Transition(
  memDir: string,
  runId: string,
): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  if (journal.pendingL1Transitions && journal.pendingL1Transitions[runId]) {
    delete journal.pendingL1Transitions[runId];
    await writeConsolidationJournal(memDir, journal);
  }
}

/**
 * Records newly captured L0 references into pendingL0Refs.
 */
export async function recordNewL0InJournal(
  memDir: string,
  l0Refs: number[],
): Promise<ConsolidationJournal> {
  const journal = await readConsolidationJournal(memDir);
  const existing = journal.pendingL0Refs ?? [];
  const merged = Array.from(new Set([...existing, ...l0Refs]));
  journal.pendingL0Refs = merged;
  await writeConsolidationJournal(memDir, journal);
  return journal;
}

/**
 * Prunes ONLY the explicitly processed/represented L0 references from pendingL0Refs.
 * Preserves all unrepresented and pending L0 references.
 */
export async function pruneProcessedL0InJournal(
  memDir: string,
  processedL0Refs: number[],
): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  const existing = journal.pendingL0Refs ?? [];
  const processedSet = new Set(processedL0Refs);
  journal.pendingL0Refs = existing.filter((r) => !processedSet.has(r));
  await writeConsolidationJournal(memDir, journal);
}

/**
 * Records newly captured or updated L1 references into dirtyScopes.
 * Evaluates against the configured L2 threshold and marks the scope as pending if met.
 * Note: Caller must hold the memDir lock (e.g. within runAutoConsolidation or runDeferredConsolidation).
 */
export async function recordNewL1InJournal(
  memDir: string,
  scope: string,
  l1Refs: number[],
  threshold = 3,
): Promise<ConsolidationJournal> {
  const journal = await readConsolidationJournal(memDir);
  const existing = journal.dirtyScopes[scope] ?? { count: 0, l1Refs: [], lastUpdated: new Date().toISOString() };
  const mergedRefs = Array.from(new Set([...existing.l1Refs, ...l1Refs]));
  const updatedEntry: DirtyScopeEntry = {
    count: mergedRefs.length,
    l1Refs: mergedRefs,
    lastUpdated: new Date().toISOString(),
  };
  journal.dirtyScopes[scope] = updatedEntry;

  if (updatedEntry.count >= threshold && !journal.pendingL2Scopes.includes(scope)) {
    journal.pendingL2Scopes.push(scope);
  }

  await writeConsolidationJournal(memDir, journal);
  return journal;
}

/**
 * Records newly created L2 references into dirtyL2.
 * Evaluates against the configured L3 threshold and marks L3 as pending if met.
 */
export async function recordNewL2InJournal(
  memDir: string,
  l2Refs: number[],
  threshold = 2,
  scopeByRef?: Record<number, string>,
): Promise<ConsolidationJournal> {
  const journal = await readConsolidationJournal(memDir);
  const mergedRefs = Array.from(new Set([...journal.dirtyL2.l2Refs, ...l2Refs]));
  const mergedScopes = { ...(journal.dirtyL2.scopeByRef ?? {}), ...(scopeByRef ?? {}) };
  journal.dirtyL2 = {
    count: mergedRefs.length,
    l2Refs: mergedRefs,
    lastUpdated: new Date().toISOString(),
    scopeByRef: mergedScopes,
  };

  if (journal.dirtyL2.count >= threshold) {
    journal.pendingL3 = true;
  }

  await writeConsolidationJournal(memDir, journal);
  return journal;
}

/**
 * Prunes ONLY the explicitly represented L1 references from a scope's dirty queue.
 * Retains all unrepresented, uncited, and unprocessed L1 evidence.
 */
export async function pruneProcessedL1InJournal(
  memDir: string,
  scope: string,
  representedL1Refs: number[],
  activeL2Ref?: number,
  status = "consolidated",
  threshold = 3,
): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  const existing = journal.dirtyScopes[scope] ?? {
    count: 0,
    l1Refs: [],
    lastUpdated: new Date().toISOString(),
  };

  const representedSet = new Set(representedL1Refs);
  const remainingL1Refs = existing.l1Refs.filter((r) => !representedSet.has(r));

  journal.dirtyScopes[scope] = {
    count: remainingL1Refs.length,
    l1Refs: remainingL1Refs,
    lastUpdated: new Date().toISOString(),
    activeL2Ref: activeL2Ref ?? existing.activeL2Ref,
    lastStatus: status,
    lastReason: undefined,
    attemptCount: (existing.attemptCount ?? 0) + 1,
    lastAttempt: new Date().toISOString(),
  };

  if (remainingL1Refs.length >= threshold) {
    if (!journal.pendingL2Scopes.includes(scope)) journal.pendingL2Scopes.push(scope);
  } else {
    journal.pendingL2Scopes = journal.pendingL2Scopes.filter((s) => s !== scope);
  }

  await writeConsolidationJournal(memDir, journal);
}

/**
 * Marks dirty scopes or levels as processed in the journal.
 */
export async function clearProcessedScopeInJournal(memDir: string, scope: string, activeL2Ref?: number): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  const existing = journal.dirtyScopes[scope];
  if (activeL2Ref !== undefined || existing?.activeL2Ref !== undefined) {
    // Preserve the activeL2Ref pointer for this scope while clearing dirty L1 refs
    journal.dirtyScopes[scope] = {
      count: 0,
      l1Refs: [],
      lastUpdated: new Date().toISOString(),
      activeL2Ref: activeL2Ref ?? existing?.activeL2Ref,
      lastStatus: "consolidated",
      lastReason: undefined,
      attemptCount: 0,
      lastAttempt: new Date().toISOString(),
    };
  } else {
    delete journal.dirtyScopes[scope];
  }
  journal.pendingL2Scopes = journal.pendingL2Scopes.filter((s) => s !== scope);
  await writeConsolidationJournal(memDir, journal);
}

/**
 * Updates a scope's outcome without discarding dirty work when consolidation fails, is unavailable, or deferred.
 */
export async function recordScopeOutcomeInJournal(
  memDir: string,
  scope: string,
  outcome: { status: string; reason?: string },
  activeL2Ref?: number,
): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  const existing = journal.dirtyScopes[scope] ?? {
    count: 0,
    l1Refs: [],
    lastUpdated: new Date().toISOString(),
  };

  if (outcome.status === "consolidated" || outcome.status === "idempotent") {
    journal.dirtyScopes[scope] = {
      count: 0,
      l1Refs: [],
      lastUpdated: new Date().toISOString(),
      activeL2Ref: activeL2Ref ?? existing.activeL2Ref,
      lastStatus: outcome.status,
      lastReason: outcome.reason,
      attemptCount: 0,
      lastAttempt: new Date().toISOString(),
    };
    journal.pendingL2Scopes = journal.pendingL2Scopes.filter((s) => s !== scope);
  } else {
    // Retain dirty references and count; record status, reason, and increment attempt count
    journal.dirtyScopes[scope] = {
      ...existing,
      activeL2Ref: activeL2Ref ?? existing.activeL2Ref,
      lastStatus: outcome.status,
      lastReason: outcome.reason,
      attemptCount: (existing.attemptCount ?? 0) + 1,
      lastAttempt: new Date().toISOString(),
    };
  }

  await writeConsolidationJournal(memDir, journal);
}

/**
 * Updates L3 outcome in the journal.
 * When representedL2Refs are provided on "synthesized" or "idempotent", removes ONLY
 * those specific references, strictly preserving all unprocessed L2 references in queue.
 */
export async function recordL3OutcomeInJournal(
  memDir: string,
  outcome: { status: string; reason?: string },
  activeL3Ref?: number,
  representedL2Refs?: number[],
  l3Threshold = 2,
): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  if ((outcome.status === "synthesized" || outcome.status === "idempotent") && representedL2Refs && representedL2Refs.length > 0) {
    const representedSet = new Set(representedL2Refs);
    const remainingL2Refs = journal.dirtyL2.l2Refs.filter((r) => !representedSet.has(r));
    const remainingScopes: Record<number, string> = {};
    if (journal.dirtyL2.scopeByRef) {
      for (const r of remainingL2Refs) {
        if (journal.dirtyL2.scopeByRef[r]) remainingScopes[r] = journal.dirtyL2.scopeByRef[r];
      }
    }
    journal.dirtyL2 = {
      count: remainingL2Refs.length,
      l2Refs: remainingL2Refs,
      lastUpdated: new Date().toISOString(),
      scopeByRef: remainingScopes,
    };
    journal.pendingL3 = remainingL2Refs.length >= l3Threshold;
    if (activeL3Ref !== undefined) {
      journal.activeL3Ref = activeL3Ref;
    }
  } else {
    // Missing reference lists must NEVER clear everything.
    // Retain dirty queue and preserve pending state.
    if (activeL3Ref !== undefined) {
      journal.activeL3Ref = activeL3Ref;
    }
  }
  journal.l3Status = outcome.status;
  journal.l3Reason = outcome.reason;
  await writeConsolidationJournal(memDir, journal);
}

/**
 * Records an interrupted successor update (predecessor update failed after successor created).
 */
export async function recordInterruptedSuccessorInJournal(
  memDir: string,
  successor: InterruptedSuccessor,
): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  journal.interruptedSuccessors = journal.interruptedSuccessors ?? [];
  // Avoid duplicate tracking of the same successor
  if (!journal.interruptedSuccessors.some((s) => s.successorRef === successor.successorRef)) {
    journal.interruptedSuccessors.push(successor);
  }
  await writeConsolidationJournal(memDir, journal);
}

/**
 * Clears a resolved interrupted successor.
 */
export async function clearInterruptedSuccessorInJournal(
  memDir: string,
  successorRef: number,
): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  if (journal.interruptedSuccessors) {
    journal.interruptedSuccessors = journal.interruptedSuccessors.filter((s) => s.successorRef !== successorRef);
    await writeConsolidationJournal(memDir, journal);
  }
}

/**
 * Marks dirty L2 as processed in the journal.
 */
export async function clearProcessedL2InJournal(memDir: string): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  journal.dirtyL2 = {
    count: 0,
    l2Refs: [],
    lastUpdated: new Date().toISOString(),
  };
  journal.pendingL3 = false;
  await writeConsolidationJournal(memDir, journal);
}

/**
 * Records completion timestamp and statistics for a consolidation run.
 */
export async function recordRunStatsInJournal(
  memDir: string,
  stats: Record<string, unknown>,
): Promise<void> {
  const journal = await readConsolidationJournal(memDir);
  journal.lastRun = new Date().toISOString();
  journal.lastStats = stats;
  await writeConsolidationJournal(memDir, journal);
}

export interface ConsolidationEligibility {
  eligibleL2Scopes: string[];
  eligibleL3: boolean;
  reasons: Record<string, string>;
  totalPendingL1: number;
  totalPendingL2: number;
}

/**
 * Fast, non-blocking check to determine whether any scopes or levels meet consolidation thresholds.
 * Zero model/inference calls.
 */
export function checkConsolidationEligibility(
  cfg: MmConfig,
  journal: ConsolidationJournal,
  now = new Date(),
  ignoreBackoff = false,
): ConsolidationEligibility {
  const l2Threshold = cfg.consolidateL2Threshold ?? 3;
  const l3Threshold = cfg.consolidateL3Threshold ?? 2;
  const maxAgeHours = cfg.consolidateMaxAgeHours;

  const eligibleL2Scopes: string[] = [];
  const reasons: Record<string, string> = {};
  let totalPendingL1 = 0;

  for (const [scope, entry] of Object.entries(journal.dirtyScopes)) {
    totalPendingL1 += entry.count;

    // Check backoff threshold for repeatedly failing scopes (unless ignoreBackoff is true)
    if (!ignoreBackoff && (entry.attemptCount ?? 0) >= 3 && entry.lastAttempt && entry.lastStatus && entry.lastStatus !== "consolidated") {
      const lastAttemptTime = new Date(entry.lastAttempt).getTime();
      const backoffMinutes = Math.min(30, Math.pow(2, (entry.attemptCount ?? 3) - 3) * 5);
      if (now.getTime() - lastAttemptTime < backoffMinutes * 60 * 1000) {
        // Scope is in backoff cooldown to avoid retry loops
        continue;
      }
    }

    let isEligible = entry.count >= l2Threshold || journal.pendingL2Scopes.includes(scope);
    if (!isEligible && maxAgeHours && maxAgeHours > 0) {
      const updatedTime = new Date(entry.lastUpdated).getTime();
      const ageHours = (now.getTime() - updatedTime) / (1000 * 60 * 60);
      if (ageHours >= maxAgeHours) {
        isEligible = true;
        reasons[scope] = `Max age exceeded (${ageHours.toFixed(1)}h >= ${maxAgeHours}h)`;
      }
    }
    if (isEligible) {
      eligibleL2Scopes.push(scope);
      if (!reasons[scope]) {
        reasons[scope] = `Threshold met (${entry.count} >= ${l2Threshold})`;
      }
    }
  }

  let eligibleL3 = journal.dirtyL2.count >= l3Threshold || journal.pendingL3;
  const totalPendingL2 = journal.dirtyL2.count;
  if (!eligibleL3 && maxAgeHours && maxAgeHours > 0 && totalPendingL2 > 0) {
    const updatedTime = new Date(journal.dirtyL2.lastUpdated).getTime();
    const ageHours = (now.getTime() - updatedTime) / (1000 * 60 * 60);
    if (ageHours >= maxAgeHours) {
      eligibleL3 = true;
      reasons["L3"] = `Max age exceeded (${ageHours.toFixed(1)}h >= ${maxAgeHours}h)`;
    }
  }
  if (eligibleL3 && !reasons["L3"]) {
    reasons["L3"] = `Threshold met (${totalPendingL2} >= ${l3Threshold})`;
  }

  return {
    eligibleL2Scopes,
    eligibleL3,
    reasons,
    totalPendingL1,
    totalPendingL2,
  };
}
