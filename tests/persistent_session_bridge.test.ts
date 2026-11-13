import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRecallTool } from "../src/tools/recall.ts";
import { distillQuestArchiveEvent } from "../src/hooks/events.ts";
import { resolveEpisodeSessionCoordinates } from "../src/hooks/auto_recall.ts";
import { encodePayload, decodePayload, bytesToBinaryString } from "../src/payload.ts";
import {
  getSessionInstances,
  clearAllSessionInstances,
} from "../src/session/manager.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { PiCtx } from "../src/hooks/events.ts";
import type { MemoryEnvelope } from "../src/types.ts";

function createFakeMemoryEnv(
  cwd: string,
  recordsByRef: Map<number, { date: string; envelope: MemoryEnvelope }>,
): ToolEnv {
  return {
    cwd,
    cfg: {
      cormBin: "/bin/fake-corm",
      memDir: join(cwd, ".pi", "mm"),
      axisLibs: null,
      scanLimit: 10,
    },
    nowProvider: () => new Date("2026-11-11T14:00:00.000Z"),
    runner: {
      run: async (inv) => {
        const args = inv.args || [];
        // Handle -r -g <ref> <filespec>
        const gIdx = args.indexOf("-g");
        if (args.includes("-r") && gIdx !== -1 && gIdx + 1 < args.length && args[gIdx + 1] !== ".") {
          const ref = Number(args[gIdx + 1]);
          const item = recordsByRef.get(ref);
          if (!item) {
            return { stdout: "", stderr: "not found", code: 1 };
          }
          const bytes = encodePayload(item.date, item.envelope);
          return { stdout: bytesToBinaryString(bytes), stdoutBytes: bytes, stderr: "", code: 0 };
        }
        // Handle scan (-X) or list (-l)
        const lines: string[] = [];
        for (const [ref, item] of recordsByRef.entries()) {
          lines.push(`${ref}\t0.9500\t${item.date}:${JSON.stringify(item.envelope)}`);
        }
        return { stdout: lines.join("\n") + "\n", stderr: "", code: 0 };
      },
    },
  };
}

