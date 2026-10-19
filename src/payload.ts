import type { MemoryEnvelope, MipmapLevel, LifecycleState } from "./types.ts";

export function splitRawPayload(payload: string): { date: string; text: string } {
  const m = /^(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?):([\s\S]*)$/.exec(payload);
  if (m) return { date: m[1], text: m[2].trimStart() };
  const idx = payload.indexOf(":");
  if (idx < 0) return { date: "", text: payload };
  return { date: payload.slice(0, idx), text: payload.slice(idx + 1) };
}

export function encodePayload(date: string, envelope: MemoryEnvelope): string {
  const serialized = JSON.stringify(envelope);
  return `${date}:${serialized}`;
}

function isValidLevel(lvl: unknown): lvl is MipmapLevel {
  return typeof lvl === "string" && ["L0", "L1", "L2", "L3"].includes(lvl);
}

function isValidLifecycle(state: unknown): state is LifecycleState {
  return typeof state === "string" && [
    "observed",
    "hypothesized",
    "tested",
    "supported",
    "contradicted",
    "superseded",
  ].includes(state);
}

export function decodePayload(raw: string): { date: string; envelope: MemoryEnvelope } {
  const { date, text } = splitRawPayload(raw);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<MemoryEnvelope>;
      if (typeof parsed === "object" && parsed !== null) {
        const level: MipmapLevel = isValidLevel(parsed.level) ? parsed.level : "L2";
        const defaultLc: LifecycleState = level === "L0" ? "observed" : "supported";
        const lifecycle: LifecycleState = isValidLifecycle(parsed.lifecycle) ? parsed.lifecycle : defaultLc;
        const summary = typeof parsed.summary === "string"
          ? parsed.summary
          : (typeof (parsed as Record<string, unknown>).text === "string"
            ? (parsed as Record<string, unknown>).text as string
            : "");
        return {
          date,
          envelope: {
            ...parsed,
            level,
            lifecycle,
            summary,
          },
        };
      }
    } catch {
      // JSON parse failure falls through to legacy plain text
    }
  }

  return {
    date,
    envelope: {
      level: "L2",
      type: "note",
      lifecycle: "observed",
      summary: text,
    },
  };
}
