import type { SessionStore } from "./store.ts";
import { debugLog } from "../debug.ts";
import {
  type CompactionModelSummarizer,
  buildEpochSummarizationPrompt,
  isThinkingStub,
  pickPreferredAssistantText,
  synthesizeDeterministicEpochSummary,
} from "./epoch.ts";

export { type CompactionModelSummarizer, createModelSummarizerFromCtx } from "./epoch.ts";

export interface BranchEntryLike {
  id: string;
  type: string;
  firstKeptEntryId?: string;
  summary?: string;
  message?: { role: string; content: unknown };
}

export interface MipmapCompactionOptions {
  branchEntries: BranchEntryLike[];
  sessionStore: SessionStore;
  directives?: string[];
  sessionId?: string;
  tokensBefore?: number;
  keepRecentUserTurns?: number;
  previousSummary?: string;
  modelSummarizer?: CompactionModelSummarizer;
  signal?: AbortSignal;
  recordEpoch?: boolean;
}

export interface MipmapCompactionResult {
  summary: string;
  epochSummary: string;
  firstKeptEntryId: string;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  reductionPct: number;
  summarizedCount: number;
  keptCount: number;
  epochIndex: number;
  epochStartTurn: number;
  lastSummarizedTurn: number;
  maxTurn: number;
  filesTouched: string[];
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
  epochIndex: number;
  epochStartTurn: number;
  priorEpochSummary?: string;
}

function collectCompactionSignals(
  sessionStore: SessionStore,
  summarizedEntries: BranchEntryLike[],
  explicitPreviousSummary?: string,
): CollectedCompactionSignals {
  const allEvents = sessionStore.getAllEvents();
  const priorEpochs = sessionStore.getCompactionEpochs();
  const epochIndex = priorEpochs.length + 1;
  const lastEpochEnd = priorEpochs.length > 0
    ? (priorEpochs[priorEpochs.length - 1].turnRange?.[1] ?? priorEpochs[priorEpochs.length - 1].turnIndex)
    : 0;
  const priorEpochSummary = explicitPreviousSummary
    || (priorEpochs.length > 0 ? priorEpochs[priorEpochs.length - 1].text : undefined);

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
        pair.assistant = pickPreferredAssistantText(pair.assistant, text);
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
      existing.assistant = pickPreferredAssistantText(existing.assistant, clean);
      dialogueByTurn.set(targetTurn, existing);
    }
  }

  return {
    modifiedFiles, toolErrors, signalTimeline, dialogueByTurn, toolCount, userCount,
    epochIndex, epochStartTurn: Math.max(1, lastEpochEnd + 1), priorEpochSummary,
  };
}