Deno.test("Phase 3: Persistent memory recall auto-indexes .jsonl session, pinpoints tool turn, and supports zoomRef+zoomTurn slicing", async () => {
  const tmpRepo = Deno.makeTempDirSync({ prefix: "mm-pers-bridge-" });
  try {
    clearAllSessionInstances();
    mkdirSync(join(tmpRepo, ".pi", "mm"), { recursive: true });
    const slot2Dir = join(tmpRepo, ".pi", "scratch", "slot-2");
    mkdirSync(slot2Dir, { recursive: true });

    const histSessionId = "01a1c7df-8888-4444-aaaa-bbbbccccdddd";
    const jsonlPath = join(tmpRepo, `${histSessionId}.jsonl`);
    const jsonlLines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: histSessionId,
        timestamp: "2026-11-10T09:00:00.000Z",
        cwd: slot2Dir,
      }),
      JSON.stringify({
        type: "message",
        id: "e-u1",
        parentId: null,
        timestamp: "2026-11-10T09:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Check why mods/gig filter is rejecting accent queries." }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "e-a1",
        parentId: "e-u1",
        timestamp: "2026-11-10T09:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Let me inspect mods/gig first." }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "e-u2",
        parentId: "e-a1",
        timestamp: "2026-11-10T09:01:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Now run the gig module test suite to reproduce the accent folding failure." }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "e-a2",
        parentId: "e-u2",
        timestamp: "2026-11-10T09:01:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Running make test-mod MOD=gig to observe the exact line." },
            {
              type: "toolCall",
              id: "call-gig-test-77",
              name: "bash",
              arguments: { command: "make test-mod MOD=gig" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "e-t2",
        parentId: "e-a2",
        timestamp: "2026-11-10T09:01:05.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-gig-test-77",
          toolName: "bash",
          isError: true,
          content: [
            {
              type: "text",
              text: [
                "make: Entering directory 'mods/gig'",
                "Running ./test.sh...",
                "PASS: gig_list_basic",
                "FAIL: gig_search_accent_pao — expected 'São Paulo' != 'Sao Paulo'",
                "Assertion failed at mods/gig/test.c:84",
                "make: *** [Makefile:18: test] Error 1",
              ].join("\n"),
            },
          ],
        },
      }),
    ];
    writeFileSync(jsonlPath, jsonlLines.join("\n") + "\n", "utf-8");

    // Store an L2 invariant (Ref 29) whose child L0 evidence (Ref 28) holds the session provenance & toolCallId
    const recordsByRef = new Map<number, { date: string; envelope: MemoryEnvelope }>();
    recordsByRef.set(28, {
      date: "2026-11-10",
      envelope: {
        level: "L0",
        type: "episode",
        lifecycle: "tested",
        summary: "bash `make test-mod MOD=gig`: FAIL gig_search_accent_pao",
        episode: {
          problem: "Accent folding regression in gig search",
          sessionId: histSessionId,
          sessionFile: jsonlPath,
          leafId: "e-t2",
          eventIds: ["call-gig-test-77"],
          toolCallId: "call-gig-test-77",
          outcome: "failure",
        },
      },
    });
    recordsByRef.set(29, {
      date: "2026-11-10",
      envelope: {
        level: "L2",
        type: "invariant",
        lifecycle: "supported",
        summary: "Search in mods/gig must remain accent-sensitive (São Paulo != Sao Paulo)",
        evidence: [28],
        context: { project: "site", subsystem: "gig" },
        episode: {
          problem: "Check why mods/gig filter is rejecting accent queries.",
          findings: ["Preserve UTF-8 codepoints in gig filter without TRANSLIT"],
          outcome: "success",
        },
      },
    });

    const env = createFakeMemoryEnv(tmpRepo, recordsByRef);
    const recallTool = makeRecallTool(async () => env);
    const mockCtx: PiCtx = {
      cwd: tmpRepo,
      hasUI: false,
      mode: "agent",
      sessionId: "current-session-9999",
    };

    // 1. Query persistent memory -> should auto-index histSessionId via L2->L0 evidence traversal
    const queryRes = await recallTool.execute(
      "call-1",
      { query: "accent-sensitive gig", scope: "persistent" },
      undefined,
      undefined,
      mockCtx,
    );
    const queryText = queryRes.content[0]?.text || "";
    assert.ok(queryText.includes("Indexed Source Session: 01a1c7df (slot-2)"));
    assert.ok(queryText.includes("[Turn 2 · bash · FAILED (Exit 1)]"));
    assert.ok(queryText.includes("memory_recall({ zoomRef: 29, zoomTurn: 2"));

    // 2. Direct zoomRef -> should also show Indexed Source Session and pinpointed Turn 2
    const zoomRefRes = await recallTool.execute(
      "call-2",
      { zoomRef: 29 },
      undefined,
      undefined,
      mockCtx,
    );
    const zoomRefText = zoomRefRes.content[0]?.text || "";
    assert.ok(zoomRefText.includes("=== Memory Zoom-In: Ref 29 ==="));
    assert.ok(zoomRefText.includes("Indexed Source Session: 01a1c7df (slot-2)"));
    assert.ok(zoomRefText.includes("memory_recall({ zoomRef: 29, zoomTurn: 2"));
    // Verify toolResult details are 100% structuredClone-safe for Pi's emitContext(messages)
    assert.ok(structuredClone(queryRes));
    assert.ok(structuredClone(zoomRefRes));

    // 3. Combined { zoomRef: 29, zoomTurn: 2, lineRange: [4, 5] } -> slices exact lines of the bash failure!
    const sliceRes = await recallTool.execute(
      "call-3",
      { zoomRef: 29, zoomTurn: 2, lineRange: [4, 5] },
      undefined,
      undefined,
      mockCtx,
    );
    const sliceText = sliceRes.content[0]?.text || "";
    assert.ok(sliceText.includes("=== Turn 2 · Tool: bash (Lines 4-5 of 6) ==="));
    assert.ok(sliceText.includes("Session: 01a1c7df (slot-2) (via Ref 29) [persistent-ref]"));
    assert.ok(sliceText.includes("4 | FAIL: gig_search_accent_pao"));
    assert.ok(sliceText.includes("5 | Assertion failed at mods/gig/test.c:84"));
    assert.ok(!sliceText.includes("1 | make: Entering directory"));
    assert.ok(structuredClone(sliceRes));

    // 4. Subsequent scope: "session" search finds the mounted persistent-ref session with provenance badge
    const crossSessionRes = await recallTool.execute(
      "call-4",
      { scope: "session", query: "gig_search_accent_pao" },
      undefined,
      undefined,
      mockCtx,
    );
    const crossText = crossSessionRes.content[0]?.text || "";
    assert.ok(crossText.includes("[Session 01a1c7df (via Ref 29) · Turn 2 · bash · FAILED (Exit 1)]"));
    assert.ok(crossText.includes("Zoom: memory_recall({ zoomRef: 29, zoomTurn: 2"));

    // 5. Direct zoom via { session: "01a1c7df", zoomTurn: 2, lineRange: [4, 4] }
    const bySessionIdZoom = await recallTool.execute(
      "call-5",
      { session: "01a1c7df", zoomTurn: 2, lineRange: [4, 4] },
      undefined,
      undefined,
      mockCtx,
    );
    const bySessionText = bySessionIdZoom.content[0]?.text || "";
    assert.ok(bySessionText.includes("4 | FAIL: gig_search_accent_pao"));
  } finally {
    clearAllSessionInstances();
    Deno.removeSync(tmpRepo, { recursive: true });
  }
});

