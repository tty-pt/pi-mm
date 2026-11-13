// R3: zero-config synthesis against the local auren server, and `/mm doctor` pipeline visibility.
import { strict as assert } from "node:assert";
import {
  DEFAULT_CONFIG,
  DEFAULT_LOCAL_SYNTH_MODEL,
  defaultLocalSynthUrl,
  synthConfigured,
  synthStatus,
  type MmConfig,
} from "../src/config.ts";
import { describeConsolidationPipeline } from "../src/tools/pipeline_status.ts";
import { defaultJournal } from "../src/tools/consolidation_journal.ts";

Deno.test("defaultLocalSynthUrl: derives the chat endpoint from the judge origin", () => {
  assert.equal(defaultLocalSynthUrl("http://127.0.0.1:4242"), "http://127.0.0.1:4242/v1/chat/completions");
  assert.equal(defaultLocalSynthUrl("http://h:9/api/v1/systemone/"), "http://h:9/v1/chat/completions");
  assert.equal(defaultLocalSynthUrl(undefined), undefined);
  assert.equal(defaultLocalSynthUrl("not a url"), undefined);
});

Deno.test("synth config: zero-config default follows the auto-defaulted local judge", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "mm-synth-cfg-" });
  try {
    const { readMmConfig } = await import("../src/config.ts");
    const cfg = await readMmConfig(dir, {});
    assert.equal(cfg.judgeUrl, "http://127.0.0.1:4242");
    assert.equal(cfg.synthUrl, "http://127.0.0.1:4242/v1/chat/completions");
    assert.equal(cfg.synthModel, DEFAULT_LOCAL_SYNTH_MODEL);
    assert.ok(synthConfigured(cfg));

    // Explicit env override wins.
    const env = await readMmConfig(dir, { PI_MM_SYNTH_URL: "http://other:1/v1/chat/completions", PI_MM_SYNTH_MODEL: "olmoe" });
    assert.equal(env.synthUrl, "http://other:1/v1/chat/completions");
    assert.equal(env.synthModel, "olmoe");

    // Explicit opt-out.
    const off = await readMmConfig(dir, { PI_MM_SYNTH_URL: "off" });
    assert.equal(synthConfigured(off), false);
    assert.equal(synthStatus(off).detail, "disabled (synthUrl: off)");

    // Judge off: no implicit synthesis.
    const noJudge = await readMmConfig(dir, { PI_MM_JUDGE_MODE: "off" });
    assert.equal(noJudge.judgeUrl, undefined);
    assert.equal(synthConfigured(noJudge), false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("describeConsolidationPipeline: reports synthesis, queue depths, backlog and stale L2", () => {
  const cfg: MmConfig = { ...DEFAULT_CONFIG, synthUrl: undefined, synthModel: undefined };
  const j = defaultJournal();
  j.pendingL0Refs = Array.from({ length: 23583 }, (_, i) => i);
  j.dirtyScopes = {
    site: { count: 714, l1Refs: Array.from({ length: 714 }, (_, i) => i), lastUpdated: "2026-11-01T00:00:00Z" },
  } as typeof j.dirtyScopes;
  j.dirtyL2 = { count: 0, l2Refs: [], lastUpdated: "2026-10-26T14:12:51.143Z" };
  const lines = describeConsolidationPipeline(cfg, j, new Date("2026-11-06T22:00:00Z"));
  const text = lines.join("\n");
  assert.match(text, /\[✗\] Synthesis \(L2\/L3\): off \(not configured/);
  assert.match(text, /pendingL0=23583 dirtyL1=714 \(1 scope\(s\)\) lastL2=2026-10-26 drain=250ms\/turn/);
  assert.match(text, /\[!\] L0 backlog is large/);
  assert.match(text, /L2 consolidation stale for 11 day\(s\) with 714 L1 waiting \(synthesis is off\)/);

  const on = describeConsolidationPipeline(
    { ...DEFAULT_CONFIG, synthUrl: "http://127.0.0.1:4242/v1/chat/completions", synthModel: "qwen" },
    defaultJournal(),
    new Date(),
  ).join("\n");
  assert.match(on, /\[✓\] Synthesis \(L2\/L3\): on \(qwen @ http:\/\/127\.0\.0\.1:4242\/v1\/chat\/completions\)/);
  assert.match(on, /pendingL0=0 dirtyL1=0/);
  assert.doesNotMatch(on, /\[!\]/);
});