function finalizeMipmapCompaction(
  options: MipmapCompactionOptions,
  sig: CollectedCompactionSignals,
  summarizedEntries: BranchEntryLike[],
  keptEntries: BranchEntryLike[],
  goalText: string,
  epochSummary: string,
): MipmapCompactionResult {
  const { branchEntries, sessionStore, directives = [], tokensBefore, recordEpoch = true } = options;
  const firstKeptEntryId = keptEntries[0].id;
  const allEvents = sessionStore.getAllEvents();
  const sortedTurns = Array.from(sig.dialogueByTurn.keys()).sort((a, b) => a - b);
  const recentTurnNums = sortedTurns.slice(-4);
  const recentDialogue: string[] = [];
  let lastAssistantMessage: { turn: number; text: string } | undefined;

  for (const t of sortedTurns) {
    const pair = sig.dialogueByTurn.get(t);
    if (pair?.assistant && (!lastAssistantMessage || !isThinkingStub(pair.assistant) || isThinkingStub(lastAssistantMessage.text))) {
      lastAssistantMessage = { turn: t, text: pair.assistant };
    }
  }

  for (const t of recentTurnNums) {
    const pair = sig.dialogueByTurn.get(t)!;
    if (pair.user) recentDialogue.push(`- Turn ${t} (User): "${pair.user.length > 260 ? `${pair.user.slice(0, 260)}…` : pair.user}"`);
    if (pair.assistant) recentDialogue.push(`- Turn ${t} (Assistant): "${pair.assistant.length > 380 ? `${pair.assistant.slice(0, 380)}…` : pair.assistant}"`);
  }

  const maxTurn = Math.max(
    sortedTurns.length > 0 ? sortedTurns[sortedTurns.length - 1] : 0,
    allEvents.length > 0 ? allEvents[allEvents.length - 1].turnIndex : summarizedEntries.length,
  );
  const lastSummarizedTurn = recentTurnNums.length > 0 ? recentTurnNums[recentTurnNums.length - 1] : maxTurn;
  const epochStartTurn = Math.min(lastSummarizedTurn, sig.epochStartTurn);
  const recentStartTurn = Math.max(1, lastSummarizedTurn - 2);
  const filesTouched = Array.from(sig.modifiedFiles).slice(0, 15);

  const sections: string[] = [`[Session Goal]\n- ${goalText}`, epochSummary];
  if (directives.length > 0) sections.push(`[Active Project Invariants & Directives]\n${directives.slice(0, 8).map((d) => `- ${d}`).join("\n")}`);
  if (filesTouched.length > 0) sections.push(`[Files And Touched Assets]\n${filesTouched.map((f) => `- ${f}`).join("\n")}`);
  if (sig.signalTimeline.length > 0) sections.push(`[Key Signal Timeline]\n${sig.signalTimeline.join("\n")}`);
  if (sig.toolErrors.length > 0) sections.push(`[Key Diagnostic Signals]\n${sig.toolErrors.join("\n")}`);
  if (recentDialogue.length > 0) {
    sections.push(
      `[Recent Conversational Thread]\n` +
      `Last ${recentTurnNums.length} Interaction${recentTurnNums.length === 1 ? "" : "s"} Before Compaction (Current Session):\n` +
      `${recentDialogue.join("\n")}`,
    );
  }
  if (lastAssistantMessage) {
    const clippedLast = lastAssistantMessage.text.length > 500 ? `${lastAssistantMessage.text.slice(0, 500)}…` : lastAssistantMessage.text;
    sections.push(
      `[Last Assistant Message Before Compaction (Turn ${lastAssistantMessage.turn})]\n` +
      `"${clippedLast}"\n` +
      `💡 Hint: To recall the full verbatim interactions right before compaction (Turns ${recentStartTurn}–${lastSummarizedTurn}), call:\n` +
      `- \`memory_recall({ scope: "session", session: "current", zoomTurn: ${lastSummarizedTurn} })\` (or \`zoomTurn: ${recentStartTurn}\`..${lastSummarizedTurn} for earlier turns)\n` +
      `- \`memory_recall({ scope: "session", session: "current", overview: true, limit: 6 })\` to list L2 compaction epochs and recent turns`,
    );
  }
  sections.push(
    `[Ephemeral Session Memory Anchor]\n` +
    `- Historical turn details 1–${lastSummarizedTurn} (${sig.toolCount} tool executions, ${Math.max(sig.userCount, sortedTurns.length)} interactions) are indexed in current session memory.\n` +
    `- Query past compiler outputs, diffs, or discussions in this session via: memory_recall({ query: "<topic>", scope: "session" }) (or pass session: "current" to restrict strictly to this session)\n` +
    `- Inspect full turn dialogue (User + Assistant + tools) via: memory_recall({ scope: "session", zoomTurn: <turn> })\n` +
    `- Inspect exact raw lines via: memory_recall({ zoomTurn: <turn>, lineRange: [<start>, <end>] })`,
  );

  const summary = sections.join("\n\n");
  if (recordEpoch) {
    void sessionStore.recordCompactionEpoch({
      summary: epochSummary, turnStart: epochStartTurn, turnEnd: lastSummarizedTurn, filesTouched, epochIndex: sig.epochIndex,
    });
  }

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
    summarizedCount: summarizedEntries.length, keptCount: keptEntries.length,
    epochIndex: sig.epochIndex, epochStartTurn, lastSummarizedTurn, maxTurn,
  });

  return {
    summary, epochSummary, firstKeptEntryId, tokensBeforeEst, tokensAfterEst, reductionPct,
    summarizedCount: summarizedEntries.length, keptCount: keptEntries.length,
    epochIndex: sig.epochIndex, epochStartTurn, lastSummarizedTurn, maxTurn, filesTouched,
  };
}