Deno.test("Phase 4: Parallel session search via memory_recall surfaces provenance badges and slot selectors", async () => {
  const tmpRepo = Deno.makeTempDirSync({ prefix: "mm-parallel-recall-" });
  try {
    clearAllSessionInstances();
    mkdirSync(join(tmpRepo, ".pi", "mm"), { recursive: true });
    const slot3Dir = join(tmpRepo, ".pi", "scratch", "slot-3");
    const slot6Dir = join(tmpRepo, ".pi", "scratch", "slot-6");
    mkdirSync(slot3Dir, { recursive: true });
    mkdirSync(slot6Dir, { recursive: true });

    const currentInst = getSessionInstances("curr8888-0000-0000-0000-000000000001", { cwd: slot6Dir });
    await currentInst.store.appendEvent({
      id: "ev-c1",
      turnIndex: 1,
      entryId: "ec1",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "bash",
      summary: "bash: make -C mods/poem passed",
      text: "Compiling poem.c\nAll poem tests passed",
      toolName: "bash",
      exitCode: 0,
    });

    const peerInst = getSessionInstances("peer3333-0000-0000-0000-000000000002", { cwd: slot3Dir });
    await peerInst.store.appendEvent({
      id: "ev-p3",
      turnIndex: 4,
      entryId: "ep4",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "bash",
      summary: "bash (exit 1): make -C external/libchaff -> noise_octave overflow",
      text: "Building libchaff...\nchaff.c:112: error: noise_octave overflow in 2.5D grid\nmake: *** [Error 1]",
      toolName: "bash",
      exitCode: 1,
      errorSnippet: "chaff.c:112: error: noise_octave overflow in 2.5D grid",
    });

    const env = createFakeMemoryEnv(tmpRepo, new Map());
    const recallTool = makeRecallTool(async () => env);
    const mockCtx: PiCtx = {
      cwd: slot6Dir,
      hasUI: false,
      mode: "agent",
      sessionId: "curr8888-0000-0000-0000-000000000001",
    };

    // Query across session scope automatically finds the parallel slot-3 error
    const res = await recallTool.execute(
      "call-p1",
      { scope: "session", query: "noise_octave overflow" },
      undefined,
      undefined,
      mockCtx,
    );
    const text = res.content[0]?.text || "";
    assert.ok(text.includes("[Parallel Session peer3333 (slot-3) · Turn 4 · bash · FAILED (Exit 1)]"));
    assert.ok(text.includes('Zoom: memory_recall({ session: "peer3333", zoomTurn: 4'));

    // Filter explicitly by slot label: session: "slot-3"
    const slotZoom = await recallTool.execute(
      "call-p2",
      { session: "slot-3", zoomTurn: 4, lineRange: [2, 2] },
      undefined,
      undefined,
      mockCtx,
    );
    const slotZoomText = slotZoom.content[0]?.text || "";
    assert.ok(slotZoomText.includes("Session: peer3333 (slot-3) [parallel]"));
    assert.ok(slotZoomText.includes("2 | chaff.c:112: error: noise_octave overflow in 2.5D grid"));
  } finally {
    clearAllSessionInstances();
    Deno.removeSync(tmpRepo, { recursive: true });
  }
});

