import type { EnvSource } from "../tools/index.ts";
import { axisPath, memDir, sepalConfigured, socketPath } from "../tools/index.ts";
import { describeCapabilities } from "../config.ts";
import { evaluateTurnWithJudge } from "../judge/adapter.ts";
import type { JudgeDecision } from "../judge/types.ts";
import { filespecFor, buildStoreInvocation, buildGetInvocation, buildListInvocation, embedEnv } from "../corm.ts";
import { allocateNextRef } from "../tools/ref_allocator.ts";
import { parseBareRefs } from "../resolve.ts";
import { encodePayload, decodePayload } from "../payload.ts";
import { withLock } from "../lock.ts";
import type { MemoryEnvelope, EpisodeRecord, MemoryContext } from "../types.ts";
import { handleBeforeAgentStart, isMemoryRecallPrompt, type BeforeAgentStartEvent } from "./auto_recall.ts";
import { validateEvidenceRef } from "../tools/lifecycle.ts";
import { executeHybridScan } from "../tools/scan.ts";
import { runAutoConsolidation, runDeferredConsolidation } from "../tools/consolidate.ts";
import { recordNewL0InJournal } from "../tools/consolidation_journal.ts";
import { debugLog, traceEvent } from "../debug.ts";
import { isDaemonLockHeld } from "../daemon.ts";
import { recordAssociations } from "../associative.ts";
import { ReinforcementScheduler, synthesizeReinforcementBlockFromDirectives, isStandingDirective, STANDING_DIRECTIVE_PATTERN } from "./reinforcement.ts";
import { DEFAULT_REINFORCEMENT_CONFIG } from "../config.ts";
import { detectSubsystemMentions } from "./auto_recall.ts";
import { readFile, writeFile, unlink, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface PiToolSpec {
  name: string; label: string; description: string; parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiCtx) => Promise<PiAgentToolResult>;
}
export interface PiAgentToolResult { content: Array<{ type: string; text?: string }>; details?: unknown; }
export interface PiExecResult { stdout: string; stderr: string; code: number; stdoutBytes?: Uint8Array; }
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

export class SessionDrainRegistry {
  private static inFlight = new Set<Promise<unknown>>();

  static track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    p.finally(() => this.inFlight.delete(p));
    return p;
  }

  static get activeCount(): number {
    return this.inFlight.size;
  }

  static async drain(timeoutMs = 5000): Promise<{ completed: boolean; remaining: number }> {
    if (this.inFlight.size === 0) return { completed: true, remaining: 0 };
    const all = Promise.allSettled(Array.from(this.inFlight));
    let timedOut = false;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });

    await Promise.race([all, timer]);
    if (timedOut && this.inFlight.size > 0) {
      debugLog("consolidation", `Session drain timed out after ${timeoutMs}ms with ${this.inFlight.size} active tasks remaining`);
      return { completed: false, remaining: this.inFlight.size };
    }
    return { completed: true, remaining: 0 };
  }

  static clear(): void {
    this.inFlight.clear();
  }
}

export const MAX_DIRTY_SCOPES_QUEUE = 50;

export interface ConsolidationTask {
  capturedL0Refs: number[];
  ctx: PiCtx;
  timestamp: number;
}

export class ConsolidationQueue {
  private queue: ConsolidationTask[] = [];
  private processing = false;

  enqueue(task: ConsolidationTask, envSource: EnvSource): Promise<void> {
    this.queue.push(task);
    if (this.queue.length > MAX_DIRTY_SCOPES_QUEUE) {
      this.queue.shift(); // Drop oldest unstarted task beyond capacity limit
    }
    const p = this.processNext(envSource);
    SessionDrainRegistry.track(p);
    return p;
  }

  private async processNext(envSource: EnvSource): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        try {
          const env = await envSource(next.ctx);
          await runAutoConsolidation(env, next.ctx, { newL0Refs: next.capturedL0Refs, incrementalOnly: true });
        } catch (err) {
          debugLog("consolidation", "Incremental consolidation error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.processing = false;
    }
  }

  get length(): number {
    return this.queue.length;
  }
}

export const consolidationQueue = new ConsolidationQueue();

let sessionSavedCount = 0;
let mmStatusTimer: ReturnType<typeof setTimeout> | undefined;
let mmDownloadSuffix: string | undefined;