function prepareMipmapCut(options: MipmapCompactionOptions) {
  const { branchEntries, sessionStore, keepRecentUserTurns = 1, previousSummary } = options;
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

  const firstUser = liveMessages.find((e) => e.message?.role === "user");
  let goalText = "Perform active engineering task";
  if (firstUser?.message?.content) {
    const clean = extractMessageProse(firstUser.message.content).replace(/<[^>]+>/g, "").trim().split("\n")[0];
    if (clean) goalText = clean.slice(0, 200);
  }
  const branchCompactions = branchEntries.filter((e) => e.type === "compaction" && typeof e.summary === "string");
  const prevSum = previousSummary || (branchCompactions.length > 0 ? branchCompactions[branchCompactions.length - 1].summary : undefined);
  const sig = collectCompactionSignals(sessionStore, summarizedEntries, prevSum);
  const sortedTurns = Array.from(sig.dialogueByTurn.keys()).sort((a, b) => a - b);
  const allEvents = sessionStore.getAllEvents();
  const maxTurn = Math.max(
    sortedTurns.length > 0 ? sortedTurns[sortedTurns.length - 1] : 0,
    allEvents.length > 0 ? allEvents[allEvents.length - 1].turnIndex : summarizedEntries.length,
  );
  const lastSummarizedTurn = sortedTurns.length > 0 ? sortedTurns[sortedTurns.length - 1] : maxTurn;
  const epochStartTurn = Math.min(lastSummarizedTurn, sig.epochStartTurn);

  return { keptEntries, summarizedEntries, goalText, sig, epochStartTurn, lastSummarizedTurn };
}

export function buildMipmapCompaction(options: MipmapCompactionOptions): MipmapCompactionResult | null {
  const prep = prepareMipmapCut(options);
  if (!prep) return null;
  const { keptEntries, summarizedEntries, goalText, sig, epochStartTurn, lastSummarizedTurn } = prep;
  const epochSummary = synthesizeDeterministicEpochSummary({
    goalText,
    epochIndex: sig.epochIndex,
    epochStartTurn,
    lastSummarizedTurn,
    dialogueByTurn: sig.dialogueByTurn,
    modifiedFiles: sig.modifiedFiles,
    toolErrors: sig.toolErrors,
    signalTimeline: sig.signalTimeline,
    previousSummary: sig.priorEpochSummary,
  });
  return finalizeMipmapCompaction(options, sig, summarizedEntries, keptEntries, goalText, epochSummary);
}

export async function buildMipmapCompactionAsync(options: MipmapCompactionOptions): Promise<MipmapCompactionResult | null> {
  const prep = prepareMipmapCut(options);
  if (!prep) return null;
  const { keptEntries, summarizedEntries, goalText, sig, epochStartTurn, lastSummarizedTurn } = prep;
  const synthInput = {
    goalText,
    epochIndex: sig.epochIndex,
    epochStartTurn,
    lastSummarizedTurn,
    dialogueByTurn: sig.dialogueByTurn,
    modifiedFiles: sig.modifiedFiles,
    toolErrors: sig.toolErrors,
    signalTimeline: sig.signalTimeline,
    previousSummary: sig.priorEpochSummary,
  };

  let epochSummary = "";
  if (options.modelSummarizer) {
    try {
      const prompt = buildEpochSummarizationPrompt(synthInput);
      const modelOut = await options.modelSummarizer(prompt, options.signal);
      if (modelOut && modelOut.trim()) {
        epochSummary = `[L2 Epoch Summary (Epoch ${sig.epochIndex} · Turns ${epochStartTurn}–${lastSummarizedTurn})]\n${modelOut.trim()}`;
      }
    } catch (err) {
      debugLog("session", "Model epoch summarization failed; falling back to deterministic mipmap epoch", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!epochSummary) {
    epochSummary = synthesizeDeterministicEpochSummary(synthInput);
  }
  return finalizeMipmapCompaction(options, sig, summarizedEntries, keptEntries, goalText, epochSummary);
}

export { buildRecentInteractionsBlock, type RecentTurnsContextOptions } from "./epoch.ts";