Deno.test("Phase 3: distillQuestArchiveEvent preserves session provenance and resolveEpisodeSessionCoordinates supports Tier 2 & Tier 3", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-prov-tiers-" });
  try {
    clearAllSessionInstances();
    let capturedEnvelope: MemoryEnvelope | undefined;
    const captureEnv: ToolEnv = {
      cwd: tmpDir,
      cfg: { cormBin: "/bin/fake-corm", memDir: join(tmpDir, ".pi", "mm"), axisLibs: null, scanLimit: 5 },
      nowProvider: () => new Date("2026-11-11T14:00:00.000Z"),
      runner: {
        run: async (inv) => {
          if (inv.payloadBytes) {
            capturedEnvelope = decodePayload(inv.payloadBytes).envelope;
          }
          return { stdout: "", stderr: "", code: 0 };
        },
      },
    };
    const distilledRef = await distillQuestArchiveEvent(
      {
        toolName: "quest_archive",
        toolCallId: "tc-archive-99",
        input: { outcome: "completed", summary: "Implemented cross-session recall" },
        details: { outcome: "completed", qid: "1xR90R", objective: "Multi-session recall" },
      },
      async () => captureEnv,
      {
        cwd: tmpDir,
        hasUI: false,
        mode: "agent",
        sessionId: "sess-archive-1234",
        sessionManager: {
          getSessionFile: () => "/tmp/sess-archive-1234.jsonl",
          getLeafId: () => "leaf-archive-55",
        },
      },
    );
    assert.ok(distilledRef);
    assert.ok(capturedEnvelope);
    assert.equal(capturedEnvelope.episode?.sessionId, "sess-archive-1234");
    assert.equal(capturedEnvelope.episode?.sessionFile, "/tmp/sess-archive-1234.jsonl");
    assert.equal(capturedEnvelope.episode?.leafId, "leaf-archive-55");
    assert.equal(capturedEnvelope.episode?.toolCallId, "tc-archive-99");

    const inst = getSessionInstances("tier-test-0000", { sessionDir: tmpDir });
    await inst.store.appendEvent({
      id: "ev-t1",
      turnIndex: 1,
      entryId: "e1",
      timestamp: new Date().toISOString(),
      role: "user",
      speaker: "User",
      summary: "Investigate bathymetry clamp in seven",
      text: "Investigate bathymetry clamp in seven",
    });
    await inst.store.appendEvent({
      id: "ev-t3",
      turnIndex: 3,
      entryId: "e3",
      timestamp: new Date().toISOString(),
      role: "tool",
      speaker: "bash",
      summary: "bash: make test-mod MOD=seven -> shore_water depth clamp verified",
      text: "Running shore_water test...\nshore_water depth clamp verified: PASS",
      toolName: "bash",
      exitCode: 0,
    });

    // Tier 2: No eventIds/toolCallIds, matches via summary substring
    const tier2Cards = await resolveEpisodeSessionCoordinates(
      inst,
      {
        sessionId: "tier-test-0000",
        eventIds: [],
        toolCallIds: [],
        summaries: ["shore_water depth clamp verified"],
      },
      42,
    );
    assert.ok(tier2Cards.length >= 1);
    assert.equal(tier2Cards[0].turnIndex, 3);
    assert.equal(tier2Cards[0].sourceMemoryRef, 42);

    // Tier 3: No eventIds and no direct 8-char substring probe -> falls back to query-ranked search
    const tier3Cards = await resolveEpisodeSessionCoordinates(
      inst,
      {
        sessionId: "tier-test-0000",
        eventIds: [],
        toolCallIds: [],
        summaries: [],
        problem: "bathymetry clamp",
      },
      43,
      "bathymetry",
    );
    assert.ok(tier3Cards.length >= 1);
    assert.equal(tier3Cards[0].turnIndex, 1);
    assert.equal(tier3Cards[0].sourceMemoryRef, 43);
  } finally {
    clearAllSessionInstances();
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

