# AGENTS.md — pi-mm package guidelines

`pi-mm` is the Unified Memory Mipmaps extension for the Pi Coding Agent harness: three primary model-facing tools (`memory_recall`, `memory_record`, `memory_review`; plus 9 optional administrative tools via `"advancedTools": true`) + a skill over the `libcorm` multi-axis C recall kernel (`joint` temporal, `lemma` lexical FTS, `sepal` semantic ANN, `islet` 2D spatial/interval spans). Storage lives under `ctx.cwd/.pi/mm/` across three unified scopes:
- `scope: "persistent"` (`.pi/mm/mem.db`): cross-session L0–L3 episodic lore, architectural invariants, and standing directives.
- `scope: "session"` (`.pi/mm/sessions/<sessionId>/session.db`): ephemeral multi-granularity turn/block/symbol index, active branch lineage DAG, progressive 3-tier recall, and mipmap-driven context compaction (`session_before_compact`).
- `scope: "code"` (`.pi/mm/code/code.db` + `code-islet.db`): live codebase symbol graph, zero-regex structural scanner (C/C++, TS/JS, Python), library-agnostic route detection, call-graph traversal, `libislet` git diff blast radius, and automatic lore fusion.

Degradation never errors.

## Location & loading

The package lives at `.pi/extensions/pi-mm/` and loads via pi's project-local auto-discovery (`*/index.ts`). No build step: pi loads the TypeScript directly. `/reload` picks up changes. Every pi session runs this extension — **every commit must leave it loadable-and-graceful** (resilience rule): handlers never throw on missing state, no imports of not-yet-existing modules, config failures degrade.

## Architecture

- **Shallow shell over corm & cormd.** `src/corm.ts` and `src/daemon.ts` own invocation building and the `CormRunner` boundary (`DaemonCormRunner` over `cormd.sock` and `ShellCormRunner` over `pi.exec` with `CORM_AXIS_PATH` + `cwd=memDir`). Tools import builders + the window/resolve helpers; nothing imports `corm` internals from the kernel.
- **Config via `src/config.ts`.** `DEFAULT_CONFIG` + `loadConfig(raw)` + `applyEnv(env)` + `resolveCormBin(cwd, pathDirs, probe)` + `resolveAxisPath(cwd)` + `sepalConfigured(cfg)` + `readMmConfig(cwd, env)`. Precedence: `settings.json "pi-mm"` → `CORM_BIN`/`CORM_AXIS_PATH`/`CORM_SEPAL_EMBED_*` env → `PATH` → in-site `external/libcorm/bin/corm`. When sepal is configured the tools use the `*.db@joint,lemma,sepal:a:s` filespec.
- **Pure helpers.** `src/window.ts`, `src/resolve.ts`, `src/corm.ts`, `src/payload.ts` (HTOK v4 binary codec). All pure functions, testable without fakes.
- **Codebase Mipmap Graph (`src/code/`).** `lexer.ts` and `scanner.ts` implement a zero-regex character-stream structural scanner for C/C++, TS/JS, and Python (extracting functions, `XY_IMPL` vs `XY_DECL`, methods, classes, structs, interfaces, enums, macros, type aliases, library-agnostic HTTP routes, and imports). `store.ts` manages incremental `mtime` indexing into `code.db` (`joint,lemma,sepal`) and `code-islet.db` (`libislet` 2D `[fileHash, startLine..endLine]` intervals) with priority root scanning and single-flight `refreshLock` serialization. `graph.ts` and `recall.ts` provide fail-closed symbol reading, language/module-isolated call-graph traversal, L3/L2 architecture overviews, `git diff` blast-radius analysis, and automatic fusion of linked `pi-mm` persistent lore (`manager.ts`).
- **Ephemeral Session Memory (`src/session/`).** `sink.ts` and `store.ts` ingest turns at 3 granularities (`turn` L1, `block` L1, `symbol` L0) serialized behind `withWriteLock`. `lineage.ts` tracks active branch ancestry across session forks/reloads. `recall.ts` delivers progressive 3-tier retrieval (Index Card $\rightarrow$ Focused Excerpt $\rightarrow$ Exact Line Slice), and `compaction.ts` synthesizes L2/L1 session mipmaps on `session_before_compact`.
- **Tools.** `src/tools/` — primary tools (`recall.ts`, `record.ts`, `review.ts`) + advanced tools (`store.ts`, `scan.ts`, `think.ts`, `forget.ts`, `reset.ts`, `consolidate.ts`, `traverse.ts`, `lifecycle.ts`, `feedback.ts`) + `index.ts` (`ToolEnv`, `give`, `defaultEnvSource`, `installTools`).
- **Degradation never error.** Empty inputs, no matches, missing binary, or nonzero exits yield `{content:[text], details:{error,…}}` — never a throw.

## Layout

```
src/
  hooks/{events,auto_recall,reinforcement,wondering}.ts
  code/{types,lexer,scanner,payload_codec,store,graph,recall,manager}.ts
  session/{types,payload_codec,store,sink,lineage,recall,compaction,manager}.ts
  judge/{circuit,embed,nearest,*-exemplars}.ts
  synth/adapter.ts
  config.ts  window.ts  resolve.ts  corm.ts  daemon.ts  payload.ts
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
