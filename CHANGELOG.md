# Changelog

All notable changes to the `@tty-pt/pi-mm` package will be documented in this file.

## [0.4.0] - 2026-10-27

### Added
- **Zero-Configuration `axil-auren` Inference Server Bring-Up (`src/auren-bootstrap.ts`, `src/auren.ts`)**:
  - Automatically provisions local inference configuration at `~/.config/auren/config.json` if absent, mapping detected models and capabilities without requiring manual setup.
  - Automatically manages background daemon startup on port 4242 with socket/HTTP readiness polling and process lifecycle management.
- **Intelligent Model Provisioning & Tiered Consent (`~/.models/`)**:
  - Supports automatic discovery and downloading of local models (`bge-base`, `bge-small`, `qwen2.5-0.5b`, `olmoe`) with cryptographic `sha256` verification, resumable range downloads, and atomic file swaps.
  - Tiered consent: light models download seamlessly, while large MoE models (`olmoe`, 3.3 GB) prompt interactively via `ctx.ui.confirm()` to respect user bandwidth and disk budget.
- **Proactive C Engine Dependency Tracking on `session_start` (`src/versions.ts`, `src/hooks/events.ts`)**:
  - Pure TypeScript SemVer parser and engine detector inspecting system packages (`pkgconfig`), source repositories (`external/`), and git tags for `axil`, `libcorm`, `libsepal`, `liblemma`, `libjoint`, and `axil-auren`.
  - Automatically alerts users on `session_start` with concise TUI remediation toasts if any required engine is missing or outdated, eliminating the need to manually invoke `/mm doctor`.
- **Integrated C Engine Diagnostics in `/mm doctor` (`src/index.ts`)**:
  - Displays full matrix of core C engines, installed versions, required thresholds, and exact copy-paste remediation commands for package managers and source compilation.
- **Turnkey Verification Playbook (`scripts/test-bootstrap-playbook.sh`, `npm run test:playbook`)**:
  - Comprehensive, non-destructive test suite validating daemon recovery, zero-config file generation, model consent dialogues, and proactive dependency warning toasts.
- **Standing Directives & Context Reinforcement (`src/hooks/reinforcement.ts`, `src/hooks/events.ts`)**:
  - Automatic detection of standing rules, operational directives, and project invariants (`isStandingDirective()`, `/mm rule <directive>`).
  - Periodic context milestone re-anchoring (e.g. at 33% and 66% context capacity) and post-compaction re-injection into `systemPromptOptions.sections.standing_directives`.
  - Subsystem-aware directive routing with strict token budget capping.

## [0.3.5]

### Fixed
- **Doctor Diagnostic Accuracy & Architecture Clarity (`src/index.ts`)**:
  - Replaced misleading `Axis Sepal (Vectors): In-Memory (Ephemeral, zero disk bytes)` with `In-Memory (Ephemeral index)` and labeled `Sepal Embeddings Cache` as an L2 disk cache to resolve user confusion between in-memory vector index and on-disk embedding cache.
  - Replaced confusing `Axis Roster: Persistent Disk (0.0 KB)` line with `Bound Axes (mem.db.roster): joint, lemma, sepal` parsing active bound axes from the database header.

## [0.3.4]

### Fixed
- **Doctor Diagnostic Accuracy (`src/index.ts`)**:
  - Fixed `/mm doctor` / `/mm status` Total Indexed Records counting by querying `corm list` (via resident `cormd` socket or CLI runner) instead of attempting to parse the binary `mem.db.roster` file as raw text lines.
  - Aligns `/mm doctor` record reporting with `/mm overview` and `/mm timeline`.
- **Roster Diagnostic Reporting (`src/index.ts`)**:
  - Added explicit persistent disk size reporting for `mem.db.roster` under secondary axes.
- **Complexity Compliance (`src/index.ts`)**:
  - Modularized TUI reporting logic into `runOverviewReport` and `runDoctorReport` to satisfy strict function complexity ceilings.
- **Documentation & Installation Guidance (`README.md`)**:
  - Separated core axis package installation (`libcorm`, `libjoint`, `liblemma`, `libsepal`, `axil`) from optional `axil-auren` daemon.
  - Documented `universe` repository prerequisite for `axil-auren` on Debian/Ubuntu.
  - Documented `libjoint` v1.6.1 fix resolving `/usr/bin/test` packaging collision.

## [0.3.3]

<p align="center">
  <img src="https://raw.githubusercontent.com/tty-pt/pi-mm/main/cover.png" alt="pi-mm cover banner" width="100%">
</p>

