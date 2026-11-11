// Capture signal tests: path/subsystem derivation, meaningful summary, introspection skip, dedupe (R4).
// Written first ("Try before risk" directive) to define the required contract.
import { strict as assert } from "node:assert";
import {
  extractReliableProjectContext,
  formatToolEventSummary,
  isInformativeExecution,
  type SignificantEvent,
  type ToolResultEvent,
} from "../src/hooks/events.ts";

Deno.test("capture: skips memory introspection, internal CLI and decoder feedback loops", () => {
  // Builtin memory tools
  assert.equal(isInformativeExecution({ toolName: "memory_recall", content: [{ type: "text", text: "results" }] }), false);
  assert.equal(isInformativeExecution({ toolName: "memory_record", content: [{ type: "text", text: "ok" }] }), false);
  assert.equal(isInformativeExecution({ toolName: "memory_review", content: [{ type: "text", text: "ok" }] }), false);
  assert.equal(isInformativeExecution({ toolName: "vcc_recall", content: [{ type: "text", text: "ok" }] }), false);

  // Shell commands that query or decode pi-mm's own database (which caused memory to record itself)
  const cormScan: ToolResultEvent = {
    toolName: "bash",
    input: { command: "corm -r -g 40843 .pi/mm/mem.db@joint,lemma:a:b" },
    content: [{ type: "text", text: "KOTH raw payload" }],
  };
  assert.equal(isInformativeExecution(cormScan), false);

  const denoEvalMm: ToolResultEvent = {
    toolName: "bash",
    input: { command: "deno eval 'import { decodePayload } from \"./.pi/extensions/pi-mm/src/payload.ts\"'" },
    content: [{ type: "text", text: "REF 48: level=L1 summary=..." }],
  };
  assert.equal(isInformativeExecution(denoEvalMm), false);

  // Legitimate dev commands still pass
  const buildTest: ToolResultEvent = {
    toolName: "bash",
    input: { command: "npm --prefix .pi/extensions/pi-mm test" },
    content: [{ type: "text", text: "491 passed | 0 failed" }],
  };
  assert.equal(isInformativeExecution(buildTest), true);
});

Deno.test("capture: formatToolEventSummary includes tool name, path/command, and meaningful content", () => {
  const readEvent: ToolResultEvent = {
    toolName: "read",
    input: { path: "docs/handoff-water-realism.md" },
    content: [{ type: "text", text: "# NeverDark Seven Water Realism — Working Design & Implementation Document\nMore text..." }],
  };
  const summary = formatToolEventSummary(readEvent);
  assert.equal(summary, "read docs/handoff-water-realism.md: # NeverDark Seven Water Realism — Working Design & Implementation Document");

  const editEvent: ToolResultEvent = {
    toolName: "edit",
    input: { path: "external/nd-world/water.c" },
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in external/nd-world/water.c." }],
  };
  assert.equal(formatToolEventSummary(editEvent), "edit external/nd-world/water.c");

  const bashTest: ToolResultEvent = {
    toolName: "bash",
    input: { command: "make test" },
    content: [{ type: "text", text: "PASS 42 tests ok" }],
  };
  assert.equal(formatToolEventSummary(bashTest), "bash `make test`: PASS 42 tests ok");
});

Deno.test("capture: extractReliableProjectContext extracts context.path and subsystem", () => {
  const events: SignificantEvent[] = [
    {
      id: "ev1",
      timestamp: new Date().toISOString(),
      toolName: "edit",
      summary: "edit external/nd-world/water.c",
      isError: false, toolArgs: { path: "external/nd-world/water.c" },
    },
  ];
  const ctx = extractReliableProjectContext({ cwd: "/home/quirinpa/site", hasUI: false, mode: "agent" }, events);
  assert.equal(ctx?.project, "site");
  assert.equal(ctx?.subsystem, "nd-world");
  assert.equal(ctx?.path, "external/nd-world/water.c");
});

Deno.test("capture: SessionEventBuffer deduplicates identical summary and args in same session", async () => {
  const { SessionEventBuffer } = await import("../src/hooks/events.ts");
  const buf = new SessionEventBuffer();
  const dir = Deno.makeTempDirSync({ prefix: "mm-buf-dedupe-" });
  try {
    buf.setJournalDir(dir);
    const ev1: SignificantEvent = {
      id: "ev-1",
      timestamp: new Date().toISOString(),
      toolName: "read",
      summary: "read docs/handoff-water-realism.md: # NeverDark Seven Water Realism",
      isError: false,
      toolArgs: { path: "docs/handoff-water-realism.md" },
    };
    const ev2: SignificantEvent = {
      id: "ev-2",
      timestamp: new Date().toISOString(),
      toolName: "read",
      summary: "read docs/handoff-water-realism.md: # NeverDark Seven Water Realism",
      isError: false,
      toolArgs: { path: "docs/handoff-water-realism.md" },
    };
    await buf.recordAsync(ev1);
    await buf.recordAsync(ev2);
    assert.equal(buf.getEvents().length, 1, "Duplicate tool event must not be recorded");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
