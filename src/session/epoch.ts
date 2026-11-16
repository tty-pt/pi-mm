import type { SessionTurnEvent } from "./types.ts";

export type CompactionModelSummarizer = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<string | null | undefined>;

export function isThinkingStub(text: string): boolean {
  const trimmed = (text || "").trim();
  return trimmed.startsWith("[Thinking]");
}

export function pickPreferredAssistantText(existing: string | undefined, candidate: string): string {
  const cleanCand = candidate.trim();
  if (!cleanCand) return existing || "";
  if (!existing || !existing.trim()) return cleanCand;
  const existingIsThink = isThinkingStub(existing);
  const candIsThink = isThinkingStub(cleanCand);
  if (existingIsThink && !candIsThink) return cleanCand;
  if (!existingIsThink && candIsThink) return existing;
  return cleanCand.length >= existing.length ? cleanCand : existing;
}

export function formatCompactionEpochHeadline(
  rawSummary: string,
  epochIndex: number,
  turnStart: number,
  turnEnd: number,
): string {
  const lines = rawSummary
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const highlights: string[] = [];
  for (let i = 0; i < lines.length && highlights.length < 3; i++) {
    const line = lines[i];
    if (
      line.startsWith("#") ||
      line.startsWith("[Session Goal]") ||
      line.startsWith("[L2 Epoch Summary") ||
      line.startsWith("[Active Project") ||
      line.startsWith("[Files And") ||
      line.startsWith("[Key ") ||
      line.startsWith("[Recent ") ||
      line.startsWith("[Last Assistant") ||
      line.startsWith("[Ephemeral ") ||
      line.startsWith("💡")
    ) {
      continue;
    }
    const clean = line.replace(/^[-*•\d.)+\s[\]xX]+/, "").trim();
    if (clean.length > 3 && !clean.startsWith("(none)")) {
      highlights.push(clean);
    }
  }

  const body = highlights.length > 0
    ? highlights.join(" | ")
    : (lines[0] || "Compacted session context");
  const rangeLabel = turnStart <= turnEnd ? `Turns ${turnStart}–${turnEnd}` : `Turn ${turnEnd}`;
  const full = `[L2 Epoch ${epochIndex} · ${rangeLabel}] ${body}`;
  return full.length > 240 ? `${full.slice(0, 237)}...` : full;
}

export interface EpochSynthesisInput {
  goalText: string;
  epochIndex: number;
  epochStartTurn: number;
  lastSummarizedTurn: number;
  dialogueByTurn: Map<number, { user?: string; assistant?: string }>;
  modifiedFiles: Set<string>;
  toolErrors: string[];
  signalTimeline: string[];
  previousSummary?: string;
}

export function synthesizeDeterministicEpochSummary(input: EpochSynthesisInput): string {
  const {
    goalText,
    epochIndex,
    epochStartTurn,
    lastSummarizedTurn,
    dialogueByTurn,
    modifiedFiles,
    toolErrors,
    previousSummary,
  } = input;

  const sortedTurns = Array.from(dialogueByTurn.keys())
    .filter((t) => t >= epochStartTurn && t <= lastSummarizedTurn)
    .sort((a, b) => a - b);
  const activeTurns = sortedTurns.length > 0
    ? sortedTurns
    : Array.from(dialogueByTurn.keys()).sort((a, b) => a - b);

  const progressItems: string[] = [];
  const decisionItems: string[] = [];
  for (const t of activeTurns) {
    const pair = dialogueByTurn.get(t);
    if (!pair) continue;
    if (pair.user && progressItems.length < 8) {
      const u = pair.user.length > 180 ? `${pair.user.slice(0, 180)}…` : pair.user;
      progressItems.push(`- Turn ${t} request: ${u}`);
    }
    if (pair.assistant && !isThinkingStub(pair.assistant) && decisionItems.length < 8) {
      const a = pair.assistant.length > 220 ? `${pair.assistant.slice(0, 220)}…` : pair.assistant;
      decisionItems.push(`- Turn ${t} outcome: ${a}`);
    }
  }

  const lines: string[] = [
    `[L2 Epoch Summary (Epoch ${epochIndex} · Turns ${epochStartTurn}–${lastSummarizedTurn})]`,
    `## Goal\n- ${goalText}`,
  ];

  if (previousSummary && previousSummary.trim()) {
    const prevClean = previousSummary.trim().split("\n").slice(0, 6).join(" ").slice(0, 320);
    lines.push(`## Prior Epoch Context\n- ${prevClean}`);
  }
  if (progressItems.length > 0) {
    lines.push(`## Progress Across Turns ${epochStartTurn}–${lastSummarizedTurn}\n${progressItems.join("\n")}`);
  }
  if (decisionItems.length > 0) {
    lines.push(`## Key Decisions & Outcomes\n${decisionItems.join("\n")}`);
  }
  if (modifiedFiles.size > 0) {
    lines.push(`## Files Touched\n${Array.from(modifiedFiles).slice(0, 12).map((f) => `- ${f}`).join("\n")}`);
  }
  if (toolErrors.length > 0) {
    lines.push(`## Blockers & Diagnostic Signals\n${toolErrors.slice(0, 4).join("\n")}`);
  }

  return lines.join("\n\n");
}

