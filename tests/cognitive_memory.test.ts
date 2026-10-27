import assert from "node:assert";
import { encodeHtokPayload, decodePayload, FLAG_IS_ANCHOR } from "../src/payload.ts";
import { computeRankingScore } from "../src/tools/ranking.ts";
import { extractKeyEntities, recordAssociations, getAssociatedTokens, loadAssociations } from "../src/associative.ts";
import { buildInjectedContext, detectSubsystemMentions } from "../src/hooks/auto_recall.ts";
import { installSessionHooks } from "../src/hooks/events.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { FusedCandidate } from "../src/tools/ranking.ts";
import type { MemoryEnvelope } from "../src/types.ts";

Deno.test("cognitive: FLAG_IS_ANCHOR 1-bit serialization roundtrip in HTOK v4", () => {
  const env: MemoryEnvelope = {
    level: "L1",
    lifecycle: "supported",
    summary: "I once spoke about airplanes with my grandpa under the cherry tree",
    isAnchor: true,
  };

  const bytes = encodeHtokPayload("2026-10-24", env);
  assert.ok(bytes.length > 12);
  const flags = bytes[11];
  assert.ok((flags & FLAG_IS_ANCHOR) !== 0, "FLAG_IS_ANCHOR must be set in header byte 11");

  const { envelope } = decodePayload(bytes);
  assert.strictEqual(envelope.isAnchor, true, "Decoded envelope must preserve isAnchor=true");

  // Non-anchor memory has flag unset
  const nonAnchorEnv: MemoryEnvelope = {
    level: "L1",
    lifecycle: "supported",
    summary: "Routine debug session",
  };
  const nonAnchorBytes = encodeHtokPayload("2026-10-24", nonAnchorEnv);
  assert.strictEqual((nonAnchorBytes[11] & FLAG_IS_ANCHOR), 0, "Non-anchor must not have FLAG_IS_ANCHOR");
  const nonAnchorDecoded = decodePayload(nonAnchorBytes);
  assert.strictEqual(nonAnchorDecoded.envelope.isAnchor, undefined);
});

Deno.test("cognitive: flashbulb anchor memory receives 1.25x salience boost in ranking", () => {
  const normalEnv: MemoryEnvelope = {
    level: "L2",
    lifecycle: "supported",
    summary: "Standard database connector rule",
  };
  const anchorEnv: MemoryEnvelope = {
    ...normalEnv,
    isAnchor: true,
  };

  const normalCand: FusedCandidate = {
    ref: 1,
    record: "2026-10-24:normal",
    origin: "lemma",
    rrfScore: 0.1,
    envelope: normalEnv,
  };

  const anchorCand: FusedCandidate = {
    ref: 2,
    record: "2026-10-24:anchor",
    origin: "lemma",
    rrfScore: 0.1,
    envelope: anchorEnv,
  };

  const normalScore = computeRankingScore(normalCand, { limit: 5 });
  const anchorScore = computeRankingScore(anchorCand, { limit: 5 });

  assert.ok(anchorScore > normalScore);
  assert.ok(Math.abs(anchorScore - normalScore * 1.25) < 1e-6, "Anchor score must be exactly 1.25x normal score");
});

