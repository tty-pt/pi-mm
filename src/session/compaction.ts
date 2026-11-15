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
  keepRecentUserTurns?: number;
}

export interface MipmapCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  reductionPct: number;
  summarizedCount: number;
  keptCount: number;
  lastSummarizedTurn: number;
  maxTurn: number;
}

function extractMessageProse(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((c) => !c.type || c.type === "text")
      .map((c) => c.text || "")
      .join(" ");
  }
  return "";
}

interface CollectedCompactionSignals {
  modifiedFiles: Set<string>;
  toolErrors: string[];
  signalTimeline: string[];
  dialogueByTurn: Map<number, { user?: string; assistant?: string }>;
  toolCount: number;
  userCount: number;
}

function collectCompactionSignals(
  sessionStore: SessionStore,
  summarizedEntries: BranchEntryLike[],
): CollectedCompactionSignals {
  const allEvents = sessionStore.getAllEvents();
  const modifiedFiles = new Set<string>();
  const toolErrors: string[] = [];
  const signalTimeline: string[] = [];
  const dialogueByTurn = new Map<number, { user?: string; assistant?: string }>();
  let toolCount = 0;
  let userCount = 0;

  for (const ev of allEvents) {
    if (ev.role === "tool") {
      toolCount++;
      if (ev.filesTouched) for (const f of ev.filesTouched) modifiedFiles.add(f);
      if (ev.errorSnippet && toolErrors.length < 5) {
        toolErrors.push(`- Turn ${ev.turnIndex} (${ev.toolName || "tool"}): ${ev.errorSnippet}`);
      }
      if (signalTimeline.length < 8) {
        const status = ev.exitCode !== undefined ? (ev.exitCode === 0 ? "OK" : `FAILED (exit ${ev.exitCode})`) : "DONE";
        const headline = (ev.errorSnippet || ev.summary || "").slice(0, 120);
        signalTimeline.push(`- Turn ${ev.turnIndex} · ${ev.toolName || ev.speaker} [${status}]: ${headline}`);
      }
    } else if (ev.role === "user") {
      userCount++;
      const text = (ev.text || ev.summary || "").replace(/\s+/g, " ").trim();
      if (text) {
        const pair = dialogueByTurn.get(ev.turnIndex) ?? {};
        pair.user = text;
        dialogueByTurn.set(ev.turnIndex, pair);
      }
    } else if (ev.role === "assistant") {
      const text = (ev.text || ev.summary || "").replace(/\s+/g, " ").trim();
      if (text) {
        const pair = dialogueByTurn.get(ev.turnIndex) ?? {};
        pair.assistant = text;
        dialogueByTurn.set(ev.turnIndex, pair);
      }
    }
  }

  let branchTurn = 0;
  for (const entry of summarizedEntries) {
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const clean = extractMessageProse(entry.message?.content).replace(/\s+/g, " ").trim();
    if (!clean) continue;
    if (role === "user") {
      branchTurn++;
      const existing = dialogueByTurn.get(branchTurn) ?? {};
      if (!existing.user) existing.user = clean;
      dialogueByTurn.set(branchTurn, existing);
    } else if (role === "assistant") {
      const targetTurn = Math.max(1, branchTurn);
      const existing = dialogueByTurn.get(targetTurn) ?? {};
      if (!existing.assistant) existing.assistant = clean;
      dialogueByTurn.set(targetTurn, existing);
    }
  }

  return { modifiedFiles, toolErrors, signalTimeline, dialogueByTurn, toolCount, userCount };
}

