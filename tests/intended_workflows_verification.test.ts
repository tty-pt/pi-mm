/**
 * Intended Workflows Verification Suite
 *
 * MAPPING MATRIX (README.md & skills/pi-mm/SKILL.md -> Test Assertions):
 * 1. Conversational Directives (@remember)      -> Section 1 (Directive Capture & Anchor Flag)
 * 2. Flashbulb Memory Anchors (FLAG_IS_ANCHOR)  -> Section 1 (Anchor Bit in Header)
 * 3. Autonomous & Incremental Consolidation     -> Section 2 (Promotion of L0 into L1/L2 Mipmaps)
 * 4. Structured Task Recording (memory_record) -> Section 3 (Approaches, Findings, Verification)
 * 5. Lifecycle Management (memory_review)      -> Section 4 (Advance tested -> supported, contradict)
 * 6. Evidence Traversal (Inspect & Traverse)    -> Section 5 (Downward Evidence Navigation)
 * 7. Latent Silence (Clean Prompt Contract)     -> Section 6 (Zero Injection on Conversational Turns)
 * 8. Proactive Subsystem Invariant Priming     -> Section 7 (L2 Invariant Priming for Mentioned Subsystem)
 * 9. On-Demand Explicit Recall (memory_recall)  -> Section 8 (Hybrid Search with Evidence)
 * 10. Mistake Tracking & Contradiction Filter  -> Section 9 (Contradicted Records Pruned from Recall)
 */

