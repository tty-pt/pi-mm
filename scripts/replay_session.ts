#!/usr/bin/env -S deno run --allow-all --sloppy-imports
/**
 * scripts/replay_session.ts
 *
 * Deterministic offline session replay simulator for pi-mm.
 * Reads a Pi session JSONL transcript and simulates:
 * 1. isInformativeExecution() noise-gate filtering.
 * 2. summarizeToolEvent() approach extraction.
 * 3. Epistemic state assignment.
 * Prints diagnostic summary and diff of memories that would be committed.
 */

import { readFileSync, existsSync } from "node:fs";
import {
  isInformativeExecution,
  summarizeToolEvent,
  extractBatchApproaches,
  extractBatchDiffs,
  extractReliableProjectContext,
  type ToolResultEvent,
  type SignificantEvent,
} from "../src/episode.ts";
import type { PiCtx } from "../src/hooks/events.ts";

function printUsage(): void {
  console.log(`Usage: deno run --allow-all scripts/replay_session.ts <session-transcript.jsonl>

Options:
  --verbose       Print all tool events, including dropped ones
  --help          Show this help message
`);
}

function main(): void {
  const args = Deno.args;
  if (args.length === 0 || args.includes("--help")) {
    printUsage();
    return;
  }

  const verbose = args.includes("--verbose");
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath || !existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    Deno.exit(1);
  }

  const rawLines = readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  console.log(`\n=== Replaying Session: ${filePath} (${rawLines.length} entries) ===\n`);

  let totalEvents = 0;
  let informativeEvents = 0;
  let droppedEvents = 0;
  const simulatedEvents: SignificantEvent[] = [];

  for (const line of rawLines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Pi transcript entries with toolResult
    if (entry.type === "tool_result" || (entry.toolName && entry.result !== undefined)) {
      totalEvents++;
      const toolEvent: ToolResultEvent = {
        toolName: String(entry.toolName || entry.name || "unknown"),
        input: (entry.input as Record<string, unknown>) || {},
        args: (entry.args as Record<string, unknown>) || undefined,
        content: Array.isArray(entry.content)
          ? entry.content
          : (typeof entry.result === "string" ? [{ type: "text", text: entry.result }] : undefined),
        details: entry.result ?? entry.details,
        isError: Boolean(entry.isError || entry.error),
      };

      const isInformative = isInformativeExecution(toolEvent);
      if (isInformative) {
        informativeEvents++;
        const sig = summarizeToolEvent(toolEvent);
        if (sig) {
          simulatedEvents.push(sig);
          if (verbose) {
            console.log(`[PASS] ${toolEvent.toolName}: ${sig.approach || sig.summary} -> ${sig.outcome || "neutral"}`);
          }
        }
      } else {
        droppedEvents++;
        if (verbose) {
          console.log(`[DROP] ${toolEvent.toolName}: ${JSON.stringify(toolEvent.input).slice(0, 80)}`);
        }
      }
    }
  }

  const fakeCtx: PiCtx = { cwd: Deno.cwd(), hasUI: false, mode: "headless" };
  const approaches = extractBatchApproaches(simulatedEvents);
  const diffs = extractBatchDiffs(simulatedEvents);
  const context = extractReliableProjectContext(fakeCtx, simulatedEvents);

  console.log(`--- Simulation Metrics ---`);
  console.log(`Total Tool Events:       ${totalEvents}`);
  console.log(`Informative (Retained):  ${informativeEvents} (${totalEvents > 0 ? ((informativeEvents / totalEvents) * 100).toFixed(1) : 0}%)`);
  console.log(`Noise Gate Dropped:      ${droppedEvents} (${totalEvents > 0 ? ((droppedEvents / totalEvents) * 100).toFixed(1) : 0}%)\n`);

  console.log(`--- Extracted Approaches (${approaches.length}) ---`);
  for (let i = 0; i < approaches.length; i++) {
    const app = approaches[i];
    console.log(`  ${i + 1}. [${app.outcome.toUpperCase()}] ${app.approach}${app.reason ? ` (${app.reason})` : ""}`);
  }

  if (diffs.length > 0) {
    console.log(`\n--- Extracted Diffs (${diffs.length}) ---`);
    for (const d of diffs.slice(0, 5)) {
      console.log(`  • ${d.slice(0, 100)}`);
    }
    if (diffs.length > 5) {
      console.log(`  ... and ${diffs.length - 5} more diffs`);
    }
  }

  if (context && (context.project || context.subsystem)) {
    console.log(`\n--- Inferred Context ---`);
    if (context.project) console.log(`  Project:   ${context.project}`);
    if (context.subsystem) console.log(`  Subsystem: ${context.subsystem}`);
  }

  console.log(`\n=== Replay Finished cleanly ===\n`);
}

if (import.meta.main) {
  main();
}
