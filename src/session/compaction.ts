import type { SessionStore } from "./store.ts";
import { debugLog } from "../debug.ts";

export interface BranchEntryLike {
  id: string;
  type: string;
  firstKeptEntryId?: string;
  message?: { role: string; content: unknown };
}

export interface MipmapCompactionOptions {
  branchEntries: BranchEntryLike[];
  sessionStore: SessionStore;
  directives?: string[];
  sessionId?: string;
  tokensBefore?: number;
}

export interface MipmapCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  reductionPct: number;
  summarizedCount: number;
  keptCount: number;
}

export function buildMipmapCompaction(options: MipmapCompactionOptions): MipmapCompactionResult | null {
  const { branchEntries, sessionStore, directives = [], tokensBefore } = options;
  if (!branchEntries || branchEntries.length <= 2) {
    return null;
  }

  // 1. Locate cut point: keep the last user turn as active context
  const liveMessages = branchEntries.filter((e) => e.type === "message" && e.message);
  if (liveMessages.length === 0) return null;

  let cutIdx = liveMessages.length - 1;
  while (cutIdx > 0 && liveMessages[cutIdx].message?.role !== "user") {
    cutIdx--;
  }

  const keptEntries = liveMessages.slice(cutIdx);
  const summarizedEntries = liveMessages.slice(0, cutIdx);
  if (summarizedEntries.length === 0) return null;

  const firstKeptEntryId = keptEntries[0].id;

  // 2. Extract Goal from initial user messages
  const firstUser = liveMessages.find((e) => e.message?.role === "user");
  let goalText = "Perform active engineering task";
  if (firstUser?.message?.content) {
    const rawContent = typeof firstUser.message.content === "string"
      ? firstUser.message.content
      : Array.isArray(firstUser.message.content)
        ? (firstUser.message.content as Array<{ text?: string }>).map((c) => c.text || "").join(" ")
        : "";
    const clean = rawContent.replace(/<[^>]+>/g, "").trim().split("\n")[0];
    if (clean) goalText = clean.slice(0, 200);
  }

  // 3. Extract Files, Inflection Timeline & Changes from SessionStore
  const allEvents = sessionStore.getAllEvents();
  const modifiedFiles = new Set<string>();
  const toolErrors: string[] = [];
  const signalTimeline: string[] = [];
  const recentDialogue: string[] = [];
  let toolCount = 0;
  let userCount = 0;

  for (const ev of allEvents) {
    if (ev.role === "tool") {
      toolCount++;
      if (ev.filesTouched) {
        for (const f of ev.filesTouched) modifiedFiles.add(f);
      }
      if (ev.errorSnippet && toolErrors.length < 5) {
        toolErrors.push(`- Turn ${ev.turnIndex} (${ev.toolName || "tool"}): ${ev.errorSnippet}`);
      }
      if (signalTimeline.length < 8) {
        const status = ev.exitCode !== undefined
          ? (ev.exitCode === 0 ? "OK" : `FAILED (exit ${ev.exitCode})`)
          : "DONE";
        const headline = (ev.errorSnippet || ev.summary || "").slice(0, 120);
        signalTimeline.push(`- Turn ${ev.turnIndex} · ${ev.toolName || ev.speaker} [${status}]: ${headline}`);
      }
    } else if (ev.role === "user") {
      userCount++;
      const text = (ev.text || ev.summary || "").replace(/\s+/g, " ").trim();
      if (text) {
        const clipped = text.length > 220 ? `${text.slice(0, 220)}…` : text;
        recentDialogue.push(`- Turn ${ev.turnIndex} (User): "${clipped}"`);
      }
    } else if (ev.role === "assistant") {
      const text = (ev.text || ev.summary || "").replace(/\s+/g, " ").trim();
      if (text) {
        const clipped = text.length > 320 ? `${text.slice(0, 320)}…` : text;
        recentDialogue.push(`- Turn ${ev.turnIndex} (Assistant): "${clipped}"`);
      }
    }
  }

  // Fallback to summarizedEntries for assistant/user turns if not all were in SessionStore
  if (!recentDialogue.some((line) => line.includes("(Assistant):"))) {
    let approxTurn = 1;
    for (const entry of summarizedEntries) {
      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const rawContent = typeof entry.message?.content === "string"
        ? entry.message.content
        : Array.isArray(entry.message?.content)
          ? (entry.message?.content as Array<{ type?: string; text?: string }>)
              .filter((c) => !c.type || c.type === "text")
              .map((c) => c.text || "")
              .join(" ")
          : "";
      const clean = rawContent.replace(/\s+/g, " ").trim();
      if (!clean) continue;
      if (role === "user") {
        const clipped = clean.length > 220 ? `${clean.slice(0, 220)}…` : clean;
        const line = `- Turn ${approxTurn} (User): "${clipped}"`;
        if (!recentDialogue.includes(line)) recentDialogue.push(line);
      } else if (role === "assistant") {
        const clipped = clean.length > 320 ? `${clean.slice(0, 320)}…` : clean;
        recentDialogue.push(`- Turn ${approxTurn} (Assistant): "${clipped}"`);
        approxTurn++;
      }
    }
  }

  // 4. Construct Mipmap Sections
  const sections: string[] = [];

  // Goal
  sections.push(`[Session Goal]\n- ${goalText}`);

  // Invariants & Directives
  if (directives.length > 0) {
    const dirLines = directives.slice(0, 8).map((d) => `- ${d}`);
    sections.push(`[Active Project Invariants & Directives]\n${dirLines.join("\n")}`);
  }

  // Files touched
  if (modifiedFiles.size > 0) {
    const filesList = Array.from(modifiedFiles).slice(0, 15).map((f) => `- ${f}`);
    sections.push(`[Files And Touched Assets]\n${filesList.join("\n")}`);
  }

  // Key Signal Timeline (Inflection points)
  if (signalTimeline.length > 0) {
    sections.push(`[Key Signal Timeline]\n${signalTimeline.join("\n")}`);
  }

  // Key diagnostics/errors if any
  if (toolErrors.length > 0) {
    sections.push(`[Key Diagnostic Signals]\n${toolErrors.join("\n")}`);
  }

  // Recent Conversational Thread (User & Assistant prose continuity)
  if (recentDialogue.length > 0) {
    sections.push(`[Recent Conversational Thread]\n${recentDialogue.slice(-6).join("\n")}`);
  }

  // Ephemeral Memory Anchor
  const lastSummarizedTurn = allEvents.length > 0 ? allEvents[allEvents.length - 1].turnIndex : summarizedEntries.length;
  sections.push(
    `[Ephemeral Session Memory Anchor]\n` +
    `- Historical turn details 1–${lastSummarizedTurn} (${toolCount} tool executions, ${userCount} interactions) are indexed in session memory.\n` +
    `- Query past compiler outputs, diffs, or discussions naturally via: memory_recall({ query: "<topic>", scope: "session" })\n` +
    `- Inspect full turn dialogue (User + Assistant + tools) via: memory_recall({ scope: "session", zoomTurn: <turn> })\n` +
    `- Inspect exact raw lines via: memory_recall({ zoomTurn: <turn>, lineRange: [<start>, <end>] })`
  );

  const summary = sections.join("\n\n");

  // Token estimations
  const totalCharsBefore = branchEntries.reduce((sum, e) => {
    const c = e.message?.content;
    if (typeof c === "string") return sum + c.length;
    if (Array.isArray(c)) {
      return sum + (c as Array<{ text?: string }>).reduce((s, p) => s + (p.text?.length || 0), 0);
    }
    return sum;
  }, 0);

  const tokensBeforeEst = tokensBefore ?? Math.max(1, Math.round(totalCharsBefore / 4));
  const tokensAfterEst = Math.round(summary.length / 4);
  const reductionPct = Math.max(0, Math.min(99, Math.round(((tokensBeforeEst - tokensAfterEst) / tokensBeforeEst) * 100)));

  debugLog("session", "Built Mipmap Compaction", {
    tokensBeforeEst,
    tokensAfterEst,
    reductionPct,
    summarizedCount: summarizedEntries.length,
    keptCount: keptEntries.length,
  });

  return {
    summary,
    firstKeptEntryId,
    tokensBeforeEst,
    tokensAfterEst,
    reductionPct,
    summarizedCount: summarizedEntries.length,
    keptCount: keptEntries.length,
  };
}