export function buildMipmapCompaction(options: MipmapCompactionOptions): MipmapCompactionResult | null {
  const { branchEntries, sessionStore, directives = [], tokensBefore, keepRecentUserTurns = 1 } = options;
  if (!branchEntries || branchEntries.length <= 2) return null;

  const liveMessages = branchEntries.filter((e) => e.type === "message" && e.message);
  if (liveMessages.length === 0) return null;

  const userIndices: number[] = [];
  for (let i = 0; i < liveMessages.length; i++) {
    if (liveMessages[i].message?.role === "user") userIndices.push(i);
  }
  if (userIndices.length <= 1) return null;

  const targetTurnsToKeep = Math.max(1, Math.min(keepRecentUserTurns, userIndices.length - 1));
  const cutIdx = userIndices[userIndices.length - targetTurnsToKeep];
  const keptEntries = liveMessages.slice(cutIdx);
  const summarizedEntries = liveMessages.slice(0, cutIdx);
  if (summarizedEntries.length === 0) return null;

  const firstKeptEntryId = keptEntries[0].id;
  const firstUser = liveMessages.find((e) => e.message?.role === "user");
  let goalText = "Perform active engineering task";
  if (firstUser?.message?.content) {
    const clean = extractMessageProse(firstUser.message.content).replace(/<[^>]+>/g, "").trim().split("\n")[0];
    if (clean) goalText = clean.slice(0, 200);
  }

  const allEvents = sessionStore.getAllEvents();
  const sig = collectCompactionSignals(sessionStore, summarizedEntries);
  const sortedTurns = Array.from(sig.dialogueByTurn.keys()).sort((a, b) => a - b);
  const recentTurnNums = sortedTurns.slice(-4);
  const recentDialogue: string[] = [];
  let lastAssistantMessage: { turn: number; text: string } | undefined;

  for (const t of recentTurnNums) {
    const pair = sig.dialogueByTurn.get(t)!;
    if (pair.user) {
      const clippedUser = pair.user.length > 260 ? `${pair.user.slice(0, 260)}…` : pair.user;
      recentDialogue.push(`- Turn ${t} (User): "${clippedUser}"`);
    }
    if (pair.assistant) {
      const clippedAsst = pair.assistant.length > 380 ? `${pair.assistant.slice(0, 380)}…` : pair.assistant;
      recentDialogue.push(`- Turn ${t} (Assistant): "${clippedAsst}"`);
      lastAssistantMessage = { turn: t, text: pair.assistant };
    }
  }

  const sections: string[] = [`[Session Goal]\n- ${goalText}`];
  if (directives.length > 0) {
    sections.push(`[Active Project Invariants & Directives]\n${directives.slice(0, 8).map((d) => `- ${d}`).join("\n")}`);
  }
  if (sig.modifiedFiles.size > 0) {
    sections.push(`[Files And Touched Assets]\n${Array.from(sig.modifiedFiles).slice(0, 15).map((f) => `- ${f}`).join("\n")}`);
  }
  if (sig.signalTimeline.length > 0) sections.push(`[Key Signal Timeline]\n${sig.signalTimeline.join("\n")}`);
  if (sig.toolErrors.length > 0) sections.push(`[Key Diagnostic Signals]\n${sig.toolErrors.join("\n")}`);
  if (recentDialogue.length > 0) {
    sections.push(
      `[Recent Conversational Thread]\n` +
      `Last ${recentTurnNums.length} Interaction${recentTurnNums.length === 1 ? "" : "s"} Before Compaction (Current Session):\n` +
      `${recentDialogue.join("\n")}`,
    );
  }

  const maxTurn = Math.max(
    sortedTurns.length > 0 ? sortedTurns[sortedTurns.length - 1] : 0,
    allEvents.length > 0 ? allEvents[allEvents.length - 1].turnIndex : summarizedEntries.length,
  );
  const lastSummarizedTurn = recentTurnNums.length > 0 ? recentTurnNums[recentTurnNums.length - 1] : maxTurn;
  const recentStartTurn = Math.max(1, lastSummarizedTurn - 2);

  if (lastAssistantMessage) {
    const clippedLast = lastAssistantMessage.text.length > 500 ? `${lastAssistantMessage.text.slice(0, 500)}…` : lastAssistantMessage.text;
    sections.push(
      `[Last Assistant Message Before Compaction (Turn ${lastAssistantMessage.turn})]\n` +
      `"${clippedLast}"\n` +
      `💡 Hint: To recall the full verbatim interactions right before compaction (Turns ${recentStartTurn}–${lastSummarizedTurn}), call:\n` +
      `- \`memory_recall({ scope: "session", session: "current", zoomTurn: ${lastSummarizedTurn} })\` (or \`zoomTurn: ${recentStartTurn}\`..${lastSummarizedTurn} for earlier turns)\n` +
      `- \`memory_recall({ scope: "session", session: "current", overview: true, limit: 6 })\` to list recent turns from this session`,
    );
  }

  sections.push(
    `[Ephemeral Session Memory Anchor]\n` +
    `- Historical turn details 1–${lastSummarizedTurn} (${sig.toolCount} tool executions, ${Math.max(sig.userCount, sortedTurns.length)} interactions) are indexed in current session memory.\n` +
    `- Query past compiler outputs, diffs, or discussions in this session via: memory_recall({ query: "<topic>", scope: "session" }) (or pass session: "current" to restrict strictly to this session)\n` +
    `- Inspect full turn dialogue (User + Assistant + tools) via: memory_recall({ scope: "session", zoomTurn: <turn> })\n` +
    `- Inspect exact raw lines via: memory_recall({ zoomTurn: <turn>, lineRange: [<start>, <end>] })`
  );

  const summary = sections.join("\n\n");
  const totalCharsBefore = branchEntries.reduce((sum, e) => {
    const c = e.message?.content;
    if (typeof c === "string") return sum + c.length;
    if (Array.isArray(c)) return sum + (c as Array<{ text?: string }>).reduce((s, p) => s + (p.text?.length || 0), 0);
    return sum;
  }, 0);

  const tokensBeforeEst = tokensBefore ?? Math.max(1, Math.round(totalCharsBefore / 4));
  const tokensAfterEst = Math.round(summary.length / 4);
  const reductionPct = Math.max(0, Math.min(99, Math.round(((tokensBeforeEst - tokensAfterEst) / tokensBeforeEst) * 100)));

  debugLog("session", "Built Mipmap Compaction", {
    tokensBeforeEst, tokensAfterEst, reductionPct,
    summarizedCount: summarizedEntries.length, keptCount: keptEntries.length, lastSummarizedTurn, maxTurn,
  });

  return {
    summary, firstKeptEntryId, tokensBeforeEst, tokensAfterEst, reductionPct,
    summarizedCount: summarizedEntries.length, keptCount: keptEntries.length, lastSummarizedTurn, maxTurn,
  };
}

