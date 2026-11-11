import { mkdir } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SessionTurnEvent,
  SessionStoreOptions,
  SessionZoomHit,
  SessionMetadata,
} from "./types.ts";
import type { LineageSessionManagerLike, SessionLineageTracker, SessionBranchEntry } from "./lineage.ts";
import {
  encodeSessionPayload,
  decodeSessionPayload,
  computeLineOffsets,
} from "./payload_codec.ts";
import type { CormRunner } from "../corm.ts";
import {
  ShellCormRunner,
  buildStoreInvocation,
  buildGetInvocation,
  buildScanInvocation,
  parseResultLines,
  type ResultLine,
} from "../corm.ts";
import { resolveCormBin, resolveAxisPath, runtimeEnv } from "../config.ts";
import { debugLog } from "../debug.ts";

export interface SessionPersistedManifest {
  version: number;
  nextRef: number;
  meta?: SessionMetadata;
  events: Array<{ ref: number; event: SessionTurnEvent; lineOffsets: number[] }>;
}

const SESSION_MANIFEST_VERSION = 1;

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "sh",
  "exec",
  "run_command",
  "quest_run_test",
  "test",
  "pi_bash",
  "pi_quest_run_test",
]);

const ERROR_KEYWORDS = [
  "fail",
  "failed",
  "error",
  "fatal",
  "panic",
  "undefined",
  "unresolved",
  "exception",
];

function isWordChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function containsWholeKeyword(haystackLower: string, keyword: string): boolean {
  let idx = haystackLower.indexOf(keyword);
  while (idx !== -1) {
    const before = idx > 0 ? haystackLower[idx - 1] : "";
    const after = idx + keyword.length < haystackLower.length ? haystackLower[idx + keyword.length] : "";
    if (!isWordChar(before) && !isWordChar(after)) {
      if (keyword === "failed") {
        const prefix = haystackLower.slice(Math.max(0, idx - 4), idx).trim();
        if (prefix === "0") {
          idx = haystackLower.indexOf(keyword, idx + keyword.length);
          continue;
        }
      }
      return true;
    }
    idx = haystackLower.indexOf(keyword, idx + keyword.length);
  }
  return false;
}

function lineHasErrorKeyword(line: string): boolean {
  const lower = line.toLowerCase();
  for (const kw of ERROR_KEYWORDS) {
    if (containsWholeKeyword(lower, kw)) return true;
  }
  return false;
}

export function extractWorkspaceLabel(cwd?: string): string | undefined {
  if (!cwd || typeof cwd !== "string") return undefined;
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length === 0) return undefined;
  for (let i = 0; i < parts.length - 2; i++) {
    if (parts[i] === ".pi" && parts[i + 1] === "scratch" && parts[i + 2].startsWith("slot-")) {
      return parts[i + 2];
    }
  }
  return parts[parts.length - 1];
}

export function resolvePrimaryRepoRootFromSlot(cwd: string): string | null {
  const isAbs = cwd.startsWith("/");
  const parts = cwd.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 2; i++) {
    if (parts[i] === ".pi" && parts[i + 1] === "scratch" && parts[i + 2].startsWith("slot-")) {
      const prefix = parts.slice(0, i).join("/");
      const candidateRoot = isAbs ? `/${prefix}` : prefix || ".";
      if (existsSync(join(candidateRoot, ".pi"))) {
        return candidateRoot;
      }
    }
  }
  return null;
}

function isTestRunnerDefaultCwd(resolvedCwd: string): boolean {
  const defaultCwd = resolveRuntimeCwd();
  if (resolvedCwd !== defaultCwd) return false;
  if (typeof Deno !== "undefined" && typeof Deno.mainModule === "string") {
    if (
      Deno.mainModule.endsWith(".test.ts") ||
      Deno.mainModule.includes("/tests/") ||
      Deno.mainModule.includes("/test/")
    ) {
      return true;
    }
  }
  return false;
}

export function resolveSharedSessionCacheRoot(cwd?: string): string {
  const resolved = resolveRuntimeCwd(cwd);
  if (isTestRunnerDefaultCwd(resolved)) {
    const pid = typeof process !== "undefined" ? process.pid : 0;
    return join(tmpdir(), `pi-mm-test-sessions-${pid}`, ".pi", "cache", "sessions");
  }
  const primaryRoot = resolvePrimaryRepoRootFromSlot(resolved);
  if (primaryRoot) {
    return join(primaryRoot, ".pi", "cache", "sessions");
  }
  return join(resolved, ".pi", "cache", "sessions");
}

