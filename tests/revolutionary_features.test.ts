import assert from "node:assert";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { CodeStore } from "../src/code/store.ts";
import {
  bindMemoryToCode,
  clearLoreBindingsCache,
  formatLoreDriftSection,
  verifyLoreBindingsForSymbols,
} from "../src/code/lore_binding.ts";
import {
  diagnoseFailureTopology,
  parseFailureTrace,
} from "../src/code/diagnose.ts";
import {
  clearSwarmLeasesCache,
  formatSwarmStigmergySection,
  querySwarmStigmergy,
  recordSwarmAttentionLease,
} from "../src/code/stigmergy.ts";
import {
  clearGuardrailDedupCache,
  evaluateCounterfactualGuardrail,
  shouldEmitSessionGuardrail,
} from "../src/hooks/guardrails.ts";
import { collectWorktreeDiffText, parseUnifiedDiffHunks } from "../src/code/graph.ts";
import { clearCodeInstances, getCodeInstances } from "../src/code/manager.ts";
import { makeRecallTool } from "../src/tools/recall.ts";
import { encodePayload } from "../src/payload.ts";
import type { MemoryEnvelope } from "../src/types.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

Deno.test("lore_binding: binds supported invariant to AST symbol fingerprint and flags stale_suspect on signature/callee mutation or diff hunk", async () => {
  clearLoreBindingsCache();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-lore-binding-test-" });
  try {
    const lockFile = join(tmpDir, "lock.ts");
    writeFileSync(lockFile, [
      "export function validateToken(tok: string): boolean {",
      "  return tok.length > 0;",
      "}",
      "",
      "export function acquireFileLock(lockPath: string, token: string): boolean {",
      "  return validateToken(token);",
      "}",
    ].join("\n"), "utf-8");

    const store = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "code-index"),
      persistToCorm: false,
    });
    await store.indexProject();

    const invariantEnv: MemoryEnvelope = {
      level: "L2",
      type: "invariant",
      lifecycle: "supported",
      summary: "acquireFileLock always validates the token via validateToken before locking",
      context: { project: "site", subsystem: "lock", path: "lock.ts" },
    };

    const binding = bindMemoryToCode(store, 412, invariantEnv, { timestampIso: "2026-11-15" });
    assert.ok(binding, "should create lore binding");
    assert.ok(binding.anchors.some((a) => a.symbolName === "acquireFileLock"));

    // 1. Fresh verification before any code mutation
    const targetSyms = store.getSymbolsByName("acquireFileLock");
    const freshReports = verifyLoreBindingsForSymbols(store, targetSyms);
    assert.strictEqual(freshReports.length, 1);
    assert.strictEqual(freshReports[0].status, "fresh");
    assert.strictEqual(freshReports[0].driftedAnchors.length, 0);
    assert.ok(formatLoreDriftSection(freshReports).includes("AST-verified ✓"));

    // 2. Uncommitted git diff hunk touching acquireFileLock flags stale_suspect (in_diff_hunk)
    const diffText = [
      "diff --git a/lock.ts b/lock.ts",
      "--- a/lock.ts",
      "+++ b/lock.ts",
      "@@ -5,2 +5,2 @@",
      "+  // modifying acquireFileLock",
    ].join("\n");
    const diffReports = verifyLoreBindingsForSymbols(store, targetSyms, parseUnifiedDiffHunks(diffText));
    assert.strictEqual(diffReports.length, 1);
    assert.strictEqual(diffReports[0].status, "stale_suspect");
    assert.strictEqual(diffReports[0].driftedAnchors[0].reason, "in_diff_hunk");
    assert.ok(formatLoreDriftSection(diffReports).includes("STALE_SUSPECT"));

    // 3. Mutating acquireFileLock signature/callees on disk flags modified_signature_or_callees
    writeFileSync(lockFile, [
      "export function validateToken(tok: string): boolean {",
      "  return tok.length > 0;",
      "}",
      "",
      "export function acquireFileLock(lockPath: string, token: string, force = false): boolean {",
      "  return force;",
      "}",
    ].join("\n"), "utf-8");
    await store.refreshFile("lock.ts");

    const mutatedSyms = store.getSymbolsByName("acquireFileLock");
    const mutatedReports = verifyLoreBindingsForSymbols(store, mutatedSyms);
    assert.strictEqual(mutatedReports.length, 1);
    assert.strictEqual(mutatedReports[0].status, "stale_suspect");
    assert.strictEqual(mutatedReports[0].driftedAnchors[0].reason, "modified_signature_or_callees");
    const rendered = formatLoreDriftSection(mutatedReports);
    assert.ok(rendered.includes("STALE_SUSPECT"));
    assert.ok(rendered.includes("AST signature/callees mutated"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("diagnose: parses stack traces (TS/C/Python) and computes Causal Fault Intersection against git diff blast radius", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-diagnose-test-" });
  try {
    const dbFile = join(tmpDir, "db.ts");
    const serviceFile = join(tmpDir, "service.ts");
    const controllerFile = join(tmpDir, "controller.ts");

    writeFileSync(dbFile, [
      "export function queryRowById(rowId: number): string {",
      "  if (rowId < 0) throw new Error('Invalid rowId');",
      "  return String(rowId);",
      "}",
    ].join("\n"), "utf-8");

    writeFileSync(serviceFile, [
      'import { queryRowById } from "./db.ts";',
      "export function loadUserProfile(userId: number): string {",
      "  return queryRowById(userId);",
      "}",
    ].join("\n"), "utf-8");

    writeFileSync(controllerFile, [
      'import { loadUserProfile } from "./service.ts";',
      "export function handleProfileEndpoint(reqUser: number): string {",
      "  return loadUserProfile(reqUser);",
      "}",
    ].join("\n"), "utf-8");

    const store = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "code-index"),
      persistToCorm: false,
    });
    await store.indexProject();

    const stackTrace = [
      "Error: Invalid rowId in profile handler",
      `    at loadUserProfile (file://${serviceFile}:3:10)`,
      `    at handleProfileEndpoint (${controllerFile}:3:10)`,
    ].join("\n");

    const parsed = parseFailureTrace(stackTrace, tmpDir);
    assert.strictEqual(parsed.headline, "Error: Invalid rowId in profile handler");
    assert.strictEqual(parsed.frames.length, 2);
    assert.strictEqual(parsed.frames[0].filePath, "service.ts");
    assert.strictEqual(parsed.frames[0].line, 3);
    assert.strictEqual(parsed.frames[0].symbolName, "loadUserProfile");

    const gitDiff = [
      "diff --git a/db.ts b/db.ts",
      "--- a/db.ts",
      "+++ b/db.ts",
      "@@ -1,3 +1,3 @@",
      "+  if (rowId <= 0) throw new Error('Invalid rowId');",
    ].join("\n");

    const diagnosis = await diagnoseFailureTopology(store, stackTrace, {
      diffText: gitDiff,
      maxDepth: 2,
    });

    assert.strictEqual(diagnosis.stackSymbols.length, 2);
    assert.ok(diagnosis.faultIntersections.length >= 2, "should intersect stack frames with modified db.ts symbol");
    assert.ok(
      diagnosis.faultIntersections.some(
        (h) => h.symbol.name === "queryRowById" && h.role === "modified_callee_of_stack",
      ),
      "should pinpoint modified callee queryRowById",
    );
    assert.ok(
      diagnosis.faultIntersections.some(
        (h) => h.symbol.name === "loadUserProfile" && h.role === "caller_of_modified_on_stack",
      ),
      "should pinpoint stack frame caller loadUserProfile",
    );
    assert.ok(diagnosis.rendered.includes("Causal Fault Intersection"));
    assert.ok(diagnosis.rendered.includes("queryRowById"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("stigmergy: records and queries parallel session attention leases across files, symbols, and call-graph neighbors", async () => {
  clearSwarmLeasesCache();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-stigmergy-test-" });
  try {
    const nowMs = 1_700_000_000_000;
    recordSwarmAttentionLease(tmpDir, {
      sessionId: "01a1d4a6-1111-2222-3333-444444444444",
      workspaceLabel: "slot-2",
      filePath: "src/tools/consolidate.ts",
      symbolName: "drainL0Backlog",
      startLine: 120,
      endLine: 185,
      action: "mutating",
      intent: "Fixing head-of-line blocking in consolidation queue",
      updatedAtMs: nowMs - 15_000,
    });

    // Same session should not alert itself
    const selfMatches = querySwarmStigmergy(tmpDir, {
      currentSessionId: "01a1d4a6-1111-2222-3333-444444444444",
      symbolNames: ["drainL0Backlog"],
      nowMs,
    });
    assert.strictEqual(selfMatches.length, 0);

    // Parallel session querying exact symbol or neighbor sees the active mutation lease
    const peerMatches = querySwarmStigmergy(tmpDir, {
      currentSessionId: "99b9e9f9-aaaa-bbbb-cccc-dddddddddddd",
      symbolNames: ["processNext"],
      neighborSymbolNames: ["drainL0Backlog"],
      nowMs,
    });
    assert.strictEqual(peerMatches.length, 1);
    assert.strictEqual(peerMatches[0].overlapKind, "call_graph_neighbor");
    assert.strictEqual(peerMatches[0].lease.shortId, "01a1d4a6");
    assert.strictEqual(peerMatches[0].lease.workspaceLabel, "slot-2");
    assert.strictEqual(peerMatches[0].ageSeconds, 15);

    const rendered = formatSwarmStigmergySection(peerMatches);
    assert.ok(rendered.includes("[Parallel Session 01a1d4a6 (slot-2)]"));
    assert.ok(rendered.includes("ACTIVELY MUTATING"));
    assert.ok(rendered.includes("drainL0Backlog"));
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("guardrails: intercepts planned actions matching contradicted memories, failed approaches, and stale invariants", async () => {
  clearGuardrailDedupCache();
  clearLoreBindingsCache();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-guardrails-test-" });
  try {
    const lockFile = join(tmpDir, "lock.ts");
    writeFileSync(lockFile, [
      "export function tryRecoverStaleLock(lockPath: string): boolean {",
      "  return false;",
      "}",
    ].join("\n"), "utf-8");

    const store = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "code-index"),
      persistToCorm: false,
    });
    await store.indexProject();

    // Create a mock runner returning a contradicted memory and an episode with a failed approach
    const failedEpisodeEnv: MemoryEnvelope = {
      level: "L1",
      type: "episode",
      lifecycle: "supported",
      summary: "Main lock recovery race condition fix in lock.ts",
      constraints: ["Never unlink legacy empty lock files on age alone"],
      episode: {
        problem: "Empty lock file race in tryRecoverStaleLock",
        approaches: [
          {
            approach: "Unlinking empty .mm.lock file directly in tryRecoverStaleLock",
            outcome: "failed",
            reason: "Caused EEXIST inode replacement race across concurrent writers",
          },
          {
            approach: "Atomic publication via unique temp file and link()",
            outcome: "worked",
            reason: "Preserves single critical-section owner invariant",
          },
        ],
      },
    };
    const rawBytes = encodePayload("2026-11-15", failedEpisodeEnv);

    const fakeEnv: ToolEnv = {
      cwd: tmpDir,
      cfg: { ...DEFAULT_CONFIG, cormBin: "corm", memDir: tmpDir },
      nowProvider: () => new Date("2026-11-15T00:00:00Z"),
      runner: {
        run(inv) {
          if (inv.args.includes("-r")) {
            return Promise.resolve({
              code: 0,
              stdout: "HTOK",
              stdoutBytes: rawBytes,
              stderr: "",
            });
          }
          return Promise.resolve({
            code: 0,
            stdout: `309\t0.920000\tHTOK\n`,
            stderr: "",
          });
        },
      },
    };

    const res = await evaluateCounterfactualGuardrail(
      fakeEnv,
      {
        toolName: "edit",
        filePath: "lock.ts",
        symbolName: "tryRecoverStaleLock",
        intentText: "unlink empty lock file in tryRecoverStaleLock",
      },
      store,
    );

    assert.strictEqual(res.triggered, true);
    assert.ok(res.warnings.some((w) => w.kind === "failed_approach" && w.ref === 309));
    assert.ok(res.warnings.some((w) => w.kind === "standing_restriction" && w.ref === 309));
    assert.ok(res.rendered.includes("Déjà Vu Counterfactual Guardrail"));
    assert.ok(res.rendered.includes("Caused EEXIST inode replacement race"));

    // Session deduplication check
    assert.strictEqual(shouldEmitSessionGuardrail("sess-1", "309:failed_approach"), true);
    assert.strictEqual(shouldEmitSessionGuardrail("sess-1", "309:failed_approach"), false);
    assert.strictEqual(shouldEmitSessionGuardrail("sess-2", "309:failed_approach"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("end-to-end integration: memory_recall supports diagnose, guardrail, AST-bound drift, and swarm stigmergy", async () => {
  clearLoreBindingsCache();
  clearSwarmLeasesCache();
  clearGuardrailDedupCache();
  clearCodeInstances();

  const tmpDir = await Deno.makeTempDir({ prefix: "mm-e2e-rev-test-" });
  try {
    const authFile = join(tmpDir, "auth.ts");
    writeFileSync(authFile, [
      "export function verifyTokenSignature(tok: string): boolean {",
      "  return tok.startsWith('sig_');",
      "}",
      "",
      "export function authenticateUser(tok: string): boolean {",
      "  if (!verifyTokenSignature(tok)) {",
      "    throw new Error('Invalid token signature');",
      "  }",
      "  return true;",
      "}",
    ].join("\n"), "utf-8");

    const codeInst = getCodeInstances({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "code-index"),
      persistToCorm: false,
    });
    await codeInst.store.indexProject();

    // 1. Bind a supported invariant to authenticateUser & verifyTokenSignature
    const invariantEnv: MemoryEnvelope = {
      level: "L2",
      type: "invariant",
      lifecycle: "supported",
      summary: "authenticateUser must call verifyTokenSignature before granting access",
      constraints: ["Never bypass verifyTokenSignature in authenticateUser"],
      context: { project: "site", subsystem: "auth", path: "auth.ts" },
      episode: {
        problem: "Token bypass regression in auth.ts",
        approaches: [
          {
            approach: "Skipping verifyTokenSignature for local tokens in authenticateUser",
            outcome: "failed",
            reason: "Allowed forged local tokens to escalate privileges",
          },
          {
            approach: "Always enforcing verifyTokenSignature in authenticateUser",
            outcome: "worked",
            reason: "Prevents forged token escalation",
          },
        ],
      },
    };
    bindMemoryToCode(codeInst.store, 501, invariantEnv);

    // 2. Record a parallel swarm session mutating auth.ts
    recordSwarmAttentionLease(codeInst.store.indexDir, {
      sessionId: "parallel-sess-99",
      workspaceLabel: "slot-4",
      filePath: "auth.ts",
      symbolName: "authenticateUser",
      action: "mutating",
    });

    // 3. Mutate authenticateUser on disk so the bound invariant becomes stale_suspect
    writeFileSync(authFile, [
      "export function verifyTokenSignature(tok: string): boolean {",
      "  return tok.startsWith('sig_');",
      "}",
      "",
      "export function authenticateUser(tok: string, allowBypass = false): boolean {",
      "  if (allowBypass) return true;",
      "  return tok.length > 0;",
      "}",
    ].join("\n"), "utf-8");
    await codeInst.store.refreshFile("auth.ts");

    const rawBytes = encodePayload("2026-11-15", invariantEnv);
    const fakeEnv: ToolEnv = {
      cwd: tmpDir,
      cfg: { ...DEFAULT_CONFIG, cormBin: "corm", memDir: tmpDir },
      nowProvider: () => new Date("2026-11-15T00:00:00Z"),
      runner: {
        run(inv) {
          if (inv.args.includes("-r")) {
            return Promise.resolve({ code: 0, stdout: "HTOK", stdoutBytes: rawBytes, stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: `501\t0.950000\tHTOK\n`, stderr: "" });
        },
      },
    };

    const recallTool = makeRecallTool(() => Promise.resolve(fakeEnv));
    const ctx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "current-sess-1" };

    // A) Symbol recall should surface both STALE_SUSPECT drift and Swarm Stigmergy
    const symRes = await recallTool.execute("c1", { scope: "code", symbol: "authenticateUser" }, undefined, undefined, ctx);
    const symText = symRes.content[0]?.text ?? "";
    assert.ok(symText.includes("authenticateUser"), "Should include symbol body");
    assert.ok(symText.includes("STALE_SUSPECT"), "Should surface AST-bound invariant drift");
    assert.ok(symText.includes("Swarm Stigmergy"), "Should surface parallel swarm session lease");
    assert.ok(symText.includes("slot-4"), "Should identify parallel slot-4");

    // B) Guardrail mode should intercept the failed approach, standing restriction, and stale invariant
    const guardRes = await recallTool.execute(
      "c2",
      {
        guardrail: "skip verifyTokenSignature for local tokens in authenticateUser",
        file: "auth.ts",
        symbol: "authenticateUser",
      },
      undefined,
      undefined,
      ctx,
    );
    const guardText = guardRes.content[0]?.text ?? "";
    assert.ok(guardText.includes("Déjà Vu Counterfactual Guardrail"), "Should render guardrail header");
    assert.ok(guardText.includes("Allowed forged local tokens"), "Should surface prior failed approach reason");
    assert.ok(guardText.includes("Never bypass verifyTokenSignature"), "Should surface standing restriction");
    assert.ok(guardText.includes("STALE_SUSPECT INVARIANT"), "Should surface stale bound invariant in guardrail");

    // C) Diagnose mode should parse stack trace and localize fault on authenticateUser
    const diagRes = await recallTool.execute(
      "c3",
      {
        diagnose: [
          "Error: Invalid token signature",
          `    at verifyTokenSignature (${authFile}:2:10)`,
          `    at authenticateUser (${authFile}:6:9)`,
        ].join("\n"),
      },
      undefined,
      undefined,
      ctx,
    );
    const diagText = diagRes.content[0]?.text ?? "";
    assert.ok(diagText.includes("Differential Failure Topology & Causal Fault Intersection"), "Should render diagnosis header");
    assert.ok(diagText.includes("verifyTokenSignature"), "Should resolve stack frame symbol");
    assert.ok(diagText.includes("authenticateUser"), "Should resolve caller frame symbol");
  } finally {
    clearCodeInstances();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("self-test regressions: TS inline object param/return spans, standing_directives.json guardrails, and dirty submodule diffs", async () => {
  clearGuardrailDedupCache();
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-selftest-reg-" });
  try {
    await Deno.mkdir(join(tmpDir, ".pi", "extensions", "pi-mm", "src"), { recursive: true });
    const subFile = join(tmpDir, ".pi", "extensions", "pi-mm", "src", "diag.ts");
    writeFileSync(subFile, [
      "export function helperCallee(x: number): number {",
      "  return x + 1;",
      "}",
      "",
      "export async function runWithInlineTypes(",
      "  name: string,",
      "  options?: { diffText?: string; maxDepth?: number },",
      "): Promise<{ ok: boolean; value: number }> {",
      "  const v = helperCallee(options?.maxDepth ?? 2);",
      "  return { ok: name.length > 0, value: v };",
      "}",
    ].join("\n"), "utf-8");

    const store = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "code-index"),
      persistToCorm: false,
       runner: undefined,
    } as never, {
      run(inv) {
        if (inv.cwd === tmpDir) {
          return Promise.resolve({
            code: 0,
            stdout: [
              "diff --git a/.pi/extensions/pi-mm b/.pi/extensions/pi-mm",
              "--- a/.pi/extensions/pi-mm",
              "+++ b/.pi/extensions/pi-mm",
              "@@ -1 +1 @@",
              "-Subproject commit 1111111111111111111111111111111111111111",
              "+Subproject commit 1111111111111111111111111111111111111111-dirty",
            ].join("\n"),
            stderr: "",
          });
        }
        return Promise.resolve({
          code: 0,
          stdout: [
            "diff --git a/src/diag.ts b/src/diag.ts",
            "--- a/src/diag.ts",
            "+++ b/src/diag.ts",
            "@@ -9,1 +9,1 @@",
            "+  const v = helperCallee(options?.maxDepth ?? 2);",
          ].join("\n"),
          stderr: "",
        });
      },
    });
    await store.indexProject();

    // 1. Verify full TS span & callees across inline object parameter and return types
    const syms = store.getSymbolsByName("runWithInlineTypes");
    assert.strictEqual(syms.length, 1);
    assert.strictEqual(syms[0].startLine, 5);
    assert.strictEqual(syms[0].endLine, 11, "Function span must not truncate at inline parameter or return type closing brace");
    assert.ok(syms[0].rawCallees.includes("helperCallee"), "Must extract callees inside body after inline object param/return types");

    // 2. Verify dirty submodule diff stripping + expansion
    const combinedDiff = await collectWorktreeDiffText(store);
    const hunks = parseUnifiedDiffHunks(combinedDiff);
    assert.strictEqual(hunks.length, 1, "Bare dirty submodule gitlink must be stripped while inner submodule file diff is expanded");
    assert.strictEqual(hunks[0].filePath, ".pi/extensions/pi-mm/src/diag.ts");

    // 3. Verify standing_directives.json prohibitive rule matching in guardrail
    writeFileSync(join(tmpDir, "standing_directives.json"), JSON.stringify([
      {
        ref: 1550,
        summary: "Episode: Worktree branch integration belongs strictly to the pi-quest harness; never manually merge, cherry-pick, or run post-archive builds in the operator's root worktree.",
        subsystem: "quest-harness",
        project: "site",
      },
    ]), "utf-8");

    const fakeEnv: ToolEnv = {
      cwd: tmpDir,
      cfg: { ...DEFAULT_CONFIG, cormBin: "corm", memDir: tmpDir },
      nowProvider: () => new Date("2026-11-15T00:00:00Z"),
      runner: {
        run() {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      },
    };

    const guard = await evaluateCounterfactualGuardrail(fakeEnv, {
      filePath: "mods/song/ux/song.c",
      intentText: "manually merge worktree branch in root worktree",
    }, store);
    assert.strictEqual(guard.triggered, true);
    assert.ok(guard.warnings.some((w) => w.ref === 1550 && w.kind === "standing_restriction"));

    // 4. Verify L0 raw tool telemetry is rejected by bindMemoryToCode and guardrail evaluation
    const rawL0ReadEnv: MemoryEnvelope = {
      level: "L0",
      type: "episode",
      lifecycle: "tested",
      summary: "read .pi/extensions/pi-mm/src/code/diag.ts: export function helperCallee(x: number)",
      episode: {
        problem: "const payload = verifySessionToken(token);",
        approaches: [
          {
            approach: "Executed read: const payload = verifySessionToken(token);",
            outcome: "failed",
            reason: "const payload = verifySessionToken(token);",
          },
        ],
      },
    };
    const l0Bind = bindMemoryToCode(store, 7613, rawL0ReadEnv);
    assert.strictEqual(l0Bind, null, "L0 raw tool telemetry must never be bound as an AST invariant");

    const l2ToolTraceEnv: MemoryEnvelope = {
      level: "L2",
      type: "episode",
      lifecycle: "supported",
      summary: "Investigation: Updated draft — verified: Executed memory_recall: No code symbols found",
      episode: {
        problem: "verifyLoreBindingsForSymbols executeCodeRecallWithLore",
        approaches: [
          {
            approach: "Executed memory_recall: memory_recall .pi/extensions/pi-quest: No code symbols found",
            outcome: "failed",
            reason: "No code symbols found",
          },
        ],
      },
    };
    const l2Bytes = encodePayload("2026-11-15", l2ToolTraceEnv);
    const noisyEnv: ToolEnv = {
      ...fakeEnv,
      runner: {
        run(inv) {
          if (inv.args.includes("-r")) {
            return Promise.resolve({ code: 0, stdout: "HTOK", stdoutBytes: l2Bytes, stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: "4744\t0.900000\tHTOK\n", stderr: "" });
        },
      },
    };
    const falsePosGuard = await evaluateCounterfactualGuardrail(noisyEnv, {
      symbolName: "verifyLoreBindingsForSymbols",
      intentText: "verifyLoreBindingsForSymbols collectLoreLines executeCodeRecallWithLore",
    }, store);
    assert.strictEqual(
      falsePosGuard.warnings.some((w) => w.ref === 4744),
      false,
      "Guardrail must ignore auto-harvested 'Executed <tool>:' approaches in L2 episodes",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("next-level features: vendor submodules exclusion, built-in method call-graph isolation, XY/WASM cross-boundary pairing, first-touch dossier, and FAIL->PASS verification ledger", async () => {
  const { clearSessionVisitedModules, resolveCrossBoundaryPairs, synthesizeFirstTouchModuleDossier } = await import("../src/code/dossier.ts");
  const { clearVerificationLedger, observeBashVerificationOutcome, recordFileMutationInLedger } = await import("../src/hooks/verification_ledger.ts");
  clearSessionVisitedModules();
  clearVerificationLedger();
  clearLoreBindingsCache();

  const tmpDir = await Deno.makeTempDir({ dir: "/var/tmp", prefix: "mm-next-level-test-" });
  try {
    // 1. Submodule vendor directory (should be ignored) vs first-party mods/song
    await Deno.mkdir(join(tmpDir, "external", "axil-auren", "submodules", "llama", "src"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "mods", "song", "ux"), { recursive: true });

    writeFileSync(join(tmpDir, "external", "axil-auren", "submodules", "llama", "src", "simplechat.js"), [
      "export class SimpleChat {",
      "  add(x) { return x; }",
      "}",
    ].join("\n"), "utf-8");

    writeFileSync(join(tmpDir, "mods", "song", "song.h"), [
      "XY_DECL(int, song_transpose_root, int, root, int, semitones);",
    ].join("\n"), "utf-8");

    writeFileSync(join(tmpDir, "mods", "song", "song.c"), [
      '#include "song.h"',
      "XY_IMPL(int, song_transpose_root, int, root, int, semitones) {",
      "  return (root + semitones) % 12;",
      "}",
    ].join("\n"), "utf-8");

    writeFileSync(join(tmpDir, "mods", "song", "ux", "song_ux.c"), [
      "void bud_app_render(void *state) {}",
      'STL_WASM_MODULE("song", bud_app_render);',
    ].join("\n"), "utf-8");

    writeFileSync(join(tmpDir, "caller.ts"), [
      "export class UnrelatedStore {",
      "  get(k: string) { return k; }",
      "}",
      "export function runCaller() {",
      "  const m = new Map<string, string>();",
      "  m.get('a');",
      "}",
    ].join("\n"), "utf-8");

    const store = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "code-index"),
      persistToCorm: false,
    });
    await store.indexProject();

    // Verify nested submodules/ directory is excluded
    assert.strictEqual(store.getSymbolsByName("SimpleChat").length, 0, "Vendor submodules/ directory must be excluded from CodeStore index");

    // Verify built-in method name `get` on Map does not link to UnrelatedStore.get
    const callerSyms = store.getSymbolsByName("runCaller");
    assert.strictEqual(callerSyms.length, 1);
    assert.strictEqual(callerSyms[0].callees.length, 0, "Built-in method .get() must not link to unrelated class Method .get()");

    // Verify XY_DECL <-> XY_IMPL linkage and cross-boundary isomorphic pairing
    const songSyms = store.getSymbolsByName("song_transpose_root");
    assert.strictEqual(songSyms.length, 2, "Should index both XY_DECL interface and XY_IMPL implementation");
    const implSym = songSyms.find((s) => s.kind === "Function")!;
    const pairs = resolveCrossBoundaryPairs(store, [implSym]);
    assert.ok(pairs.some((p) => p.includes("[XY Contract Pair] XY_DECL song_transpose_root")), "Should pair XY_IMPL with XY_DECL");
    assert.ok(pairs.some((p) => p.includes("[Isomorphic UX Entry]")), "Should pair server module symbol with isomorphic UX entry");

    // Verify First-Touch Module Dossier fires once per session per module
    const dossier1 = synthesizeFirstTouchModuleDossier(store, "sess-dossier-1", "mods/song/ux/song_ux.c");
    assert.ok(dossier1.includes("[pi-mm First-Touch Module Dossier: mods/song]"));
    assert.ok(dossier1.includes("Pure-C Isomorphic UX"));
    assert.ok(dossier1.includes("make -C mods/song && make site-wasm"));
    const dossier2 = synthesizeFirstTouchModuleDossier(store, "sess-dossier-1", "mods/song/song.c");
    assert.strictEqual(dossier2, "", "Second touch to same module in same session must not emit duplicate dossier");

    // Verify FAIL -> edit -> PASS verification ledger automatically synthesizes L2 tested memory
    let storedPayloadText = "";
    const fakeEnv: ToolEnv = {
      cwd: tmpDir,
      cfg: { ...DEFAULT_CONFIG, cormBin: "corm", memDir: tmpDir },
      nowProvider: () => new Date("2026-11-15T00:00:00Z"),
      runner: {
        run(inv) {
          if (inv.args.includes("-p")) {
            storedPayloadText = inv.payloadJson || "";
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          }
          if (inv.args.includes("-l")) {
            return Promise.resolve({ code: 0, stdout: "100\n", stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      },
    };
    const envSource = () => Promise.resolve(fakeEnv);
    const ctx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-verify-1" };

    // Step A: failing test run
    const failRef = await observeBashVerificationOutcome("sess-verify-1", {
      toolName: "bash",
      isError: true,
      input: { command: "make test-mod MOD=song" },
      content: [{ type: "text", text: "mods/song/song.c:4: error: Modulo by zero in song_transpose_root" }],
    }, envSource, ctx);
    assert.strictEqual(failRef, null);

    // Step B: file mutation
    recordFileMutationInLedger("sess-verify-1", "mods/song/song.c");

    // Step C: passing test run
    const passRef = await observeBashVerificationOutcome("sess-verify-1", {
      toolName: "bash",
      isError: false,
      input: { command: "make test-mod MOD=song" },
      content: [{ type: "text", text: "PASS: mods/song" }],
    }, envSource, ctx);
    assert.ok(typeof passRef === "number" && passRef > 0, "FAIL -> edit -> PASS must synthesize an attested L2 memory ref");
    assert.ok(storedPayloadText.includes("Verified Fix (make test-mod MOD=song)"), "Stored payload should include attested command and fix summary");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("live-execution precision fixes: generic method lore isolation, test route dossier filtering, overview clustering, diagnose+guardrail composition, turn coalescing, and scratch-slot stigmergy", async () => {
  const { clearSessionVisitedModules, synthesizeFirstTouchModuleDossier } = await import("../src/code/dossier.ts");
  const { buildCodeArchitectureOverview } = await import("../src/code/graph.ts");
  const { clearVerificationLedger, observeBashVerificationOutcome } = await import("../src/hooks/verification_ledger.ts");
  const { makeRecordTool } = await import("../src/tools/record.ts");
  const { getSessionInstances } = await import("../src/session/manager.ts");

  clearSessionVisitedModules();
  clearVerificationLedger();
  clearLoreBindingsCache();
  clearSwarmLeasesCache();
  clearCodeInstances();

  const tmpDir = await Deno.makeTempDir({ dir: "/var/tmp", prefix: "mm-precision-fixes-" });
  try {
    await Deno.mkdir(join(tmpDir, ".pi", "extensions", "pi-mm", "src", "session"), { recursive: true });
    await Deno.mkdir(join(tmpDir, ".pi", "extensions", "pi-mm", "tests"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "tests", "unit"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "mods", "chat"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "external", "axil-auren", "tests", "mocks"), { recursive: true });

    // 1. Class with generic `.search()` method in .pi/extensions/pi-mm
    const recallFile = join(tmpDir, ".pi", "extensions", "pi-mm", "src", "session", "recall.ts");
    writeFileSync(recallFile, [
      "export class SessionRecallEngine {",
      "  search(query: string): string {",
      "    return query.trim();",
      "  }",
      "}",
    ].join("\n"), "utf-8");

    // 2. Test fixture with route string inside .pi/extensions/pi-mm/tests/
    writeFileSync(join(tmpDir, ".pi", "extensions", "pi-mm", "tests", "scanner.test.ts"), [
      "export function testRouteFixture() {",
      '  app.post("/song/edit", handleSongEdit);',
      "}",
    ].join("\n"), "utf-8");

    // 3. Test runner with high-degree main() in tests/unit/ and mock corm_open in tests/mocks/
    writeFileSync(join(tmpDir, "tests", "unit", "test_runner.c"), [
      "void helperA(void) {}",
      "void helperB(void) {}",
      "void *corm_open(void *a) { return a; }",
      "int main(void) { helperA(); helperB(); return 0; }",
    ].join("\n"), "utf-8");

    writeFileSync(join(tmpDir, "external", "axil-auren", "tests", "mocks", "corm_mock.c"), [
      "void *corm_open(void *a) { return a; }",
    ].join("\n"), "utf-8");

    // 4. mods/chat production file and colocated test_unit.c
    writeFileSync(join(tmpDir, "mods", "chat", "chat.c"), [
      "static void ensure_storage_dir(void) {}",
      "void xy_install(void) {",
      "  ensure_storage_dir();",
      "  corm_open(0);",
      "}",
    ].join("\n"), "utf-8");

    writeFileSync(join(tmpDir, "mods", "chat", "test_unit.c"), [
      "int main(void) { return 0; }",
    ].join("\n"), "utf-8");

    const codeInst = getCodeInstances({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "mm", "code"),
      persistToCorm: false,
    });
    await codeInst.store.indexProject();

    // Fix 1: Unrelated axil-resume-search memory mentioning "semantic search" must NOT bind to SessionRecallEngine.search
    const unrelatedSearchLore: MemoryEnvelope = {
      level: "L2",
      type: "episode",
      lifecycle: "supported",
      summary: "Episode: Document semantic search comprehensively in docs/SEMANTIC_SEARCH.md and external/axil-resume-search/README.md",
      context: { project: "site", subsystem: "axil-resume-search", path: "docs/SEMANTIC_SEARCH.md" },
    };
    const falseBinding = bindMemoryToCode(codeInst.store, 6015, unrelatedSearchLore);
    assert.strictEqual(falseBinding, null, "Generic prose word 'search' must not bind unrelated axil-resume-search lore to SessionRecallEngine.search");

    // Fix 3: First-Touch Module Dossier for .pi/extensions/pi-mm must exclude test fixture routes
    const dossier = synthesizeFirstTouchModuleDossier(
      codeInst.store,
      "sess-prec-1",
      ".pi/extensions/pi-mm/src/session/recall.ts",
    );
    assert.ok(dossier.includes("[pi-mm First-Touch Module Dossier: .pi/extensions/pi-mm]"));
    assert.ok(!dossier.includes("/song/edit"), "Dossier Key Entry Points must exclude Routes inside tests/");

    // Fix 4: Architecture Overview clusters .pi/extensions/pi-mm distinctly and excludes tests/unit/test_runner.c:main and mods/chat/test_unit.c:main from hotspots & entry points
    const overview = buildCodeArchitectureOverview(codeInst.store);
    assert.ok(overview.modules.some((m) => m.moduleName === ".pi/extensions/pi-mm"), "Overview must cluster .pi/extensions/pi-mm");
    assert.ok(!overview.hotspots.some((h) => h.filePath.startsWith("tests/") || h.name === "main"), "Hotspots must exclude tests/unit/* and main()");
    assert.ok(!overview.entryPointsAndRoutes.some((e) => e.filePath.includes("test_unit.c")), "Entry Points must exclude mods/chat/test_unit.c:main");

    // Mock/test stub definitions of corm_open must NOT appear in Direct Callees of production mods/chat/chat.c:xy_install
    const chatInstall = codeInst.store.getSymbolByQualifiedName("mods/chat/chat.c:xy_install");
    assert.ok(chatInstall, "Should index mods/chat/chat.c:xy_install");
    const calleeFiles = chatInstall.callees.map((ref) => codeInst.store.getSymbolSync(ref)?.filePath ?? "");
    assert.ok(calleeFiles.includes("mods/chat/chat.c"), "Should include production callee ensure_storage_dir");
    assert.ok(!calleeFiles.some((fp) => fp.includes("test_runner.c") || fp.includes("corm_mock.c")), "Production symbol callees must exclude test and mock stubs");

    // Fix 6: Session turn coalescing prefers substantive multi-line assistant synthesis over 1-line [Thinking] tool-loop step
    const sessInst = getSessionInstances("sess-prec-1", { cwd: tmpDir });
    sessInst.tracker.addEntry("e-1");
    await sessInst.store.appendEvent({
      id: "ev-1",
      entryId: "e-1",
      turnIndex: 5,
      timestamp: "2026-11-15T00:00:01Z",
      role: "assistant",
      speaker: "Assistant",
      summary: "[Thinking] Search pi-mm code recall logic",
      text: "[Thinking] Search pi-mm code recall logic",
    });
    sessInst.tracker.addEntry("e-2", "e-1");
    await sessInst.store.appendEvent({
      id: "ev-2",
      entryId: "e-2",
      parentId: "e-1",
      turnIndex: 5,
      timestamp: "2026-11-15T00:00:02Z",
      role: "assistant",
      speaker: "Assistant",
      summary: "Completed architectural synthesis of SessionRecallEngine.search with 6 verified fixes.",
      text: [
        "Completed architectural synthesis of SessionRecallEngine.search with 6 verified fixes.",
        "1. Prevent generic method names from binding across unrelated modules.",
        "2. Filter ephemeral thinking steps from Linked Engineering Lore.",
        "3. Exclude test fixture routes from First-Touch Module Dossier.",
        "4. Separate .pi/extensions/<ext> clusters in overview.",
      ].join("\n"),
    });
    const ovCards = await sessInst.engine.search({ query: "overview", limit: 5 });
    const turn5Card = ovCards.cards.find((c) => c.turnIndex === 5 && c.role === "assistant");
    assert.ok(turn5Card, "Should return coalesced assistant card for turn 5");
    assert.ok(
      turn5Card.summary.includes("Completed architectural synthesis"),
      "Coalesced turn card must pick substantive multi-line synthesis over 1-line [Thinking] step",
    );

    // Fix 5: Combined diagnose + guardrail executes BOTH fault localization and guardrail evaluation
    const rawUnrelatedBytes = encodePayload("2026-11-15", unrelatedSearchLore);
    const fakeEnv: ToolEnv = {
      cwd: tmpDir,
      cfg: { ...DEFAULT_CONFIG, cormBin: "corm", memDir: tmpDir },
      nowProvider: () => new Date("2026-11-15T00:00:00Z"),
      runner: {
        run(inv) {
          if (inv.args.includes("-r")) {
            return Promise.resolve({ code: 0, stdout: "HTOK", stdoutBytes: rawUnrelatedBytes, stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: "6015\t0.910000\tHTOK\n", stderr: "" });
        },
      },
    };
    const recallTool = makeRecallTool(() => Promise.resolve(fakeEnv));
    const ctx = { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-prec-1" };

    const combinedRes = await recallTool.execute(
      "comb-1",
      {
        diagnose: `Error: search failed\n    at search (${recallFile}:2:5)`,
        guardrail: "modify SessionRecallEngine.search in recall.ts",
      },
      undefined,
      undefined,
      ctx,
    );
    const combinedText = combinedRes.content[0]?.text ?? "";
    assert.ok(combinedText.includes("Differential Failure Topology"), "Combined call must include diagnose output");
    assert.ok(combinedText.includes("Counterfactual Guardrail"), "Combined call must also include guardrail evaluation");

    // Fix 1 + Fix 2 verification on symbol read: reading SessionRecallEngine.search must NOT fuse unrelated Ref 6015 or 1-line [Thinking]
    const searchSymRes = await recallTool.execute(
      "sym-search-1",
      { scope: "code", symbol: "SessionRecallEngine.search", file: recallFile },
      undefined,
      undefined,
      ctx,
    );
    const searchSymText = searchSymRes.content[0]?.text ?? "";
    assert.ok(!searchSymText.includes("Ref 6015"), "Unrelated axil-resume-search lore must not fuse onto SessionRecallEngine.search");
    assert.ok(!searchSymText.includes("[Thinking] Search pi-mm"), "1-line [Thinking] step must not leak into Linked Engineering Lore");
    assert.ok(searchSymText.includes("Completed architectural synthesis"), "Substantive 5-line session synthesis should be retained");

    // Part 2 Item 5: Scratch-slot stigmergy coordination across .pi/scratch/slot-2/.pi/mm/code and root .pi/mm/code
    const slot2IndexDir = join(tmpDir, ".pi", "scratch", "slot-2", ".pi", "mm", "code");
    recordSwarmAttentionLease(slot2IndexDir, {
      sessionId: "slot2-worker-sess",
      workspaceLabel: "slot-2",
      filePath: ".pi/extensions/pi-mm/src/session/recall.ts",
      symbolName: "search",
      action: "mutating",
    });
    const rootMatches = querySwarmStigmergy(join(tmpDir, ".pi", "mm", "code"), {
      currentSessionId: "root-sess",
      filePaths: [".pi/extensions/pi-mm/src/session/recall.ts"],
    });
    assert.ok(
      rootMatches.some((m) => m.lease.sessionId === "slot2-worker-sess" && m.lease.workspaceLabel === "slot-2"),
      "Scratch slot-2 lease must be visible in root worktree coordination dir",
    );

    // Part 2 Item 3: Execution-attested test promotion in memory_record
    await observeBashVerificationOutcome("sess-prec-1", {
      toolName: "bash",
      isError: false,
      input: { command: "deno test --allow-all .pi/extensions/pi-mm/tests/" },
      content: [{ type: "text", text: "ok | 40 passed" }],
    });
    const recordTool = makeRecordTool(() => Promise.resolve({
      ...fakeEnv,
      runner: {
        run(inv) {
          if (inv.args.includes("-l")) return Promise.resolve({ code: 0, stdout: "777\n", stderr: "" });
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      },
    }));
    const recOut = await recordTool.execute(
      "rec-1",
      {
        problem: "Fix generic symbol lore binding",
        approaches: [{ approach: "Require file/module corroboration for single-word symbols", outcome: "worked", reason: "Eliminates cross-module false positives" }],
        verification: { testsPassed: ["deno test --allow-all .pi/extensions/pi-mm/tests/"] },
      },
      undefined,
      undefined,
      ctx,
    );
    const recText = recOut.content[0]?.text ?? "";
    assert.ok(recText.includes("execution-attested ✓"), "memory_record must stamp execution-attested ✓ when test passed in session ledger");
  } finally {
    clearCodeInstances();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("superpowers A-D: higher-order route/callback/XY call-graph stitching, context-window staleness radar, evidence DAG truth maintenance cascade, and diff contract/verification flight check", async () => {
  const { checkSessionContextDrift, clearContextSnapshots, formatContextDriftNotice, recordSessionFileSnapshot } = await import("../src/code/context_sync.ts");
  const { detectWorktreeChangesImpact, traceSymbolPath } = await import("../src/code/graph.ts");
  const { formatCodeDiffImpact, formatModuleVerificationSection } = await import("../src/code/manager.ts");
  const { executeLifecycle } = await import("../src/tools/lifecycle.ts");
  const { clearVerificationLedger, evaluateModuleVerificationStatus, observeBashVerificationOutcome, recordFileMutationInLedger } = await import("../src/hooks/verification_ledger.ts");
  const { reinforcementScheduler } = await import("../src/hooks/events.ts");

  clearContextSnapshots();
  clearVerificationLedger();
  clearLoreBindingsCache();
  clearSwarmLeasesCache();
  clearCodeInstances();
  reinforcementScheduler.clearDirectives();

  const tmpDir = await Deno.makeTempDir({ dir: "/var/tmp", prefix: "mm-superpowers-ad-" });
  try {
    await Deno.mkdir(join(tmpDir, "mods", "common"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "mods", "song"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "mods", "chat"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "external", "nd-view", "src"), { recursive: true });

    // 1. Common module with xy_install
    writeFileSync(join(tmpDir, "mods", "common", "common.c"), [
      "void xy_install(void) {}",
    ].join("\n"), "utf-8");

    // 2. Song module with XY_DECL in song.h, #define macro constant, struct initializer callback, and XY_IMPL in song.c
    writeFileSync(join(tmpDir, "mods", "song", "song.h"), [
      "#define song_app_fields song_bud_fields",
      "XY_DECL(int, song_get_by_id, int, song_id);",
    ].join("\n"), "utf-8");

    writeFileSync(join(tmpDir, "mods", "song", "song.c"), [
      '#include "song.h"',
      "static int song_db_lookup(int id) { return id; }",
      "static int song_detail_handler(int fd, char *body) { return fd; }",
      "XY_IMPL(int, song_get_by_id, int, song_id) {",
      "  bud_state_apply(&song_id, song_app_fields);",
      "  return song_db_lookup(song_id);",
      "}",
      "void xy_install(void) {",
      "  standard_item_handlers_t h = { .detail = song_detail_handler };",
      "  register_standard_item_handlers(&h);",
      "}",
    ].join("\n"), "utf-8");

    // 2b. C file with parenthesized #define macros immediately preceding a multi-line C function
    writeFileSync(join(tmpDir, "external", "nd-view", "src", "view.c"), [
      "#define VIEW_PAD_AROUND (VIEW_AROUND + 1)",
      "#define VIEW_PAD_SIZE ((VIEW_PAD_AROUND << 1) + 1)",
      "void",
      "eng_view(unsigned player_ref)",
      "{",
      "  song_get_by_id((int)player_ref);",
      "}",
    ].join("\n"), "utf-8");

    // 3. Chat module registering bare route "/chat", method route "GET:/api/chat/sessions",
    //    passing function pointers, calling xy_load("./mods/song/song"), and calling XY_DECL song_get_by_id
    const chatPath = join(tmpDir, "mods", "chat", "chat.c");
    writeFileSync(chatPath, [
      '#include "../song/song.h"',
      "static void chat_route_handler(void *req) {",
      "  song_get_by_id(1);",
      "}",
      "static void chat_api_sessions_handler(void *req) {}",
      "void xy_install(void) {",
      '  xy_load("./mods/common/common");',
      '  xy_load("./mods/song/song");',
      '  axil_register_handler("/chat", chat_route_handler);',
      '  axil_register_handler("GET:/api/chat/sessions", chat_api_sessions_handler);',
      "}",
    ].join("\n"), "utf-8");

    const store = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "mm", "code"),
      persistToCorm: false,
    });
    await store.indexProject();

    // === Superpower A Verification ===
    // 0) Parenthesized #define macro must NOT swallow the subsequent multi-line C function eng_view
    const padMacros = store.getSymbolsByName("VIEW_PAD_AROUND");
    assert.strictEqual(padMacros.length, 1, "VIEW_PAD_AROUND must only be indexed once as a Macro, never as a Function");
    assert.strictEqual(padMacros[0].kind, "Macro");
    const engViewSym = store.getSymbolByQualifiedName("external/nd-view/src/view.c:eng_view");
    assert.ok(engViewSym && engViewSym.kind === "Function", "eng_view following #define macros must be indexed as a Function");

    // Struct designated-initializer callback (.detail = song_detail_handler) is stitched, while #define macro constant song_app_fields is excluded from callees
    const songInstall = store.getSymbolByQualifiedName("mods/song/song.c:xy_install")!;
    const songDetail = store.getSymbolByQualifiedName("mods/song/song.c:song_detail_handler")!;
    assert.ok(songInstall.callees.includes(songDetail.ref), "Struct initializer .detail = song_detail_handler must be linked as callee");
    const implSymInitial = store.getSymbolByQualifiedName("mods/song/song.c:song_get_by_id")!;
    const implCalleeNames = implSymInitial.callees.map((r) => store.getSymbolSync(r)?.name);
    assert.ok(!implCalleeNames.includes("song_app_fields"), "Non-callable #define macro argument song_app_fields must not pollute callees");

    // 1) Bare route "/chat" is indexed as ALL /chat and wired: xy_install -> ALL /chat -> chat_route_handler -> song_get_by_id
    const bareRoute = store.getSymbolByQualifiedName("mods/chat/chat.c:ALL /chat");
    assert.ok(bareRoute, "Bare route registration axil_register_handler(\"/chat\", ...) must be indexed as ALL /chat");
    const chatHandler = store.getSymbolByQualifiedName("mods/chat/chat.c:chat_route_handler");
    assert.ok(chatHandler, "chat_route_handler must be indexed");
    assert.ok(
      chatHandler.callers.length >= 1,
      "Function-pointer route handler chat_route_handler must have inbound callers (no longer 0 callers)",
    );

    // 2) Full inbound trace from song_db_lookup reaches chat_route_handler and xy_install!
    const traceLookup = traceSymbolPath(store, "song_db_lookup", { direction: "inbound", depth: 5 });
    assert.strictEqual(traceLookup.status, "ok");
    const collectTraceNames = (node?: import("../src/code/types.ts").CodeTraceNode): string[] => {
      if (!node) return [];
      return [node.qualifiedName, ...node.children.flatMap(collectTraceNames)];
    };
    const inboundNames = collectTraceNames(traceLookup.inboundTree);
    assert.ok(inboundNames.includes("mods/song/song.c:song_get_by_id"), "Inbound trace must reach XY_IMPL song_get_by_id");
    assert.ok(inboundNames.includes("mods/chat/chat.c:chat_route_handler"), "Inbound trace must reach cross-module caller chat_route_handler");
    assert.ok(inboundNames.includes("mods/chat/chat.c:xy_install"), "Inbound trace must reach enclosing registration entry xy_install");

    // 3) XY_DECL <-> XY_IMPL stitching: tracing XY_DECL outbound reaches XY_IMPL and song_db_lookup
    const declSym = store.getSymbolByQualifiedName("mods/song/song.h:song_get_by_id");
    const implSym = store.getSymbolByQualifiedName("mods/song/song.c:song_get_by_id");
    assert.ok(declSym && implSym, "Both XY_DECL and XY_IMPL must exist");
    assert.ok(declSym.callees.includes(implSym.ref), "XY_DECL must have a stitched call edge to XY_IMPL");

    // 4) xy_load stitching: mods/chat/chat.c:xy_install calls mods/common/common.c:xy_install
    const chatInstall = store.getSymbolByQualifiedName("mods/chat/chat.c:xy_install")!;
    const commonInstall = store.getSymbolByQualifiedName("mods/common/common.c:xy_install")!;
    assert.ok(chatInstall.callees.includes(commonInstall.ref), "xy_install must link to xy_load target module's xy_install");

    // === Superpower B Verification: Context-Window Staleness Radar ===
    const snap = recordSessionFileSnapshot(store, "sess-radar-1", "mods/chat/chat.c");
    assert.ok(snap, "Should record session file snapshot on read/recall");

    // No external change yet -> 0 drift reports
    const noDrift = await checkSessionContextDrift(store, "sess-radar-1");
    assert.strictEqual(noDrift.length, 0, "Unmodified file must not trigger context drift");

    // Simulate external edit on disk (e.g. operator or background slot adds lines and modifies chat_api_sessions_handler)
    writeFileSync(chatPath, [
      '#include "../song/song.h"',
      "// Operator added header comment line 1",
      "// Operator added header comment line 2",
      "static void chat_route_handler(void *req) {",
      "  song_get_by_id(1);",
      "}",
      "static void chat_api_sessions_handler(void *req) {",
      "  song_get_by_id(42);",
      "}",
      "static void operator_new_helper(void) {}",
      "void xy_install(void) {",
      '  xy_load("./mods/common/common");',
      '  xy_load("./mods/song/song");',
      '  axil_register_handler("/chat", chat_route_handler);',
      '  axil_register_handler("GET:/api/chat/sessions", chat_api_sessions_handler);',
      "}",
    ].join("\n"), "utf-8");

    const driftReports = await checkSessionContextDrift(store, "sess-radar-1");
    assert.strictEqual(driftReports.length, 1, "External modification must be detected");
    const driftNotice = formatContextDriftNotice(driftReports);
    assert.ok(driftNotice.includes("Working-Memory Sync"), "Should format Working-Memory Sync header");
    assert.ok(driftNotice.includes("chat_route_handler (lines shifted"), "Should report shifted lines for chat_route_handler");
    assert.ok(driftNotice.includes("chat_api_sessions_handler (modified"), "Should report modified body/callees for chat_api_sessions_handler");
    assert.ok(driftNotice.includes("operator_new_helper (added"), "Should report newly added symbol operator_new_helper");

    // Subsequent check without further disk change must return empty (alert once per external edit)
    const repeatDrift = await checkSessionContextDrift(store, "sess-radar-1");
    assert.strictEqual(repeatDrift.length, 0, "Updated snapshot must not re-alert without new disk changes");

    // === Superpower C Verification: Epistemic Truth Maintenance Cascade ===
    const memDb = new Map<number, Uint8Array>();
    const ref100: MemoryEnvelope = {
      level: "L1",
      type: "episode",
      lifecycle: "supported",
      summary: "Empirical finding: song_get_by_id caches results in static buffer",
      context: { project: "site", subsystem: "song", path: "mods/song/song.c" },
    };
    const ref200: MemoryEnvelope = {
      level: "L2",
      type: "invariant",
      lifecycle: "supported",
      standing: true,
      summary: "Invariant: Never free pointer returned by song_get_by_id",
      evidence: [100],
      context: { project: "site", subsystem: "song", path: "mods/song/song.c" },
    };
    memDb.set(100, encodePayload("2026-11-15", ref100));
    memDb.set(200, encodePayload("2026-11-15", ref200));

    bindMemoryToCode(store, 200, ref200, { explicitSymbols: ["song_get_by_id"], explicitFile: "mods/song/song.c" });
    reinforcementScheduler.registerDirective({ ref: 200, summary: ref200.summary, subsystem: "song", project: "site" });
    assert.strictEqual(reinforcementScheduler.getDirectives().length, 1);

    const fakeEnv: ToolEnv = {
      cwd: tmpDir,
      cfg: { ...DEFAULT_CONFIG, cormBin: "corm", memDir: tmpDir },
      nowProvider: () => new Date("2026-11-15T12:00:00Z"),
      runner: {
        run(inv) {
          if (inv.args.includes("-g") && inv.args.includes(".")) {
            return Promise.resolve({ code: 0, stdout: Array.from(memDb.keys()).join("\n") + "\n", stderr: "" });
          }
          if (inv.args.includes("-r") && inv.args.includes("-g")) {
            const gIdx = inv.args.indexOf("-g");
            const r = gIdx >= 0 ? Number(inv.args[gIdx + 1]) : -1;
            const bytes = memDb.get(r);
            if (!bytes) return Promise.resolve({ code: 1, stdout: "", stderr: "not found" });
            return Promise.resolve({ code: 0, stdout: "HTOK", stdoutBytes: bytes, stderr: "" });
          }
          if (inv.args.includes("-p")) {
            const r = inv.ref ?? -1;
            if (inv.payloadBytes) {
              memDb.set(r, inv.payloadBytes);
            }
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
      },
    };

    const lcRes = await executeLifecycle(
      () => Promise.resolve(fakeEnv),
      { ref: 100, lifecycle: "contradicted", reason: "song_get_by_id allocates fresh struct per call" },
      { cwd: tmpDir, hasUI: false, mode: "agent", sessionId: "sess-tm-1" },
    );
    const lcDetails = lcRes.details as { cascadedRefs?: number[] } | undefined;
    assert.deepStrictEqual(lcDetails?.cascadedRefs, [200], "Contradicting Ref 100 must cascade and downgrade dependent Ref 200");

    const { decodeResult } = await import("../src/payload.ts");
    const updated200 = decodeResult({ stdout: "HTOK", stdoutBytes: memDb.get(200)! });
    assert.strictEqual(updated200.envelope.lifecycle, "hypothesized", "Dependent Ref 200 must be downgraded to hypothesized");
    assert.strictEqual(reinforcementScheduler.getDirectives().length, 0, "Downgraded directive Ref 200 must be removed from active standing directives");

    // === Superpower D Verification: XY Contract Mismatch + Per-Module Verification Gate Status in diff: true ===
    // Modify XY_IMPL signature in mods/song/song.c without updating XY_DECL in mods/song/song.h
    writeFileSync(join(tmpDir, "mods", "song", "song.c"), [
      '#include "song.h"',
      "static int song_db_lookup(int id) { return id; }",
      "XY_IMPL(int, song_get_by_id, int, song_id, int, flags) {",
      "  return song_db_lookup(song_id + flags);",
      "}",
      "void xy_install(void) {}",
    ].join("\n"), "utf-8");
    await store.refreshFile("mods/song/song.c");

    const diffText = [
      "diff --git a/mods/song/song.c b/mods/song/song.c",
      "--- a/mods/song/song.c",
      "+++ b/mods/song/song.c",
      "@@ -3,3 +3,3 @@",
    ].join("\n");

    const impact = await detectWorktreeChangesImpact(store, diffText, 2);
    assert.ok(impact.contractMismatches && impact.contractMismatches.length === 1, "Should detect XY_DECL != XY_IMPL signature mismatch");
    assert.strictEqual(impact.contractMismatches![0].symbolName, "song_get_by_id");
    assert.strictEqual(impact.contractMismatches![0].reason, "signature_mismatch");

    const renderedDiff = formatCodeDiffImpact(impact);
    assert.ok(renderedDiff.includes("[XY Signature Mismatch] song_get_by_id"), "Diff impact output must highlight XY signature mismatch");

    // Check module verification status before and after running Tier-0 gate (including external/nd-view)
    recordFileMutationInLedger("sess-ver-gate", "mods/song/song.c", 1000);
    const statusBefore = evaluateModuleVerificationStatus("sess-ver-gate", ["mods/song/song.c", "external/nd-view/src/view.c"]);
    assert.strictEqual(statusBefore.length, 2, "Both mods/song and external/nd-view must have Tier-0 verification gates");
    assert.strictEqual(statusBefore[0].status, "unverified_since_edit");
    assert.strictEqual(statusBefore[1].moduleKey, "external/nd-view");
    assert.strictEqual(statusBefore[1].requiredCommand, "make standalone-unit-tests");
    assert.ok(formatModuleVerificationSection(statusBefore).includes("[UNVERIFIED SINCE LAST EDIT ⚠️] mods/song"));

    await observeBashVerificationOutcome("sess-ver-gate", {
      toolName: "bash",
      isError: false,
      input: { command: "make -C mods/song && make test-mod MOD=song" },
      content: [{ type: "text", text: "PASS" }],
    });
    const statusAfter = evaluateModuleVerificationStatus("sess-ver-gate", ["mods/song/song.c"]);
    assert.strictEqual(statusAfter[0].status, "verified");
    assert.ok(formatModuleVerificationSection(statusAfter).includes("[VERIFIED ✓ after last edit] mods/song"));
  } finally {
    clearCodeInstances();
    clearContextSnapshots();
    clearVerificationLedger();
    reinforcementScheduler.clearDirectives();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});



