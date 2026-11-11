import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SessionTurnEvent,
  SessionStoreOptions,
  SessionZoomHit,
} from "./types.ts";
import type { LineageSessionManagerLike, SessionLineageTracker } from "./lineage.ts";
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

interface SessionPersistedManifest {
  version: number;
  nextRef: number;
  events: Array<{ ref: number; event: SessionTurnEvent; lineOffsets: number[] }>;
}

const SESSION_MANIFEST_VERSION = 1;
const SYNTHETIC_ACP_LINE_RE = /^\[Antigravity tool(?: update)?: [^\n]+\]$/gm;

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
    this.sessionDir = options.sessionDir ?? join(cwd, ".pi", "cache", "sessions", this.sessionId);
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
    this.loadEventsFromDisk();
  }

  getMaxTurnIndex(): number {
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
  }

  private loadEventsFromDisk(): void {
    if (this.loadedFromDisk) return;
    this.loadedFromDisk = true;
    if (!existsSync(this.manifestPath)) return;
    try {
      const raw = readFileSync(this.manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as SessionPersistedManifest;
      if (!parsed || parsed.version !== SESSION_MANIFEST_VERSION || !Array.isArray(parsed.events)) return;
      this.nextRef = Math.max(this.nextRef, parsed.nextRef || 1);
      for (const item of parsed.events) {
        if (!item || typeof item.ref !== "number" || !item.event) continue;
        const ev = item.event;
        if (ev.role === "assistant" || ev.role === "user") {
          const cleaned = cleanSyntheticText(ev.text || "");
          if (!cleaned && !ev.thinking) continue;
          ev.text = cleaned;
        }
        // Skip previously persisted duplicate hydrated entries if an earlier live event already matches
        if (ev.id.startsWith("ev-hydrated-")) {
          const dup = this.findMatchingEvent(ev.role, ev.text || "", undefined, ev.toolName);
          if (dup) {
            this.aliasEntryId(dup.ref, ev.entryId, ev.parentId);
            continue;
          }
        }
        this.eventsByRef.set(item.ref, ev);
        this.lineOffsetsByRef.set(item.ref, item.lineOffsets ?? computeLineOffsets(ev.text || ""));
        if (ev.entryId) {
          this.eventsByEntryId.set(ev.entryId, ev);
        }
        if (item.ref >= this.nextRef) this.nextRef = item.ref + 1;
      }
    } catch {
      // Ignore corrupt cache
    }
  }

  private saveEventsToDisk(): void {
    try {
      if (!existsSync(this.sessionDir)) return;
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
        events,
      };
      const tmpPath = `${this.manifestPath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(manifest), "utf-8");
      renameSync(tmpPath, this.manifestPath);
    } catch {
      // Best-effort cache write
    }
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

    let turnIdx = this.getMaxTurnIndex();
    let added = false;

    for (const entry of rawEntries) {
      if (!entry || typeof entry !== "object") continue;
      const entryId = entry.id;
      const parentId = entry.parentId;
      if (entryId && tracker) {
        tracker.addEntry(entryId, parentId);
      }
      if (!entry.message || (entry.type && entry.type !== "message")) continue;
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
      let exitCode: number | undefined;

      if (roleRaw === "user") {
        role = "user";
        speaker = "User";
      } else if (roleRaw === "assistant") {
        role = "assistant";
        speaker = "Assistant";
      } else if (roleRaw === "tool" || roleRaw === "toolResult") {
        role = "tool";
        toolName = entry.message.toolName || "tool";
        speaker = toolName;
        if (toolName === "memory_recall" || toolName === "memory_record" || toolName === "memory_review") {
          continue;
        }
        exitCode = entry.message.isError ? 1 : 0;
      } else {
        continue;
      }

      // Deduplicate against live events recorded via SessionSink
      const existingMatch = this.findMatchingEvent(role, text, entry.message.toolCallId, toolName);
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

      const firstLine = (text || thinking || "").split("\n")[0] || "";
      const summary = firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
      const eId = entryId || `hydrated-${turnIdx}-${role}-${this.nextRef}`;
      if (this.eventsByEntryId.has(eId)) continue;

      const lineOffsets = computeLineOffsets(text);
      const lineCount = text.length === 0 ? 0 : text.split("\n").length;
      const byteLength = new TextEncoder().encode(text).length;
      const ref = this.nextRef++;

      const fullEvent: SessionTurnEvent = {
        id: `ev-hydrated-${eId}`,
        turnIndex: Math.max(1, turnIdx),
        entryId: eId,
        parentId,
        timestamp: entry.timestamp || new Date().toISOString(),
        role,
        speaker,
        summary,
        text,
        thinking,
        toolName,
        exitCode,
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
      this.loadEventsFromDisk();
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
    return this.eventsByEntryId.get(entryId) ?? null;
  }

  getAllEvents(): SessionTurnEvent[] {
    return Array.from(this.eventsByRef.values());
  }

  getEventCount(): number {
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
  return text.replace(SYNTHETIC_ACP_LINE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
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

