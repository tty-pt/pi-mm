# AGENTS.md — pi-mm package guidelines

`pi-mm` is the Unified Memory Mipmaps extension for the Pi Coding Agent harness: three primary model-facing tools (`memory_recall`, `memory_record`, `memory_review`; plus 9 optional administrative tools via `"advancedTools": true`) + a skill over the `libcorm` multi-axis C recall kernel (`joint` temporal, `lemma` lexical FTS, `sepal` semantic ANN, `islet` 2D spatial/interval spans). Storage lives under `ctx.cwd/.pi/mm/` across three unified scopes:
- `scope: "persistent"` (`.pi/mm/mem.db`): cross-session L0–L3 episodic lore, architectural invariants, standing directives, verification-attested causal fixes, and Evidence DAG truth maintenance.
- `scope: "session"` (`.pi/mm/sessions/<sessionId>/session.db`): ephemeral multi-granularity turn/block/symbol index, active branch lineage DAG, explicit session provenance boundaries (`session: "current" | "parallel" | "all" | "<id>" | "<slot>"`), progressive 3-tier recall, and mipmap-driven context compaction (`session_before_compact`).
- `scope: "code"` (`.pi/mm/code/code.db` + `code-islet.db` + `lore-bindings.json` + `swarm-leases.json`): live codebase symbol graph, zero-regex structural scanner (C/C++, TS/JS, Python), higher-order callback/initializer/`xy_load` stitching, library-agnostic route detection, call-graph traversal, `libislet` git diff blast radius & Tier-0 verification gates, stack-trace fault localization (`diagnose`), counterfactual guardrails (`guardrail`), context-window staleness radar, first-touch module dossiers, swarm stigmergy, and AST-bound lore fusion.

Degradation never errors.

## Location & loading

The package lives at `.pi/extensions/pi-mm/` and loads via pi's project-local auto-discovery (`*/index.ts`). No build step: pi loads the TypeScript directly. `/reload` picks up changes. Every pi session runs this extension — **every commit must leave it loadable-and-graceful** (resilience rule): handlers never throw on missing state, no imports of not-yet-existing modules, config failures degrade.

## Architecture