/** Show (or clear) a model-download progress suffix next to the brain indicator. */
export function setMmDownloadProgress(
  ctx: PiCtx | undefined,
  text: string | undefined,
): void {
  mmDownloadSuffix = text;
  const ui = (ctx as { ui?: { setStatus?: (id: string, text: string | undefined) => void; theme?: { fg?: (name: string, text: string) => string } } })?.ui;
  if (!ui?.setStatus || mmStatusTimer !== undefined) return;
  const base = `🧠 ${sessionSavedCount}${mmDownloadSuffix ? ` ${mmDownloadSuffix}` : ""}`;
  ui.setStatus("pi-mm", ui.theme?.fg ? ui.theme.fg("muted", base) : base);
}

export function notifyMmEvent(
  ctx: PiCtx | undefined,
  type: "saved" | "degraded" | "recalled",
  count?: number,
): void {
  const ui = (ctx as { ui?: { setStatus?: (id: string, text: string | undefined) => void; theme?: { fg?: (name: string, text: string) => string } } })?.ui;
  if (!ui?.setStatus) return;

  if (mmStatusTimer !== undefined) {
    clearTimeout(mmStatusTimer);
    mmStatusTimer = undefined;
  }

  const renderIdleOrCount = () => {
    const txt = `🧠 ${sessionSavedCount}${mmDownloadSuffix ? ` ${mmDownloadSuffix}` : ""}`;
    return ui.theme?.fg ? ui.theme.fg("muted", txt) : txt;
  };

  if (type === "saved") {
    sessionSavedCount += (count ?? 1);
    const flash = ui.theme?.fg ? ui.theme.fg("success", "🧠 +1") : "🧠 +1";
    ui.setStatus("pi-mm", flash);
    mmStatusTimer = setTimeout(() => {
      ui.setStatus?.("pi-mm", renderIdleOrCount());
    }, 2500);
    return;
  }

  if (type === "degraded") {
    const warn = ui.theme?.fg ? ui.theme.fg("error", "⚠️") : "⚠️";
    ui.setStatus("pi-mm", warn);
    mmStatusTimer = setTimeout(() => {
      ui.setStatus?.("pi-mm", renderIdleOrCount());
    }, 3500);
    return;
  }

  if (type === "recalled" && count && count > 0 && sessionSavedCount === 0) {
    const txt = ui.theme?.fg ? ui.theme.fg("muted", `🧠 ${count}`) : `🧠 ${count}`;
    ui.setStatus("pi-mm", txt);
  }
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

export function isInformativeExecution(event: ToolResultEvent): boolean {
  if (!event || typeof event !== "object") return false;

  const toolName = event.toolName || "";
  const isErr = Boolean(event.isError);
  const text = event.content?.map((c) => c.text || "").join(" ").trim() || "";
  const cmd = String(event.input?.["command"] || event.args?.["command"] || "");

  // 1. Degenerate Syntax Fragments: string fragments of length < 3 matching /^[{}()\[\];,]+$/
  if (text.length > 0 && text.length < 3 && /^[{}()[\];,]+$/.test(text)) {
    return false;
  }

  const isCodeMod = /edit|write|patch/i.test(toolName);
  if (isCodeMod) {
    return true;
  }

  const isTrivialOutput = !text || /^(?:\(no output\)|0|true|done|ok)$/i.test(text);

  const hasErrorWord = /\b(?:FAIL|failed|error|fatal|panic)\b/i.test(text.replace(/0\s+failed/gi, ""));
  const failed = isErr || hasErrorWord;

  const isVerification = /test|check|verify|smoke/i.test(toolName) ||
                         /test|check|make|deno|cargo|npm/i.test(cmd) ||
                         /test|PASS|check-complexity|integration|ok\s+\d+|all green/i.test(text);
  const verifiedWorked = !failed && isVerification && (/PASS|passed|all green|ok\s+-|0 failed/i.test(text));

  // Failed executions with informative error context are preserved
  if (failed) {
    if (isTrivialOutput && !cmd) return false;
    return true;
  }

  // Explicitly verified successes are preserved
  if (verifiedWorked) {
    return true;
  }

  // Verification commands with clean exit 0 and non-trivial output or explicit test command
  if (isVerification && !failed && cmd && /test|check|verify/i.test(cmd) && !/^(?:echo|true|pwd|ls|cat)\b/.test(cmd)) {
    return true;
  }

  // Dedicated search and read tools (search_code, read, search_graph, get_code_snippet, etc.)
  const isSearchOrRead = /search|read|find|get_code/i.test(toolName);
  if (isSearchOrRead) {
    if (isTrivialOutput || /^(?:0 matches|no matches|0 results|found 0|empty)/i.test(text)) {
      return false;
    }
    return true;
  }

  // Memory introspection and session recall tools are not software engineering modifications
  if (/^(?:memory_|vcc_recall)/.test(toolName)) {
    return false;
  }

  // Routine bash commands or trivial outputs without code modification or verification
  if (isTrivialOutput || toolName === "bash") {
    return false;
  }

  return true;
}

export function summarizeToolEvent(event: ToolResultEvent): SignificantEvent | null {
  if (!isInformativeExecution(event)) {
    return null;
  }

  const isErr = Boolean(event.isError);
  const text = event.content?.map((c) => c.text || "").join(" ").trim() || "";
  const cmd = String(event.input?.["command"] || event.args?.["command"] || "");
  const hasErrorWord = /\b(?:FAIL|failed|error|fatal|panic)\b/i.test(text.replace(/0\s+failed/gi, ""));
  const failed = isErr || hasErrorWord;

  const isVerification = /test|check|verify|smoke/i.test(event.toolName) ||
                         /test|check|make|deno|cargo|npm/i.test(cmd) ||
                         /test|PASS|check-complexity|integration|ok\s+\d+|all green/i.test(text);
  const verifiedWorked = !failed && isVerification && (/PASS|passed|all green|ok\s+-|0 failed/i.test(text));

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
    if (!env.cfg.cormBin) { activeSessionBuffer.rollbackFlush("corm-not-found"); return null; }

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
      const ref = await allocateNextRef(cwd, env.runner, env.cfg.cormBin, fspec, axes, eEnv);
      const res = await env.runner.run(buildStoreInvocation(env.cfg.cormBin, fspec, ref, payload, axes, cwd, eEnv));
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
export const reinforcementScheduler = new ReinforcementScheduler();

export { isStandingDirective, STANDING_DIRECTIVE_PATTERN };

export interface ConversationalClassification {
  meaningful: boolean;
  type?: "note" | "decision" | "episode" | "invariant";
  level?: "L0" | "L1" | "L2";
  summary?: string;
  problem?: string;
  findings?: string[];
  evidence?: number[];
  context?: MemoryContext;
  isAnchor?: boolean;
  standing?: boolean;
}

export async function persistConversationalMemory(
  classification: ConversationalClassification,
  envSource: EnvSource,
  ctx: PiCtx,
): Promise<number | null> {
  try {
    const env = await envSource(ctx);
    if (!env.cfg.cormBin || !classification.meaningful || !classification.summary) return null;

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
      lifecycle: classification.standing ? "supported" : "observed",
      summary: classification.summary,
      evidence: classification.evidence,
      context,
      episode,
      isAnchor: Boolean(classification.isAnchor || classification.standing || classification.summary.includes("@remember") || classification.summary.toLowerCase().startsWith("remember:") || context?.project === "user") || undefined,
      standing: classification.standing || undefined,
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
      const ref = await allocateNextRef(cwd, env.runner, env.cfg.cormBin, fspec, axes, eEnv);
      const res = await env.runner.run(buildStoreInvocation(env.cfg.cormBin, fspec, ref, payload, axes, cwd, eEnv));
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
        if (classification.standing && classification.summary) {
          reinforcementScheduler.registerDirective({
            ref,
            summary: classification.summary,
            subsystem: classification.context?.subsystem,
            project: classification.context?.project,
          });
        }
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
      const getRes = await env.runner.run(buildGetInvocation(env.cfg.cormBin, fspec, activeRef, axes, cwd, eEnv));
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
      const storeRes = await env.runner.run(buildStoreInvocation(env.cfg.cormBin, fspec, activeRef, payload, axes, cwd, eEnv));
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
        const getRes = await env.runner.run(buildGetInvocation(env.cfg.cormBin, fspec, targetRefNum, axes, cwd, eEnv));
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

      const newRef = await allocateNextRef(cwd, env.runner, env.cfg.cormBin, fspec, axes, eEnv);

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
      const res = await env.runner.run(buildStoreInvocation(env.cfg.cormBin, fspec, newRef, newPayload, axes, cwd, eEnv));
      if (res.code !== 0) return null;

      // If valid target was superseded, update predecessor with bidirectional supersededBy link
      if (validTarget && targetRefNum !== undefined && targetPayloadToUpdate) {
        targetPayloadToUpdate.envelope.lifecycle = "superseded";
        targetPayloadToUpdate.envelope.supersededBy = newRef;
        const oldUpdatedPayload = encodePayload(targetPayloadToUpdate.date, targetPayloadToUpdate.envelope);
        await env.runner.run(buildStoreInvocation(env.cfg.cormBin, fspec, targetRefNum, oldUpdatedPayload, axes, cwd, eEnv));
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
    reinforcementScheduler.onSessionStart();
    activeConversationTurn.activeMemoryRef = undefined;
    activeConversationTurn.activeSessionId = undefined;
    if (envSource && ctxUnknown) {
      try {
        const ctx = ctxUnknown as PiCtx;
        const sessionId = extractSessionId(ctx);
        const env = await envSource(ctx);
        debugLog("startup", `[pi-mm] ${describeCapabilities(env.cfg)}`);
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
          captureEmbedUrl: env.cfg.captureEmbedUrl ?? env.cfg.judgeUrl,
          captureEmbedModel: env.cfg.captureEmbedModel,
          judgeMode: env.cfg.judgeMode,
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
          cormdSocket: socketPath(env),
          captureEmbedUrl: env.cfg.captureEmbedUrl ?? env.cfg.judgeUrl,
          captureEmbedModel: env.cfg.captureEmbedModel,
          judgeFallback: env.cfg.judgeFallback,
          semanticSearch: embed,
          embedUrl: env.cfg.embedUrl,
          embedModel: env.cfg.embedModel,
        }, { sessionId });

        const list = await env.runner.run(buildListInvocation(env.cfg.cormBin, fspec, axes, cwd));
        for (const r of parseBareRefs(list.stdout)) {
          const res = await env.runner.run(buildGetInvocation(env.cfg.cormBin, fspec, r, axes, cwd));
          if (res.code === 0 && res.stdout.trim()) {
            const { envelope } = decodePayload(res.stdout.trim());
            for (const id of envelope.episode?.eventIds || []) committedIds.add(id);
            if (envelope.standing || (envelope.level === "L2" && envelope.type === "invariant")) {
              if (envelope.lifecycle === "supported" || envelope.lifecycle === "tested") {
                reinforcementScheduler.registerDirective({
                  ref: r,
                  summary: envelope.summary,
                  subsystem: envelope.context?.subsystem,
                  project: envelope.context?.project,
                });
              }
            }
          }
        }
        await activeSessionBuffer.restoreJournal(cwd, committedIds);

        const ui = (ctxUnknown as {
          ui?: {
            setStatus?: (id: string, text: string | undefined) => void;
            notify?: (text: string, level?: "info" | "warning" | "error") => void;
            theme?: { fg?: (name: string, text: string) => string };
          };
        })?.ui;
        if (ui?.setStatus) {
          sessionSavedCount = 0;
          const idleTxt = ui.theme?.fg ? ui.theme.fg("muted", "🧠 0") : "🧠 0";
          ui.setStatus("pi-mm", idleTxt);
          ui.setStatus("mm-judge", undefined);
        }

        const isProject = Boolean(ctx.cwd && (existsSync(join(ctx.cwd, ".pi")) || existsSync(join(ctx.cwd, "mem.db")) || existsSync(cwd)));
        if (isProject) {
          try {
            const { findSepalLib, ensureAuren, describeProgress, DOCS_SEPAL } = await import("../auren.ts");
            const { checkAllEngineVersions, formatRemediationToast } = await import("../versions.ts");
            const notify = typeof ui?.notify === "function" ? ui.notify.bind(ui) : undefined;
            const told = new Set<string>();
            const tell = (key: string, text: string, level: "info" | "warning") => {
              if (!notify || told.has(key)) return;
              told.add(key);
              notify(text, level);
            };

            // Proactively alert the user if any core engine is missing or outdated
            const engineReports = checkAllEngineVersions({ cwd: ctx.cwd });
            for (const rep of engineReports) {
              if (rep.status === "missing" || rep.status === "outdated") {
                if (rep.name === "libsepal" && env.cfg.semanticSearch === false) continue;
                tell(`engine:${rep.name}:${rep.status}`, `[pi-mm] ${formatRemediationToast(rep)}`, "warning");
              }
            }

            if (!findSepalLib(ctx.cwd) && env.cfg.semanticSearch !== false) {
              tell("sepal", `[pi-mm] Semantic recall needs libsepal, which is not installed. See: ${DOCS_SEPAL}`, "warning");
            }
            if (env.cfg.judgeMode !== "off" && env.cfg.judgeMode !== "heuristic") {
              const confirmFn = (ctxUnknown as { ui?: { confirm?: (title: string, message: string) => Promise<boolean> } })?.ui?.confirm;
              void ensureAuren({
                cwd: ctx.cwd,
                settings: { autoStart: env.cfg.autoStartAuren, autoDownloadModels: env.cfg.autoDownloadModels },
                confirm: confirmFn ? (m: string) => confirmFn.call((ctxUnknown as { ui: object }).ui, "pi-mm: local model", m) : undefined,
                onUpdate: (st) => {
                  setMmDownloadProgress(ctxUnknown as PiCtx, describeProgress(st));
                  for (const n of st.notices) {
                    if (n.code === "downloading") continue;
                    tell(`${n.code}:${n.message}`, `[pi-mm] ${n.message} See: ${n.link}`, n.severity);
                  }
                },
              });
            }
          } catch {
            // Best-effort notification
          }
        }
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
        if (activeConversationTurn.prompt) {
          void recordAssociations(cwd, activeConversationTurn.prompt).catch(() => {});
        }
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
          const mode = env.cfg.captureMode ?? (env.cfg.judgeMode === "off" ? "off" : ((env.cfg.captureEmbedUrl || env.cfg.judgeUrl) ? "judge" : "all"));

          let shouldStoreConversational = false;
          let contentToStore = prompt;

          if (isMemoryRecallPrompt(prompt)) {
            debugLog("capture", "Skipping conversational capture for memory recall query", { prompt: prompt.slice(0, 80) });
            shouldStoreConversational = false;
          } else if (mode === "off") {
            debugLog("capture", "Capture mode is off; skipping automatic capture");
          } else if (mode === "keyword") {
            const keywords = env.cfg.captureKeywords ?? (env.cfg.captureKeyword ? [env.cfg.captureKeyword] : ["@remember", "@memory", "remember:", "note:"]);
            const lower = prompt.toLowerCase();
            const matched = keywords.find((k: string) => lower.startsWith(k.toLowerCase()));
            if (matched) {
              contentToStore = prompt.slice(matched.length).replace(/^[:\-\s]+/, "").trim();
              if (contentToStore) shouldStoreConversational = true;
            }
          } else if (mode === "judge") {
            // Check deterministic trigger word families first before querying judge
            const keywords = env.cfg.captureKeywords ?? (env.cfg.captureKeyword ? [env.cfg.captureKeyword] : ["@remember", "@memory", "remember:", "note:"]);
            const lower = prompt.toLowerCase();
            const matched = keywords.find((k: string) => lower.startsWith(k.toLowerCase()));

            if (matched) {
              contentToStore = prompt.slice(matched.length).replace(/^[:\-\s]+/, "").trim();
              if (contentToStore) shouldStoreConversational = true;
            } else {
              const judgeStart = Date.now();
              const judgeRes = await evaluateTurnWithJudge(prompt, response, env.cfg, globalThis.fetch, threadContext);
              const judgeDurationMs = Date.now() - judgeStart;

              if (judgeRes.degraded) {
                notifyMmEvent(ctx, "degraded");
              }

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
            }
          } else {
            // mode === "all"
            shouldStoreConversational = true;
          }

          if (shouldStoreConversational) {
            const isDirective = prompt.toLowerCase().includes("@remember") || prompt.toLowerCase().startsWith("remember:");
            const isStanding = isStandingDirective(prompt);
            const l0Classification: ConversationalClassification = {
              meaningful: true,
              type: isStanding ? "invariant" : "note",
              level: isStanding ? "L2" : "L0",
              summary: contentToStore.slice(0, 250),
              problem: contentToStore,
              findings: [contentToStore],
              context: activeConversationTurn.topicSubject ? { subject: activeConversationTurn.topicSubject } : undefined,
              isAnchor: isDirective || isStanding || undefined,
              standing: isStanding || undefined,
            };
            const l0Ref = await persistConversationalMemory(l0Classification, envSource, ctx);
            debugLog("capture", "Captured L0 experience record", { l0Ref, summary: l0Classification.summary });
            if (l0Ref !== null && l0Ref !== undefined) {
              const numRef = typeof l0Ref === "number" ? l0Ref : parseInt(String(l0Ref), 10);
              if (!isNaN(numRef)) capturedL0Refs.push(numRef);
              void recordAssociations(memDir(env), contentToStore).catch(() => {});
              notifyMmEvent(ctx, "saved");
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

    // 3. Dispatch incremental auto-consolidation through non-blocking queue
    if (hasActiveRun) {
      try {
        const task: ConsolidationTask = {
          capturedL0Refs: [...capturedL0Refs],
          ctx,
          timestamp: Date.now(),
        };
        const taskPromise = consolidationQueue.enqueue(task, envSource);
        // In synchronous test harnesses allow awaiting; in live agent production runs non-blocking
        if (ctx?.mode === "test" || (typeof Deno !== "undefined" && Deno?.env?.get("PI_MM_ASYNC_CONSOLIDATION") !== "1")) {
          await taskPromise;
        }
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

    // Check reinforcement trigger (session_start, compaction reset, or milestone)
    try {
      const env = await envSource(ctxUnknown as PiCtx);
      const usage = (ctxUnknown as { getContextUsage?: () => { percent?: number } })?.getContextUsage?.() ||
                    (pi as { getContextUsage?: () => { percent?: number } })?.getContextUsage?.();
      const pct = typeof usage?.percent === "number" ? usage.percent : 0;
      const reinfCfg = (env.cfg.reinforcement as Required<import("../config.ts").ReinforcementConfig>) ?? DEFAULT_REINFORCEMENT_CONFIG;
      const trigger = reinforcementScheduler.checkTrigger(pct, reinfCfg);
      if (trigger.trigger) {
        const promptText = typeof event.prompt === "string" ? event.prompt : "";
        const mentioned = promptText ? detectSubsystemMentions(promptText) : undefined;
        const directives = reinforcementScheduler.getDirectives(mentioned);
        const block = synthesizeReinforcementBlockFromDirectives(directives, ctxUnknown as PiCtx, trigger, reinfCfg);
        if (block && event.systemPromptOptions && typeof event.systemPromptOptions === "object") {
          if (!event.systemPromptOptions.sections) {
            event.systemPromptOptions.sections = {};
          }
          event.systemPromptOptions.sections["standing_directives"] = block;
          debugLog("reinforcement", "Injected standing directives into systemPromptOptions", {
            reason: trigger.reason,
            milestone: trigger.milestone,
          });
        }
      }
    } catch (err) {
      debugLog("reinforcement", "Reinforcement check failed", { error: String(err) });
    }

    const recallRes = await handleBeforeAgentStart(event, ctxUnknown as PiCtx, envSource);
    const details = recallRes?.message?.details as { refs?: unknown[]; recallIntent?: boolean } | undefined;
    if (details?.refs && details.refs.length > 0) {
      notifyMmEvent(ctxUnknown as PiCtx, "recalled", details.refs.length);
    }
    if (details?.recallIntent) {
      debugLog("recall", "recall_intent_classified", { prompt: event.prompt });
    }
    return recallRes;
  });

  const onBeforeCompact = async (eventUnknown: unknown, ctxUnknown?: unknown) => {
    // 0. Signal compaction reset to reinforcement scheduler
    reinforcementScheduler.onCompaction();

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
  pi.on("turn_start", async (_event: unknown, ctxUnknown?: unknown) => {
    if (!envSource || !ctxUnknown) return;
    try {
      const ctx = ctxUnknown as PiCtx;
      const env = await envSource(ctx);
      const usage = (ctx as { getContextUsage?: () => { percent?: number } })?.getContextUsage?.() ||
                    (pi as { getContextUsage?: () => { percent?: number } })?.getContextUsage?.();
      const pct = typeof usage?.percent === "number" ? usage.percent : 0;
      const reinfCfg = (env.cfg.reinforcement as Required<import("../config.ts").ReinforcementConfig>) ?? DEFAULT_REINFORCEMENT_CONFIG;
      const trigger = reinforcementScheduler.checkTrigger(pct, reinfCfg);
      if (trigger.trigger) {
        const directives = reinforcementScheduler.getDirectives();
        const block = synthesizeReinforcementBlockFromDirectives(directives, ctx, trigger, reinfCfg);
        if (block) {
          debugLog("reinforcement", "turn_start milestone triggered", {
            reason: trigger.reason,
            milestone: trigger.milestone,
            percent: pct,
          });
        }
      }
    } catch { /* best effort */ }
  });
  pi.on("agent_settled", onRunSettled);
  pi.on("session_before_compact", onBeforeCompact);
  pi.on("session_shutdown", async (_ev: unknown, ctxUnknown?: unknown) => {
    if (!envSource || !ctxUnknown) return;
    try {
      const env = await envSource(ctxUnknown as PiCtx);
      await runDeferredConsolidation(env, ctxUnknown as PiCtx);
    } catch { /* ignore shutdown errors */ }
    try {
      await SessionDrainRegistry.drain(3000);
    } catch { /* ignore drain errors */ }
  });
}
