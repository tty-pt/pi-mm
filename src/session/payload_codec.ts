import type { SessionTurnEvent } from "./types.ts";

export interface DecodedSessionPayload {
  date: string;
  event: SessionTurnEvent;
  lineOffsets: number[];
}

export function computeLineOffsets(text: string): number[] {
  const offsets: number[] = [0];
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) { // newline
      offsets.push(i + 1);
    }
  }
  return offsets;
}

export function encodeSessionPayload(
  date: string,
  event: Omit<SessionTurnEvent, "lineCount" | "byteLength">,
  lineOffsets: number[],
): Uint8Array {
  const text = event.text || "";
  const lines = text.split("\n");
  const lineCount = lines.length;
  const byteLength = new TextEncoder().encode(text).length;

  const metadata = {
    id: event.id,
    turnIndex: event.turnIndex,
    entryId: event.entryId,
    parentId: event.parentId,
    timestamp: event.timestamp,
    role: event.role,
    speaker: event.speaker,
    toolName: event.toolName,
    toolArgs: event.toolArgs,
    exitCode: event.exitCode,
    filesTouched: event.filesTouched,
    errorSnippet: event.errorSnippet,
    lineCount,
    byteLength,
    lineOffsets,
  };

  const payloadString = [
    date,
    "[METADATA:JSON]",
    JSON.stringify(metadata),
    "[/METADATA]",
    "[SUMMARY]",
    event.summary || "",
    "[/SUMMARY]",
    "[RAW_OUTPUT]",
    text,
    "[/RAW_OUTPUT]",
  ].join("\n");

  return new TextEncoder().encode(payloadString);
}

export function decodeSessionPayload(rawText: string): DecodedSessionPayload | null {
  if (!rawText || !rawText.trim()) return null;

  const lines = rawText.split("\n");
  const date = lines[0].trim();

  const metaStart = rawText.indexOf("[METADATA:JSON]\n");
  const metaEnd = rawText.indexOf("\n[/METADATA]");
  if (metaStart < 0 || metaEnd < 0) return null;

  const metaJson = rawText.slice(metaStart + "[METADATA:JSON]\n".length, metaEnd).trim();
  let metadata: any;
  try {
    metadata = JSON.parse(metaJson);
  } catch {
    return null;
  }

  const sumStart = rawText.indexOf("[SUMMARY]\n", metaEnd);
  const sumEnd = rawText.indexOf("\n[/SUMMARY]", sumStart);
  const summary = sumStart >= 0 && sumEnd >= 0
    ? rawText.slice(sumStart + "[SUMMARY]\n".length, sumEnd).trim()
    : metadata.summary || "";

  const rawStart = rawText.indexOf("[RAW_OUTPUT]\n", sumEnd);
  const rawEnd = rawText.lastIndexOf("\n[/RAW_OUTPUT]");
  const text = rawStart >= 0 && rawEnd >= 0
    ? rawText.slice(rawStart + "[RAW_OUTPUT]\n".length, rawEnd)
    : "";

  const event: SessionTurnEvent = {
    id: metadata.id,
    turnIndex: metadata.turnIndex,
    entryId: metadata.entryId,
    parentId: metadata.parentId,
    timestamp: metadata.timestamp,
    role: metadata.role,
    speaker: metadata.speaker,
    summary,
    text,
    toolName: metadata.toolName,
    toolArgs: metadata.toolArgs,
    exitCode: metadata.exitCode,
    filesTouched: metadata.filesTouched,
    errorSnippet: metadata.errorSnippet,
    lineCount: metadata.lineCount ?? lines.length,
    byteLength: metadata.byteLength ?? text.length,
  };

  return {
    date,
    event,
    lineOffsets: metadata.lineOffsets ?? computeLineOffsets(text),
  };
}
