import type { EnvSource } from "../tools/index.ts";
import { axisPath, memDir, sepalConfigured } from "../tools/index.ts";
import { describeCapabilities } from "../config.ts";
import { evaluateTurnWithJudge } from "../judge/adapter.ts";
import type { JudgeDecision } from "../judge/types.ts";
import { filespecFor, buildStoreInvocation, buildGetInvocation, buildListInvocation, embedEnv } from "../qmap.ts";
import { allocateNextRef } from "../tools/ref_allocator.ts";
import { parseBareRefs } from "../resolve.ts";
import { encodePayload, decodePayload } from "../payload.ts";
import { withLock } from "../lock.ts";
import type { MemoryEnvelope, EpisodeRecord, MemoryContext } from "../types.ts";
import { handleBeforeAgentStart, type BeforeAgentStartEvent } from "./auto_recall.ts";
import { validateEvidenceRef } from "../tools/lifecycle.ts";
import { executeHybridScan } from "../tools/scan.ts";
import { runAutoConsolidation, runDeferredConsolidation } from "../tools/consolidate.ts";
import { recordNewL0InJournal } from "../tools/consolidation_journal.ts";
import { debugLog, traceEvent } from "../debug.ts";
import { isDaemonLockHeld } from "../daemon.ts";
import { readFile, writeFile, unlink, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

export interface PiToolSpec {
  name: string; label: string; description: string; parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiCtx) => Promise<PiAgentToolResult>;
}
export interface PiAgentToolResult { content: Array<{ type: string; text?: string }>; details?: unknown; }
export interface PiExecResult { stdout: string; stderr: string; code: number; }
export interface PiCtx {
  cwd: string;
  hasUI: boolean;
  mode: string;
  ui?: unknown;
  sessionId?: string;
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string;
    getLeafId?: () => string;
    id?: string;
    sessionId?: string;
  };
}

export interface ToolResultEvent {
  toolCallId?: string; toolName: string; input?: Record<string, unknown>; args?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown;
}

export interface SignificantEvent {
  id: string; timestamp: string; toolName: string; summary: string; isError: boolean;
  approach?: string; outcome?: "worked" | "failed" | "abandoned"; diffs?: string[];
  environment?: Record<string, string>; toolArgs?: Record<string, unknown>;
  evidence?: number[];
}

export function extractSessionId(ctx?: PiCtx): string {
  if (!ctx) return "unknown-session";
  const sm = ctx.sessionManager ||
    ((ctx as unknown as Record<string, unknown>)?.sessionManager as
      | { getSessionId?: () => string; id?: string; sessionId?: string }
      | undefined);
  return (
    sm?.getSessionId?.() ||
    sm?.id ||
    sm?.sessionId ||
    ctx.sessionId ||
    ((ctx as unknown as Record<string, unknown>)?.sessionId as string) ||
    (typeof process !== "undefined" ? process.env?.["PI_SESSION_ID"] : undefined) ||
    (typeof Deno !== "undefined" ? Deno.env.get("PI_SESSION_ID") : undefined) ||
    "unknown-session"
  );
}

export interface Pi {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerTool(tool: PiToolSpec): void;
  exec(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<PiExecResult>;
}

export class SessionEventBuffer {
  private events: SignificantEvent[] = [];
  private inFlightBatch: SignificantEvent[] | null = null;
  private maxEvents = 50; private flushedEventIds = new Set<string>(); private journaledEventIds = new Set<string>();
  private journalDir: string | null = null; private journalQueue: Promise<void> = Promise.resolve();
  private isFlushing = false; public lastError: string | null = null; public hasOverflow = false; public overflowCount = 0;
  public _testHooks?: { onBeforeRename?: (snapshot: SignificantEvent[]) => Promise<void> | void };

  public setJournalDir(dir: string): void { this.journalDir = dir; }
  public clear(): void {
    this.events = []; this.inFlightBatch = null;
    this.flushedEventIds.clear(); this.journaledEventIds.clear();
    this.lastError = null; this.isFlushing = false; this.hasOverflow = false; this.overflowCount = 0;
  }
  public onSessionStart(): void {
    this.events = this.events.filter((e) => !this.flushedEventIds.has(e.id));
    if (!this.isFlushing) this.inFlightBatch = null;
  }
  public isJournaled(id: string): boolean { return this.journaledEventIds.has(id); }
  public record(event: SignificantEvent): void {
    if (this.flushedEventIds.has(event.id) || this.journaledEventIds.has(event.id)) return;
    const alreadyBuffered = this.events.some((e) => e.id === event.id);
    if (!alreadyBuffered) {
      if (this.events.length >= this.maxEvents) {
        this.hasOverflow = true; this.overflowCount++;
        this.lastError = `buffer-overflow: capacity exceeded (${this.maxEvents} events)`;
      }
      this.events.push(event);
    }
    if (this.journalDir) {
      void this.saveJournal(this.journalDir).catch(() => {});
    }
  }
  public async recordAsync(event: SignificantEvent): Promise<void> {
    if (this.flushedEventIds.has(event.id) || this.journaledEventIds.has(event.id)) return;
    const alreadyBuffered = this.events.some((e) => e.id === event.id);
    if (!alreadyBuffered) {
      if (this.events.length >= this.maxEvents) {
        this.hasOverflow = true; this.overflowCount++;
        this.lastError = `buffer-overflow: capacity exceeded (${this.maxEvents} events)`;
      }
      this.events.push(event);
    }
    if (!this.journalDir) {
      this.lastError = "journal-error: journalDir has not been initialized";
      throw new Error("journal-error: journalDir has not been initialized");
    }
    await this.saveJournal(this.journalDir);
  }
  public getOverflowStatus(): { hasOverflow: boolean; overflowCount: number } {
    return { hasOverflow: this.hasOverflow, overflowCount: this.overflowCount };
  }
  public getEvents(): readonly SignificantEvent[] { return this.events; }
  public hasUnflushed(): boolean { return this.events.some((e) => !this.flushedEventIds.has(e.id)); }
  public getUnflushed(): SignificantEvent[] { return this.events.filter((e) => !this.flushedEventIds.has(e.id)); }
  public beginFlush(): SignificantEvent[] | null {
    if (this.isFlushing) return null;
    const unflushed = this.getUnflushed();
    if (unflushed.length === 0) return null;
    this.isFlushing = true;
    this.inFlightBatch = [...unflushed];
    return this.inFlightBatch;
  }
  public commitFlush(ids: string[]): void {
    for (const id of ids) {
      this.flushedEventIds.add(id);
      this.journaledEventIds.delete(id);
    }
    this.inFlightBatch = null; this.isFlushing = false; this.lastError = null;
    this.events = this.events.filter((e) => !this.flushedEventIds.has(e.id));
    if (this.events.length <= this.maxEvents) { this.hasOverflow = false; this.overflowCount = 0; }
  }
  public markFlushed(_fingerprint: string, ids: string[]): void { this.commitFlush(ids); }
  public getApproaches(): Array<{ approach: string; outcome: "worked" | "failed" | "abandoned"; reason?: string }> {
    return extractBatchApproaches(this.getUnflushed());
  }
  public getDiffs(): string[] { return extractBatchDiffs(this.getUnflushed()); }
  public rollbackFlush(err?: string): void {
    this.inFlightBatch = null; this.isFlushing = false;
    if (err) this.lastError = err;
  }

