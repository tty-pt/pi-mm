import type { SessionStore } from "./store.ts";
import type { SessionLineageTracker } from "./lineage.ts";
import type { SessionTurnEvent } from "./types.ts";
import { formatToolEventSummary } from "../hooks/events.ts";
import type { ToolResultEvent } from "../hooks/events.ts";
import { debugLog } from "../debug.ts";

const SKIP_TOOL_NAMES = new Set([
  "memory_recall",
  "memory_record",
  "memory_review",
]);

const SYNTHETIC_ACP_LINE_RE = /^\[Antigravity tool(?: update)?: [^\n]+\]$/gm;
const SHELL_OR_TEST_TOOL_RE = /^(?:bash|sh|exec|run_command|quest_run_test|test)$/i;

export class SessionSink {
  private currentTurnIndex = 1;
  private currentEntryId = "entry-1";
  private currentParentId?: string;
  private entryIdConsumed = false;
  private eventSeq = 0;
  private readonly store: SessionStore;
  private readonly tracker?: SessionLineageTracker;

  constructor(
    store: SessionStore,
    tracker?: SessionLineageTracker,
  ) {
    this.store = store;
    this.tracker = tracker;
  }

  setTurn(turnIndex: number, entryId?: string, parentId?: string): void {
    this.currentTurnIndex = turnIndex;
    if (entryId) {
      this.currentEntryId = entryId;
      this.entryIdConsumed = false;
      if (this.tracker) {
        this.tracker.addEntry(entryId, parentId);
      }
    }
    if (parentId) this.currentParentId = parentId;
  }

  getCurrentTurnIndex(): number {
    return this.currentTurnIndex;
  }

  private allocateEventIds(
    roleLabel: string,
    explicitEntryId?: string,
    explicitParentId?: string,
  ): { eId: string; pId?: string } {
    if (explicitEntryId) {
      const pId = explicitParentId ?? (explicitEntryId !== this.currentEntryId ? this.currentEntryId : this.currentParentId);
      this.currentEntryId = explicitEntryId;
      this.currentParentId = pId;
      this.entryIdConsumed = true;
      if (this.tracker) this.tracker.addEntry(explicitEntryId, pId);
      return { eId: explicitEntryId, pId };
    }
    if (!this.entryIdConsumed && this.currentEntryId) {
      this.entryIdConsumed = true;
      if (this.tracker) this.tracker.addEntry(this.currentEntryId, this.currentParentId);
      return { eId: this.currentEntryId, pId: this.currentParentId };
    }
    const pId = explicitParentId ?? this.currentEntryId;
    const eId = `entry-${this.currentTurnIndex}-${roleLabel}-${++this.eventSeq}`;
    this.currentEntryId = eId;
    this.currentParentId = pId;
    this.entryIdConsumed = true;
    if (this.tracker) this.tracker.addEntry(eId, pId);
    return { eId, pId };
  }

  async recordUserPrompt(
    prompt: string,
    entryId?: string,
    parentId?: string,
  ): Promise<number> {
    const cleanPrompt = stripSyntheticProgressLines(prompt);
    if (!cleanPrompt) return 0;

    const existing = this.store.findMatchingEvent("user", cleanPrompt);
    if (existing && existing.event.turnIndex === this.currentTurnIndex) {
      if (entryId) {
        this.store.aliasEntryId(existing.ref, entryId, parentId);
        this.currentEntryId = entryId;
        this.entryIdConsumed = true;
      }
      return existing.ref;
    }

    const { eId, pId } = this.allocateEventIds("user", entryId, parentId);

    const summary = cleanPrompt.length > 200
      ? `${cleanPrompt.slice(0, 197)}...`
      : cleanPrompt;

    const ref = await this.store.appendEvent({
      id: `ev-${Date.now()}-user-${this.currentTurnIndex}`,
      turnIndex: this.currentTurnIndex,
      entryId: eId,
      parentId: pId,
      timestamp: new Date().toISOString(),
      role: "user",
      speaker: "User",
      summary,
      text: cleanPrompt,
    });

    debugLog("session", "Recorded user prompt in session store", { ref, turnIndex: this.currentTurnIndex });
    return ref;
  }

