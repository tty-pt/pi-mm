# Changelog

All notable changes to the `@tty-pt/pi-mm` package will be documented in this file.

## [0.5.4] - 2026-10-30

### Added
- **Assistant Cognitive Wondering Detection & Epistemic Steering** (`src/hooks/events.ts`, `src/hooks/wondering.ts`, `src/judge/wondering-exemplars.ts`):
  - Hooked `pi.on("message_end")` to observe assistant turns, extracting text and thinking blocks (`part.thinking` and `part.text`).
  - Added `evaluateAssistantWondering(text, cfg)` using in-memory vector embeddings on `axil-auren` (`POST /v1/classify`, `bge-base`) against bilingual exemplars (`WONDERING_EXEMPLARS`: `wondering` vs `routine_action`).
  - When the agent expresses uncertainty, architectural curiosity, or wonders how a subsystem works mid-task, the system steers the agent via `pi.sendMessage({ customType: "memory_hint", content: hint }, { deliverAs: "steer" })`.
  - Zero database queries are executed; the agent is steered to query `memory_recall` via inference.
  - Per-turn deduplication prevents duplicate steering hints.
  - Added empirical evaluation harness (`scripts/eval-wondering.ts`) measuring 100.0% accuracy, 100.0% wondering recall, and 0.0% false positives (p50: 17.9 ms).

## [0.5.3] - 2026-10-30

### Added
- **Unified Hint-Only Recall Architecture & Epistemic Nudges** (`src/hooks/auto_recall.ts`, `src/config.ts`, `src/judge/recall-exemplars.ts`):
  - Added `recallAction?: "hint" | "query"` setting to `MmConfig` (with environment variable override `PI_MM_RECALL_ACTION`, defaulting to `"hint"` in runtime configuration).
  - When `isRecallIntent` is confirmed true (via vector embeddings on `axil-auren` `POST /v1/classify`) in hint mode, `auto_recall` executes **zero automated database scans** (`runScanWithTimeout` and `primeSubsystemInvariants` are bypassed completely).
  - Injects a quiet epistemic hint into `event.systemPromptOptions.sections["memory_context"]` advising the agent to formulate queries via LLM inference and retrieve records using `memory_recall`.
  - Sets `display: false` on the returned custom message, completely eliminating noisy, unprompted UI cards in the user's chat interface.
  - Expanded `RECALL_EXEMPLARS.recall_past` with architectural wonderings and exploratory questions (*"How does the caching layer work in this project?"*, *"How does FTS handle accent folding here?"*, *"Why are descriptors leaking in corm?"*), ensuring cognitive curiosity is detected and guided without speculative database scans.
  - Preserved `recallAction: "query"` for legacy auto-injected background recall compatibility.

## [0.5.2] - 2026-10-30

### Fixed
- **Elimination of Regex Query Stripping in Favor of Stopword Set Filtering** (`src/hooks/auto_recall.ts`, `src/tools/scan.ts`):
  - Completely removed the `extractRecallSearchQuery` regex prefix-stripping heuristic from `auto_recall.ts`, adhering to the standing directive against regex heuristics (Ref 14579).
  - Added conversational stop words (`"remember"`, `"recall"`, `"mention"`, `"mentioning"`, `"tell"`, `"told"`, `"say"`, `"said"`, `"speaking"`, `"talk"`, `"talked"`, `"you"`, `"me"`, `"us"`, `"i"`, `"we"`) to `STOP_WORDS` in `src/tools/scan.ts`.
  - Token-level search naturally eliminates conversational framing words via $O(1)$ set lookup (`!STOP_WORDS.has(w.toLowerCase())`) without regexes.
  - Recall intent is detected cleanly via in-memory vector cosine similarity (`POST /v1/classify`, `bge-base`), and query formulation is delegated to the agent's LLM inference via `memory_recall`.

## [0.5.1] - 2026-10-30

### Fixed
- **Conversational Recall Query Sanitization & Stopword Elimination** (`src/hooks/auto_recall.ts`):
  - Added `extractRecallSearchQuery(prompt)` to strip conversational recall framing prefixes (*"do you remember (me mentioning/talking about)?"*, *"what did I say about..."*, *"did I mention..."*, *"lembras-te de..."*) and trailing question punctuation before scanning.
  - When recall intent is confirmed by the classifier, `runScanWithTimeout` executes search against the sanitized semantic topic keywords rather than the raw conversational prompt, preventing conversational stopwords (like the word *"remember"*) from acting as database query tokens and matching unrelated past sessions.
