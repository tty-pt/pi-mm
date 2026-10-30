// HIGH_LEVEL: #hooks — assistant cognitive wondering detection and self-hinting.
// When the agent expresses uncertainty, architectural curiosity, or wonders how
// a subsystem works, this module detects the intent via vector embeddings
// (axil-auren POST /v1/classify) and steers the agent with a memory hint.
import type { MmConfig } from "../config.ts";
import { WONDERING_EXEMPLARS, WONDERING_KINDS } from "../judge/wondering-exemplars.ts";
import { mergeExemplars, gate, nearestExemplar } from "../judge/nearest.ts";

export function extractAssistantThoughtsAndText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "object" && part !== null) {
        const p = part as { type?: string; text?: string; thinking?: string };
        if (p.type === "thinking") {
          const thinkText = p.thinking ?? p.text ?? "";
          if (thinkText.trim()) parts.push(thinkText.trim());
        } else if (p.type === "text" || !p.type) {
          const txt = p.text ?? "";
          if (txt.trim()) parts.push(txt.trim());
        }
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

export async function classifyWonderingByEmbedding(
  text: string,
  cfg: MmConfig,
  fetchFn?: typeof fetch,
): Promise<"wondering" | "routine_action" | null> {
  const examples = mergeExemplars(WONDERING_EXEMPLARS, {}, WONDERING_KINDS);
  const verdict = await nearestExemplar(cfg, examples, text, fetchFn);
  if (verdict === null) return null;
  return gate(verdict, {
    minSimilarity: cfg.wonderingMinSimilarity ?? 0.60,
    minMargin: cfg.wonderingMinMargin ?? 0.08,
    harmless: "routine_action",
    actionable: new Set(["wondering"]),
  }) as "wondering" | "routine_action";
}

export async function evaluateAssistantWondering(
  text: string,
  cfg: MmConfig,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  if (cfg.wonderingEmbed === "off") return false;
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;

  try {
    const verdict = await classifyWonderingByEmbedding(trimmed, cfg, fetchFn);
    return verdict === "wondering";
  } catch {
    return false;
  }
}
