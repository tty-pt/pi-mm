import { strict as assert } from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { decodePayload } from "../src/payload.ts";
import { buildInjectedContext } from "../src/hooks/auto_recall.ts";
import { activeConversationTurn, installSessionHooks, reinforcementScheduler, type PiCtx } from "../src/hooks/events.ts";
import {
  extractDirectiveClause,
  isNaturalAnchor,
  isStandingDirective,
  stripNaturalRememberPrefix,
} from "../src/hooks/reinforcement.ts";
import { synthesizeL2ScopeKnowledge } from "../src/synth/adapter.ts";
import { makeRecordTool } from "../src/tools/record.ts";
import type { FusedCandidate } from "../src/tools/ranking.ts";
import { makeStoreTool } from "../src/tools/store.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { MemoryEnvelope } from "../src/types.ts";

function makeInMemoryEnv(memDir: string, overrides: Partial<typeof DEFAULT_CONFIG> = {}): {
  env: ToolEnv;
  store: Map<number, string | Uint8Array>;
} {
  const store = new Map<number, string | Uint8Array>();
  const runner = {
    run: (inv: {
      command: string;
      args: string[];
      payloadBytes?: Uint8Array;
      ref?: number;
      payloadJson?: string;
    }) => {
      const args = inv.args;
      if (args.includes("-p")) {
        const pIdx = args.indexOf("-p") + 1;
        const spec = args[pIdx];
        const colonIdx = spec.indexOf(":");
        const ref = inv.ref ?? Number(spec.slice(0, colonIdx));
        if (inv.payloadBytes) {
          store.set(ref, inv.payloadBytes);
        } else {
          store.set(ref, spec.slice(colonIdx + 1));
        }
        return Promise.resolve({ code: 0, stdout: `${ref}\n`, stderr: "" });
      }
      if (args.includes("-r") && args.includes("-g")) {
        const refIdx = args.indexOf("-g") + 1;
        const ref = Number(args[refIdx]);
        const val = store.get(ref);
        if (!val) return Promise.resolve({ code: 0, stdout: "-1\n", stderr: "" });
        if (typeof val === "string") {
          return Promise.resolve({ code: 0, stdout: `${val}\n`, stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "HTOK", stderr: "", stdoutBytes: val });
      }
      if (args.includes("-g") && args.includes(".")) {
        const refs = Array.from(store.keys()).sort((a, b) => a - b);
        return Promise.resolve({ code: 0, stdout: refs.join("\n") + (refs.length ? "\n" : ""), stderr: "" });
      }
      if (args.includes("-g")) {
        const out: string[] = [];
        for (const [ref, payload] of store.entries()) {
          if (typeof payload === "string") {
            out.push(`${ref} 0.90 ${payload}`);
          }
        }
        return Promise.resolve({ code: 0, stdout: out.join("\n") + (out.length ? "\n" : ""), stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
  const cfg = {
    ...DEFAULT_CONFIG,
    cormBin: "/usr/bin/corm",
    memDir,
    axisLibs: "/usr/lib",
    ...overrides,
  };
  const env: ToolEnv = {
    cfg,
    runner,
    nowProvider: () => new Date("2026-11-16T12:00:00Z"),
    cwd: memDir,
  };
  return { env, store };
}

Deno.test("natural_remember_and_directives: standing directive & natural anchor detection and clause extraction", () => {
  // Standing directives
  assert.strictEqual(isStandingDirective("Remember forever to run deno lint before finishing"), true);
  assert.strictEqual(isStandingDirective("Never forget to check return codes"), true);
  assert.strictEqual(isStandingDirective("From now on, never mock the database in integration tests"), true);
  assert.strictEqual(isStandingDirective("Regra permanente: nunca usar console.log em produção"), true);
  // Preserved negative invariant from directive_intent.test.ts
  assert.strictEqual(isStandingDirective("Make sure we never write raw SQL queries in request handlers"), false);

  // Natural anchors (facts/preferences)
  assert.strictEqual(isNaturalAnchor("Remember forever that our production port is 8443"), true);
  assert.strictEqual(isNaturalAnchor("Keep in mind that the API gateway strips custom X-Internal headers"), true);
  assert.strictEqual(isNaturalAnchor("Don't forget that staging uses Redis cluster 3"), true);
  assert.strictEqual(isNaturalAnchor("Fix the login button alignment"), false);

  // Prefix stripping
  assert.strictEqual(
    stripNaturalRememberPrefix("Please remember forever that our production port is 8443"),
    "our production port is 8443",
  );

  // Clause extraction from mixed task + directive prompt
  const mixed = "Fix the parser bug in src/parser.ts. Also, remember forever to never mock the database in tests.";
  const clause = extractDirectiveClause(mixed);
  assert.strictEqual(clause, "remember forever to never mock the database in tests.");
  assert.strictEqual(isStandingDirective(clause), true);
});

Deno.test("natural_remember_and_directives: memory_record supports standing rules and anchored facts without approaches[]", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-record-standing-" });
  reinforcementScheduler.clearDirectives();
  try {
    const { env, store } = makeInMemoryEnv(tmpDir);
    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "test", sessionId: "sess-rec-1" };
    const recordTool = makeRecordTool(() => Promise.resolve(env));

    // 1. Standing rule without approaches[] -> L2 supported invariant + standing_directives.json
    const res1 = await recordTool.execute(
      "call-1",
      {
        problem: "Never use console.log in production modules",
        standing: true,
        constraints: ["Never use console.log in production modules"],
      },
      undefined,
      undefined,
      ctx,
    );
    const details1 = res1.details as { ref?: number; summary?: string };
    assert.strictEqual(details1.ref, 1);
    assert.strictEqual(details1.summary, "Never use console.log in production modules");
    assert.strictEqual(activeConversationTurn.explicitlyRecordedInTurn, true);

    const stored1 = decodePayload(store.get(1)!);
    assert.strictEqual(stored1.envelope.level, "L2");
    assert.strictEqual(stored1.envelope.type, "invariant");
    assert.strictEqual(stored1.envelope.lifecycle, "supported");
    assert.strictEqual(stored1.envelope.standing, true);
    assert.strictEqual(stored1.envelope.isAnchor, true);

    const directivesOnDisk = JSON.parse(await readFile(join(tmpDir, "standing_directives.json"), "utf8"));
    assert.strictEqual(directivesOnDisk.length, 1);
    assert.strictEqual(directivesOnDisk[0].ref, 1);
    assert.strictEqual(directivesOnDisk[0].summary, "Never use console.log in production modules");

    // 2. Anchored fact without approaches[] -> L1 supported note with isAnchor: true
    const res2 = await recordTool.execute(
      "call-2",
      {
        problem: "The production webhook receiver runs on port 8443",
        anchor: true,
        type: "decision",
      },
      undefined,
      undefined,
      ctx,
    );
    const details2 = res2.details as { ref?: number };
    assert.strictEqual(details2.ref, 2);
    const stored2 = decodePayload(store.get(2)!);
    assert.strictEqual(stored2.envelope.level, "L1");
    assert.strictEqual(stored2.envelope.type, "decision");
    assert.strictEqual(stored2.envelope.lifecycle, "supported");
    assert.strictEqual(stored2.envelope.isAnchor, true);
  } finally {
    reinforcementScheduler.clearDirectives();
    activeConversationTurn.explicitlyRecordedInTurn = undefined;
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("natural_remember_and_directives: standing_directives.json preserves pre-existing directives and removes superseded refs", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-directives-sync-" });
  reinforcementScheduler.clearDirectives();
  try {
    // Pre-populate standing_directives.json on disk (simulating a directive from an earlier session)
    await writeFile(
      join(tmpDir, "standing_directives.json"),
      JSON.stringify([{ ref: 1, summary: "Old directive on disk" }], null, 2),
      "utf8",
    );

    const { env, store } = makeInMemoryEnv(tmpDir);
    // Also seed ref 1 in the store so applySupersedes can read and supersede it
    store.set(
      1,
      `2026-11-16:${JSON.stringify({
        level: "L2",
        type: "invariant",
        lifecycle: "supported",
        summary: "Old directive on disk",
        standing: true,
      })}`,
    );

    const ctx: PiCtx = { cwd: tmpDir, hasUI: false, mode: "test", sessionId: "sess-sync-1" };
    const storeTool = makeStoreTool(() => Promise.resolve(env));

    // Store a second independent standing directive -> both ref 1 and ref 2 must be preserved on disk
    await storeTool.execute(
      "call-s1",
      {
        summary: "Second standing directive",
        level: "L2",
        type: "invariant",
        standing: true,
      },
      undefined,
      undefined,
      ctx,
    );

    let diskDirs = JSON.parse(await readFile(join(tmpDir, "standing_directives.json"), "utf8"));
    assert.strictEqual(diskDirs.length, 2, "Must merge existing on-disk directives with newly registered directive");
    assert.deepStrictEqual(diskDirs.map((d: { ref: number }) => d.ref), [1, 2]);

    // Store a third directive that supersedes ref 1 -> ref 1 must be unregistered and removed from disk
    await storeTool.execute(
      "call-s2",
      {
        summary: "Updated replacement directive",
        level: "L2",
        type: "invariant",
        standing: true,
        supersedes: 1,
      },
      undefined,
      undefined,
      ctx,
    );

    diskDirs = JSON.parse(await readFile(join(tmpDir, "standing_directives.json"), "utf8"));
    assert.deepStrictEqual(
      diskDirs.map((d: { ref: number }) => d.ref),
      [2, 3],
      "Superseded directive ref 1 must be removed from standing_directives.json",
    );
    assert.strictEqual(
      reinforcementScheduler.getDirectives().some((d) => d.ref === 1),
      false,
      "Superseded directive ref 1 must be removed from in-memory scheduler",
    );
  } finally {
    reinforcementScheduler.clearDirectives();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test({
  name: "natural_remember_and_directives: onRunSettled captures natural remember and preserves isAnchor through L0->L1 consolidation and auto_recall",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-e2e-anchor-" });
  reinforcementScheduler.clearDirectives();
  try {
    const { env, store } = makeInMemoryEnv(tmpDir, {
      captureMode: "judge",
      judgeFallback: "skip",
    });
    const ctx: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "test",
      sessionId: "sess-anchor-1",
      sessionManager: {
        getSessionId: () => "sess-anchor-1",
        getSessionFile: () => join(tmpDir, "sess.jsonl"),
        getLeafId: () => "leaf-1",
      },
    };

    const listeners: Record<string, ((event: unknown, ctx?: unknown) => Promise<unknown>)[]> = {};
    const mockPi = {
      on: (ev: string, h: (e: unknown, c?: unknown) => Promise<unknown>) => {
        listeners[ev] = listeners[ev] || [];
        listeners[ev].push(h);
      },
    };
    // deno-lint-ignore no-explicit-any
    installSessionHooks(mockPi as any, () => Promise.resolve(env));
    const emit = async (ev: string, data: unknown) => {
      for (const h of listeners[ev] || []) await h(data, ctx);
    };

    await emit("session_start", null);

    // 1. User gives a natural "Remember forever that..." fact while judge endpoint is unconfigured (fallback = skip)
    await emit("before_agent_start", {
      messageType: "user",
      prompt: "Remember forever that the billing service uses port 9091 in staging.",
    });
    await emit("message_end", {
      message: { role: "assistant", content: "Got it, I will remember that the billing service uses port 9091 in staging." },
    });
    await emit("agent_settled", null);

    // Verify L0 was created and auto-consolidated to L1 with isAnchor preserved!
    const envelopes: Array<{ ref: number; env: MemoryEnvelope }> = [];
    for (const [ref, payload] of store.entries()) {
      envelopes.push({ ref, env: decodePayload(payload).envelope });
    }
    const l1 = envelopes.find((e) => e.env.level === "L1");
    assert.ok(l1, "Anchored L0 must be promoted to L1 during consolidation");
    assert.strictEqual(l1!.env.isAnchor, true, "L1 envelope must preserve isAnchor: true from L0");
    assert.ok(l1!.env.summary.includes("billing service uses port 9091 in staging"));

    // 2. Verify buildInjectedContext injects this anchored L1 memory on a normal technical prompt
    // WITHOUT mentioning any hardcoded C library name or saying "Do you remember?"
    const rawL1Record = store.get(l1!.ref)!;
    const candidates: FusedCandidate[] = [
      {
        ref: l1!.ref,
        record: typeof rawL1Record === "string" ? rawL1Record : new TextDecoder().decode(rawL1Record),
        origin: "lemma",
        rrfScore: 0.05,
        envelope: l1!.env,
      },
    ];
    const injected = buildInjectedContext(
      candidates,
      1200,
      undefined,
      "Configure the staging healthcheck for the billing service",
      false,
      "sess-anchor-2",
    );
    assert.ok(
      injected.includes("billing service uses port 9091 in staging"),
      "Anchored L1 memory must be injected on matching technical prompts without requiring hardcoded subsystem names",
    );

    // 3. User gives a mixed task + standing rule prompt
    await emit("before_agent_start", {
      messageType: "user",
      prompt: "Check the router config. Also, remember forever to never commit .env files.",
    });
    await emit("message_end", {
      message: { role: "assistant", content: "Checked the router config and noted the rule." },
    });
    await emit("agent_settled", null);

    const allEnvs = Array.from(store.values()).map((p) => decodePayload(p).envelope);
    const l2Rule = allEnvs.find((e) => e.level === "L2" && e.type === "invariant" && e.standing === true);
    assert.ok(l2Rule, "Standing rule clause in mixed prompt must be saved as L2 standing invariant");
    assert.ok(l2Rule!.summary.toLowerCase().includes("never commit .env files"));
    assert.ok(existsSync(join(tmpDir, "standing_directives.json")));
  } finally {
    reinforcementScheduler.clearDirectives();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
  },
});

Deno.test("natural_remember_and_directives: synthesizeL2ScopeKnowledge returns unavailable when local server only has embedding models", async () => {
  const mockFetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/chat/completions")) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "unknown model" }), {
          status: 404,
          statusText: "Not Found",
        }),
      );
    }
    if (url.endsWith("/v1/models")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "bge-base", object: "model" }],
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;

  const outcome = await synthesizeL2ScopeKnowledge(
    {
      scope: "site",
      isConversational: false,
      evidence: [
        { ref: 1, level: "L1", summary: "Fact A", lifecycle: "observed" },
        { ref: 2, level: "L1", summary: "Fact B", lifecycle: "observed" },
      ],
    },
    {
      ...DEFAULT_CONFIG,
      synthUrl: "http://127.0.0.1:14242",
      synthModel: "smollm",
    },
    mockFetch,
  );

  assert.strictEqual(outcome.status, "unavailable");
  assert.ok(outcome.reason?.includes("No generative chat model loaded"));
});