export interface RecentTurnsContextOptions {
  sessionStore: SessionStore;
  currentPrompt?: string;
  maxTurns?: number;
  postCompaction?: boolean;
}

export function buildRecentInteractionsBlock(options: RecentTurnsContextOptions): string | null {
  const { sessionStore, currentPrompt, maxTurns = 3, postCompaction = false } = options;
  const allEvents = sessionStore.getAllEvents();
  const convEvents = allEvents.filter(
    (ev) => (ev.role === "user" || ev.role === "assistant") && (ev.text || ev.summary || "").trim().length > 0,
  );

  // Exclude the current incoming prompt if it was already recorded at the tail
  const trimmedCurrent = (currentPrompt || "").trim();
  const priorConv = convEvents.length > 0 &&
      trimmedCurrent.length > 0 &&
      convEvents[convEvents.length - 1].role === "user" &&
      (convEvents[convEvents.length - 1].text || convEvents[convEvents.length - 1].summary || "").trim() === trimmedCurrent
    ? convEvents.slice(0, -1)
    : convEvents;

  if (priorConv.length === 0) return null;

  // Group into distinct turns so we show the last N user+assistant interactions
  const turnsMap = new Map<number, Array<{ role: "user" | "assistant"; text: string }>>();
  for (const ev of priorConv) {
    if (ev.role !== "user" && ev.role !== "assistant") continue;
    const raw = (ev.text || ev.summary || "").trim();
    if (!raw) continue;
    const list = turnsMap.get(ev.turnIndex) ?? [];
    list.push({ role: ev.role, text: raw });
    turnsMap.set(ev.turnIndex, list);
  }

  const turnNumbers = Array.from(turnsMap.keys()).sort((a, b) => a - b);
  if (turnNumbers.length === 0) return null;

  const selectedTurns = turnNumbers.slice(-Math.max(1, maxTurns));
  const firstTurn = selectedTurns[0];
  const lastTurn = selectedTurns[selectedTurns.length - 1];

  const turnLines: string[] = [];
  let lastAssistantText: string | undefined;
  let lastAssistantTurn = lastTurn;

  for (const t of selectedTurns) {
    const items = turnsMap.get(t)!;
    for (const item of items) {
      const roleLabel = item.role === "user" ? "User" : "Assistant";
      const limit = item.role === "assistant" && t === lastTurn ? 600 : 380;
      const clipped = item.text.length > limit ? `${item.text.slice(0, limit)}…` : item.text;
      turnLines.push(`- Turn ${t} (${roleLabel}): "${clipped}"`);
      if (item.role === "assistant") {
        lastAssistantText = item.text;
        lastAssistantTurn = t;
      }
    }
  }

  const header = postCompaction
    ? `[Post-Compaction Session Continuity — Current Session (Turns ${firstTurn}–${lastTurn})]`
    : `[Recent Session Continuity Context]\nScope: Current Active Session (Turns ${firstTurn}–${lastTurn})`;

  const lines: string[] = [
    header,
    `Recent interactions from the CURRENT session transcript before this turn:`,
    ...turnLines,
  ];

  if (lastAssistantText) {
    const clippedLast = lastAssistantText.length > 500
      ? `${lastAssistantText.slice(0, 500)}…`
      : lastAssistantText;
    lines.push(
      `\nLast Assistant Message (Turn ${lastAssistantTurn}): "${clippedLast}"`,
    );
  }

  lines.push(
    `\n💡 Hint — Recalling Pre-Compaction Interactions in This Session:\n` +
    `- To inspect the full verbatim dialogue and tool outputs of the last turn before compaction, call: \`memory_recall({ scope: "session", session: "current", zoomTurn: ${lastTurn} })\`\n` +
    `- To inspect earlier turns leading up to compaction, call: \`memory_recall({ scope: "session", session: "current", zoomTurn: <turn> })\` (e.g. turns ${firstTurn}–${lastTurn}) or \`memory_recall({ scope: "session", session: "current", query: "<topic>" })\`\n` +
    `- Guidance: These turns belong to the CURRENT active session. Answer questions about what we were just discussing using the turns above (or by zooming into them). Do NOT confuse them with past/other sessions in persistent memory.`,
  );

  return lines.join("\n");
}