- **Shallow shell over corm, cormd, and in-process N-API.** `src/corm.ts`, `src/napi_runner.ts`, and `src/daemon.ts` own invocation building and the `CormRunner` boundary (`NativeAddonCormRunner` over `@tty-pt/corm` `corm_node.node` in-process, `DaemonCormRunner` over `cormd.sock`, and `ShellCormRunner` over `pi.exec` with `CORM_AXIS_PATH` + `cwd=memDir`). Tools import builders + the window/resolve helpers; nothing imports `corm` internals from the kernel.
- **Config via `src/config.ts`.** `DEFAULT_CONFIG` + `loadConfig(raw)` + `applyEnv(env)` + `resolveCormBin(cwd, pathDirs, probe)` + `resolveAxisPath(cwd)` + `sepalConfigured(cfg)` + `readMmConfig(cwd, env)`. Precedence: `settings.json "pi-mm"` → `CORM_BIN`/`CORM_AXIS_PATH`/`CORM_SEPAL_EMBED_*` env → `node_modules/@tty-pt/*/prebuilds/<os>-<cpu>[-musl]` → `PATH` → in-site `external/libcorm/bin/corm`. When sepal is configured the tools use the `*.db@joint,lemma,sepal:a:s` filespec.
- **Pure helpers.** `src/window.ts`, `src/resolve.ts`, `src/corm.ts`, `src/payload.ts` (HTOK v4 binary codec). All pure functions, testable without fakes.
- **Codebase Mipmap Graph & Epistemic Tooling (`src/code/`).** `lexer.ts` and `scanner.ts` implement a zero-regex character-stream structural scanner for C/C++, TS/JS, and Python (extracting functions, `XY_IMPL` vs `XY_DECL`, methods, classes, structs, interfaces, enums, macros, type aliases, library-agnostic HTTP routes, higher-order callback args, struct designated-initializer callbacks, and `#include`/`import`/`xy_load` dependencies). `store.ts` manages incremental `mtime` indexing into `code.db` (`joint,lemma,sepal`) and `code-islet.db` (`libislet` 2D `[fileHash, startLine..endLine]` intervals) with priority root scanning, vendor submodule exclusion, and single-flight `refreshLock` serialization. `graph.ts` and `recall.ts` provide fail-closed symbol reading, language/module-isolated call-graph traversal, L3/L2 architecture overviews, and `git diff` blast-radius analysis. `diagnose.ts` parses stack traces and compiler diagnostics to compute Causal Fault Intersections against `git diff`. `lore_binding.ts` binds persistent lore to AST symbol fingerprints and flags `stale_suspect` drift. `context_sync.ts` tracks per-session file/symbol snapshots and alerts on external disk modifications. `dossier.ts` synthesizes first-touch module dossiers, cross-boundary pairs (`XY_DECL` $\leftrightarrow$ `XY_IMPL`, Server C $\leftrightarrow$ UX WASM), and Tier-0 verification gates. `stigmergy.ts` coordinates live spatial attention leases across parallel sessions and `.pi/scratch/slot-*` worktrees.
- **Ephemeral Session Memory (`src/session/`).** `sink.ts` and `store.ts` ingest turns at 3 granularities (`turn` L1, `block` L1, `symbol` L0) serialized behind `withWriteLock`. `lineage.ts` tracks active branch ancestry across session forks/reloads. `recall.ts` delivers progressive 3-tier retrieval (Index Card $\rightarrow$ Focused Excerpt $\rightarrow$ Exact Line Slice) with explicit session provenance boundaries (`[Current Session]`, `[Parallel Session]`, `[Past Session]`), and `compaction.ts` synthesizes L2/L1 session mipmaps on `session_before_compact`.
- **Hooks & Guardrails (`src/hooks/`).** `events.ts` wires Pi lifecycle events, turn coalescing, and status bar updates. `guardrails.ts` intercepts planned or failed actions against contradicted memories, failed approaches, standing restrictions, and stale invariants. `verification_ledger.ts` tracks `FAIL -> PASS` test/build transitions to synthesize attested L2 causal fix memories and report Tier-0 diff verification status.
- **Tools.** `src/tools/` — primary tools (`recall.ts`, `record.ts`, `review.ts`) + advanced tools (`store.ts`, `scan.ts`, `think.ts`, `forget.ts`, `reset.ts`, `consolidate.ts`, `traverse.ts`, `lifecycle.ts`, `feedback.ts`) + `index.ts` (`ToolEnv`, `give`, `defaultEnvSource`, `installTools`).
- **Degradation never error.** Empty inputs, no matches, missing binary, or nonzero exits yield `{content:[text], details:{error,…}}` — never a throw.

## Layout

```
src/
  hooks/{events,auto_recall,reinforcement,wondering,guardrails,verification_ledger}.ts
  code/{types,lexer,scanner,payload_codec,store,graph,recall,manager,diagnose,lore_binding,stigmergy,dossier,context_sync}.ts
  session/{types,payload_codec,store,sink,lineage,recall,compaction,manager}.ts
  judge/{circuit,embed,nearest,*-exemplars}.ts
  synth/adapter.ts
  config.ts  window.ts  resolve.ts  corm.ts  napi_runner.ts  daemon.ts  payload.ts  versions.ts
  tools/{index,recall,record,review,store,scan,think,forget,reset,consolidate,traverse,lifecycle,feedback,overview,ranking}.ts
tests/              hermetic unit + integration suites
skills/pi-mm/SKILL.md
scripts/zip_bundle.ts  check-complexity.ts  integration-mm.sh
```

Single-use stays single-use; shared stays shared (golden rule).

## Budgets & verification

```bash
npm --prefix .pi/extensions/pi-mm test
npm --prefix .pi/extensions/pi-mm run lint
deno run --no-check --allow-all scripts/check-complexity.ts
npm --prefix .pi/extensions/pi-mm run zip
sh scripts/integration-mm.sh
```

Default budgets: file <350 LOC, function <80 LOC (with explicit subsystem ceilings in `scripts/check-complexity.ts`). Tests mirror `src/`; `npm test` preloads `tests/no-live-network.ts` for hermetic execution.
