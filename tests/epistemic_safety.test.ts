import assert from "node:assert";
import { makeRecordTool } from "../src/tools/record.ts";
import { makeLifecycleTool } from "../src/tools/lifecycle.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { QmapRunner, Invocation } from "../src/qmap.ts";
import type { PiExecResult } from "../src/hooks/events.ts";
import { decodePayload, encodePayload } from "../src/payload.ts";

function fakeRunner(results: PiExecResult[]): { runner: QmapRunner; invocations: Invocation[] } {
  let idx = 0;
  const invocations: Invocation[] = [];
  const runner: QmapRunner = {
    run: (inv: Invocation): Promise<PiExecResult> => {
      invocations.push(inv);
      if (idx < results.length) {
        return Promise.resolve(results[idx++]);
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };
  return { runner, invocations };
}

function makeEnv(runner: QmapRunner): ToolEnv {
  try { Deno.removeSync("/tmp/fake-mm/.pi/mm/.ref_seq"); } catch { /* ignore */ }
  try { Deno.removeSync("/tmp/fake-mm/.ref_seq"); } catch { /* ignore */ }
  return {
    cwd: "/tmp/fake-mm",
    runner,
    nowProvider: () => new Date("2026-03-30T12:00:00"),
    cfg: { ...DEFAULT_CONFIG, qmapBin: "/usr/bin/qmap", memDir: ".pi/mm" },
  };
}

const ctx = { cwd: "/tmp/fake-mm", hasUI: false, mode: "headless" };

Deno.test("epistemic_safety: memory_record assigns tested when approach worked without verification", async () => {
  const { runner, invocations } = fakeRunner([
    { stdout: "1\n", stderr: "", code: 0 }, // list
    { stdout: "", stderr: "", code: 0 },    // store
  ]);

  const tool = makeRecordTool(() => Promise.resolve(makeEnv(runner)));
  await tool.execute("call-1", {
    problem: "Experiment with socket timeout",
    approaches: [
      { approach: "Set SO_RCVTIMEO to 500ms", outcome: "worked", reason: "Felt responsive in manual test" },
    ],
  }, undefined, undefined, ctx);

  assert.ok(invocations.length >= 2);
  const storedPayload = invocations[1].args[1];
  const { envelope } = decodePayload(storedPayload.slice(2));
  assert.strictEqual(envelope.lifecycle, "tested", "Unverified worked approach must be marked tested, not supported");
  assert.ok(envelope.summary.includes("tested: Set SO_RCVTIMEO"), "Summary must say tested, not verified");
});

Deno.test("epistemic_safety: memory_record assigns tested when approach worked without evidence, noting model-reported tests", async () => {
  const { runner, invocations } = fakeRunner([
    { stdout: "1\n", stderr: "", code: 0 },
    { stdout: "", stderr: "", code: 0 },
  ]);

  const tool = makeRecordTool(() => Promise.resolve(makeEnv(runner)));
  await tool.execute("call-2", {
    problem: "Fix socket timeout bug",
    approaches: [
      { approach: "Set SO_RCVTIMEO with setsockopt", outcome: "worked", reason: "Sockets time out correctly under load" },
    ],
    verification: {
      testsPassed: ["test_socket_timeout", "test_socket_reconnect"],
      verifiedDiff: true,
    },
  }, undefined, undefined, ctx);

  const storedPayload = invocations[1].args[1];
  const { envelope } = decodePayload(storedPayload.slice(2));
  assert.strictEqual(envelope.lifecycle, "tested", "Model-reported tests must be marked tested, not supported");
  assert.ok(envelope.summary.includes("tested: Set SO_RCVTIMEO"), "Summary must say tested");
  assert.ok(envelope.summary.includes("model-reported tests: test_socket_timeout"), "Summary must explicitly note model-reported tests");
});

Deno.test("epistemic_safety: memory_record rejects missing or dangling evidence references", async () => {
  const { runner } = fakeRunner([
    { stdout: "", stderr: "not found", code: 1 }, // get ref 999 fails
  ]);

  const tool = makeRecordTool(() => Promise.resolve(makeEnv(runner)));
  const res = await tool.execute("call-dangle", {
    problem: "Fix socket timeout bug",
    approaches: [
      { approach: "Set SO_RCVTIMEO", outcome: "worked", reason: "Works" },
    ],
    evidence: [999],
  }, undefined, undefined, ctx);

  const text = res.content[0].text ?? "";
  assert.ok(text.includes("evidence reference 999 not found"), "Must reject nonexistent evidence reference");
});

Deno.test("epistemic_safety: memory_record rejects contradicted evidence references", async () => {
  const contradictedTarget = {
    level: "L0" as const,
    lifecycle: "contradicted" as const,
    summary: "Refuted theory about sockets",
  };
  const { runner } = fakeRunner([
    { stdout: encodePayload("2026-03-30", contradictedTarget), stderr: "", code: 0 },
  ]);

  const tool = makeRecordTool(() => Promise.resolve(makeEnv(runner)));
  const res = await tool.execute("call-contradicted", {
    problem: "Fix socket timeout bug",
    approaches: [
      { approach: "Set SO_RCVTIMEO", outcome: "worked", reason: "Works" },
    ],
    evidence: [10],
  }, undefined, undefined, ctx);

  const text = res.content[0].text ?? "";
  assert.ok(text.includes("is contradicted and cannot support new conclusions"), "Must reject contradicted evidence reference");
});

Deno.test("epistemic_safety: memory_record assigns supported when valid evidence is confirmed", async () => {
  const validTarget = {
    level: "L0" as const,
    lifecycle: "supported" as const,
    summary: "Valid observation about socket descriptors",
  };
  const { runner, invocations } = fakeRunner([
    { stdout: encodePayload("2026-03-30", validTarget), stderr: "", code: 0 }, // get ref 10
    { stdout: "1\n10\n", stderr: "", code: 0 },                                  // list
    { stdout: "", stderr: "", code: 0 },                                         // store
  ]);

  const tool = makeRecordTool(() => Promise.resolve(makeEnv(runner)));
  await tool.execute("call-valid-evidence", {
    problem: "Fix socket timeout bug",
    approaches: [
      { approach: "Set SO_RCVTIMEO", outcome: "worked", reason: "Works" },
    ],
    evidence: [10],
  }, undefined, undefined, ctx);

  assert.ok(invocations.length >= 3);
  const storedPayload = invocations[2].args[1];
  const payloadStr = storedPayload.slice(storedPayload.indexOf(":") + 1);
  const { envelope } = decodePayload(payloadStr);
  assert.strictEqual(envelope.lifecycle, "supported", "Verified with valid evidence must be supported");
  assert.ok(envelope.summary.includes("verified: Set SO_RCVTIMEO"));
});

Deno.test("epistemic_safety: memory_record assigns observed when approach failed", async () => {
  const { runner, invocations } = fakeRunner([
    { stdout: "1\n", stderr: "", code: 0 },
    { stdout: "", stderr: "", code: 0 },
  ]);

  const tool = makeRecordTool(() => Promise.resolve(makeEnv(runner)));
  await tool.execute("call-3", {
    problem: "Fix socket timeout bug",
    approaches: [
      { approach: "Increase buffer size", outcome: "failed", reason: "Did not fix timeout" },
    ],
  }, undefined, undefined, ctx);

  const storedPayload = invocations[1].args[1];
  const { envelope } = decodePayload(storedPayload.slice(2));
  assert.strictEqual(envelope.lifecycle, "observed", "Failed approach must be marked observed");
});

Deno.test("epistemic_safety: decodePayload defaults legacy plain text to observed", () => {
  const decoded = decodePayload("2026-03-30:Plain unstructured legacy note");
  assert.strictEqual(decoded.envelope.lifecycle, "observed", "Legacy plain text must default to observed");
});

Deno.test("epistemic_safety: memory_lifecycle rejects promotion to supported without evidence", async () => {
  const existing = {
    level: "L1" as const,
    lifecycle: "tested" as const,
    summary: "Investigation into memory leak",
    evidence: [],
  };
  const { runner } = fakeRunner([
    { stdout: encodePayload("2026-03-30", existing), stderr: "", code: 0 },
  ]);

  const tool = makeLifecycleTool(() => Promise.resolve(makeEnv(runner)));
  const res = await tool.execute("call-4", {
    ref: 7,
    lifecycle: "supported",
  }, undefined, undefined, ctx);

  const text = res.content[0].text ?? "";
  assert.ok(text.includes("requires supporting evidenceRef or existing evidence"), "Must reject unbacked promotion");
});

Deno.test("epistemic_safety: memory_lifecycle rejects promotion when evidenceRef does not exist", async () => {
  const existing = {
    level: "L1" as const,
    lifecycle: "tested" as const,
    summary: "Investigation into memory leak",
    evidence: [],
  };
  const { runner } = fakeRunner([
    { stdout: encodePayload("2026-03-30", existing), stderr: "", code: 0 }, // get ref 7
    { stdout: "", stderr: "not found", code: 1 },                           // get ref 42 fails
  ]);

  const tool = makeLifecycleTool(() => Promise.resolve(makeEnv(runner)));
  const res = await tool.execute("call-fail-missing", {
    ref: 7,
    lifecycle: "supported",
    evidenceRef: 42,
  }, undefined, undefined, ctx);

  const text = res.content[0].text ?? "";
  assert.ok(text.includes("evidence reference 42 not found"), "Must reject nonexistent evidenceRef");
});

Deno.test("epistemic_safety: memory_lifecycle rejects promotion when evidenceRef is contradicted", async () => {
  const existing = {
    level: "L1" as const,
    lifecycle: "tested" as const,
    summary: "Investigation into memory leak",
    evidence: [],
  };
  const contradictedTarget = {
    level: "L0" as const,
    lifecycle: "contradicted" as const,
    summary: "Refuted evidence",
  };
  const { runner } = fakeRunner([
    { stdout: encodePayload("2026-03-30", existing), stderr: "", code: 0 },           // get ref 7
    { stdout: encodePayload("2026-03-30", contradictedTarget), stderr: "", code: 0 }, // get ref 42
  ]);

  const tool = makeLifecycleTool(() => Promise.resolve(makeEnv(runner)));
  const res = await tool.execute("call-fail-contradicted", {
    ref: 7,
    lifecycle: "supported",
    evidenceRef: 42,
  }, undefined, undefined, ctx);

  const text = res.content[0].text ?? "";
  assert.ok(text.includes("is contradicted and cannot support new conclusions"), "Must reject contradicted evidenceRef");
});

Deno.test("epistemic_safety: memory_lifecycle promotes to supported when valid evidenceRef is provided", async () => {
  const existing = {
    level: "L1" as const,
    lifecycle: "tested" as const,
    summary: "Investigation into memory leak",
    evidence: [],
  };
  const validTarget = {
    level: "L0" as const,
    lifecycle: "supported" as const,
    summary: "Verified root cause evidence",
  };
  const { runner, invocations } = fakeRunner([
    { stdout: encodePayload("2026-03-30", existing), stderr: "", code: 0 },    // get ref 7
    { stdout: encodePayload("2026-03-30", validTarget), stderr: "", code: 0 }, // get ref 42
    { stdout: "", stderr: "", code: 0 },                                       // store ref 7
  ]);

  const tool = makeLifecycleTool(() => Promise.resolve(makeEnv(runner)));
  await tool.execute("call-5", {
    ref: 7,
    lifecycle: "supported",
    evidenceRef: 42,
  }, undefined, undefined, ctx);

  assert.ok(invocations.length >= 3);
  const storedPayload = invocations[2].args[1];
  const payloadStr = storedPayload.slice(storedPayload.indexOf(":") + 1);
  const { envelope } = decodePayload(payloadStr);
  assert.strictEqual(envelope.lifecycle, "supported");
  assert.ok(envelope.evidence?.includes(42), "evidenceRef must be recorded in envelope.evidence");
});
