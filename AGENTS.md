# AGENTS.md — pi-mm package guidelines

`pi-mm` is the Memory Mipmaps extension for the Pi Coding Agent harness: five tools (`memory_scan/think/store/forget/reset`) + a skill over the phase-2 `qmap` CLI surface (`CLI-SURFACE-EXAMPLES.md` §8, `PHASE-2-CLI.md`). Storage is local qmap files under `ctx.cwd/.pi/mm/`; degradation never errors.

## Location & loading

The package lives at `.pi/extensions/pi-mm/` and loads via pi's project-local auto-discovery (`*/index.ts`). No build step: pi loads the TypeScript directly. `/reload` picks up changes. Every pi session runs this extension from the skeleton onward — **every commit must leave it loadable-and-graceful** (resilience rule): handlers never throw on missing state, no imports of not-yet-existing modules, config failures degrade.

## Architecture

- **Shallow shell over qmap.** `src/qmap.ts` owns invocation building (byte-pinned to §8) and the `QmapRunner` boundary (`ShellQmapRunner` over `pi.exec` with `QMAP_AXIS_PATH` + `cwd=memDir`). Tools import builders + the window/resolve helpers; nothing imports `qmap` internals from the kernel.
- **Config via `src/config.ts`.** `DEFAULT_CONFIG` + `loadConfig(raw)` + `applyEnv(env)` + `resolveQmapBin(cwd, pathDirs, probe)` + `resolveAxisPath(cwd)` + `sepalConfigured(cfg)` + `readMmConfig(cwd, env)` mirror `pi-quest/src/config.ts` shape; tested first, implemented first. Precedence: `settings.json "pi-mm"` → `QMAP_BIN`/`QMAP_AXIS_PATH`/`QMAP_SEPAL_EMBED_*` env → `PATH` → in-site `external/libqmap/bin/qmap`. When sepal is configured the tools use the `mem.db@joint,stoma,sepal:a:s` filespec (sepal must never enter the roster unconfigured — its EINVAL rejects the whole `-p`).
- **Pure helpers.** `src/window.ts` (level→`{a,b}|null`, always bounded per F2 — no bare `a` leaf), `src/resolve.ts` (bare-ref parse + `-1` sentinel skip + `nextRef=max+1`), `src/qmap.ts` (`scanExpr`, `embedEnv`, `parseResultLines`, `payloadDate`). All pure functions, testable without fakes.
- **Query-time semantic recall — bare names in `-X`, ALL params ride flags.** `-X` is pure structure: `memory_scan` emits bare `joint`/`stoma`/`sepal` names (AND-joined). Params ride plugin-declared flags: `--field=text --matched=1` (stoma), `--since/--until` when a time window applies (joint), `--query=<topic>` (broadcast to stoma + sepal, the only two axes declaring `query`), and `--min-sim=0.2` when sepal is configured (libsepal embeds server-side at decode — `m` omitted, the library default clamps to the store size and the CLI `-t` caps output; a per-embed on-disk cache under the store dir avoids repeat HTTP; no curl, no temp files, no `ToolEnv.exec`). Without sepal, only `--field=text --matched=1 --query=<topic>` ride (stoma text). Else the soft `unconfigured` fallback. An unreachable endpoint fails the query loud (exit 1), never silent-empty.
- **Tools.** `src/tools/` — one file per tool + `index.ts` (`ToolEnv`, `give`, `defaultEnvSource`, `installTools`). Each factory is `(EnvSource) => PiToolSpec`; tests inject a fake `ToolEnv` via `give`, real installs use `defaultEnvSource(pi)` (reads config, builds `ShellQmapRunner`). Tools stub `qmap` in unit tests by contract (never shell out in `deno test`); real-qmap coverage is `scripts/integration-mm.sh` (incl. the gated embed smoke: python3 one-shot mock restarted per embed call + `struct.pack` LE float32 vectors — note POSIX sh `printf` has no portable `\xHH`) + the manual Pi-recall gate.
- **Degradation never error.** Empty inputs, no matches, missing binary, or nonzero exits yield `{content:[text], details:{error,…}}` — never a throw.

## Layout

```
src/
  hooks/events.ts   minimal Pi types (command+args+{cwd,env} exec)
  config.ts
  window.ts  resolve.ts  qmap.ts
  tools/{index,store,scan,think,forget,reset}.ts
tests/              fake-qmap + config/window/resolve/args/embed/tools + smoke
skills/pi-mm/SKILL.md
scripts/zip_bundle.ts  check-complexity.ts  integration-mm.sh
```

Single-use stays single-use; shared stays shared (golden rule).

## Budgets & verification

```bash
deno test --allow-all --sloppy-imports --node-modules-dir=none tests/
deno lint src/ tests/
deno run --allow-all scripts/check-complexity.ts
npm --prefix .pi/extensions/pi-mm run zip
sh scripts/integration-mm.sh
```

File <350 LOC, function <80 LOC. Tests mirror `src/`; bulk is pure. No `/usr` installs; real-qmap coverage uses fresh in-site `external/libqmap/bin/qmap` + sibling `libjoint`/`libstoma` (+ `libsepal` in the gated embed smoke).
