import assert from "node:assert/strict";
import { ReinforcementScheduler, isStandingDirective, synthesizeReinforcementBlockFromDirectives } from "../src/hooks/reinforcement.ts";
import { DEFAULT_REINFORCEMENT_CONFIG } from "../src/config.ts";

Deno.test("context_reinforcement: isStandingDirective correctly identifies standing rules", () => {
  assert.equal(isStandingDirective("always remember to not use grep and instead use ripgrep"), true);
  assert.equal(isStandingDirective("always remember: never edit var/ directly"), true);
  assert.equal(isStandingDirective("never use grep in our codebase"), true);
  assert.equal(isStandingDirective("our rule is all audio files must be FLAC"), true);
  assert.equal(isStandingDirective("standing rule: always run make test before finishing"), true);
  assert.equal(isStandingDirective("invariant: accent folding pão != pao"), true);

  // Negative cases
  assert.equal(isStandingDirective("Can you check the grep results?"), false);
  assert.equal(isStandingDirective("Hello there, how are you?"), false);
  assert.equal(isStandingDirective("Fix buffer overflow in song decoder"), false);
  assert.equal(isStandingDirective(""), false);
});

Deno.test("context_reinforcement: ReinforcementScheduler handles session start, milestones, and compaction", () => {
  const scheduler = new ReinforcementScheduler();
  const cfg = { ...DEFAULT_REINFORCEMENT_CONFIG, milestones: [0.33, 0.66] };

  // 1. Session start triggers
  const startRes = scheduler.checkTrigger(5, cfg);
  assert.equal(startRes.trigger, true);
  assert.equal(startRes.reason, "session_start");

  // 2. Normal turn at 15% should NOT trigger again
  const turn1Res = scheduler.checkTrigger(15, cfg);
  assert.equal(turn1Res.trigger, false);

  // 3. Normal turn at 30% should NOT trigger
  const turn2Res = scheduler.checkTrigger(30, cfg);
  assert.equal(turn2Res.trigger, false);

  // 4. Crossing 33% threshold (e.g. 35%) triggers milestone 1
  const m1Res = scheduler.checkTrigger(35, cfg);
  assert.equal(m1Res.trigger, true);
  assert.equal(m1Res.reason, "milestone");
  assert.equal(m1Res.milestone, 0.33);

  // 5. Subsequent turn at 40% (still within milestone 1) should NOT trigger
  const turn3Res = scheduler.checkTrigger(40, cfg);
  assert.equal(turn3Res.trigger, false);

  // 6. Crossing 66% threshold (e.g. 70%) triggers milestone 2
  const m2Res = scheduler.checkTrigger(70, cfg);
  assert.equal(m2Res.trigger, true);
  assert.equal(m2Res.reason, "milestone");
  assert.equal(m2Res.milestone, 0.66);

  // 7. Compaction occurs -> resets scheduler and primes post-compaction re-anchor
  scheduler.onCompaction();
  const postCompactRes = scheduler.checkTrigger(20, cfg);
  assert.equal(postCompactRes.trigger, true);
  assert.equal(postCompactRes.reason, "compaction");

  // 8. Disabled config yields zero triggers
  scheduler.onSessionStart();
  const disabledRes = scheduler.checkTrigger(35, { ...cfg, enabled: false });
  assert.equal(disabledRes.trigger, false);
});

Deno.test("context_reinforcement: synthesizeReinforcementBlockFromDirectives formats directives within token budget", () => {
  const scheduler = new ReinforcementScheduler();
  scheduler.registerDirective({
    ref: 1,
    summary: "Never use grep; always use ripgrep or search_code.",
  });
  scheduler.registerDirective({
    ref: 2,
    summary: "All audio pipeline outputs must use lossless FLAC format.",
    subsystem: "song",
  });

  const ctx = { cwd: "/tmp", hasUI: false, mode: "test" };
  const block = synthesizeReinforcementBlockFromDirectives(
    scheduler.getDirectives(),
    ctx,
    { trigger: true, reason: "milestone", milestone: 0.33 },
    DEFAULT_REINFORCEMENT_CONFIG,
  );

  assert.ok(block.includes("[Standing Operational Directives & Environment Baseline — Context Milestone (33% capacity)]"));
  assert.ok(block.includes("Never use grep; always use ripgrep or search_code."));
  assert.ok(block.includes("All audio pipeline outputs must use lossless FLAC format."));
  // Budget check: maxTokens default is 180 (~720 chars)
  assert.ok(block.length < 180 * 4);

  // Subsystem filtering test
  const songOnly = scheduler.getDirectives(["song"]);
  assert.equal(songOnly.length, 2);
  const grpOnly = scheduler.getDirectives(["grp"]);
  // Directive 1 is universal (no subsystem), Directive 2 is song -> grpOnly gets only universal directive 1
  assert.equal(grpOnly.length, 1);
  assert.equal(grpOnly[0].ref, 1);
});
