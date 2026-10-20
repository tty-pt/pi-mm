import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { debugLog } from "./debug.ts";

export interface SessionExcerpt {
  role: "user" | "assistant";
  text: string;
  id?: string;
}

export interface SessionExtractOptions {
  originText?: string;
  query?: string;
  leafId?: string;
  maxFollowUps?: number;
  charBudget?: number;
}

/**
 * Normalizes text content from a Pi message object.
 * Handles both plain strings and block arrays (extracting only type === "text" and ignoring thinking/toolCall).
 */
export function extractTextFromMessage(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((part: unknown) => typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
      .map((part: unknown) => (part as { text?: string }).text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * Resolves the path to a native Pi session file (.jsonl or .json) on disk.
 * Checks direct sessionFile path, test directory locations, and ~/.pi/agent/sessions.
 */
export async function resolveSessionFilePath(
  sessionFile?: string,
  sessionId?: string,
  cwd?: string,
): Promise<string | null> {
  // 1. Direct file path check
  if (sessionFile && typeof sessionFile === "string" && sessionFile.trim().length > 0) {
    const rawPath = sessionFile.trim();
    try {
      const s = await stat(rawPath);
      if (s.isFile()) return rawPath;
    } catch {
      // Continue to search fallbacks
    }
  }

  if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return null;
  }

  const cleanId = sessionId.trim();

  // 2. Test/tmp directory check
  const candidateTmpPaths = [
    `/tmp/sessions/${cleanId}.jsonl`,
    `/tmp/sessions/${cleanId}.json`,
    `/tmp/${cleanId}.jsonl`,
    `/tmp/${cleanId}.json`,
  ];
  for (const p of candidateTmpPaths) {
    try {
      const s = await stat(p);
      if (s.isFile()) return p;
    } catch {
      // next
    }
  }

  // 3. ~/.pi/agent/sessions search
  try {
    const home = homedir();
    const sessionsBase = join(home, ".pi", "agent", "sessions");
    const dirs = await readdir(sessionsBase, { withFileTypes: true }).catch(() => []);

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const subDir = join(sessionsBase, dir.name);
      const files = await readdir(subDir).catch(() => []);
      for (const file of files) {
        if (file.endsWith(".jsonl") && file.includes(cleanId)) {
          const matchedPath = join(subDir, file);
          return matchedPath;
        }
      }
    }
  } catch {
    // Fail-safe
  }

  // 4. cwd-relative check
  if (cwd) {
    try {
      const cwdSession = join(cwd, `${cleanId}.jsonl`);
      const s = await stat(cwdSession);
      if (s.isFile()) return cwdSession;
    } catch {
      // ignore
    }
  }

  return null;
}

export interface ParsedSessionMessage {
  id?: string;
  parentId?: string;
  role: "user" | "assistant";
  text: string;
}

/**
 * Parses lines of a Pi session JSONL file into a clean list of conversational messages.
 */
export async function parseSessionFileMessages(filePath: string): Promise<ParsedSessionMessage[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n");
    const messages: ParsedSessionMessage[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === "message" && obj.message && typeof obj.message === "object") {
          const role = obj.message.role;
          if (role === "user" || role === "assistant") {
            const text = extractTextFromMessage(obj.message.content);
            if (text.length > 0) {
              messages.push({
                id: obj.id,
                parentId: obj.parentId,
                role,
                text,
              });
            }
          }
        }
      } catch {
        // Skip malformed individual lines
      }
    }

    return messages;
  } catch (err) {
    debugLog("recall", "Failed to parse session file messages", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function tokenizeQuery(text: string): string[] {
  const stopWords = new Set([
    "what", "which", "where", "when", "who", "whom", "whose", "why", "how",
    "did", "does", "do", "was", "were", "is", "are", "been", "being", "have", "has", "had",
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
    "about", "you", "your", "my", "me", "i", "we", "our", "us", "he", "him", "his", "she", "her",
    "remember", "tell", "told", "say", "said", "know", "anything", "something",
    "can", "could", "would", "should", "kind", "kinds", "type", "types", "usually", "often",
  ]);

  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !stopWords.has(w));
}

/**
 * Extracts relevant conversation excerpts from a source session file.
 * Identifies the originating message matching the memory summary or problem,
 * and recovers subsequent follow-up user statements and assistant questions/answers.
 */
export async function extractSessionExcerpts(
  sessionFilePath: string,
  options?: SessionExtractOptions,
): Promise<SessionExcerpt[]> {
  const messages = await parseSessionFileMessages(sessionFilePath);
  if (messages.length === 0) return [];

  const budget = options?.charBudget ?? 750;

  // Build message tree map for ancestry resolution
  const byId = new Map<string, ParsedSessionMessage>();
  for (const m of messages) {
    if (m.id) byId.set(m.id, m);
  }

  // 1. Locate the originating message
  let originIdx = -1;
  const originText = options?.originText?.toLowerCase().trim();
  const queryText = options?.query?.toLowerCase().trim();

  // If leafId is provided, trace ancestry chain
  const ancestryChain = new Set<string>();
  if (options?.leafId && byId.has(options.leafId)) {
    let curr: string | undefined = options.leafId;
    while (curr && byId.has(curr)) {
      ancestryChain.add(curr);
      curr = byId.get(curr)?.parentId;
    }
  }

  if (originText && originText.length >= 10) {
    // Try exact or substring match on user messages first
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user") {
        const lower = msg.text.toLowerCase();
        if (lower.includes(originText) || originText.includes(lower.slice(0, 30))) {
          originIdx = i;
          break;
        }
      }
    }
  }

  // Fallback: match salient tokens from originText
  if (originIdx === -1 && originText) {
    const originTokens = originText
      .split(/\s+/)
      .map((w) => w.replace(/[^\w-]/g, "").toLowerCase())
      .filter((w) => w.length >= 4);

    let bestScore = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user") continue;
      const lower = msg.text.toLowerCase();
      let score = 0;
      for (const tok of originTokens) {
        if (lower.includes(tok)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        originIdx = i;
      }
    }
  }

  if (originIdx === -1 && options?.leafId && byId.has(options.leafId)) {
    originIdx = messages.findIndex((m) => m.id === options.leafId);
  }

  // If still not found, start from the first user message
  if (originIdx === -1) {
    originIdx = messages.findIndex((m) => m.role === "user");
  }

  if (originIdx === -1) return [];

  // Build thread message set using authentic ancestry and descendants along the parentId chain
  const threadIndices = new Set<number>();
  threadIndices.add(originIdx);

  // Trace backwards along parentId ancestry from originIdx
  let currId = messages[originIdx]?.parentId;
  while (currId && byId.has(currId)) {
    const pIdx = messages.findIndex((m) => m.id === currId);
    if (pIdx !== -1) {
      threadIndices.add(pIdx);
      currId = messages[pIdx].parentId;
    } else {
      break;
    }
  }

  // Trace forward along parentId descendants from known thread messages
  for (let i = originIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.parentId && byId.has(m.parentId)) {
      const pIdx = messages.findIndex((msg) => msg.id === m.parentId);
      if (pIdx !== -1 && threadIndices.has(pIdx)) {
        threadIndices.add(i);
      }
    } else if (i === originIdx + 1 || (i > 0 && threadIndices.has(i - 1))) {
      // Linear sequence fallback if parentId is absent
      threadIndices.add(i);
    }
  }

  const sortedThread = Array.from(threadIndices).sort((a, b) => a - b);
  const threadStartIdx = sortedThread[0] ?? originIdx;

  // Build topic and query tokens for relevance scoring
  const topicTokens = new Set<string>();
  if (queryText) for (const t of tokenizeQuery(queryText)) topicTokens.add(t);
  if (originText) for (const t of tokenizeQuery(originText)) topicTokens.add(t);

  const selectedIndices = new Set<number>();
  selectedIndices.add(threadStartIdx);
  if (originIdx !== -1) selectedIndices.add(originIdx);

  // 1. Pass: select assistant turns matching topic
  for (const i of sortedThread) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const lower = msg.text.toLowerCase();
      const hasTopic = topicTokens.size > 0 && Array.from(topicTokens).some((tok) => lower.includes(tok));
      if (hasTopic) {
        selectedIndices.add(i);
      }
    }
  }

  // 2. Pass: select user turns that match topic, are origin, or answer selected assistant questions
  for (const i of sortedThread) {
    const msg = messages[i];
    if (msg.role === "user") {
      const lower = msg.text.toLowerCase();
      const hasTopic = topicTokens.size === 0 || Array.from(topicTokens).some((tok) => lower.includes(tok));
      const isOrigin = i === originIdx || i === threadStartIdx;
      const isAnswerToAssistantQuestion = i > 0 && selectedIndices.has(i - 1) && messages[i - 1].text.trim().endsWith("?");
      if (hasTopic || isOrigin || isAnswerToAssistantQuestion) {
        selectedIndices.add(i);
      }
    }
  }

  // 3. Pass: include assistant questions that prompted selected user turns
  for (const i of sortedThread) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const isPromptForNext = i + 1 < messages.length && selectedIndices.has(i + 1);
      if (isPromptForNext) {
        selectedIndices.add(i);
      }
    }
  }

  // 3. STRICT CHRONOLOGICAL ORDERING (as required by reviewer advisory)
  const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);

  // 4. Apply character budget formatting cleanly (prioritizing factual user turns over filler)
  const budgeted: SessionExcerpt[] = [];
  let totalLen = 0;

  for (const idx of sortedIndices) {
    const msg = messages[idx];
    const cleanText = msg.text.replace(/\s+/g, " ").trim();
    if (!cleanText) continue;

    // Bound assistant turns so they do not crowd out user facts
    const maxLen = msg.role === "assistant" ? 120 : 300;
    const trimmed = cleanText.length > maxLen ? cleanText.slice(0, maxLen - 3) + "..." : cleanText;

    const remaining = budget - totalLen;
    if (remaining < 30) break;

    // If remaining space is tight (< 80 chars), skip assistant filler to save space for user turns
    if (msg.role === "assistant" && remaining < 80) {
      continue;
    }

    if (trimmed.length > remaining) {
      if (msg.role === "user") {
        budgeted.push({
          role: msg.role,
          text: trimmed.slice(0, remaining - 3) + "...",
          id: msg.id,
        });
      }
      break;
    }

    budgeted.push({
      role: msg.role,
      text: trimmed,
      id: msg.id,
    });
    totalLen += trimmed.length + 15; // allowance for role prefix
  }

  return budgeted;
}