export function listCandidateSessionCacheRoots(cwd?: string): string[] {
  const resolved = resolveRuntimeCwd(cwd);
  if (isTestRunnerDefaultCwd(resolved)) {
    return [resolveSharedSessionCacheRoot(resolved)];
  }
  const primaryRoot = resolvePrimaryRepoRootFromSlot(resolved) ?? resolved;
  const roots: string[] = [];
  const seen = new Set<string>();

  const addRoot = (dir: string) => {
    if (!seen.has(dir)) {
      seen.add(dir);
      roots.push(dir);
    }
  };

  addRoot(resolveSharedSessionCacheRoot(resolved));
  addRoot(join(resolved, ".pi", "cache", "sessions"));

  const scratchDir = join(primaryRoot, ".pi", "scratch");
  if (existsSync(scratchDir)) {
    try {
      const entries = readdirSync(scratchDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("slot-")) {
          const slotCache = join(scratchDir, entry.name, ".pi", "cache", "sessions");
          if (existsSync(slotCache)) {
            addRoot(slotCache);
          }
        }
      }
    } catch {
      // Ignore unreadable scratch dir
    }
  }

  return roots;
}

function formatHydratedToolSummary(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
  rawOutput: string,
  exitCode: number | undefined,
  errorSnippet: string | undefined,
): string {
  const statusStr = exitCode !== undefined && exitCode !== 0 ? ` (exit ${exitCode})` : "";
  const cmd = typeof toolArgs?.["command"] === "string"
    ? toolArgs["command"].trim().split("\n")[0].slice(0, 120)
    : typeof toolArgs?.["CommandLine"] === "string"
    ? toolArgs["CommandLine"].trim().split("\n")[0].slice(0, 120)
    : undefined;
  const pathArg = typeof toolArgs?.["path"] === "string"
    ? toolArgs["path"]
    : typeof toolArgs?.["file"] === "string"
    ? toolArgs["file"]
    : typeof toolArgs?.["TargetFile"] === "string"
    ? toolArgs["TargetFile"]
    : typeof toolArgs?.["AbsolutePath"] === "string"
    ? toolArgs["AbsolutePath"]
    : undefined;

  let base = `${toolName}${statusStr}`;
  if (cmd) {
    base += `: ${cmd}`;
  } else if (pathArg) {
    base += `: ${pathArg}`;
  } else {
    const firstOut = rawOutput.split("\n").map((l) => l.trim()).find(Boolean) || "";
    if (firstOut) {
      base += `: ${firstOut.slice(0, 120)}`;
    }
  }

  if (errorSnippet && !base.includes(errorSnippet.slice(0, 40))) {
    base += ` -> ${errorSnippet.slice(0, 100)}`;
  }

  return base.length > 200 ? `${base.slice(0, 197)}...` : base;
}

export class SessionStore {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly manifestPath: string;
  cormBin: string;
  axisPath: string;
  readonly runner: CormRunner;
  filespec: string;
  extraEnv: Record<string, string>;
  private embedUrl?: string;

  private nextRef = 1;
  private readonly eventsByRef = new Map<number, SessionTurnEvent>();
  private readonly lineOffsetsByRef = new Map<number, number[]>();
  private readonly eventsByEntryId = new Map<string, SessionTurnEvent>();
  private readonly inFlightWrites = new Set<Promise<void>>();
  private initialized = false;
  private loadedFromDisk = false;
  private lastLoadedMtimeMs = -1;
  private lastLoadedSize = -1;
  private metaCwd?: string;
  private metaWorkspaceLabel?: string;
  private metaSessionFile?: string;
  private attachedTracker?: SessionLineageTracker;

  private readonly options: SessionStoreOptions;