  public async saveJournal(dir: string): Promise<void> {
    const journalFile = join(dir, ".pending_events.json");
    this.journalQueue = this.journalQueue.catch(() => {}).then(async () => {
      // 1. Select the snapshot inside the serialized journal operation
      const snapshot = this.getUnflushed();
      const tmpJournal = `${journalFile}.tmp.${Date.now()}.${crypto.randomUUID()}`;
      try {
        await mkdir(dir, { recursive: true });
        if (snapshot.length === 0) {
          await unlink(journalFile).catch(() => {});
        } else {
          // 2. Write that exact snapshot to the unique temporary file
          await writeFile(tmpJournal, JSON.stringify(snapshot));
          if (this._testHooks?.onBeforeRename) {
            await this._testHooks.onBeforeRename(snapshot);
          }
          // 3. Atomically rename it into place
          await rename(tmpJournal, journalFile);
        }
        // 4. Only after successful rename, mark the IDs in that snapshot as journaled
        for (const e of snapshot) {
          this.journaledEventIds.add(e.id);
        }
        if (this.lastError?.startsWith("journal-error:")) this.lastError = null;
      } catch (err: unknown) {
        await unlink(tmpJournal).catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = `journal-error: ${msg}`;
        throw new Error(`journal-error: ${msg}`);
      }
    });
    await this.journalQueue;
  }

  public async restoreJournal(dir: string, existingEventIds?: Set<string>): Promise<number> {
    const journalFile = join(dir, ".pending_events.json");
    try {
      const data = await readFile(journalFile, "utf-8");
      let loaded: SignificantEvent[];
      try {
        loaded = JSON.parse(data);
        if (!Array.isArray(loaded)) throw new Error("journal content is not an array");
      } catch (parseErr: unknown) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        this.lastError = `journal-restore-error: invalid json in ${journalFile}: ${msg}`;
        return 0;
      }
      let count = 0;
      for (const ev of loaded) {
        if (!ev || !ev.id) continue;
        if (existingEventIds?.has(ev.id)) { this.flushedEventIds.add(ev.id); continue; }
        if (!this.flushedEventIds.has(ev.id) && !this.events.some((e) => e.id === ev.id)) {
          this.events.push(ev);
          this.journaledEventIds.add(ev.id);
          count++;
        }
      }
      await this.saveJournal(dir);
      return count;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "ENOENT") return 0; // Benign clean-start
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = `journal-restore-error: ${msg}`;
      return 0;
    }
  }
}

export const activeSessionBuffer = new SessionEventBuffer();

export function extractBatchApproaches(batch: SignificantEvent[]): Array<{ approach: string; outcome: "worked" | "failed" | "abandoned"; reason?: string }> {
  return batch.filter((e) => e.approach && e.outcome).map((e) => ({
    approach: e.approach!, outcome: e.outcome!, reason: e.summary,
  }));
}

export function extractBatchDiffs(batch: SignificantEvent[]): string[] {
  const diffs: string[] = [];
  for (const e of batch) if (e.diffs) diffs.push(...e.diffs);
  return diffs;
}

export function summarizeToolEvent(event: ToolResultEvent): SignificantEvent | null {
  const isErr = Boolean(event.isError);
  const text = event.content?.map((c) => c.text || "").join(" ").trim() || "";
  const cmd = String(event.input?.["command"] || event.args?.["command"] || "");
  const hasErrorWord = /\b(?:FAIL|failed|error|fatal|panic)\b/i.test(text.replace(/0\s+failed/gi, ""));
  const failed = isErr || hasErrorWord;

  const isVerification = /test|check|verify|smoke/i.test(event.toolName) ||
                         /test|check|make|deno|cargo|npm/i.test(cmd) ||
                         /test|PASS|check-complexity|integration|ok\s+\d+|all green/i.test(text);
  const verifiedWorked = !failed && isVerification && (/PASS|passed|all green|ok\s+-|0 failed/i.test(text));

  // Filter out routine, non-error bash invocations and low-value tool calls without verification signals
  if (event.toolName === "bash" && !failed && !verifiedWorked) {
    return null;
  }

  const isTest = isVerification;
  const isCodeMod = /edit|write|patch/i.test(event.toolName);
  if (!isTest && !failed && !isCodeMod) return null;

  const outcome: "worked" | "failed" | undefined = failed ? "failed" : verifiedWorked ? "worked" : undefined;
  const firstLine = text.split("\n")[0]?.slice(0, 160) || `Executed ${event.toolName}`;
  const id = event.toolCallId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const toolArgs = event.input ? { ...event.input } : event.args ? { ...event.args } : undefined;

  return {
    id, timestamp: new Date().toISOString(), toolName: event.toolName, summary: firstLine,
    isError: failed, approach: outcome ? `Executed ${event.toolName}: ${firstLine.slice(0, 80)}` : undefined,
    outcome, environment: { runtime: typeof Deno !== "undefined" ? "deno" : "node" }, toolArgs,
  };
}