### Added
- **All-Time Timeline Overview & Multi-Resolution Recall (`src/tools/overview.ts`, `src/tools/recall.ts`)**:
  - Added `overview` flag to `memory_recall` to synthesize a structured high-level summary of active operational principles (L3), invariants (L2), task investigations (L1), and chronological epochs across all time.
  - Added direct `zoomRef` drill-down in `memory_recall` to retrieve full vertical context: problem statements, attempted approaches (worked/failed/abandoned), diffs, findings, and complete upward/downward evidence lineage trees.
  - Added slash commands `/mm overview` and `/mm timeline` with rich TUI report formatting.
  - Automated proactive overview context injection in `before_agent_start` when users pose open-ended introspection questions (*"What do you remember?"*).

### Changed
- **Modularized Architecture & Complexity Ceilings (`src/tools/overview_render.ts`, `scripts/check-complexity.ts`)**:
  - Extracted overview markdown rendering into pure helper module `overview_render.ts`.
  - Refactored `executeRecall` into compact sub-handlers (`executeOverviewRecall`, `executeTargetedHybridRecall`).
  - Added subsystem baseline complexity ceilings in `check-complexity.ts` while enforcing strict LOC limits on new modules.

### Fixed
- **Static Analysis & Lint Cleanliness (`src/associative.ts`, `tests/payload.test.ts`, `tests/hybrid.test.ts`)**:
  - Resolved all 10 `deno lint` errors (require-await in `recordAssociations` and `replay_session.ts`; unused imports/variables in `payload.test.ts`, `hybrid.test.ts`, and `cognitive_memory.test.ts`).
  - 93 files checked with 0 warnings and 0 errors.
- **Native Benchmark Streaming (`scripts/benchmark-mm.ts`)**:
  - Fixed binary payload streaming over stdin in native C benchmark runner (`-p <ref>:-`).
  - Fixed payload stringification in synthetic benchmark ranking.

## [0.3.2]

### Added
- **Decoupled Socket Runtime Path & DrvFs Auto-Fallback (`src/config.ts`, `src/tools/index.ts`)**:
  - Added `socketPath` and `runtimeDir` configuration keys, with `PI_MM_SOCKET` and `PI_MM_RUNTIME_DIR` environment variable overrides.
  - Added automatic detection and routing of `cormd.sock` to `$XDG_RUNTIME_DIR/pi-mm/cormd-<hash>.sock` or `/tmp/pi-mm/cormd-<hash>.sock` when `memDir` is located on non-POSIX socket filesystems (such as WSL Windows mounts under `/mnt/*` / DrvFs).
  - Cleanly separates ephemeral host IPC endpoints from persistent repository data (`mem.db`, vector indexes, crash journals).

### Changed
- **System-Wide Axis Library Resolution (`src/config.ts`)**:
  - `resolveAxisPath()` now detects and defaults to system-installed CORM axis libraries (`/usr/lib`, `/usr/local/lib`, `/usr/lib/ttypt`, `/lib`, `/usr/lib64`) when monorepo submodules (`<cwd>/external/lib*`) are not present.
  - Allows `pi-mm` to run out-of-the-box in standalone repositories without triggering `cormd: unknown axis 'joint'/'lemma'/'sepal'`.
  - Preserves local monorepo checkout priority when `external/libjoint/lib` exists on disk.

### Fixed
- **Global Settings Fallback (`src/config.ts`)**:
  - `readMmConfig()` and `resolveAdvancedTools()` now check global settings candidates (`PI_SETTINGS_PATH`, `${PI_CODING_AGENT_DIR}/settings.json`, `~/.pi/agent/settings.json`, and `~/.pi/settings.json`) when `<cwd>/.pi/settings.json` is missing or does not configure `pi-mm`.
  - Project-level settings continue to override global settings field-by-field.
  - Added support for `"mm"` key alongside `"pi-mm"`.
  - Updated database compaction script (`scripts/compact_db.ts`) to use `readMmConfig()`.

## [0.3.1]

### Added
- **Latent Human-Like Mipmap Recall & LOD Gating (`src/hooks/auto_recall.ts`)**:
  - Gated proactive context injection on conversational turns: unprompted conversational and task prompts lacking subsystem mentions yield zero context injection.
  - Proactive priming on technical turns strictly bounded to L2 subsystem invariants and active hypotheses matching mentioned subsystems.
  - Episodic memories (L1) remain latent, surfacing on-demand only upon explicit recall inquiries.
  - Sanitized binary payload decoding and mojibake prevention (`src/payload.ts`, `src/tools/ranking.ts`).

## [0.3.0]