export function buildEpochSummarizationPrompt(input: EpochSynthesisInput): string {
  const {
    goalText,
    epochIndex,
    epochStartTurn,
    lastSummarizedTurn,
    dialogueByTurn,
    modifiedFiles,
    toolErrors,
    signalTimeline,
    previousSummary,
  } = input;

  const sortedTurns = Array.from(dialogueByTurn.keys()).sort((a, b) => a - b);
  const transcriptLines: string[] = [];
  for (const t of sortedTurns) {
    const pair = dialogueByTurn.get(t)!;
    if (pair.user) transcriptLines.push(`[Turn ${t} · User]: ${pair.user.slice(0, 600)}`);
    if (pair.assistant) transcriptLines.push(`[Turn ${t} · Assistant]: ${pair.assistant.slice(0, 900)}`);
  }

  const prevBlock = previousSummary && previousSummary.trim()
    ? `\n<previous-epoch-summary>\n${previousSummary.trim().slice(0, 3000)}\n</previous-epoch-summary>\n`
    : "";
  const filesBlock = modifiedFiles.size > 0
    ? `\nFiles touched: ${Array.from(modifiedFiles).slice(0, 20).join(", ")}`
    : "";
  const toolsBlock = signalTimeline.length > 0
    ? `\nTool signals:\n${signalTimeline.join("\n")}`
    : "";
  const errorsBlock = toolErrors.length > 0
    ? `\nErrors:\n${toolErrors.join("\n")}`
    : "";

  return [
    `Summarize this session epoch (Epoch ${epochIndex}, Turns ${epochStartTurn}–${lastSummarizedTurn}) so future turns and overview queries know what happened between compactions.`,
    `Primary session goal: ${goalText}`,
    prevBlock,
    `<conversation-epoch>`,
    transcriptLines.join("\n"),
    filesBlock,
    toolsBlock,
    errorsBlock,
    `</conversation-epoch>`,
    `Use this exact markdown structure (concise, preserving exact file paths, symbols, decisions, and next steps):`,
    `## Goal`,
    `## Progress`,
    `## Key Decisions`,
    `## Next Steps`,
  ].filter(Boolean).join("\n");
}

export function createModelSummarizerFromCtx(
  ctxUnknown: unknown,
  defaultSignal?: AbortSignal,
): CompactionModelSummarizer | undefined {
  const ctx = ctxUnknown as {
    model?: unknown;
    modelRegistry?: {
      complete?: (
        model: unknown,
        context: { messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }> },
        options?: Record<string, unknown>,
      ) => Promise<{ content?: Array<{ type?: string; text?: string }>; stopReason?: string }>;
    };
  } | undefined;

  if (!ctx?.model || typeof ctx.modelRegistry?.complete !== "function") {
    return undefined;
  }

  return async (prompt: string, signal?: AbortSignal) => {
    const response = await ctx.modelRegistry!.complete!(
      ctx.model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: 2048,
        signal: signal ?? defaultSignal,
        cacheRetention: "none",
      },
    );
    if (!response || response.stopReason === "error" || !Array.isArray(response.content)) {
      return null;
    }
    const text = response.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("\n")
      .trim();
    return text || null;
  };
}

export function formatRecentEpochContextBlock(epochs: SessionTurnEvent[]): string | null {
  if (!epochs || epochs.length === 0) return null;
  const lines: string[] = [`[L2 Session Mipmap — Compacted Epoch Context]`];
  for (let i = 0; i < epochs.length - 1; i++) {
    lines.push(`- ${epochs[i].summary}`);
  }
  const latest = epochs[epochs.length - 1];
  const rangeStr = latest.turnRange ? `Turns ${latest.turnRange[0]}–${latest.turnRange[1]}` : `Turn ${latest.turnIndex}`;
  const rawBody = (latest.text || latest.summary || "").trim();
  const clippedBody = rawBody.length > 900 ? `${rawBody.slice(0, 900)}…` : rawBody;
  lines.push(`Latest Compacted Epoch (${rangeStr}):\n${clippedBody}`);
  return lines.join("\n");
}

export interface RecentTurnsContextOptions {
  sessionStore: { getAllEvents(): SessionTurnEvent[]; getCompactionEpochs(): SessionTurnEvent[]; getMaxTurnIndex(): number };
  currentPrompt?: string;
  maxTurns?: number;
  postCompaction?: boolean;
}