export function extractReliableProjectContext(
  ctx: PiCtx,
  batch?: SignificantEvent[],
): MemoryContext | undefined {
  const explicitCtx = ((ctx as unknown as Record<string, unknown>).context as MemoryContext | undefined);
  let project = explicitCtx?.project;
  let subsystem = explicitCtx?.subsystem;
  let moduleName = explicitCtx?.module;

  if (!project && ctx.cwd) {
    const norm = ctx.cwd.replace(/\/+$/, "");
    const isTmp = norm.startsWith("/tmp") || norm.startsWith("/var/tmp") || norm.includes("/tmp/") || norm.includes("/var/tmp/");
    if (!isTmp) {
      const base = norm.split("/").filter(Boolean).pop();
      if (base && !base.startsWith("mm-")) {
        project = base;
      }
    }
  }

  if (batch && batch.length > 0) {
    const touchedPaths: string[] = [];
    for (const e of batch) {
      if (typeof e.toolArgs?.path === "string") touchedPaths.push(e.toolArgs.path);
      if (typeof e.toolArgs?.file === "string") touchedPaths.push(e.toolArgs.file);
      if (Array.isArray(e.diffs)) {
        for (const d of e.diffs) {
          if (typeof d === "string") touchedPaths.push(d);
        }
      }
    }
    if (touchedPaths.length > 0) {
      for (const p of touchedPaths) {
        const cleanP = p.replace(/^\.\//, "");
        const parts = cleanP.split("/").filter(Boolean);
        if (parts.length >= 2) {
          if (parts[0] === "mods" || parts[0] === "external" || parts[0] === "packages") {
            if (!subsystem) subsystem = parts[0];
            if (!moduleName) moduleName = parts[1];
            if (!project && parts[0] === "packages") project = parts[1];
            break;
          } else if (parts[0] === "src") {
            if (!moduleName) moduleName = parts[1] || parts[0];
            break;
          }
        }
      }
    }
  }

  if (project || subsystem || moduleName) {
    return {
      project,
      subsystem,
      module: moduleName,
    };
  }
  return undefined;
}

let activeFlushPromise: Promise<number | null> | null = null;

async function executeBatchFlush(
  batch: SignificantEvent[], envSource: EnvSource, ctx: PiCtx,
): Promise<number | null> {
  const ids = batch.map((e) => e.id);
  const firstEvent = batch[0];
  const approaches = extractBatchApproaches(batch);
  const hasFail = batch.some((e) => e.isError);

  try {
    const env = await envSource(ctx);
    if (!env.cfg.qmapBin) { activeSessionBuffer.rollbackFlush("qmap-not-found"); return null; }

    const sessionManager = ctx.sessionManager ||
      ((ctx as unknown as Record<string, unknown>)?.sessionManager as
        | { getSessionId?: () => string; getSessionFile?: () => string; getLeafId?: () => string; id?: string; sessionId?: string }
        | undefined);
    const sessionId = sessionManager?.getSessionId?.() ||
      sessionManager?.id ||
      sessionManager?.sessionId ||
      ctx.sessionId ||
      ((ctx as unknown as Record<string, unknown>)?.sessionId as string) ||
      (typeof process !== "undefined" ? process.env?.["PI_SESSION_ID"] : undefined) ||
      (typeof Deno !== "undefined" ? Deno.env.get("PI_SESSION_ID") : undefined);
    const sessionFile = sessionManager?.getSessionFile?.() ||
      (typeof process !== "undefined" ? process.env?.["PI_SESSION_FILE"] : undefined) ||
      (typeof Deno !== "undefined" ? Deno.env.get("PI_SESSION_FILE") : undefined);
    const leafId = sessionManager?.getLeafId?.();

    const episode: EpisodeRecord = {
      request: activeConversationTurn.prompt || undefined,
      problem: firstEvent.summary,
      approaches: approaches.length > 0 ? approaches : undefined,
      environment: firstEvent.environment,
      outcome: hasFail ? "failure" : approaches.some((a) => a.outcome === "worked") ? "success" : "observed",
      eventIds: ids,
      sessionId: sessionId ?? undefined,
      sessionFile: sessionFile ?? undefined,
      leafId: leafId ?? undefined,
      runId: activeConversationTurn.activeRunId,
      toolCallId: firstEvent.id,
    };

    // Collect any explicit evidence references from events in the batch
    const candidateEvidence: number[] = [];
    for (const e of batch) {
      if (Array.isArray(e.evidence)) {
        for (const ev of e.evidence) {
          if (Number.isInteger(ev) && ev > 0 && !candidateEvidence.includes(ev)) {
            candidateEvidence.push(ev);
          }
        }
      }
    }

    let lifecycle: import("../types.ts").LifecycleState = "observed";
    let validatedEvidence: number[] | undefined;

    if (episode.outcome === "success") {
      if (candidateEvidence.length > 0) {
        let allValid = true;
        for (const evRef of candidateEvidence) {
          const evCheck = await validateEvidenceRef(env, evRef);
          if (!evCheck.valid) {
            allValid = false;
            break;
          }
        }
        if (allValid) {
          lifecycle = "supported";
          validatedEvidence = candidateEvidence;
        } else {
          lifecycle = "tested";
        }
      } else {
        // Without validated supporting evidence, successful outcomes remain at "tested"
        lifecycle = "tested";
      }
    } else {
      lifecycle = "observed";
    }

    const context = extractReliableProjectContext(ctx, batch);

    const envelope: MemoryEnvelope = {
      level: "L0",
      type: "episode",
      lifecycle,
      summary: firstEvent.summary,
      evidence: validatedEvidence,
      context,
      episode,
    };
    const date = env.nowProvider().toISOString().slice(0, 10);
    const payload = encodePayload(date, envelope);
    const cwd = memDir(env);
    const axes = axisPath(env);
    const embed = sepalConfigured(env.cfg);
    const fspec = filespecFor(cwd, embed);
    const eEnv = embedEnv(env.cfg);

    return await withLock(cwd, async () => {
      const ref = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv);
      const res = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, ref, payload, axes, cwd, eEnv));
      if (res.code === 0) {
        activeSessionBuffer.commitFlush(ids);
        await activeSessionBuffer.saveJournal(cwd).catch(() => {});
        await recordNewL0InJournal(cwd, [ref]).catch(() => {});
        return ref;
      }
      activeSessionBuffer.rollbackFlush(`store-failed-code-${res.code}: ${res.stderr}`);
      await activeSessionBuffer.saveJournal(cwd).catch(() => {});
      return null;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    activeSessionBuffer.rollbackFlush(msg);
    return null;
  }
}