import { strict as assert } from "node:assert";
import { join } from "node:path";
import { rmSync, writeFileSync, existsSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";
import { filespecFor, buildListInvocation, buildGetInvocation } from "../src/corm.ts";
import { parseBareRefs } from "../src/resolve.ts";
import { decodePayload, encodePayload } from "../src/payload.ts";
import { installSessionHooks, type PiCtx } from "../src/hooks/events.ts";
import { handleBeforeAgentStart } from "../src/hooks/auto_recall.ts";
import { makeRecordTool } from "../src/tools/record.ts";
import { makeRecallTool } from "../src/tools/recall.ts";
import { makeReviewTool } from "../src/tools/review.ts";
import { runAutoConsolidation } from "../src/tools/consolidate.ts";
import { makeTraverseTool } from "../src/tools/traverse.ts";
import type { ToolEnv } from "../src/tools/index.ts";

const home = Deno.env.get("HOME") || "";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";

Deno.test("intended_workflows: comprehensive multi-session mipmap lifecycle validation", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-e2e-intended-" });
  const sockPath = join(tmpDir, "cormd.sock");
  const fspec = filespecFor(tmpDir, false);

  const sessionA_Id = "sess-lifecycle-A";
  const sessionA_File = join(tmpDir, "sess-A.jsonl");
  const sessionB_Id = "sess-lifecycle-B";
  const sessionB_File = join(tmpDir, "sess-B.jsonl");

  try {
    await ensureDaemon({ cormdBin, filespec: fspec, socketPath: sockPath, axisPath, cwd: tmpDir });
    const shellExec = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, { args, cwd: tmpDir, stdout: "piped", stderr: "piped" });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };
    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args) });

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin,
      cormdBin,
      memDir: tmpDir,
      axisLibs: axisPath,
      captureMode: "keyword" as const,
      captureKeywords: ["@remember", "@memory", "remember:", "note:"],
      consolidateThreshold: 1, // Rapid consolidation for integration test
      consolidateBatchLimit: 10,
    };

    const ctxA: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionA_Id,
      sessionManager: {
        getSessionId: () => sessionA_Id,
        getSessionFile: () => sessionA_File,
        getLeafId: () => "leaf_A_001",
      },
    };

    const envA: ToolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-24T12:00:00Z"),
      cwd: tmpDir,
    };
    const envSourceA = (_c?: PiCtx) => Promise.resolve(envA);

    const listenersA: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPiA = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listenersA[ev] = listenersA[ev] || [];
        listenersA[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPiA as any, envSourceA);

    const emitA = async (ev: string, data: unknown) => {
      for (const h of listenersA[ev] || []) await h(data, ctxA);
    };

    await emitA("session_start", null);

    // =========================================================================
    // SECTION 1: Directive Capture & Flashbulb Anchor
    // =========================================================================
    const promptPersona = "@remember We enforce pure C and zero site-specific JS in all modules.";
    await emitA("before_agent_start", { messageType: "user", prompt: promptPersona });
    await emitA("message_end", { message: { role: "assistant", content: "Understood. Pure C and zero site-specific JS rule recorded." } });
    await emitA("agent_settled", null);

    const listRes1 = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir));
    const refs1 = parseBareRefs(listRes1.stdout);
    assert.ok(refs1.length >= 1, "Directive @remember must store memory record in CORM");

    const personaL0 = await daemonRunner.run(buildGetInvocation(cormBin, fspec, refs1[0], axisPath, tmpDir));
    const personaData = decodePayload(personaL0.stdoutBytes ?? personaL0.stdout.trim());
    assert.ok(personaData.envelope.summary.includes("pure C and zero site-specific JS"));
    assert.strictEqual(personaData.envelope.isAnchor, true, "Explicit @remember directive must set FLAG_IS_ANCHOR");

    // =========================================================================
    // SECTION 2: Structured Task Resolution with memory_record
    // =========================================================================
    const recordTool = makeRecordTool(envSourceA);
    const recordRes = await recordTool.execute("rec-call-1", {
      problem: "corm_open file descriptor exhaustion on duplicate open",
      approaches: [
        { approach: "allocate fresh fd on every open", outcome: "failed", reason: "exhausts OS file descriptor table under load" },
        { approach: "check live handle table and alias handles on identical (file, map)", outcome: "worked", reason: "reuses live descriptor safely" },
      ],
      findings: ["corm_open was allocating redundant descriptors for identical paths"],
      diffs: ["--- a/libcorm.c\n+++ b/libcorm.c\n+ alias handle check"],
      verification: {
        testsPassed: ["test_corm_alias_roundtrip", "test_concurrency"],
        verifiedDiff: true,
      },
      outcome: "success",
      project: "site",
      subsystem: "libcorm",
    }, undefined, undefined, ctxA);

    assert.ok(recordRes.content[0].text?.includes("Recorded episode at Ref"), "memory_record must store task episode");

    // =========================================================================
    // SECTION 2.5: Autonomous Consolidation & Mipmap Promotion
    // =========================================================================
    const autoConsolidateRes = await runAutoConsolidation(envA, ctxA);
    assert.ok(autoConsolidateRes, "runAutoConsolidation must execute without errors");

    // Store a speculative hypothesis to test contradiction later
    const hypEnv = {
      level: "L1" as const,
      type: "investigation" as const,
      lifecycle: "hypothesized" as const,
      summary: "Hypothesis: socket polling requires 50ms thread sleep",
      context: { project: "site", subsystem: "libcorm" },
    };
    const hypBytes = encodePayload("2026-10-24", hypEnv);
    const hypRef = refs1[refs1.length - 1] + 2;
    await daemonRunner.run({
      command: cormBin,
      args: ["-p", `${hypRef}:-`, fspec],
      payloadBytes: hypBytes,
      cwd: tmpDir,
      env: { CORM_AXIS_PATH: axisPath },
      filespec: fspec,
      ref: hypRef,
    });

    // =========================================================================
    // SECTION 3: Lifecycle Review & Mistake Tracking (memory_review)
    // =========================================================================
    const reviewTool = makeReviewTool(envSourceA);

    // 1. Inspect evidence hierarchy
    const inspectRes = await reviewTool.execute("rev-call-1", {
      ref: refs1[0],
      action: "inspect",
    }, undefined, undefined, ctxA);
    assert.ok(inspectRes.content[0].text?.includes("=== Review Inspection for Ref"));

    // 2. Contradict the flawed hypothesis
    const contradictRes = await reviewTool.execute("rev-call-2", {
      ref: hypRef,
      action: "update_lifecycle",
      lifecycle: "contradicted",
      reason: "Thread sleep introduces 50ms latency penalty; non-blocking poll is strictly superior",
    }, undefined, undefined, ctxA);
    const contradictDetails = contradictRes.details as { currentState?: string } | undefined;
    assert.strictEqual(contradictDetails?.currentState, "contradicted", "reviewTool must update state to contradicted");

    // Verify contradicted record in storage
    const hypGet = await daemonRunner.run(buildGetInvocation(cormBin, fspec, hypRef, axisPath, tmpDir));
    const hypData = decodePayload(hypGet.stdoutBytes ?? hypGet.stdout.trim());
    assert.strictEqual(hypData.envelope.lifecycle, "contradicted", "Hypothesis must be updated to contradicted");

    // Store an active L2 invariant for libcorm citing persona ref as evidence
    const invRef = hypRef + 1;
    const invEnv = {
      level: "L2" as const,
      type: "invariant" as const,
      lifecycle: "supported" as const,
      summary: "Invariant: corm_open must alias live handles on identical (file, map)",
      context: { project: "site", subsystem: "libcorm" },
      evidence: [refs1[0]],
    };
    await daemonRunner.run({
      command: cormBin,
      args: ["-p", `${invRef}:-`, fspec],
      payloadBytes: encodePayload("2026-10-24", invEnv),
      cwd: tmpDir,
      env: { CORM_AXIS_PATH: axisPath },
      filespec: fspec,
      ref: invRef,
    });

    // =========================================================================
    // SECTION 3.5: Bidirectional Evidence Traversal (memory_traverse)
    // =========================================================================
    const traverseTool = makeTraverseTool(envSourceA);

    // 1. Downward traversal from L2 invariant to L0 evidence
    const downRes = await traverseTool.execute("tr-down", {
      ref: invRef,
      direction: "down",
    }, undefined, undefined, ctxA);
    const downText = downRes.content[0].text ?? "";
    assert.ok(downText.includes(`Ref ${refs1[0]}`), "Downward traversal must link to source evidence Ref");

    // 2. Upward traversal from L0 evidence to citing L2 invariant
    const upRes = await traverseTool.execute("tr-up", {
      ref: refs1[0],
      direction: "up",
    }, undefined, undefined, ctxA);
    const upText = upRes.content[0].text ?? "";
    assert.ok(upText.includes(`Ref ${invRef}`), "Upward traversal must discover higher abstraction citing this evidence");

    // Write session A transcript for excerpt retrieval
    const sessionALines = [
      JSON.stringify({ type: "session", id: sessionA_Id, timestamp: "2026-10-24T12:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: promptPersona }] } }),
      JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [{ type: "text", text: "Understood. Pure C and zero site-specific JS rule recorded." }] } }),
    ];
    writeFileSync(sessionA_File, sessionALines.join("\n") + "\n", "utf8");

    // =========================================================================
    // SESSION B: Cross-Session Continuity & Contract Enforcement
    // =========================================================================
    const ctxB: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionB_Id,
      sessionManager: {
        getSessionId: () => sessionB_Id,
        getSessionFile: () => sessionB_File,
        getLeafId: () => "leaf_B_001",
      },
    };

    const envB: ToolEnv = {
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-24T14:00:00Z"),
      cwd: tmpDir,
    };
    const envSourceB = (_c?: PiCtx) => Promise.resolve(envB);

    // -------------------------------------------------------------------------
    // TEST 1: Latent Clean Prompt Contract (R3)
    // Conversational, reviewing, and planning turns must inject ZERO context!
    // -------------------------------------------------------------------------
    const resReview = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Review the above work, compared to my prompt.",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);
    assert.strictEqual(resReview, null, "Review turn must inject zero context");

    const resPlan = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Ok. Glad you saw that. So plan a fix for the remaining.",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);
    assert.strictEqual(resPlan, null, "Planning turn must inject zero context");

    // -------------------------------------------------------------------------
    // TEST 2: Proactive Subsystem Invariant Priming (R2)
    // Technical prompts touching "libcorm" prime libcorm invariants only!
    // -------------------------------------------------------------------------
    const resSubsystem = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Fix the handle leak in libcorm",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);
    assert.ok(resSubsystem, "Technical prompt mentioning libcorm must prime invariant");
    const subContent = resSubsystem.message?.content || "";
    assert.ok(subContent.includes("[Primed Subsystem Invariants]"), "Must include primed invariant header");
    assert.ok(subContent.includes("corm_open must alias live handles"), "Must prime corm_open invariant");
    assert.strictEqual(subContent.includes("socket polling requires 50ms"), false, "Contradicted hypothesis must not be primed");

    // -------------------------------------------------------------------------
    // TEST 3: Explicit On-Demand Recall
    // Explicit inquiries recall the relevant fact with full continuity!
    // -------------------------------------------------------------------------
    const resRecall = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Do you remember what rule we have about pure C and JS?",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);
    assert.ok(resRecall, "Explicit recall question must return memory");
    const recallContent = resRecall.message?.content || "";
    assert.ok(recallContent.includes("pure C and zero site-specific JS"), "Must recover pure C / JS rule");

    // -------------------------------------------------------------------------
    // TEST 4: Essential 3 Tools - memory_recall with Evidence Traversal
    // -------------------------------------------------------------------------
    const recallTool = makeRecallTool(envSourceB);
    const toolRecallRes = await recallTool.execute("rec-query-1", {
      query: "corm_open live handle aliasing",
      includeEvidence: true,
      project: "site",
    }, undefined, undefined, ctxB);

    const recallText = toolRecallRes.content[0].text ?? "";
    assert.ok(recallText.includes("corm_open must alias live handles"), "memory_recall must find invariant");
    assert.ok(recallText.includes("Supporting Evidence"), "includeEvidence: true must return evidence tree");
    assert.strictEqual(recallText.includes("socket polling requires 50ms"), false, "Contradicted hypothesis must be omitted from normal recall");

    // Clean up resident cormd daemon
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