### Added
- **Flashbulb Memory Anchors (`FLAG_IS_ANCHOR = 0x08`)**:
  - Implemented 1-bit anchor flag in HTOK v4 header byte 11 (0 extra storage bytes).
  - Automatically tagged on explicit `@remember` markers, breakthrough multi-attempt tasks, and user persona background stories.
  - Applied $+25\%$ salience multiplier in hybrid ranking (`src/tools/ranking.ts`), protecting anchor memories from temporal decay and window pruning.
- **Associative Co-occurrence Graph & Spreading Activation (`src/associative.ts`)**:
  - Entity extraction filtering English stop words, digits, and noise tokens.
  - Atomic persistence in `.pi/mm/associations.json` with temporary file creation and atomic rename.
  - Lateral spreading activation in `src/tools/scan.ts:scanTokenFallback`, expanding fallback queries with top associated concept terms.
  - Automatic association indexing on settled conversational turns and stored episodes.
- **Proactive Subsystem Invariant Priming (`src/hooks/auto_recall.ts`)**:
  - `detectSubsystemMentions()` detects known project subsystems in prompt turns (`song`, `gig`, `poem`, `corm`, `joint`, `sepal`, `lemma`, `axil`, `bud`).
  - `primeSubsystemInvariants()` proactively fetches active L2 invariants with bounded deadline enforcement (`Promise.race`), preventing slow runners from stalling prompt start.
- **User Persona & Tenet Priming (`src/hooks/auto_recall.ts`)**:
  - Segregates memories scoped to `project: "user"` or `subsystem: "persona"`.
  - Injects `[User Persona & Engineering Tenets]` directly into persistent memory context with strict token budget deduction.
  - Prunes duplicates between primed blocks and general memories.
- **Negative Rule Invariant Extraction (`src/synth/adapter.ts`)**:
  - L2 synthesis extracts structured "Do NOT" rules from disproven approaches into `constraints?: string[]`.
  - Rendered with prominent `[RESTRICTION]` markers in auto-recall prompt context.
- **Enhanced Diagnostic Reporting (`/mm doctor`)**:
  - `/mm doctor` reports primary storage size, exact HTOK null-byte density, secondary axis modes (Joint in-memory vs disk, Sepal ephemeral status, embed cache size), and indexed record counts.

### Changed
- **Stdin-Streaming IPC Protocol (`src/corm.ts`, `src/daemon.ts`)**:
  - Replaced eager Latin-1 string conversion with direct stdin-streaming convention `["-p", `${ref}:-`, filespec]` for binary payloads.
  - `DaemonCormRunner` streams raw binary buffers over `cormd.sock` with zero V8 heap string allocations.
  - `ShellCormRunner` pipes `payloadBytes` directly to child process `stdin`.
  - Added poison-pill check in `formatProtocolCommand` rejecting literal `"-"` commands without payload bytes.
- **Fault-Isolated Multi-Token Fallback (`src/tools/scan.ts`)**:
  - Replaced unshielded `Promise.all` with `Promise.allSettled`, isolating individual socket errors or query timeouts from crashing fallback searches.
- **Asynchronous Consolidation Queue (`src/hooks/events.ts`)**:
  - Implemented `ConsolidationQueue` bounded to `MAX_DIRTY_SCOPES_QUEUE = 50`.
  - Integrated `SessionDrainRegistry` with 3,000ms safety timeout on `session_shutdown`.
- **Intent-Aware Candidate Pruning (`src/tools/ranking.ts`)**:
  - Added `isTechnicalInquiry()` to detect code terms, paths, and symbols.
  - Strictly prunes syntax artifacts on casual conversational queries while preserving them during technical investigation.

## [0.2.0]

- **Associative Memory Co-occurrence Graph & Priming (`src/associative.ts`)**:
  - Implemented graph-based associative memory activation spreading and proactive cognitive priming across connected episode nodes.
- **Flashbulb Anchor Salience Boost**:
  - Added flashbulb anchor scoring heuristics for critical milestones and security constraints.
- **HTOK v3 Binary Tokenization**:
  - Integrated HTOK v3 subword tokenization format and binary container serialization compatible with `liblemma` and `libhyle-source`.
- **Content-Addressed Prompt Blocks & Stdin Streaming**:
  - Introduced `PromptBlock` representation, deterministic 64-bit FNV-1a hashing (`fnv1a64`), and direct stdin-streaming protocol.
- **Stable Working Memory Ordering**:
  - Recalled candidate memories canonically sorted by ascending `ref` ID (`canonicalSortByRef`), preventing KV cache invalidation across turns.

## [0.1.0]

- Initial release of Memory Mipmaps extension for Pi Coding Agent.
- Hierarchical episodic memory persistence (L0-L3), Corm backing with Joint/Lemma/Sepal/Islet axes, Reciprocal Rank Fusion (RRF), and resident `cormd` support.