- **Unconditional Question-Memory Exclusion in Injected Context** (`src/hooks/auto_recall.ts`):
  - Removed the `!isExplicitRecall` bypass in `buildInjectedContext`. `isQuestionMemory(c, c.envelope)` is now strictly and unconditionally enforced across all modes, ensuring conversational meta-questions (e.g. *"In general, what do you remember?"*, *"What was my request?"*) are never injected as factual background context.
- **Silent Non-Intrusive Guidance on Empty Matches** (`src/hooks/auto_recall.ts`):
  - When recall intent is detected but no high-confidence memory records match, the emitted notice sets `display: false`, keeping the user's chat clean without displaying empty or spurious memory cards while delivering the guidance notice to `event.systemPromptOptions.sections["memory_context"]`.

## [0.5.0] - 2026-10-29

### Added
- **Embedding classification of standing directives and operational invariants** (`directiveEmbed: "auto"`). In conversational turn capture and reinforcement scheduling, user statements are evaluated against bilingual exemplars (`standing_directive` vs `transient_task`) via `POST /v1/classify`. When confirmed, the statement is classified as an invariant (`level: "L2"`, `isAnchor: true`) and registered in the reinforcement scheduler, eliminating the fragile English-only regex. Options: `directiveEmbed`, `directiveMinSimilarity`, `directiveMinMargin`, `directiveExemplars`, `directiveFallback`.
- **Embedding classification of open-ended memory overview questions** (`overviewEmbed: "auto"`). Distinguishes open-ended retrospective inquiries (`overview_query`) from targeted topic searches (`specific_query`), correctly injecting structured all-time timeline mipmaps (`buildMemoryOverview`) and eliminating empty lexical keyword scans on synthesis questions. Options: `overviewEmbed`, `overviewMinSimilarity`, `overviewMinMargin`, `overviewExemplars`, `overviewFallback`.
- **Embedding classification of recall intent** (`recallEmbed: "auto"`). In `before_agent_start`, evaluates user prompts using nearest-exemplar embeddings via `axil-auren`'s `POST /v1/classify` (shipped bilingual EN/PT exemplars in `src/judge/recall-exemplars.ts`) to detect whether the user is querying past technical decisions, investigations, preferences, or lore (`recall_past` vs `standalone`). When recall intent is confirmed:
  1. Lifts unprompted context filtering in `auto_recall.ts`, allowing hybrid scan and vector search to retrieve relevant memories even without hardcoded subsystem mentions.
  2. Nudges the agent with actionable tool guidance in `systemPromptOptions.sections["memory_context"]`, instructing the model to consult `memory_recall` (and `zoomRef` if specific memories are retrieved) before guessing or invoking unrelated bash/grep tools.
  3. Seamless fallback to deterministic regex heuristics (`isMemoryRecallPrompt`) when the classifier server is offline or unconfigured.
  New configuration options: `recallEmbed` (`"auto"` | `"off"`), `recallMinSimilarity` (0.60), `recallMinMargin` (0.08), `recallExemplars`, `recallFallback` (`"regex"` | `"skip"`), and environment variable overrides `PI_MM_RECALL_EMBED`, `PI_MM_RECALL_MIN_MARGIN`, `PI_MM_RECALL_MIN_SIMILARITY`, `PI_MM_RECALL_FALLBACK`.
- **Empirical recall intent evaluation harness and script** (`scripts/eval-recall.ts`, `npm run eval:recall`). Measures head-to-head performance of the new embedding classifier against the previous heuristic gate over a held-out, bilingual corpus of 44 turns:
  - Accuracy: 81.8% (36/44) vs 56.8% (25/44) (+25.0% accuracy gain).
  - Recall Catch Rate: 63.6% (14/22) vs 13.6% (3/22) (4.7× improvement).
  - Task Specificity: 100.0% (22/22) vs 100.0% (22/22) with 0 false positives.
  - Latency: 17 ms p50, 34 ms p95.
- **Embedding-Only Model Provisioning & Redundancy Prevention** (`src/auren-bootstrap.ts`):
  - In `shouldAutoDownload`, restricted automatic model downloads strictly to models declaring embedding capabilities (`capabilities: ["embed"]`), eliminating downloads of heavy, unused inference/chat/judge models (`qwen`, `olmoe`).
  - In `run`, verified if any embedding model is already present on disk (`~/.models/`); if present, auto-download is skipped entirely. If absent, only the primary preferred embedding model (`bge-base`, 117 MB) is downloaded.