Deno.test("cognitive: entity co-occurrence graph tracks associations and expands query tokens", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-associative-test-" });
  try {
    const text1 = "My grandpa flew commercial airplanes from Lisbon to Funchal";
    const text2 = "Talking with my grandpa under the old cherry tree";

    const entities1 = extractKeyEntities(text1);
    assert.ok(entities1.includes("grandpa"));
    assert.ok(entities1.includes("airplanes"));
    assert.ok(entities1.includes("lisbon"));
    assert.ok(entities1.includes("funchal"));

    await recordAssociations(tmpDir, text1);
    await recordAssociations(tmpDir, text2);

    const map = loadAssociations(tmpDir);
    assert.ok(map["grandpa"], "grandpa must be an indexed entity");
    assert.ok(map["grandpa"]["airplanes"] >= 1);
    assert.ok(map["grandpa"]["cherry"] >= 1);

    // Query expansion for 'airplanes' triggers 'grandpa'
    const neighbors = getAssociatedTokens(tmpDir, ["airplanes"], 2);
    assert.ok(neighbors.includes("grandpa"), "airplanes query must associatively activate grandpa");
  } finally {
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("cognitive: buildInjectedContext primes user persona and subsystem invariants with budget deduction", () => {
  const candidates: FusedCandidate[] = [
    {
      ref: 10,
      record: "2026-10-24:{}",
      origin: "lemma",
      rrfScore: 0.05,
      envelope: {
        level: "L2",
        type: "note",
        lifecycle: "supported",
        summary: "Architecture preference: Pure C, SSR-first, zero site-specific JS",
        context: { project: "user", subsystem: "persona" },
      },
    },
    {
      ref: 20,
      record: "2026-10-24:{}",
      origin: "lemma",
      rrfScore: 0.04,
      envelope: {
        level: "L2",
        type: "invariant",
        lifecycle: "supported",
        summary: "Audio recordings must archive in 48kHz 24-bit FLAC format",
        context: { project: "site", subsystem: "song" },
      },
    },
    {
      ref: 30,
      record: "2026-10-24:{}",
      origin: "lemma",
      rrfScore: 0.03,
      envelope: {
        level: "L1",
        type: "investigation",
        lifecycle: "supported",
        summary: "FLAC streaming latency investigation",
      },
    },
  ];

  const budget = 1200;
  const context = buildInjectedContext(candidates, budget, undefined, "Let's check mods/song playback");

  assert.ok(context.includes("[User Persona & Engineering Tenets]"), "Must include persona header");
  assert.ok(context.includes("Pure C, SSR-first"), "Must include persona content");
  assert.ok(context.includes("[Primed Subsystem Invariants]"), "Must include primed subsystem header");
  assert.ok(context.includes("Audio recordings must archive in 48kHz 24-bit FLAC"), "Must include subsystem invariant");
  assert.ok(context.includes("Background memories for conversational reference:"), "Must include general memory section");
  assert.ok(context.includes("FLAC streaming latency"), "Must include general memory");
  assert.ok(context.length <= budget, `Injected length ${context.length} must respect budget ${budget}`);

  // Verification: Ensure NO duplicate entries between primed blocks and general memories
  const occurrences = (context.match(/Audio recordings must archive in 48kHz 24-bit FLAC/g) || []).length;
  assert.strictEqual(occurrences, 1, "Primed subsystem invariant must not be duplicated in general memories");
});

Deno.test("cognitive: detectSubsystemMentions identifies project subsystems in prompts", () => {
  assert.deepStrictEqual(detectSubsystemMentions("Let's add a button in mods/song"), ["song"]);
  assert.deepStrictEqual(detectSubsystemMentions("Investigate memory leak in libcorm"), ["corm"]);
  assert.deepStrictEqual(detectSubsystemMentions("Check axil and sepal query performance"), ["axil", "sepal"]);
  assert.deepStrictEqual(detectSubsystemMentions("Good morning, how are you?"), []);
});

Deno.test("cognitive: onRunSettled indexes associations for captured memories", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-settle-assoc-" });
  try {
    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };

    let storedRef = 0;
    const runner = {
      run(inv: import("../src/corm.ts").Invocation) {
        if (inv.args[0] === "-g" && inv.args[1] === ".") {
          return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        }
        if (inv.args[0] === "-p") {
          storedRef++;
          return Promise.resolve({ stdout: String(storedRef), stderr: "", code: 0 });
        }
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      },
    };

    const cfg = { ...DEFAULT_CONFIG, cormBin: "/fake/corm", memDir: tmpDir, captureMode: "all" as const };
    const mockCtx = { cwd: tmpDir, hasUI: false, mode: "test" };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve({ cfg, runner, nowProvider: () => new Date(), cwd: tmpDir }));

    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, mockCtx);
    };

    await emit("session_start", null);
    await emit("before_agent_start", { messageType: "user", prompt: "Grandpa flew airplanes across Atlantic crosswinds" });
    await emit("agent_settled", null);

    // Verify associations were recorded on settled turn
    const map = loadAssociations(tmpDir);
    assert.ok(map["grandpa"], "grandpa must be recorded in associations.json during agent_settled");
    assert.ok(map["grandpa"]["airplanes"] >= 1, "grandpa must be linked to airplanes");
  } finally {
    try { Deno.removeSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