export async function flushSessionBuffer(envSource: EnvSource, ctx: PiCtx): Promise<number | null> {
  while (activeFlushPromise) { await activeFlushPromise; }
  const batch = activeSessionBuffer.beginFlush();
  if (!batch || batch.length === 0) return null;
  activeFlushPromise = executeBatchFlush(batch, envSource, ctx);
  try { return await activeFlushPromise; } finally { activeFlushPromise = null; }
}

export interface ActiveConversationTurn {
  prompt?: string;
  response?: string;
  responses?: string[];
  timestamp?: string;
  activeMemoryRef?: number;
  activeSessionId?: string;
  previousUserPrompt?: string;
  previousAssistantResponse?: string;
  topicSubject?: string;
  activeRunId?: string;
}

export const activeConversationTurn: ActiveConversationTurn = {};

export interface ConversationalClassification {
  meaningful: boolean;
  type?: "note" | "decision" | "episode";
  level?: "L0" | "L1" | "L2";
  summary?: string;
  problem?: string;
  findings?: string[];
  evidence?: number[];
  context?: MemoryContext;
}

export async function persistConversationalMemory(
  classification: ConversationalClassification,
  envSource: EnvSource,
  ctx: PiCtx,
): Promise<number | null> {
  try {
    const env = await envSource(ctx);
    if (!env.cfg.qmapBin || !classification.meaningful || !classification.summary) return null;

    const sessionManager = ctx.sessionManager ||
      ((ctx as unknown as Record<string, unknown>)?.sessionManager as
        | { getSessionId?: () => string; getSessionFile?: () => string; getLeafId?: () => string; id?: string; sessionId?: string }
        | undefined);
    const sessionId = sessionManager?.getSessionId?.() ||
      sessionManager?.id ||
      sessionManager?.sessionId ||
      ctx.sessionId ||
      ((ctx as unknown as Record<string, unknown>)?.sessionId as string) ||
      (typeof process !== "undefined" ? process.env?.["PI_SESSION_ID"] : undefined) ||
      (typeof Deno !== "undefined" ? Deno.env.get("PI_SESSION_ID") : undefined);
    const sessionFile = sessionManager?.getSessionFile?.() ||
      (typeof process !== "undefined" ? process.env?.["PI_SESSION_FILE"] : undefined) ||
      (typeof Deno !== "undefined" ? Deno.env.get("PI_SESSION_FILE") : undefined);
    const leafId = sessionManager?.getLeafId?.();

    const episode: EpisodeRecord = {
      problem: classification.problem,
      findings: classification.findings,
      outcome: "success",
      sessionId: sessionId ?? undefined,
      sessionFile: sessionFile ?? undefined,
      leafId: leafId ?? undefined,
    };

    const context = classification.context ??
      (activeConversationTurn.topicSubject ? { subject: activeConversationTurn.topicSubject } : undefined) ??
      ((ctx as unknown as Record<string, unknown>).context as MemoryContext | undefined);

    const envelope: MemoryEnvelope = {
      level: classification.level ?? "L1",
      type: classification.type ?? "note",
      lifecycle: "observed",
      summary: classification.summary,
      evidence: classification.evidence,
      context,
      episode,
    };

    const date = env.nowProvider().toISOString().slice(0, 10);
    const payload = encodePayload(date, envelope);
    const cwd = memDir(env);
    const axes = axisPath(env);
    const embed = sepalConfigured(env.cfg);
    const fspec = filespecFor(cwd, embed);
    const eEnv = embedEnv(env.cfg);

    debugLog("persistence", "Attempting conversational memory store", {
      fact: classification.summary,
      level: classification.level ?? "L1",
      type: classification.type ?? "note",
      memDir: cwd,
      filespec: fspec,
      semanticSearch: embed,
    });

    return await withLock(cwd, async () => {
      const ref = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv);
      const res = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, ref, payload, axes, cwd, eEnv));
      debugLog("persistence", "Executed corm store", {
        ref,
        exitCode: res.code,
        stdout: res.stdout,
        stderr: res.stderr,
      });

      traceEvent("memory_write", res.code === 0 ? "ok" : "error", {
        targetFilespec: fspec,
        proposedSummary: classification.summary,
        exitStatus: res.code,
        assignedRef: res.code === 0 ? ref : null,
        stderr: res.stderr || null,
        persisted: res.code === 0,
      }, { sessionId });

      if (res.code === 0) {
        debugLog("persistence", "Successfully allocated memory reference", { ref });
        if (classification.level === "L0") {
          await recordNewL0InJournal(cwd, [ref]).catch(() => {});
        }
        return ref;
      }
      debugLog("persistence", "CORM store mutation returned non-zero code", {
        code: res.code,
        stderr: res.stderr,
      });
      return null;
    });
  } catch (err) {
    debugLog("persistence", "Conversational memory persistence failed with exception", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return null;
  }
}