- **Non-Blocking Visual Feedback on Downloads & Model Usage** (`src/auren-bootstrap.ts`, `src/hooks/events.ts`):
  - Enriched `describeProgress` to report model identifier and progress percentage (`⬇ bge-base (42%)`).
  - Added `describeModelStatus` reporting download progress during fetching, active model status (`⚡ bge-base`) when running on port 4242, or clearing when idle.
  - Wired into reserved status bar key `"mm-judge"` with deduplicated, single-shot informational toasts on download start and completion.
- **Multi-surface evaluation harness and script** (`scripts/eval-surfaces.ts`, `npm run eval:surfaces`). Evaluates classification accuracy, false positives, and latency across standing directives (`directive_intent`), overview queries (`overview_routing`), and quest kinds (`kind_classification`):
  - Benchmarks embedding classification against baseline regex/heuristics on held-out bilingual test sets.
  - Confirms zero state-changing regressions on invariant tracking and memory overview injection.
- Comprehensive unit and integration test suite in `tests/recall_intent.test.ts` covering bilingual exemplars, mock `/v1/classify` endpoints, threshold gating, offline fallback, and end-to-end `handleBeforeAgentStart` context injection and agent nudging.
- **Embedding classification of conversational turns** (`captureMode: "judge"`). `evaluateTurnWithJudge` first classifies the user's prompt by nearest-exemplar embeddings (shipped examples in `src/judge/capture-exemplars.ts`, extended by form after the first held-out run), then falls back to the judge, then to `judgeFallback`. Works with embeddings alone (no `judgeUrl` needed). New self-contained modules `src/judge/embed.ts` and `src/judge/nearest.ts` (pi-mm never imports pi-quest). Settings: `captureEmbed` (`auto`|`off`), `captureEmbedUrl`, `captureEmbedModel`, `captureMinSimilarity` (0.6), `captureMinMargin` (0.075), `captureExemplars` (`remember`/`skip`, any language); env `PI_MM_CAPTURE_EMBED`, `PI_MM_CAPTURE_EMBED_URL`, `PI_MM_CAPTURE_EMBED_MODEL`, `PI_MM_CAPTURE_MIN_MARGIN`, `PI_MM_CAPTURE_MIN_SIMILARITY`. `JudgeDecisionSource` gains `"embed"`. **Measured** (44 EN/PT turns, `bge-base` vs `olmoe`, held-out corpus B): embeddings 26/44 (59%) with **0 false "remember"**; the judge 24/44 (55%) with **20 false "remember"** (it answers "remember" to 40 of 44 non-memories on the two corpora combined). The trade is recall: embeddings recognise 4/22 real memories on B (7/22 on the development corpus A), judge 22/22, so fewer turns are stored automatically; explicit `@remember` is unchanged. The first held-out run (corpus A, default exemplars) **failed** the adoption rule with 3 false "remember" and no margin fixed it, so the exemplars were extended by form and the hypothesis (default margin, new exemplars, zero false "remember") was recorded before corpus B was written. `captureEmbed: "off"` restores the judge-only path.
- Measurement harness `tests/eval/harness.ts` (ported from pi-quest) and the opt-in live evaluation `tests/eval/capture-eval.test.ts` (`PI_MM_EVAL_JUDGE=1`); its corpus/exemplar disjointness checks run in `npm test`.
- README: `captureMode` and the new settings are documented, with a "what decides what" table and the numbers above.

### Changed
- **`npm test` is hermetic.** The previous suite quietly made 14 requests to the live auren server (the zero-config discovery probe and `/mm doctor`'s health check). The test script now preloads `tests/no-live-network.ts` (refuses non-loopback hosts and port 4242; ephemeral loopback fake servers still work) and sets `PI_MM_AUTO_START_AUREN=0` (without it, refused discovery made one smoke test take 62 s by trying to start a local server). Both are asserted by `tests/no_live_network.test.ts`; `PI_MM_ALLOW_LIVE=1` lifts the guard. Measured: 0 requests to the live server during the suite.
- **Daemon Runner Decoupling and Memoization** (`src/tools/index.ts`): Decoupled `cormd` daemon startup latency and memoized daemon runner instance to eliminate process spawn overhead and improve tool execution responsiveness.
- Note: in a project that sets neither `captureMode` nor `judgeUrl`, `captureMode` resolves to `"all"` and none of the above applies.

- `judgeModel` defaults to `olmoe` (the protocol already defaulted to `systemone`), so a fresh install uses the model/protocol pair that measured best; documented in the README configuration table. axil-auren now answers an unparseable judge reply with `choice: null`, which the judge client treats as unavailable.
- Removed legacy generative judge helpers `callLlmJudge`, `normalizeSystemOneUrl`, and `parseJevAnswer` from `src/judge/adapter.ts`.

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