  async flush(timeoutMs = 250): Promise<void> {
    if (this.inFlightWrites.size === 0) return;
    const all = Promise.allSettled(Array.from(this.inFlightWrites));
    if (timeoutMs <= 0) {
      await all;
      return;
    }
    await Promise.race([
      all,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  constructor(
    options: SessionStoreOptions,
    customRunner?: CormRunner,
  ) {
    this.options = options;
    this.sessionId = options.sessionId;
    const cwd = resolveRuntimeCwd(options.cwd);
    this.metaCwd = options.cwd || cwd;
    this.metaWorkspaceLabel = options.workspaceLabel || extractWorkspaceLabel(this.metaCwd);
    this.metaSessionFile = options.sessionFile;
    this.sessionDir = options.sessionDir ?? join(resolveSharedSessionCacheRoot(cwd), this.sessionId);
    this.manifestPath = join(this.sessionDir, "events.json");

    // Resolve corm and axes
    const envMap = runtimeEnv();
    const pathDirs = (envMap["PATH"] || "").split(":");
    const resolvedBin = options.cormBin || resolveCormBin({ cormBin: "" } as any, cwd, pathDirs, existsSync).path;
    this.cormBin = resolvedBin || "corm";
    this.embedUrl = options.embedUrl || envMap["CORM_SEPAL_EMBED_URL"];

    const cfg = {
      cormBin: this.cormBin,
      axisLibs: options.axisLibs ?? null,
      memDir: this.sessionDir,
      scanLimit: 5,
      embedUrl: this.embedUrl,
      semanticSearch: Boolean(this.embedUrl),
    };
    this.axisPath = resolveAxisPath(cfg as any, cwd);

    const embed = Boolean(this.embedUrl);
    this.filespec = `${this.sessionDir}/session.db@joint,lemma${embed ? ",sepal" : ""}:a:b`;

    this.extraEnv = {
      CORM_AXIS_PATH: this.axisPath,
    };
    if (this.embedUrl) {
      this.extraEnv["CORM_SEPAL_EMBED_URL"] = this.embedUrl;
      this.extraEnv["CORM_SEPAL_EMBED_MODEL"] = options.embedModel || envMap["CORM_SEPAL_EMBED_MODEL"] || "bge-base";
      if (options.embedKey) this.extraEnv["CORM_SEPAL_EMBED_KEY"] = options.embedKey;
    }
    if (options.ephemeralSepal !== false) {
      this.extraEnv["CORM_SEPAL_EPHEMERAL"] = "1";
    }

    this.runner = customRunner ?? createDefaultRunner();
    this.refreshFromDiskIfNeeded();
  }

  attachTracker(tracker: SessionLineageTracker): void {
    this.attachedTracker = tracker;
    for (const ev of this.eventsByRef.values()) {
      if (ev.entryId) {
        tracker.addEntry(ev.entryId, ev.parentId);
      }
    }
  }

  setSessionFile(sessionFile?: string): void {
    if (sessionFile && sessionFile.trim()) {
      this.metaSessionFile = sessionFile.trim();
    }
  }

  setWorkspaceCwd(cwd?: string): void {
    if (cwd && cwd.trim()) {
      this.metaCwd = cwd.trim();
      this.metaWorkspaceLabel = extractWorkspaceLabel(this.metaCwd) ?? this.metaWorkspaceLabel;
    }
  }

  getMetadata(): SessionMetadata {
    this.refreshFromDiskIfNeeded();
    let startedAt = "";
    let updatedAt = "";
    let maxTurn = 0;
    let firstUserPrompt: string | undefined;

    for (const ev of this.eventsByRef.values()) {
      if (ev.timestamp) {
        if (!startedAt || ev.timestamp < startedAt) startedAt = ev.timestamp;
        if (!updatedAt || ev.timestamp > updatedAt) updatedAt = ev.timestamp;
      }
      if (ev.turnIndex > maxTurn) maxTurn = ev.turnIndex;
      if (firstUserPrompt === undefined && ev.role === "user" && ev.text) {
        const clean = ev.text.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
        if (clean) {
          firstUserPrompt = clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
        }
      }
    }

    const nowIso = new Date().toISOString();
    return {
      sessionId: this.sessionId,
      shortId: this.sessionId.slice(0, 8),
      cwd: this.metaCwd,
      workspaceLabel: this.metaWorkspaceLabel || extractWorkspaceLabel(this.metaCwd),
      sessionFile: this.metaSessionFile,
      startedAt: startedAt || nowIso,
      updatedAt: updatedAt || startedAt || nowIso,
      turnCount: maxTurn,
      eventCount: this.eventsByRef.size,
      firstUserPrompt,
    };
  }

  getMaxTurnIndex(): number {
    this.refreshFromDiskIfNeeded();
    let maxTurn = 0;
    for (const ev of this.eventsByRef.values()) {
      if (ev.turnIndex > maxTurn) maxTurn = ev.turnIndex;
    }
    return maxTurn;
  }

  findMatchingEvent(
    role: SessionTurnEvent["role"],
    text: string,
    toolCallId?: string,
    toolName?: string,
  ): { ref: number; event: SessionTurnEvent } | null {
    this.refreshFromDiskIfNeeded();
    const normText = text.trim();
    for (const [ref, ev] of this.eventsByRef.entries()) {
      if (toolCallId && ev.id === toolCallId) {
        return { ref, event: ev };
      }
      if (ev.role !== role) continue;
      if (role === "tool" && toolName && ev.toolName && ev.toolName !== toolName) continue;
      if (normText && (ev.text || "").trim() === normText) {
        return { ref, event: ev };
      }
    }
    return null;
  }

  aliasEntryId(ref: number, entryId: string, parentId?: string): void {
    const ev = this.eventsByRef.get(ref);
    if (!ev || !entryId) return;
    if (ev.entryId) {
      this.eventsByEntryId.set(ev.entryId, ev);
    }
    ev.entryId = entryId;
    this.eventsByEntryId.set(entryId, ev);
    if (parentId) {
      ev.parentId = parentId;
    }
    if (this.attachedTracker) {
      this.attachedTracker.addEntry(entryId, parentId);
    }
  }

  refreshFromDiskIfNeeded(tracker?: SessionLineageTracker): boolean {
    if (tracker) {
      this.attachedTracker = tracker;
    }
    if (!existsSync(this.manifestPath)) return false;
    try {
      const st = statSync(this.manifestPath);
      if (
        this.loadedFromDisk &&
        st.mtimeMs === this.lastLoadedMtimeMs &&
        st.size === this.lastLoadedSize
      ) {
        return false;
      }
      const raw = readFileSync(this.manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as SessionPersistedManifest;
      if (!parsed || parsed.version !== SESSION_MANIFEST_VERSION || !Array.isArray(parsed.events)) {
        return false;
      }

      this.loadedFromDisk = true;
      this.lastLoadedMtimeMs = st.mtimeMs;
      this.lastLoadedSize = st.size;

      if (parsed.meta) {
        if (parsed.meta.cwd) this.metaCwd = parsed.meta.cwd;
        if (parsed.meta.workspaceLabel) {
          this.metaWorkspaceLabel = parsed.meta.workspaceLabel;
        }
        if (parsed.meta.sessionFile && !this.metaSessionFile) {
          this.metaSessionFile = parsed.meta.sessionFile;
        }
      }

      this.nextRef = Math.max(this.nextRef, parsed.nextRef || 1);
      let addedAny = false;
      const activeTracker = tracker ?? this.attachedTracker;

      for (const item of parsed.events) {
        if (!item || typeof item.ref !== "number" || !item.event) continue;
        const ev = item.event;
        if (ev.role === "assistant" || ev.role === "user") {
          const cleaned = cleanSyntheticText(ev.text || "");
          if (!cleaned && !ev.thinking) continue;
          ev.text = cleaned;
        }
        if (this.eventsByRef.has(item.ref)) {
          const existing = this.eventsByRef.get(item.ref)!;
          if (ev.entryId && existing.entryId !== ev.entryId) {
            this.aliasEntryId(item.ref, ev.entryId, ev.parentId);
          }
          continue;
        }
        // Skip previously persisted duplicate hydrated entries if an earlier live event already matches
        if (ev.id.startsWith("ev-hydrated-")) {
          const dup = this.findMatchingEventInMemory(ev.role, ev.text || "", undefined, ev.toolName);
          if (dup) {
            this.aliasEntryId(dup.ref, ev.entryId, ev.parentId);
            continue;
          }
        }
        this.eventsByRef.set(item.ref, ev);
        this.lineOffsetsByRef.set(item.ref, item.lineOffsets ?? computeLineOffsets(ev.text || ""));
        if (ev.entryId) {
          this.eventsByEntryId.set(ev.entryId, ev);
          if (activeTracker) {
            activeTracker.addEntry(ev.entryId, ev.parentId);
          }
        }
        if (item.ref >= this.nextRef) this.nextRef = item.ref + 1;
        addedAny = true;
      }
      return addedAny;
    } catch {
      // Ignore corrupt or concurrently written cache
      return false;
    }
  }

  private findMatchingEventInMemory(
    role: SessionTurnEvent["role"],
    text: string,
    toolCallId?: string,
    toolName?: string,
  ): { ref: number; event: SessionTurnEvent } | null {
    const normText = text.trim();
    for (const [ref, ev] of this.eventsByRef.entries()) {
      if (toolCallId && ev.id === toolCallId) {
        return { ref, event: ev };
      }
      if (ev.role !== role) continue;
      if (role === "tool" && toolName && ev.toolName && ev.toolName !== toolName) continue;
      if (normText && (ev.text || "").trim() === normText) {
        return { ref, event: ev };
      }
    }
    return null;
  }

  private saveEventsToDisk(): void {
    try {
      if (!existsSync(this.sessionDir)) {
        mkdirSync(this.sessionDir, { recursive: true });
      }
      const events: Array<{ ref: number; event: SessionTurnEvent; lineOffsets: number[] }> = [];
      for (const [ref, event] of this.eventsByRef.entries()) {
        events.push({
          ref,
          event,
          lineOffsets: this.lineOffsetsByRef.get(ref) ?? [],
        });
      }
      const manifest: SessionPersistedManifest = {
        version: SESSION_MANIFEST_VERSION,
        nextRef: this.nextRef,
        meta: this.getMetadataSnapshot(),
        events,
      };
      const tmpPath = `${this.manifestPath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(manifest), "utf-8");
      renameSync(tmpPath, this.manifestPath);
      try {
        const st = statSync(this.manifestPath);
        this.lastLoadedMtimeMs = st.mtimeMs;
        this.lastLoadedSize = st.size;
        this.loadedFromDisk = true;
      } catch {
        // Ignore stat error
      }
    } catch {
      // Best-effort cache write
    }
  }

  private getMetadataSnapshot(): SessionMetadata {
    let startedAt = "";
    let updatedAt = "";
    let maxTurn = 0;
    let firstUserPrompt: string | undefined;

    for (const ev of this.eventsByRef.values()) {
      if (ev.timestamp) {
        if (!startedAt || ev.timestamp < startedAt) startedAt = ev.timestamp;
        if (!updatedAt || ev.timestamp > updatedAt) updatedAt = ev.timestamp;
      }
      if (ev.turnIndex > maxTurn) maxTurn = ev.turnIndex;
      if (firstUserPrompt === undefined && ev.role === "user" && ev.text) {
        const clean = ev.text.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
        if (clean) {
          firstUserPrompt = clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
        }
      }
    }

    const nowIso = new Date().toISOString();
    return {
      sessionId: this.sessionId,
      shortId: this.sessionId.slice(0, 8),
      cwd: this.metaCwd,
      workspaceLabel: this.metaWorkspaceLabel || extractWorkspaceLabel(this.metaCwd),
      sessionFile: this.metaSessionFile,
      startedAt: startedAt || nowIso,
      updatedAt: updatedAt || startedAt || nowIso,
      turnCount: maxTurn,
      eventCount: this.eventsByRef.size,
      firstUserPrompt,
    };
  }

  /**
   * Hydrates missing session events from raw Pi branch/session entries (in-memory or parsed from .jsonl).
   */
  hydrateFromRawEntries(
    rawEntries: SessionBranchEntry[],
    tracker?: SessionLineageTracker,
  ): boolean {
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) return false;
    this.refreshFromDiskIfNeeded(tracker);
    const activeTracker = tracker ?? this.attachedTracker;

    let turnIdx = this.getMaxTurnIndex();
    let added = false;
    const pendingToolCalls = new Map<string, { name: string; args?: Record<string, unknown> }>();

    for (const entry of rawEntries) {
      if (!entry || typeof entry !== "object") continue;
      const entryId = entry.id;
      const parentId = entry.parentId ?? undefined;
      if (entryId && activeTracker) {
        activeTracker.addEntry(entryId, parentId);
      }
      if (!entry.message || (entry.type && entry.type !== "message")) continue;

      // Always collect toolCall definitions from assistant messages even if entry was already seen
      if (Array.isArray(entry.message.content)) {
        for (const p of entry.message.content) {
          if (typeof p === "object" && p !== null) {
            const part = p as {
              type?: string;
              id?: string;
              name?: string;
              arguments?: Record<string, unknown>;
              input?: Record<string, unknown>;
              args?: Record<string, unknown>;
            };
            if ((part.type === "toolCall" || part.type === "tool_use") && part.id && part.name) {
              pendingToolCalls.set(part.id, {
                name: part.name,
                args: part.arguments ?? part.input ?? part.args,
              });
            }
          }
        }
      }

      if (entryId && this.eventsByEntryId.has(entryId)) {
        const existingByEntry = this.eventsByEntryId.get(entryId)!;
        if (existingByEntry.turnIndex > turnIdx) turnIdx = existingByEntry.turnIndex;
        continue;
      }

      const roleRaw = entry.message.role || "";
      const content = entry.message.content;
      let text = "";
      let thinking: string | undefined;

      if (typeof content === "string") {
        text = content.trim();
      } else if (Array.isArray(content)) {
        const textParts: string[] = [];
        const thinkParts: string[] = [];
        for (const p of content) {
          if (typeof p === "object" && p !== null) {
            const part = p as { type?: string; text?: string; thinking?: string };
            if (part.type === "text" && part.text) textParts.push(part.text);
            else if (part.type === "thinking" && (part.thinking || part.text)) {
              thinkParts.push(part.thinking || part.text || "");
            }
          }
        }
        text = textParts.join("\n").trim();
        if (thinkParts.length > 0) thinking = thinkParts.join("\n").trim();
      }

      if (roleRaw === "user" || roleRaw === "assistant") {
        text = cleanSyntheticText(text);
        if (thinking) thinking = cleanSyntheticText(thinking);
      }
      if (!text && !thinking) continue;

      let role: "user" | "assistant" | "tool" = "user";
      let speaker = "User";
      let toolName: string | undefined;
      let toolArgs: Record<string, unknown> | undefined;
      let filesTouched: string[] | undefined;
      let exitCode: number | undefined;
      let errorSnippet: string | undefined;

      const msgAny = entry.message as {
        role?: string;
        toolName?: string;
        toolCallId?: string;
        isError?: boolean;
        input?: Record<string, unknown>;
        args?: Record<string, unknown>;
        arguments?: Record<string, unknown>;
      };

      if (roleRaw === "user") {
        role = "user";
        speaker = "User";
      } else if (roleRaw === "assistant") {
        role = "assistant";
        speaker = "Assistant";
      } else if (roleRaw === "tool" || roleRaw === "toolResult") {
        role = "tool";
        const callInfo = msgAny.toolCallId ? pendingToolCalls.get(msgAny.toolCallId) : undefined;
        toolName = msgAny.toolName || callInfo?.name || "tool";
        speaker = toolName;
        if (
          toolName === "memory_recall" ||
          toolName === "memory_record" ||
          toolName === "memory_review" ||
          toolName === "pi_memory_recall" ||
          toolName === "pi_memory_record" ||
          toolName === "pi_memory_review"
        ) {
          continue;
        }
        toolArgs = msgAny.input ?? msgAny.args ?? msgAny.arguments ?? callInfo?.args;
        const pathVal = typeof toolArgs?.["path"] === "string"
          ? toolArgs["path"]
          : typeof toolArgs?.["file"] === "string"
          ? toolArgs["file"]
          : typeof toolArgs?.["TargetFile"] === "string"
          ? toolArgs["TargetFile"]
          : typeof toolArgs?.["AbsolutePath"] === "string"
          ? toolArgs["AbsolutePath"]
          : undefined;
        if (pathVal) {
          filesTouched = [pathVal];
        }

        const isShellOrTest = SHELL_TOOL_NAMES.has(toolName.toLowerCase());
        const allOutLines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        const errLines = isShellOrTest || msgAny.isError
          ? allOutLines.filter((l) => lineHasErrorKeyword(l))
          : [];
        const failed = Boolean(msgAny.isError) || (isShellOrTest && errLines.length > 0);
        exitCode = failed ? 1 : 0;
        if (failed) {
          errorSnippet = (errLines[0] || allOutLines[allOutLines.length - 1])?.slice(0, 150);
        }
      } else {
        continue;
      }

      // Deduplicate against live events recorded via SessionSink
      const existingMatch = this.findMatchingEventInMemory(role, text, msgAny.toolCallId, toolName);
      if (existingMatch) {
        if (entryId) {
          this.aliasEntryId(existingMatch.ref, entryId, parentId);
          added = true;
        }
        if (existingMatch.event.turnIndex > turnIdx) {
          turnIdx = existingMatch.event.turnIndex;
        }
        continue;
      }

      if (role === "user") {
        turnIdx++;
      } else if (turnIdx === 0) {
        turnIdx = 1;
      }

      const effectiveText = text || (thinking ? `[Thinking]\n${thinking}` : "");
      let summary: string;
      if (role === "tool" && toolName) {
        summary = formatHydratedToolSummary(toolName, toolArgs, effectiveText, exitCode, errorSnippet);
      } else {
        const firstLine = (text || thinking || "").split("\n")[0] || "";
        summary = firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
      }

      const eId = entryId || `hydrated-${turnIdx}-${role}-${this.nextRef}`;
      if (this.eventsByEntryId.has(eId)) continue;

      const lineOffsets = computeLineOffsets(effectiveText);
      const lineCount = effectiveText.length === 0 ? 0 : effectiveText.split("\n").length;
      const byteLength = new TextEncoder().encode(effectiveText).length;
      const ref = this.nextRef++;

      const fullEvent: SessionTurnEvent = {
        id: msgAny.toolCallId || `ev-hydrated-${eId}`,
        turnIndex: Math.max(1, turnIdx),
        entryId: eId,
        parentId,
        timestamp: entry.timestamp || new Date().toISOString(),
        role,
        speaker,
        summary,
        text: effectiveText,
        thinking,
        toolName,
        toolArgs,
        exitCode,
        filesTouched,
        errorSnippet,
        lineCount,
        byteLength,
      };

      this.eventsByRef.set(ref, fullEvent);
      this.lineOffsetsByRef.set(ref, lineOffsets);
      this.eventsByEntryId.set(eId, fullEvent);
      added = true;
    }

    if (added) {
      this.saveEventsToDisk();
    }
    return added;
  }

  /**
   * Hydrates missing session events from Pi's sessionManager branch/entries (e.g. after session restart or tree navigation).
   */
  hydrateFromSessionManager(
    sessionManager?: LineageSessionManagerLike,
    tracker?: SessionLineageTracker,
  ): void {
    if (!sessionManager) return;
    const rawEntries = sessionManager.getEntries?.() || sessionManager.getBranch?.() || [];
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) return;
    this.hydrateFromRawEntries(rawEntries, tracker);
  }

  /**
   * Hydrates full-fidelity session events directly from a Pi .jsonl transcript file on disk.
   */
  hydrateFromJsonlFile(
    filePath: string,
    tracker?: SessionLineageTracker,
  ): boolean {
    if (!filePath || !existsSync(filePath)) return false;
    this.metaSessionFile = filePath;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n");
      const entries: SessionBranchEntry[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (obj["type"] === "session") {
            if (typeof obj["cwd"] === "string" && obj["cwd"].trim()) {
              this.setWorkspaceCwd(obj["cwd"]);
            }
            continue;
          }
          if (obj["type"] === "message" || obj["message"]) {
            entries.push(obj as unknown as SessionBranchEntry);
          }
        } catch {
          // Ignore malformed individual JSONL line
        }
      }

      if (entries.length === 0) return false;
      const changed = this.hydrateFromRawEntries(entries, tracker);
      if (!changed && !existsSync(this.manifestPath) && this.eventsByRef.size > 0) {
        this.saveEventsToDisk();
      }
      return this.eventsByRef.size > 0;
    } catch (err) {
      debugLog("session", "Failed to hydrate SessionStore from JSONL file", {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  configure(updates: Partial<SessionStoreOptions>): void {
    const cwd = resolveRuntimeCwd(updates.cwd ?? this.options.cwd);
    if (updates.cormBin) {
      this.cormBin = updates.cormBin;
    }
    if (updates.embedUrl && !this.embedUrl) {
      this.embedUrl = updates.embedUrl;
      const cfg = {
        cormBin: this.cormBin,
        axisLibs: updates.axisLibs ?? this.options.axisLibs ?? null,
        memDir: this.sessionDir,
        scanLimit: 5,
        embedUrl: this.embedUrl,
        semanticSearch: true,
      };
      this.axisPath = resolveAxisPath(cfg as any, cwd);
      this.filespec = `${this.sessionDir}/session.db@joint,lemma,sepal:a:b`;
      this.extraEnv["CORM_AXIS_PATH"] = this.axisPath;
      this.extraEnv["CORM_SEPAL_EMBED_URL"] = this.embedUrl;
      this.extraEnv["CORM_SEPAL_EMBED_MODEL"] = updates.embedModel || this.options.embedModel || "bge-base";
      if (updates.embedKey) this.extraEnv["CORM_SEPAL_EMBED_KEY"] = updates.embedKey;
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      if (!existsSync(this.sessionDir)) {
        await mkdir(this.sessionDir, { recursive: true });
      }
      this.refreshFromDiskIfNeeded();
      this.initialized = true;
      debugLog("session", "SessionStore initialized with C multi-axis filespec", {
        sessionId: this.sessionId,
        filespec: this.filespec,
        axisPath: this.axisPath,
      });
    } catch (err) {
      debugLog("session", "Failed to initialize session directory", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getFilespec(): string {
    return this.filespec;
  }

  /**
   * Appends a session event to the store and persists it into the C multi-axis kernel (corm -p).
   */
  async appendEvent(eventData: Omit<SessionTurnEvent, "lineCount" | "byteLength">): Promise<number> {
    await this.init();
    this.refreshFromDiskIfNeeded();

    const rawText = eventData.text || "";
    const lineOffsets = computeLineOffsets(rawText);
    const lineCount = rawText.length === 0 ? 0 : rawText.split("\n").length;
    const byteLength = new TextEncoder().encode(rawText).length;

    const ref = this.nextRef++;
    const fullEvent: SessionTurnEvent = {
      ...eventData,
      lineCount,
      byteLength,
    };

    // 1. In-memory indexing & line-offset jump table
    this.eventsByRef.set(ref, fullEvent);
    this.lineOffsetsByRef.set(ref, lineOffsets);
    if (fullEvent.entryId) {
      this.eventsByEntryId.set(fullEvent.entryId, fullEvent);
    }
    this.saveEventsToDisk();

    // 2. Persist to genuine C kernel via corm -p (non-blocking for Zero-Lag Invariant)
    const date = fullEvent.timestamp?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const payloadBytes = encodeSessionPayload(date, eventData, lineOffsets);

    const writePromise = (async () => {
      try {
        const storeInv = buildStoreInvocation(
          this.cormBin,
          this.filespec,
          ref,
          payloadBytes,
          this.axisPath,
          this.sessionDir,
          this.extraEnv,
        );
        const res = await this.runner.run(storeInv);
        debugLog("session", "Persisted event into C session.db kernel", {
          ref,
          exitCode: res.code,
          stderr: res.stderr ? res.stderr.slice(0, 100) : undefined,
        });
      } catch (err) {
        debugLog("session", "Failed to persist to corm store", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    this.inFlightWrites.add(writePromise);
    writePromise.finally(() => this.inFlightWrites.delete(writePromise));

    return ref;
  }

  async getEvent(ref: number): Promise<SessionTurnEvent | null> {
    this.refreshFromDiskIfNeeded();
    if (this.eventsByRef.has(ref)) {
      return this.eventsByRef.get(ref)!;
    }

    try {
      const getInv = buildGetInvocation(
        this.cormBin,
        this.filespec,
        ref,
        this.axisPath,
        this.sessionDir,
        this.extraEnv,
      );
      const res = await this.runner.run(getInv);
      if (res.code === 0 && res.stdout) {
        const decoded = decodeSessionPayload(res.stdout);
        if (decoded) {
          this.eventsByRef.set(ref, decoded.event);
          this.lineOffsetsByRef.set(ref, decoded.lineOffsets);
          if (decoded.event.entryId) {
            this.eventsByEntryId.set(decoded.event.entryId, decoded.event);
          }
          return decoded.event;
        }
      }
    } catch {
      // Fallback
    }

    return null;
  }

  getEventByEntryId(entryId: string): SessionTurnEvent | null {
    this.refreshFromDiskIfNeeded();
    return this.eventsByEntryId.get(entryId) ?? null;
  }

  getAllEvents(): SessionTurnEvent[] {
    this.refreshFromDiskIfNeeded();
    return Array.from(this.eventsByRef.values());
  }

  getEventCount(): number {
    this.refreshFromDiskIfNeeded();
    return this.eventsByRef.size;
  }

  /**
   * Executes genuine lexical FTS scan using liblemma via corm -X '(lemma)'.
   */
  async queryLexical(topic: string, limit = 5): Promise<ResultLine[]> {
    try {
      const args = ["--field=text", "--query=" + topic];
      const scanInv = buildScanInvocation(
        this.cormBin,
        this.filespec,
        "(lemma)",
        limit,
        this.axisPath,
        this.sessionDir,
        this.extraEnv,
        args,
      );
      const res = await this.runner.run(scanInv);
      if (res.code === 0 && res.stdout) {
        return parseResultLines(res.stdout);
      }
    } catch (err) {
      debugLog("session", "Corm lexical query error", { error: String(err) });
    }
    return [];
  }

  /**
   * Executes genuine semantic vector scan using libsepal via corm -X '(sepal)'.
   */
  async querySemantic(topic: string, limit = 5): Promise<ResultLine[]> {
    if (!this.embedUrl) return [];
    try {
      const args = ["--field=text", "--query=" + topic];
      const scanInv = buildScanInvocation(
        this.cormBin,
        this.filespec,
        "(sepal)",
        limit,
        this.axisPath,
        this.sessionDir,
        this.extraEnv,
        args,
      );
      const res = await this.runner.run(scanInv);
      if (res.code === 0 && res.stdout) {
        return parseResultLines(res.stdout);
      }
    } catch (err) {
      debugLog("session", "Corm semantic query error", { error: String(err) });
    }
    return [];
  }

  /**
   * Slices lines from an event's text payload using the line-offset jump table in O(1).
   */
  sliceLines(ref: number, range?: [number, number]): SessionZoomHit | null {
    this.refreshFromDiskIfNeeded();
    const ev = this.eventsByRef.get(ref);
    if (!ev) return null;

    const rawText = ev.text || "";
    const allLines = rawText.split("\n");
    const totalLines = allLines.length;

    let start = 1;
    let end = totalLines;
    if (range && Array.isArray(range) && range.length === 2) {
      start = Math.max(1, Math.min(range[0], totalLines));
      end = Math.max(start, Math.min(range[1], totalLines));
    }

    const offsets = this.lineOffsetsByRef.get(ref);
    // If jump offsets are available, verify line bounds
    if (offsets && offsets.length >= totalLines) {
      // Direct jump offset slice verification
      const startByte = offsets[start - 1] ?? 0;
      const endByte = start < totalLines ? (offsets[end] ?? rawText.length) : rawText.length;
      debugLog("session", "Slicing lines via mmap jump offsets", {
        ref,
        start,
        end,
        startByte,
        endByte,
      });
    }

    const sliced = allLines.slice(start - 1, end).map((text, idx) => ({
      lineNum: start + idx,
      text,
    }));

    return {
      ref,
      turnIndex: ev.turnIndex,
      toolName: ev.toolName,
      totalLines,
      startLine: start,
      endLine: end,
      lines: sliced,
      rawContent: sliced.map((l) => `${l.lineNum} | ${l.text}`).join("\n"),
    };
  }

  getEventsByTurn(turnIndex: number): Array<{ ref: number; event: SessionTurnEvent }> {
    this.refreshFromDiskIfNeeded();
    const results: Array<{ ref: number; event: SessionTurnEvent }> = [];
    for (const [ref, ev] of this.eventsByRef.entries()) {
      if (ev.turnIndex === turnIndex) {
        results.push({ ref, event: ev });
      }
    }
    return results;
  }

  clear(): void {
    this.eventsByRef.clear();
    this.lineOffsetsByRef.clear();
    this.eventsByEntryId.clear();
    this.nextRef = 1;
    this.lastLoadedMtimeMs = -1;
    this.lastLoadedSize = -1;
    this.loadedFromDisk = false;
    try {
      if (existsSync(this.manifestPath)) {
        unlinkSync(this.manifestPath);
      }
    } catch {
      // ignore
    }
  }
}

export function cleanSyntheticText(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let emptyRun = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      (trimmed.startsWith("[Antigravity tool: ") || trimmed.startsWith("[Antigravity tool update: ")) &&
      trimmed.endsWith("]")
    ) {
      continue;
    }
    if (trimmed === "") {
      emptyRun++;
      if (emptyRun <= 1) {
        kept.push("");
      }
    } else {
      emptyRun = 0;
      kept.push(line);
    }
  }
  return kept.join("\n").trim();
}

export function resolveRuntimeCwd(explicitCwd?: string): string {
  if (explicitCwd && explicitCwd.trim() !== "") return explicitCwd;
  if (typeof Deno !== "undefined" && typeof Deno.cwd === "function") {
    return Deno.cwd();
  }
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    return process.cwd();
  }
  return ".";
}

export function createDefaultRunner(): CormRunner {
  return new ShellCormRunner(async (command, args, options) => {
    if (typeof Deno !== "undefined" && Deno.Command) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const cmd = new Deno.Command(command, {
          args,
          cwd: options?.cwd,
          env: options?.env,
          stdin: options?.stdin ? "piped" : "null",
          stdout: "piped",
          stderr: "piped",
          signal: controller.signal,
        });
        let out;
        if (options?.stdin) {
          const child = cmd.spawn();
          const writer = child.stdin.getWriter();
          await writer.write(options.stdin);
          await writer.close();
          out = await child.output();
        } else {
          out = await cmd.output();
        }
        const dec = new TextDecoder();
        return {
          stdout: dec.decode(out.stdout),
          stderr: dec.decode(out.stderr),
          code: out.code,
        };
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : "corm process timed out or failed",
          code: 124,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        stdio: [options?.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const finish = (res: { stdout: string; stderr: string; code: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        finish({ stdout, stderr: stderr || "corm process timed out", code: 124 });
      }, 10000);
      if (options?.stdin && child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.write(options.stdin);
        child.stdin.end();
      }
      child.stdout?.on("data", (d) => stdout += d.toString());
      child.stderr?.on("data", (d) => stderr += d.toString());
      child.on("close", (code) => finish({ stdout, stderr, code: code ?? 0 }));
      child.on("error", (err) => finish({ stdout: "", stderr: err.message, code: 1 }));
    });
  });
}