  async recordAssistantResponse(
    text: string,
    thinking?: string,
    entryId?: string,
    parentId?: string,
  ): Promise<number> {
    const cleanText = stripSyntheticProgressLines(text);
    const cleanThinking = thinking ? stripSyntheticProgressLines(thinking) : undefined;
    if (!cleanText && !cleanThinking) return 0;

    const existing = this.store.findMatchingEvent("assistant", cleanText);
    if (existing && existing.event.turnIndex === this.currentTurnIndex) {
      if (entryId) {
        this.store.aliasEntryId(existing.ref, entryId, parentId);
        this.currentEntryId = entryId;
        this.entryIdConsumed = true;
      }
      return existing.ref;
    }

    const { eId, pId } = this.allocateEventIds("assistant", entryId, parentId);

    const firstLine = cleanText.split("\n")[0] || cleanThinking?.split("\n")[0] || "";
    const summary = firstLine.length > 200
      ? `${firstLine.slice(0, 197)}...`
      : firstLine || "Assistant response";

    const ref = await this.store.appendEvent({
      id: `ev-${Date.now()}-assistant-${this.currentTurnIndex}`,
      turnIndex: this.currentTurnIndex,
      entryId: eId,
      parentId: pId,
      timestamp: new Date().toISOString(),
      role: "assistant",
      speaker: "Assistant",
      summary,
      text: cleanText,
      thinking: cleanThinking,
    });

    debugLog("session", "Recorded assistant turn in session store", { ref, turnIndex: this.currentTurnIndex });
    return ref;
  }

  async recordToolResult(
    event: ToolResultEvent,
    entryId?: string,
    parentId?: string,
  ): Promise<number | null> {
    if (SKIP_TOOL_NAMES.has(event.toolName)) {
      return null;
    }

    const tool = event.toolName || "tool";
    const rawOutput = event.content?.map((c) => c.text || "").join("\n").trim() || "";

    // Internal introspection skip
    const cmd = String(event.input?.["command"] || event.args?.["command"] || "");
    if (cmd.includes("corm -r -g") || cmd.includes("session.db") || cmd.includes("mem.db")) {
      return null;
    }

    const path = typeof event.input?.["path"] === "string" ? event.input["path"]
               : typeof event.args?.["path"] === "string" ? event.args["path"]
               : typeof event.input?.["file"] === "string" ? event.input["file"]
               : typeof event.args?.["file"] === "string" ? event.args["file"]
               : undefined;

    const filesTouched = path ? [path] : undefined;

    const isErr = Boolean(event.isError);
    const isShellOrTest = SHELL_OR_TEST_TOOL_RE.test(tool);
    const hasErrorWord = isShellOrTest &&
      /\b(?:FAIL|failed|error|fatal|panic|undefined|unresolved|exception)\b/i.test(rawOutput.replace(/0\s+failed/gi, ""));
    const failed = isErr || hasErrorWord;
    const exitCode = failed ? 1 : 0;

    let errorSnippet: string | undefined;
    if (failed) {
      const allOutLines = rawOutput.split("\n").map((l) => l.trim()).filter(Boolean);
      const errLines = allOutLines.filter((l) => /\b(?:FAIL|failed|error|fatal|panic|undefined|unresolved|exception)\b/i.test(l));
      errorSnippet = (errLines[0] || allOutLines[allOutLines.length - 1])?.slice(0, 150);
    }

    // Zero-lag structured summary for vector embedding & high-signal display
    const summary = formatToolEventSummary(event);

    const { eId, pId } = this.allocateEventIds(tool, entryId, parentId);

    const ref = await this.store.appendEvent({
      id: event.toolCallId || `ev-${Date.now()}-${tool}`,
      turnIndex: this.currentTurnIndex,
      entryId: eId,
      parentId: pId,
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: tool,
      summary,
      text: rawOutput,
      toolName: tool,
      toolArgs: event.input ? { ...event.input } : event.args ? { ...event.args } : undefined,
      exitCode,
      filesTouched,
      errorSnippet,
    });

    debugLog("session", "Recorded tool execution in session store", { ref, tool, exitCode });
    return ref;
  }
}

export function stripSyntheticProgressLines(text: string): string {
  return text.replace(SYNTHETIC_ACP_LINE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