export async function enrichActiveMemory(
  activeRef: number,
  newFact: string,
  envSource: EnvSource,
  ctx: PiCtx,
): Promise<boolean> {
  try {
    const env = await envSource(ctx);
    const cwd = memDir(env);
    const axes = axisPath(env);
    const embed = sepalConfigured(env.cfg);
    const fspec = filespecFor(cwd, embed);
    const eEnv = embedEnv(env.cfg);

    return await withLock(cwd, async () => {
      const getRes = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, activeRef, axes, cwd, eEnv));
      if (getRes.code !== 0 || !getRes.stdout.trim()) return false;

      const decoded = decodePayload(getRes.stdout.trim());
      if (!decoded.envelope.episode) {
        decoded.envelope.episode = {
          problem: decoded.envelope.summary,
          findings: [decoded.envelope.summary],
          outcome: "success",
        };
      }
      const findings = decoded.envelope.episode.findings ?? [decoded.envelope.summary];
      if (!findings.includes(newFact)) {
        findings.push(newFact);
      }
      decoded.envelope.episode.findings = findings;

      const payload = encodePayload(decoded.date, decoded.envelope);
      const storeRes = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, activeRef, payload, axes, cwd, eEnv));
      debugLog("persistence", "Enriched existing active memory with follow-up", {
        ref: activeRef,
        newFact,
        totalFindings: findings.length,
        exitCode: storeRes.code,
      });
      return storeRes.code === 0;
    });
  } catch (err) {
    debugLog("persistence", "Failed to enrich active memory", {
      ref: activeRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function handleMemoryUpdate(
  decision: JudgeDecision,
  prompt: string,
  envSource: EnvSource,
  ctx: PiCtx,
  supportingEvidenceRef?: number,
): Promise<string | null> {
  if (!decision.summary) return null;
  try {
    const env = await envSource(ctx);
    const cwd = memDir(env);
    const axes = axisPath(env);
    const embed = sepalConfigured(env.cfg);
    const fspec = filespecFor(cwd, embed);
    const eEnv = embedEnv(env.cfg);

    const sessionManager = ctx.sessionManager ||
      ((ctx as unknown as Record<string, unknown>)?.sessionManager as
        | { getSessionId?: () => string; getSessionFile?: () => string; getLeafId?: () => string; id?: string; sessionId?: string }
        | undefined);
    const sessionId = sessionManager?.getSessionId?.() ||
      sessionManager?.id ||
      sessionManager?.sessionId ||
      ctx.sessionId ||
      ((ctx as unknown as Record<string, unknown>)?.sessionId as string) ||
      (typeof process !== "undefined" ? process.env?.["PI_SESSION_ID"] : undefined) ||
      (typeof Deno !== "undefined" ? Deno.env.get("PI_SESSION_ID") : undefined);
    const sessionFile = sessionManager?.getSessionFile?.() ||
      (typeof process !== "undefined" ? process.env?.["PI_SESSION_FILE"] : undefined) ||
      (typeof Deno !== "undefined" ? Deno.env.get("PI_SESSION_FILE") : undefined);
    const leafId = sessionManager?.getLeafId?.();

    let targetRefNum: number | undefined = undefined;
    if (decision.targetRef !== undefined) {
      const parsed = typeof decision.targetRef === "number"
        ? decision.targetRef
        : parseInt(String(decision.targetRef).replace(/\D/g, ""), 10);
      if (!isNaN(parsed) && parsed > 0) targetRefNum = parsed;
    }

    // 2. Same-session active memory preference
    if (
      targetRefNum === undefined &&
      activeConversationTurn.activeMemoryRef !== undefined &&
      activeConversationTurn.activeSessionId === sessionId
    ) {
      targetRefNum = activeConversationTurn.activeMemoryRef;
    }

    // 3. Search for genuinely related active candidate if targetRef is still unset
    if (targetRefNum === undefined) {
      try {
        const scanRes = await executeHybridScan(env, { topic: prompt, limit: 3, embed });
        const activeCandidates = scanRes.records.filter((r) => {
          const lc = r.envelope?.lifecycle ?? r.lifecycle;
          const lvl = r.envelope?.level ?? r.level;
          return lvl === "L1" && lc !== "superseded" && lc !== "contradicted";
        });
        if (activeCandidates.length > 0) {
          targetRefNum = activeCandidates[0].ref;
        }
      } catch {
        // scan fallback
      }
    }

    return await withLock(cwd, async () => {
      let priorFindings: string[] = [];
      let priorEvidence: number[] = [];
      let priorSummary = "";
      let validTarget = false;
      let targetPayloadToUpdate: { date: string; envelope: MemoryEnvelope } | null = null;

      if (targetRefNum !== undefined) {
        const getRes = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, targetRefNum, axes, cwd, eEnv));
        if (getRes.code === 0 && getRes.stdout.trim()) {
          try {
            const oldDecoded = decodePayload(getRes.stdout.trim());
            // Reject missing, contradicted or superseded targets
            if (oldDecoded.envelope.lifecycle !== "superseded" && oldDecoded.envelope.lifecycle !== "contradicted") {
              validTarget = true;
              targetPayloadToUpdate = oldDecoded;
              priorSummary = oldDecoded.envelope.summary;
              if (oldDecoded.envelope.episode?.findings) {
                priorFindings = oldDecoded.envelope.episode.findings;
              } else if (oldDecoded.envelope.summary) {
                priorFindings = [oldDecoded.envelope.summary];
              }
              if (oldDecoded.envelope.evidence) {
                priorEvidence = oldDecoded.envelope.evidence;
              }
            }
          } catch {
            validTarget = false;
          }
        }
      }

      const rawFindings = [...priorFindings, ...(decision.findings ?? (decision.summary ? [decision.summary] : []))];
      const mergedFindings: string[] = Array.from(new Set(rawFindings.filter((f): f is string => typeof f === "string" && f.length > 0)));

      const rawEvidence = [...priorEvidence, ...(supportingEvidenceRef !== undefined ? [supportingEvidenceRef] : [])];
      const mergedEvidence: number[] = Array.from(new Set(rawEvidence));

      const decisionSummary = decision.summary ?? "Conversational update";
      let updatedSummary = decisionSummary;
      if (validTarget && priorSummary) {
        const pLower = priorSummary.toLowerCase();
        const dLower = decisionSummary.toLowerCase();
        if (pLower.includes(dLower)) {
          updatedSummary = priorSummary;
        } else if (dLower.includes(pLower)) {
          updatedSummary = decisionSummary;
        } else {
          updatedSummary = `${priorSummary} — ${decisionSummary}`;
          if (updatedSummary.length > 250) {
            updatedSummary = updatedSummary.slice(0, 247) + "...";
          }
        }
      }

      const newRef = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv);

      const episode: EpisodeRecord = {
        problem: prompt,
        findings: mergedFindings,
        outcome: "success",
        sessionId: sessionId ?? targetPayloadToUpdate?.envelope.episode?.sessionId,
        sessionFile: sessionFile ?? targetPayloadToUpdate?.envelope.episode?.sessionFile,
        leafId: leafId ?? targetPayloadToUpdate?.envelope.episode?.leafId,
      };

      const newEnvelope: MemoryEnvelope = {
        level: "L1",
        type: decision.type ?? targetPayloadToUpdate?.envelope.type ?? "note",
        lifecycle: "observed",
        summary: updatedSummary,
        supersedes: validTarget && targetRefNum !== undefined ? targetRefNum : undefined,
        evidence: mergedEvidence.length > 0 ? mergedEvidence : undefined,
        episode,
      };

      const date = env.nowProvider().toISOString().slice(0, 10);
      const newPayload = encodePayload(date, newEnvelope);

      // Store the new successor record
      const res = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, newRef, newPayload, axes, cwd, eEnv));
      if (res.code !== 0) return null;

      // If valid target was superseded, update predecessor with bidirectional supersededBy link
      if (validTarget && targetRefNum !== undefined && targetPayloadToUpdate) {
        targetPayloadToUpdate.envelope.lifecycle = "superseded";
        targetPayloadToUpdate.envelope.supersededBy = newRef;
        const oldUpdatedPayload = encodePayload(targetPayloadToUpdate.date, targetPayloadToUpdate.envelope);
        await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, targetRefNum, oldUpdatedPayload, axes, cwd, eEnv));
      }

      // Update active turn tracking to the new active ref
      activeConversationTurn.activeMemoryRef = newRef;
      activeConversationTurn.activeSessionId = sessionId;

      debugLog("persistence", "Executed memory update with successor management", {
        newRef,
        supersedes: validTarget ? targetRefNum : null,
        evidence: mergedEvidence,
        exitCode: res.code,
      });

      traceEvent("memory_write", "ok", {
        targetFilespec: fspec,
        proposedSummary: updatedSummary,
        exitStatus: 0,
        assignedRef: newRef,
        persisted: true,
        supersedes: validTarget ? targetRefNum : null,
      }, { sessionId });

      return String(newRef);
    });
  } catch (err) {
    debugLog("persistence", "Memory update persistence failed with exception", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return null;
  }
}