export function buildRecentInteractionsBlock(options: RecentTurnsContextOptions): string | null {
  const { sessionStore, currentPrompt, maxTurns = 3, postCompaction = false } = options;
  const allEvents = sessionStore.getAllEvents();
  const epochs = sessionStore.getCompactionEpochs();
  const convEvents = allEvents.filter(
    (ev) => (ev.role === "user" || ev.role === "assistant") && (ev.text || ev.summary || "").trim().length > 0,
  );
  const trimmedCurrent = (currentPrompt || "").trim();
  const priorConv = convEvents.length > 0 &&
      trimmedCurrent.length > 0 &&
      convEvents[convEvents.length - 1].role === "user" &&
      (convEvents[convEvents.length - 1].text || convEvents[convEvents.length - 1].summary || "").trim() === trimmedCurrent
    ? convEvents.slice(0, -1)
    : convEvents;
  if (priorConv.length === 0 && epochs.length === 0) return null;

  const turnsMap = new Map<number, Array<{ role: "user" | "assistant"; text: string }>>();
  let bestSubstantiveAssistant: { turn: number; text: string } | undefined;
  for (const ev of priorConv) {
    if (ev.role !== "user" && ev.role !== "assistant") continue;
    const raw = (ev.text || ev.summary || "").trim();
    if (!raw) continue;
    if (ev.role === "assistant" && !isThinkingStub(raw)) bestSubstantiveAssistant = { turn: ev.turnIndex, text: raw };
    const list = turnsMap.get(ev.turnIndex) ?? [];
    list.push({ role: ev.role, text: raw });
    turnsMap.set(ev.turnIndex, list);
  }

  const turnNumbers = Array.from(turnsMap.keys()).sort((a, b) => a - b);
  const selectedTurns = turnNumbers.slice(-Math.max(1, maxTurns));
  const firstTurn = selectedTurns[0] ?? 1;
  const lastTurn = selectedTurns[selectedTurns.length - 1] ?? Math.max(1, sessionStore.getMaxTurnIndex());
  const turnLines: string[] = [];
  let lastAssistantText = bestSubstantiveAssistant?.text;
  let lastAssistantTurn = bestSubstantiveAssistant?.turn ?? lastTurn;

  for (const t of selectedTurns) {
    const items = turnsMap.get(t) ?? [];
    const hasSubstantiveAsst = items.some((it) => it.role === "assistant" && !isThinkingStub(it.text));
    for (const item of items) {
      if (item.role === "assistant" && hasSubstantiveAsst && isThinkingStub(item.text)) continue;
      const roleLabel = item.role === "user" ? "User" : "Assistant";
      const limit = item.role === "assistant" && t === lastTurn ? 600 : 380;
      const clipped = item.text.length > limit ? `${item.text.slice(0, limit)}…` : item.text;
      turnLines.push(`- Turn ${t} (${roleLabel}): "${clipped}"`);
      if (item.role === "assistant" && (!lastAssistantText || !isThinkingStub(item.text))) {
        lastAssistantText = item.text;
        lastAssistantTurn = t;
      }
    }
  }

  const header = postCompaction
    ? `[Post-Compaction Session Continuity — Current Session (Turns ${firstTurn}–${lastTurn})]`
    : `[Recent Session Continuity Context]\nScope: Current Active Session (Turns ${firstTurn}–${lastTurn})`;
  const lines: string[] = [header];
  const epochBlock = formatRecentEpochContextBlock(epochs);
  if (epochBlock) lines.push(epochBlock);
  if (turnLines.length > 0) lines.push(`Recent interactions from the CURRENT session transcript before this turn:`, ...turnLines);
  if (lastAssistantText) {
    const clippedLast = lastAssistantText.length > 500 ? `${lastAssistantText.slice(0, 500)}…` : lastAssistantText;
    lines.push(`\nLast Assistant Message (Turn ${lastAssistantTurn}): "${clippedLast}"`);
  }
  lines.push(
    `\n💡 Hint — Recalling Pre-Compaction Interactions in This Session:\n` +
    `- To inspect the full verbatim dialogue and tool outputs of the last turn before compaction, call: \`memory_recall({ scope: "session", session: "current", zoomTurn: ${lastTurn} })\`\n` +
    `- To inspect earlier turns or L2 compaction epochs, call: \`memory_recall({ scope: "session", session: "current", overview: true })\` or \`memory_recall({ scope: "session", session: "current", zoomTurn: <turn> })\` (e.g. turns ${firstTurn}–${lastTurn})\n` +
    `- Guidance: These turns belong to the CURRENT active session. Answer questions about what we were just discussing using the turns above (or by zooming into them). Do NOT confuse them with past/other sessions in persistent memory.`,
  );
  return lines.join("\n");
}