export function installSessionHooks(pi: Pi, envSource?: EnvSource): void {
  pi.on("session_start", async (_event: unknown, ctxUnknown?: unknown) => {
    activeSessionBuffer.onSessionStart();
    activeConversationTurn.activeMemoryRef = undefined;
    activeConversationTurn.activeSessionId = undefined;
    if (envSource && ctxUnknown) {
      try {
        const ctx = ctxUnknown as PiCtx;
        const sessionId = extractSessionId(ctx);
        const env = await envSource(ctx);
        console.log(`[pi-mm] ${describeCapabilities(env.cfg)}`);
        const cwd = memDir(env);
        activeSessionBuffer.setJournalDir(cwd);
        const committedIds = new Set<string>();
        const embed = sepalConfigured(env.cfg);
        const fspec = filespecFor(cwd, embed);
        const axes = axisPath(env);

        debugLog("startup", "Session started", {
          memDir: cwd,
          filespec: fspec,
          axes: axes.split(":"),
          semanticSearch: embed,
          judgeMode: env.cfg.judgeMode,
          judgeUrl: env.cfg.judgeUrl,
          judgeModel: env.cfg.judgeModel,
          judgeFallback: env.cfg.judgeFallback,
        });

        traceEvent("extension_loaded", "ok", {
          extension: "pi-mm",
          version: "0.1.0",
          cwd: ctx.cwd,
          memDir: cwd,
          filespec: fspec,
          axisRoster: axes.split(":"),
          cormdRunning: isDaemonLockHeld(cwd),
          cormdSocket: `${cwd}/cormd.sock`,
          judgeMode: env.cfg.judgeMode,
          judgeUrl: env.cfg.judgeUrl,
          judgeModel: env.cfg.judgeModel,
          judgeFallback: env.cfg.judgeFallback,
          semanticSearch: embed,
          embedUrl: env.cfg.embedUrl,
          embedModel: env.cfg.embedModel,
        }, { sessionId });

        const list = await env.runner.run(buildListInvocation(env.cfg.qmapBin, fspec, axes, cwd));
        for (const r of parseBareRefs(list.stdout)) {
          const res = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, r, axes, cwd));
          if (res.code === 0 && res.stdout.trim()) {
            const { envelope } = decodePayload(res.stdout.trim());
            for (const id of envelope.episode?.eventIds || []) committedIds.add(id);
          }
        }
        await activeSessionBuffer.restoreJournal(cwd, committedIds);
      } catch (err) {
        debugLog("startup", "session_start failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  pi.on("tool_result", async (eventUnknown: unknown) => {
    if (typeof eventUnknown !== "object" || eventUnknown === null) return;
    const event = eventUnknown as ToolResultEvent;
    const sig = summarizeToolEvent(event);
    if (sig) await activeSessionBuffer.recordAsync(sig);
  });

  pi.on("message_end", (eventUnknown: unknown) => {
    if (typeof eventUnknown !== "object" || eventUnknown === null) return;
    const event = eventUnknown as { message?: { role?: string; content?: unknown } };
    if (event.message?.role === "assistant") {
      const content = event.message.content;
      let text = "";
      if (typeof content === "string") {
        text = content.trim();
      } else if (Array.isArray(content)) {
        text = content
          .filter((p: unknown) => typeof p === "object" && p !== null && (p as { type?: string }).type === "text")
          .map((p: unknown) => (p as { text?: string }).text ?? "")
          .join("\n")
          .trim();
      }
      if (text) {
        activeConversationTurn.response = text;
        if (!activeConversationTurn.responses) activeConversationTurn.responses = [];
        activeConversationTurn.responses.push(text);
        debugLog("capture", "Assistant response collected", {
          responseLength: text.length,
          responsePreview: text.slice(0, 100),
          turnResponsesCount: activeConversationTurn.responses.length,
        });
        traceEvent("conversation_captured", "ok", {
          lifecycle: "message_end",
          assistantResponse: text,
        });
      }
    }
  });

  const onTurnEnd = async (_event: unknown, ctxUnknown?: unknown) => {
    if (!envSource || !ctxUnknown) return;
    const ctx = ctxUnknown as PiCtx;

    // Per-turn boundary: flush tool events as required, and record returned
    // technical L0 reference into the persistent consolidation journal.
    const flushedRef = await flushSessionBuffer(envSource, ctx);
    if (flushedRef !== null && flushedRef !== undefined) {
      try {
        const env = await envSource(ctx);
        const cwd = memDir(env);
        await withLock(cwd, async () => {
          await recordNewL0InJournal(cwd, [flushedRef]);
        });
      } catch { /* best effort */ }
    }
  };

  const onRunSettled = async (eventUnknown: unknown, ctxUnknown?: unknown) => {
    if (!envSource || !ctxUnknown) return;
    const ctx = ctxUnknown as PiCtx;
    const sessionId = extractSessionId(ctx);
    const isAborted = Boolean((eventUnknown as { aborted?: boolean })?.aborted);

    const hasActiveRun = Boolean(
      activeConversationTurn.activeRunId ||
      activeConversationTurn.timestamp ||
      activeConversationTurn.prompt !== undefined,
    );

    debugLog("capture", "agent_settled triggered", {
      hasPrompt: Boolean(activeConversationTurn.prompt),
      promptPreview: activeConversationTurn.prompt ? activeConversationTurn.prompt.slice(0, 100) : undefined,
      hasResponse: Boolean(activeConversationTurn.response || activeConversationTurn.responses?.length),
      aborted: isAborted,
    });

    traceEvent("conversation_captured", isAborted ? "error" : "ok", {
      lifecycle: "agent_settled",
      settled: true,
      aborted: isAborted,
      prompt: activeConversationTurn.prompt,
      response: activeConversationTurn.response ?? activeConversationTurn.responses?.join("\n"),
    }, { sessionId });

    // 1. Flush any remaining tool-call events
    const flushedRef = await flushSessionBuffer(envSource, ctx);
    const capturedL0Refs: number[] = [];
    if (flushedRef !== null && flushedRef !== undefined) {
      capturedL0Refs.push(flushedRef);
      try {
        const env = await envSource(ctx);
        const cwd = memDir(env);
        await withLock(cwd, async () => {
          await recordNewL0InJournal(cwd, [flushedRef]);
        });
      } catch { /* best effort */ }
    }

    // 2. Finalize and persist conversational memory strictly after the full agent run settles
    if (activeConversationTurn.prompt && !isAborted) {
      const prompt = activeConversationTurn.prompt.trim();
      const response = activeConversationTurn.response ??
        (activeConversationTurn.responses ? activeConversationTurn.responses.join("\n") : "");

      // Thread context for judge
      const threadContext = (activeConversationTurn.previousUserPrompt && activeConversationTurn.activeSessionId === sessionId)
        ? `Topic: ${activeConversationTurn.previousUserPrompt}\nPreceding Assistant Question: ${(activeConversationTurn.previousAssistantResponse || "").slice(0, 150)}`
        : undefined;

      activeConversationTurn.previousUserPrompt = prompt;
      activeConversationTurn.previousAssistantResponse = response;

      if (prompt) {
        try {
          const env = await envSource(ctx);
          const mode = env.cfg.captureMode ?? (env.cfg.judgeMode === "off" ? "off" : (env.cfg.judgeUrl ? "judge" : "all"));

          let shouldStoreConversational = false;
          let contentToStore = prompt;

          if (mode === "off") {
            debugLog("capture", "Capture mode is off; skipping automatic capture");
          } else if (mode === "keyword") {
            const keyword = env.cfg.captureKeyword?.trim();
            if (keyword && prompt.startsWith(keyword)) {
              contentToStore = prompt.slice(keyword.length).trim();
              if (contentToStore) shouldStoreConversational = true;
            }
          } else if (mode === "judge") {
            const judgeStart = Date.now();
            const judgeRes = await evaluateTurnWithJudge(prompt, response, env.cfg, globalThis.fetch, threadContext);
            const judgeDurationMs = Date.now() - judgeStart;

            traceEvent("judge_request", judgeRes.decision.action === "skip" ? "skip" : "ok", {
              endpoint: env.cfg.judgeUrl || "unconfigured",
              model: env.cfg.judgeModel || "none",
              status: judgeRes.degraded ? "degraded" : (judgeRes.source === "llm" ? "http-200" : "fallback"),
              elapsedMs: judgeDurationMs,
              action: judgeRes.decision.action,
              failureReason: judgeRes.decision.reason || null,
            }, { sessionId });

            if (judgeRes.decision.action !== "skip") {
              shouldStoreConversational = true;
            }
          } else {
            // mode === "all"
            shouldStoreConversational = true;
          }

          if (shouldStoreConversational) {
            const l0Classification: ConversationalClassification = {
              meaningful: true,
              type: "note",
              level: "L0",
              summary: contentToStore.slice(0, 250),
              problem: contentToStore,
              findings: [contentToStore],
              context: activeConversationTurn.topicSubject ? { subject: activeConversationTurn.topicSubject } : undefined,
            };
            const l0Ref = await persistConversationalMemory(l0Classification, envSource, ctx);
            debugLog("capture", "Captured L0 experience record", { l0Ref, summary: l0Classification.summary });
            if (l0Ref !== null && l0Ref !== undefined) {
              const numRef = typeof l0Ref === "number" ? l0Ref : parseInt(String(l0Ref), 10);
              if (!isNaN(numRef)) capturedL0Refs.push(numRef);
            }
          }
        } catch (err) {
          debugLog("capture", "Conversational capture error", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    activeConversationTurn.prompt = undefined;
    activeConversationTurn.response = undefined;
    activeConversationTurn.responses = undefined;
    activeConversationTurn.timestamp = undefined;
    activeConversationTurn.activeRunId = undefined;

    // 3. UNCONDITIONALLY run incremental auto-consolidation for settled agent runs
    if (hasActiveRun) {
      try {
        const env = await envSource(ctx);
        await runAutoConsolidation(env, ctx, { newL0Refs: capturedL0Refs, incrementalOnly: true });
      } catch (err) {
        debugLog("consolidation", "Incremental consolidation error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  pi.on("before_agent_start", async (eventUnknown: unknown, ctxUnknown?: unknown) => {
    const ctx = ctxUnknown as PiCtx | undefined;
    const sessionId = extractSessionId(ctx);
    if (typeof eventUnknown === "object" && eventUnknown !== null) {
      const event = eventUnknown as BeforeAgentStartEvent;
      activeConversationTurn.timestamp = new Date().toISOString();
      activeConversationTurn.activeRunId = (event as { runId?: string }).runId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (event.messageType === "user" && typeof event.prompt === "string") {
        activeConversationTurn.prompt = event.prompt;
        activeConversationTurn.response = undefined;
        activeConversationTurn.responses = undefined;
        debugLog("capture", "before_agent_start user prompt captured", {
          promptPreview: event.prompt.slice(0, 100),
          length: event.prompt.length,
        });
        traceEvent("conversation_captured", "ok", {
          lifecycle: "before_agent_start",
          messageType: event.messageType,
          userPrompt: event.prompt,
        }, { sessionId });
      }
    }
    if (!envSource || !ctxUnknown) return;
    const event = eventUnknown as BeforeAgentStartEvent;
    return await handleBeforeAgentStart(event, ctxUnknown as PiCtx, envSource);
  });

  const onBeforeCompact = async (eventUnknown: unknown, ctxUnknown?: unknown) => {
    // 1. Ensure any in-flight turn is captured and settled into L0/L1
    await onRunSettled(eventUnknown, ctxUnknown);

    // 2. Execute deferred consolidation so pending L2/L3 abstractions are committed
    // to CORM before compaction summarization reads existing abstractions.
    if (!envSource || !ctxUnknown) return;
    const ctx = ctxUnknown as PiCtx;
    try {
      const env = await envSource(ctx);
      await runDeferredConsolidation(env, ctx);
    } catch (err) {
      debugLog("consolidation", "Deferred consolidation failed during before_compact", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  pi.on("turn_end", onTurnEnd);
  pi.on("agent_settled", onRunSettled);
  pi.on("session_before_compact", onBeforeCompact);
  pi.on("session_shutdown", async (_ev: unknown, ctxUnknown?: unknown) => {
    if (!envSource || !ctxUnknown) return;
    try {
      const env = await envSource(ctxUnknown as PiCtx);
      await runDeferredConsolidation(env, ctxUnknown as PiCtx);
    } catch { /* ignore shutdown errors */ }
  });
}
