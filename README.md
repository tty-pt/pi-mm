<p align="center">
  <img src="https://raw.githubusercontent.com/tty-pt/pi-mm/main/cover.png" alt="pi-mm cover" width="100%" />
</p>

# pi-mm: Intelligent Persistent Memory for Pi Coding Agent

[![npm version](https://img.shields.io/npm/v/@tty-pt/pi-mm.svg?color=blue)](https://www.npmjs.com/package/@tty-pt/pi-mm)
[![License: BSD-2-Clause](https://img.shields.io/badge/License-BSD--2--Clause-blue.svg)](LICENSE)
[![Zero-Config](https://img.shields.io/badge/zero--config-auren-16A34A)](https://github.com/tty-pt/axil-auren)

> Multi-resolution persistent memory, active session recall, and live codebase mipmap graphs for the Pi Coding Agent powered by native C engines (`libcorm`, `libsepal`, `liblemma`, `libjoint`, `libislet`).

`pi-mm` gives your [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) a unified multi-resolution memory space spanning **persistent cross-session lore** (`scope: "persistent"`), **ephemeral active session transcripts & lossless compaction** (`scope: "session"`), and **live codebase symbol graphs, call graphs, and git diff blast radius** (`scope: "code"`). It automatically injects relevant prior technical decisions into context before each turn, compacts long sessions into navigable mipmaps, and fuses historical debugging episodes directly into code symbol reads—with **zero manual configuration**.

---

## 1. Quickstart: Zero-Configuration Bring-Up

Install the extension:

```bash
pi install npm:@tty-pt/pi-mm
```

`pi-mm` works out of the box:
1. **Automatic Daemon Startup**: Checks if `axil-auren` is running on port 4242. If offline, it brings up the local server automatically.
2. **Automatic Model Provisioning**: Discovers models in `~/.models/` and auto-downloads the required fast embedding model (`bge-base`, 117 MB) with sha256 verification. Heavy and unused inference/chat models are never downloaded. Shows non-blocking visual progress (`⬇️ bge-base (42%)`) and usage status (`⚡ bge-base`) in the status bar (`mm-judge`).
3. **Proactive Dependency Checks**: On `session_start`, `pi-mm` automatically checks core C engines (`libcorm`, `libsepal`, `liblemma`, `libjoint`, `axil`, `axil-auren`) and displays actionable remediation toasts if anything is missing.

### Verify Memory Health

Inside Pi, run:
```text
/mm doctor
```
Outputs live endpoint connectivity, latency, loaded models, storage footprint, consolidation pipeline health (L2/L3 synthesis status, L0/L1 queue depths, drain rate, backlog/stale alerts), and core C engine versions.

---

## 2. Agent Tools Reference

By default, `pi-mm` exposes 3 focused tools to keep the agent's context clean and avoid tool ambiguity:

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `memory_recall` | `query`, `scope`, `overview`, `zoomRef`, `zoomTurn`, `toolIndex`, `lineage`, `symbol`, `symbols`, `file`, `kind`, `parentSymbol`, `neighbors`, `trace`, `direction`, `depth`, `diff`, `lineRange`, `maxLines`, `fullOutput`, `project`, `subsystem`, `level`, `includeEvidence`, `limit` | Unified multi-resolution retrieval across persistent lore (`scope: "persistent"`), active session turns (`scope: "session"`), and live codebase structure & call graphs (`scope: "code"`). |
| `memory_record` | `problem`, `approaches`, `diffs`, `findings`, `outcome`, `verification` | Explicitly records an episode, bug fix, or project invariant with verified test commands. |
| `memory_review` | `ref`, `action`, `lifecycle`, `reason`, `evidenceRef` | Inspects memory evidence hierarchy (`action: "inspect"`) or transitions factual lifecycle status (`action: "update_lifecycle"`). |

*Advanced fine-grained tools (`memory_store`, `memory_scan`, `memory_think`, `memory_forget`, etc.) can be enabled via `"advancedTools": true`.*

### 2.1 Multi-Axis Codebase Mipmap Graph & Lore Fusion (`scope: "code"`)

`pi-mm` indexes live repository source code directly into the C multi-axis recall kernel (`libcorm` + `liblemma` + `libsepal` + `libislet`), replacing standalone AST/graph tools with a unified codebase mipmap space:

- **Zero-Regex Character-Stream Structural Scanner** (`src/code/lexer.ts`, `src/code/scanner.ts`):
  - Single-pass character-stream state machine tracking string literals, line/block comments, preprocessor directives, brace/paren depth, and line numbers across **C/C++**, **TypeScript/JavaScript**, and **Python**.
  - Extracts `Function` (including `XY_IMPL(...)` definitions vs `XY_DECL(...)` forward declarations), `Method`, `Class`, `Struct`, `Interface`, `Enum`, `Macro`, `TypeAlias`, and HTTP `Route` symbols, plus `#include`, `import`, and `xy_load(...)` module dependencies.
  - **Library-Agnostic Structural Route Detection**: Detects route registrations purely from call-argument structure without hardcoded framework names:
    1. Method calls: `obj.<http_method>("/path"[, handler])` (e.g. `app.get("/v1/classify", handler)`)
    2. Two-string calls: `fn("<http_method>", "/path"[, handler])` (e.g. `register_route("POST", "/song/edit", handler)`)
    3. Method-prefixed route strings: `fn("<HTTP_METHOD>:/path"[, handler])` or `fn("<HTTP_METHOD> /path"[, handler])` (e.g. `route("GET:/api/song/:id", handler)`)
- **Incremental Multi-Axis Code Store & Concurrency Safety** (`src/code/store.ts`, `src/code/graph.ts`):
  - Stores L2 file summaries and L1/L0 symbol records in `code.db` (`joint,lemma,sepal`) and 2D `[fileHash, startLine..endLine]` interval spans in `code-islet.db` (`libislet`).
  - **Priority Root Indexing**: Scans primary project roots (`mods/`, `src/`, `include/`, `lib/`, `app/`, `bin/`) before `external/`, `vendor/`, or `tests/` so first-party code is always indexed within the file budget, and skips nested git submodule directories when `git status` reports only submodule commit changes.
  - **Single-Flight Refresh Serialization**: Serializes concurrent `refreshIncremental()` calls behind an in-memory promise lock (`refreshLock`), preventing parallel `corm -c` rebuilds from racing on `code.db`.
  - **Call-Graph Disambiguation**: Filters language keywords, C/POSIX stdlib routines (`malloc`, `free`, `memcpy`, `printf`, etc.), and C struct member pointer invocations (`ops->load()`) from `rawCallees`; resolves call edges with language-family isolation, same-file/same-module/import-path affinity, and `XY_IMPL` definition preference over `XY_DECL` header declarations.
- **Five Unified Codebase Workflows**:
  1. **Hybrid Symbol Search & Auto-Preview**: `memory_recall({ scope: "code", query: "<symbol or concept>", file?, kind? })` — fuses `liblemma` identifier/signature matching and `libsepal` semantic search; automatically expands full source, callers/callees, and linked lore when a single symbol matches unambiguously.
  2. **Concrete Symbol / Batch Source Read (Fail-Closed on Ambiguity)**: `memory_recall({ symbol: "render_song_item", file?, parentSymbol?, neighbors?: "both", lineRange?: [1, 80] })` or `memory_recall({ symbols: ["SymA", "SymB"] })` — returns exact `file:startLine-endLine` source slices, direct callers/callees, and automatically fuses linked `pi-mm` persistent invariants and past debugging episodes (`queryLinkedLoreForSymbols`).
  3. **Multi-Hop Call Graph Traversal**: `memory_recall({ trace: "song_install", direction: "inbound" | "outbound" | "both", depth: 3 })` — BFS traversal with cycle detection and per-hop file:line citations.
  4. **Architecture Overview (L3/L2 Mipmap)**: `memory_recall({ scope: "code", overview: true })` — synthesizes module clusters, `#include`/`import`/`xy_load` dependency DAG, HTTP routes & entry points, and high-degree call hotspots.
  5. **Worktree Change Impact & Blast Radius**: `memory_recall({ diff: true, depth: 2 })` — maps `git diff` modified line hunks via `libislet` 2D interval spans to affected symbols and traces inbound callers up to `depth` hops.

### 2.2 Ephemeral Semantic Session Memory, Progressive Recall & Mipmap Compaction (`scope: "session"`)

`pi-mm` indexes active conversational turns and tool outputs into an ephemeral per-session multi-axis store (`.pi/mm/sessions/<sessionId>/session.db`), enabling progressive in-session recall and lossless context compaction:

- **Asymmetric Multi-Granularity Ingestion & Write Serialization** (`src/session/sink.ts`, `src/session/store.ts`):
  - Decomposes each settled turn into **Turn (L1)** summaries, **Block (L1)** tool/reasoning segments, and **Symbol (L0)** exact identifier/path records over `libcorm` (`joint,lemma,sepal`), while preserving raw line-addressable turn payloads on disk (`turns/turn-<N>.json`).
  - Serializes all `ingestTurn` and `rebuildSessionIndex` mutations through a per-store promise queue (`withWriteLock`), preventing concurrent `corm -p` / `corm -c` CLI invocations from corrupting `session.db`.
- **Active Branch Lineage DAG & Reload Resilience** (`src/session/lineage.ts`, `src/session/manager.ts`):
  - Tracks turn parent-child edges across session branches and forks so `lineage: "active"` (default) filters out abandoned sibling branches while `lineage: "all"` searches the entire session DAG.
  - Automatically reconstructs linear ancestry for previously persisted turns if the extension is reloaded mid-session or a session is resumed without in-memory lineage nodes.
- **Progressive 3-Tier Session Retrieval** (`src/session/recall.ts`):
  - Fuses C multi-axis (`liblemma` + `libsepal` + `libjoint`) scores with exact symbol/identifier boosts and formats matches according to query specificity:
    - **Tier 1 (Index Card)**: Compact turn metadata, timestamp, summary, and extracted symbols.
    - **Tier 2 (Focused Excerpt)**: Relevant message/tool block excerpt surrounding the matched query terms.
    - **Tier 3 (Exact Line Slice)**: Exact line range (`memory_recall({ scope: "session", zoomTurn: 7, toolIndex?: 0, lineRange: [10, 40] })`) sliced directly from the stored turn payload.
- **Mipmap-Driven Context Compaction** (`src/session/compaction.ts`):
  - Hooks `session_before_compact` to synthesize a structured L2/L1 session mipmap (session objectives, completed milestones, active files & symbols, verified decisions, and unresolved blockers) with explicit `memory_recall({ scope: "session", zoomTurn })` drill-down pointers, ensuring compacted turns remain 100% retrievable on demand.

---

## 3. Diagnostic & Timeline Commands

| Command | Description |
| :--- | :--- |
| `/mm doctor` | Displays live status for decision judge, vector endpoints, storage file sizes, and core C engines. |
| `/mm overview` | Synthesizes an all-time structured timeline across active principles (L3), invariants (L2), and milestones (L1). |
| `/mm timeline` | Chronological grouping of memory capture epochs and historical activity. |

---

## 4. Configuration Reference

Configure settings in `.pi/settings.json` (or user `~/.pi/agent/settings.json`):

| Option | Default | Description |
| :--- | :--- | :--- |
| `captureEmbedUrl` | `"http://127.0.0.1:4242"` | Endpoint URL for in-memory semantic classification (`POST /v1/classify`). Independent of `embedUrl`, which feeds the memory index |
| `captureEmbedModel` | `"bge-base"` | Classification embedding model (a multilingual model improves non-English recall) |
| `captureMode` | `"all"`, or `"judge"` when `captureEmbedUrl` is set in your settings | What automatic conversational capture stores: `"all"` (every user turn), `"keyword"` (only turns starting with a capture keyword), `"judge"` (turns the embedding classifier says are worth remembering), `"off"` |
| `captureEmbed` | `"auto"` | Classify turns by embeddings in `captureMode: "judge"`. Env: `PI_MM_CAPTURE_EMBED` |
| `captureMinSimilarity` | `0.55` | Cosine floor for any embedding verdict (0..1) |
| `captureMinMargin` | `0.025` | How far a "remember" verdict must beat "skip" (0..1); lower margin enables high-frequency technical capture |
| `captureExemplars` | `{}` | Your own example sentences, `{ "remember": [...], "skip": [...] }`, any language, merged with the shipped ones |
| `judgeFallback` | `"skip"` | Deterministic fallback when the classifier server is offline (`"skip"` or `"capture"`) |
| `autoStartAuren` | `true` | Automatically launch `axil-auren` in the background if offline |
| `autoDownloadModels` | `"manual"` | Model download policy (`"manual"` prompts for heavy models, `"auto"` downloads without prompting) |
| `semanticSearch` | `true` | Enable dense vector embeddings and semantic recall via `libsepal` |
| `embedUrl` | `"http://127.0.0.1:4242/v1/embeddings"` | Embedding generation endpoint |
| `embedModel` | `"bge-base"` | Embedding model identifier (`"bge-base"` for 768-d, `"bge-small"` for 384-d) |
| `synthUrl` | auto (auren chat endpoint) | Chat completions URL for L2/L3 abstraction synthesis (defaults to `/v1/chat/completions` on the local auren server, or `"off"` to disable). Env: `PI_MM_SYNTH_URL` |
| `synthModel` | `"smollm"` | Model name for L2/L3 synthesis when auto-defaulted to local auren. Env: `PI_MM_SYNTH_MODEL` |
| `consolidateDrainMs` | `250` | Wall-clock budget in ms per turn to drain the pending L0 consolidation queue; 0 disables idle backlog draining. Env: `PI_MM_CONSOLIDATE_DRAIN_MS` |
| `consolidateBatchLimit` | `20` | Maximum number of memories processed per consolidation batch. Env: `PI_MM_CONSOLIDATE_BATCH_LIMIT` |
| `maxStorageBytes` | `107374182400` | Soft storage limit threshold in bytes (default 100 GB). Env: `PI_MM_MAX_STORAGE_BYTES` |
| `l0RetentionPolicy` | `"keep_all"` | Raw L0 tool retention policy: `"keep_all"` (preserves full 100GB history) or `"prune_after_consolidation"` (supersedes raw tool traces once consolidated). Env: `PI_MM_L0_RETENTION_POLICY` |
| `autoRecallBudgetChars` | `1500` | Maximum character budget injected into system prompt before a turn. Env: `PI_MM_AUTO_RECALL_BUDGET` |
| `semanticDeduplication` | `true` | Automatically supersede older duplicate records in the same scope when cosine similarity >= 0.88. Env: `PI_MM_SEMANTIC_DEDUPLICATION` |
| `advancedTools` | `false` | Expose the 9 advanced low-level memory inspection tools |
| `recallEmbed` | `"auto"` | Classify user prompts by embeddings (`POST /v1/classify`) to detect recall intent (`"auto"` or `"off"`). Env: `PI_MM_RECALL_EMBED` |
| `recallMinSimilarity` | `0.6` | Cosine floor for recall intent embedding classification (0..1) |
| `recallMinMargin` | `0.08` | How far a `"recall_past"` verdict must beat `"standalone"` (0..1) |
| `recallExemplars` | `{}` | Your own example sentences, `{ "recall_past": [...], "standalone": [...] }`, merged with shipped ones |
| `recallFallback` | `"skip"` | Fallback when classifier endpoint is offline: `"skip"` (default, zero guessing) or `"capture"` |
| `recallAction` | `"query"` | Action on recall inquiry: `"query"` (default, executes hybrid scan and injects matching memories) or `"hint"` (emits epistemic hint advising agent to use `memory_recall`). Env: `PI_MM_RECALL_ACTION` |
| `wonderingEmbed` | `"auto"` | Classify assistant turns and thoughts by embeddings (`POST /v1/classify`) to detect cognitive wonderings and architectural curiosity (`"auto"` or `"off"`). Env: `PI_MM_WONDERING_EMBED` |
| `wonderingMinSimilarity` | `0.6` | Cosine floor for assistant wondering embedding classification (0..1) |
| `wonderingMinMargin` | `0.08` | How far a `"wondering"` verdict must beat `"routine_action"` (0..1) |
| `directiveEmbed` | `"auto"` | Classify user prompts by embeddings (`POST /v1/classify`) to detect standing directives/rules (`"auto"` or `"off"`). Env: `PI_MM_DIRECTIVE_EMBED` |
| `directiveMinSimilarity` | `0.6` | Cosine floor for standing directive classification (0..1) |
| `directiveMinMargin` | `0.08` | How far a `"standing_directive"` verdict must beat `"transient_task"` (0..1) |
| `directiveExemplars` | `{}` | Custom examples `{ "standing_directive": [...], "transient_task": [...] }` merged with shipped ones |
| `directiveFallback` | `"skip"` | Fallback when endpoint is offline: `"skip"` (default, zero guessing) or `"capture"` |
| `overviewEmbed` | `"auto"` | Classify direct memory inquiries by embeddings (`POST /v1/classify`) to detect open-ended overviews (`"auto"` or `"off"`). Env: `PI_MM_OVERVIEW_EMBED` |
| `overviewMinSimilarity` | `0.6` | Cosine floor for overview routing classification (0..1) |
| `overviewMinMargin` | `0.08` | How far an `"overview_query"` verdict must beat `"specific_query"` (0..1) |
| `overviewExemplars` | `{}` | Custom examples `{ "overview_query": [...], "specific_query": [...] }` merged with shipped ones |
| `overviewFallback` | `"skip"` | Fallback when endpoint is offline: `"skip"` (default, zero guessing) or `"capture"` |
| `judgeProtocol` | *(deprecated)* | Deprecated in favor of `POST /v1/classify` |
| `judgeModel` | *(deprecated)* | Deprecated in favor of `POST /v1/classify` |
| `judgeUrl` | *(deprecated)* | Deprecated; mapped to `captureEmbedUrl` |

### Automatic Capture: What Decides What

`captureMode` decides **whether anything is judged at all**. Recall questions ("do you remember ...") are never captured, in any mode. In `keyword` and `judge` modes a turn that starts with a capture keyword (`@remember`, `remember:`, `note:` by default) is always stored, without consulting anything; in `all` mode every other turn is stored too.

| `captureMode` | What stores a turn | If that is unavailable |
| :--- | :--- | :--- |
| `all` | Every user turn. No classifier and no embeddings are consulted. | n/a |
| `keyword` | Only turns that start with a capture keyword | n/a |
| `judge` | **In-Memory Embedding Classification** via `POST /v1/classify` | Deterministic `judgeFallback` (`skip` stores nothing, `capture` stores the turn) |
| `off` | Nothing automatic | n/a |

`captureMode` resolves to `all` unless you set it or put a `judgeUrl` in your settings (which implies `judge`). **If you never set either, the embedding tier below never runs.**

Why embeddings for `judge` mode: on English/Portuguese turns the default judge model (`olmoe`) answered "remember" to 40 of the 44 turns that were not worth remembering (greetings, thanks, recall probes, task requests; counted over two corpora of 22 such turns each), i.e. it stored almost everything. Measured on the held-out corpus of 44 new turns:

| | Embeddings (`bge-base`) | Judge (`olmoe`) |
| :--- | :--- | :--- |
| Accuracy | 26/44 (59%) | 24/44 (55%) |
| False "remember" (a wrong store) | **0** | **20** |
| Real memories recognised | **4/22** (7/22 on the development corpus) | 22/22 |
| Latency (p50) | ~15 ms | ~1.9 s |

Read that honestly: **embeddings are high-precision and low-recall.** They store few turns and almost never the wrong one, so most casual statements are *not* captured automatically; say `@remember ...` for the ones that matter, add `captureExemplars` in your own phrasing, or lower `captureMinMargin` to store more. The first held-out run failed the adoption rule (3 false "remember"); the exemplar set was then extended by form and a hypothesis recorded before a fresh corpus confirmed it. `bge-base` is English-only, so Portuguese statements mostly fall back to "skip" until you add examples or use a multilingual model.

Measure your own phrasing (opt-in, never part of `npm test`; prints accuracy, false "remember", latency and every miss for both strategies):
`PI_MM_EVAL_JUDGE=1 deno test --allow-all --sloppy-imports tests/eval/` (set `PI_MM_EVAL_URL` for a non-default server).

### Proactive Recall Intent: What Drives Context Injection

In addition to write-path capture judging, `pi-mm` intelligently classifies the **read path** before each agent turn (`before_agent_start`). When a user asks about past architectural choices, previous debugging sessions, decisions, rules, or lore, `pi-mm` uses `POST /v1/classify` against a curated bilingual exemplar corpus (`recall_past` vs `standalone`):

1. **Hint-Only Architecture (`recallAction: "hint"`, default)**: When recall intent or architectural wondering is confirmed by embeddings, `auto_recall` executes **zero automated database scans** (`runScanWithTimeout` and `primeSubsystemInvariants` are completely bypassed). Instead, it injects a quiet epistemic hint into `event.systemPromptOptions.sections["memory_context"]` advising the agent to formulate queries via LLM inference and retrieve records using `memory_recall`. It sets `display: false` on the returned custom message, completely eliminating noisy, unprompted UI cards in the user's chat interface. For legacy auto-injected background recall, set `"recallAction": "query"`.
2. **Lifting Unprompted Suppression**: In general conversational turns without memory keywords, context injection is conservative. When `recall_past` intent is confirmed by embeddings, unprompted context filtering is lifted, allowing vector and hybrid retrieval to surface relevant memories even without exact subsystem matches.
3. **Actionable Agent Steering**: When recall intent is positive, `pi-mm` augments the agent's system prompt sections (`memory_context`) with explicit guidance directing the model to inspect `memory_recall` (and `zoomRef` if candidate records are retrieved) before guessing or invoking irrelevant bash or grep tools.
4. **Resilient Offline Fallback**: If `axil-auren` is offline or unconfigured, `pi-mm` safely defaults to skipping unprompted retrieval (`recallFallback: "skip"`), completely eliminating fragile regex guessing or false positives.

### Daemon Circuit Breaker & Resilient Timeout

All embedding classification and vector calls to `axil-auren` are wrapped with a resilient in-memory circuit breaker (`src/judge/circuit.ts`):
- **Fast Timeout**: Imposes a tight default timeout of 250 ms (`DEFAULT_CLASSIFY_TIMEOUT_MS = 250`) on `/v1/classify`, well above normal local inference (~18 ms p50) but fast enough to prevent perceptible turn lag.
- **Fail-Fast Cooldown**: On connection refusal (`ECONNREFUSED`), socket hang, network error, or 5xx server status, the daemon base URL is placed on a 30-second cooldown (`CIRCUIT_BACKOFF_MS = 30_000`).
- **Zero Overhead When Offline**: While the circuit is open, subsequent calls bypass network I/O completely and return `null` immediately (measured at ~1 µs, 0 ms overhead), ensuring that Pi never freezes or stalls when `axil-auren` is stopped.

### Assistant Cognitive Wondering Detection & Self-Hinting

When the agent expresses cognitive uncertainty, architectural curiosity, or wonders how a subsystem works mid-task:
- Examples: *"I wonder how the caching layer works in this project"*, *"Not sure how FTS handles accent folding here"*, *"Where are session files stored in this architecture?"*
- `pi-mm` intercepts the assistant's turn in `message_end` and evaluates the reasoning via vector embeddings (`POST /v1/classify` on `axil-auren`, `bge-base`).
- When classified as `wondering` (similarity $\ge 0.60$, margin $\ge 0.08$), the system steers the agent via `pi.sendMessage` (`deliverAs: "steer"`):
  > `💡 [Memory Hint]: You are exploring how this subsystem, convention, or architecture works. Check memory_recall to consult past technical decisions and lore.`
- **Zero automated database scans** are run in the background, ensuring no speculative database queries and zero UI pollution. The agent uses its own inference to query `memory_recall`.
- **Measured Accuracy**: 100.0% accuracy (24/24), 100.0% recall, and 0.0% false positives (p50: 17.9 ms) across bilingual wondering and routine action benchmarks (`npm run eval:wondering` or `scripts/eval-wondering.ts`).

#### Empirical Benchmark: Regex Heuristics vs. Embeddings

Measured on a held-out, bilingual (English + Portuguese) corpus of **44 realistic turns** (22 `recall_past` queries, 22 `standalone` engineering tasks), completely disjoint from training exemplars (`npm run eval:recall` against `axil-auren` with `bge-base`):

| Metric | Previous Heuristic Gate (`isMemoryRecallPrompt`) | `axil-auren` Embeddings (`POST /v1/classify`) | Impact / Delta |
| :--- | :--- | :--- | :--- |
| **Overall Accuracy** | **56.8%** (25/44) | **81.8%** (36/44) | **+25.0% accuracy** |
| **Recall Catch Rate (`recall_past`)** | **13.6%** (3/22) | **63.6%** (14/22) | **4.7× improvement** (+11 caught) |
| **Task Specificity (`standalone`)** | **100.0%** (22/22) | **100.0%** (22/22) | **Zero regressions / zero false recall** |
| **False Positives** | **0** | **0** | **Zero unwanted memory spam** |
| **Latency (p50 / p95)** | < 1 ms | **17 ms / 34 ms** | Fast, imperceptible C SIMD execution |

Run the recall evaluation suite against your live `axil-auren` instance:
```bash
npm --prefix .pi/extensions/pi-mm run eval:recall
```

`npm test` is hermetic: it preloads `tests/no-live-network.ts`, which refuses any request to the real auren port (4242) or to a non-loopback host, and runs with `PI_MM_AUTO_START_AUREN=0` so no local server is started. Run with `PI_MM_ALLOW_LIVE=1` to lift the guard.

### Quest Symbiosis & Standing Directive Reinforcement

`pi-mm` works seamlessly with `pi-quest` for continuous memory distillation and operational discipline:

- **Decoupled Quest Archive Distillation**:
  When a quest concludes via `quest_archive`, `pi-mm` asynchronously processes the completed task metadata. Key findings, verified code diffs, execution metrics, and root-cause discoveries are distilled into structured episodic records (`memory_record`) without stalling the agent turn. Failed quests with setbacks are similarly preserved as lessons learned (`lifecycle: "observed"`, `approach: "failed"`).
- **Dual-End Assistant Discovery Distillation & Enriched L0 Summaries**:
  When a task turn involves informative tool executions (code modifications or test runs) and the assistant explains the fix, `pi-mm` distills the discovery into an L1 Task Episode citing the tool executions as evidence. Tool executions are summarized with rich file paths, commands, and first-line outputs (`formatToolEventSummary`), while internal memory introspection queries and corm database inspection commands are filtered out to prevent self-referential capture loops.
- **Unwedged L0 Consolidation & Zero-Config Local Synthesis**:
  L0 tool episodes are consolidated into L1 episodes without queue stalls. Fresh turns are consolidated first, followed by the remaining backlog ordered newest-first (`orderPendingL0Refs`). Idle turns drain remaining L0 items within a configurable wall-clock budget (`consolidateDrainMs`, default 250ms). When a local `axil-auren` server is running, L2/L3 abstraction synthesis is automatically wired to its OpenAI-compatible chat endpoint (`/v1/chat/completions`) using `smollm`, eliminating stalled consolidation queues without manual configuration.
- **Retrieval-Quality Gate & L0 Targeted Recall**:
  Targeted recall via `memory_recall` includes L0 task memories when requested (`level: "L0"` or untiered searches) while strictly exempting structured technical episodes from code artifact pruning. Golden retrieval quality is asserted via a rigorous benchmark gate (`scripts/eval-retrieval.ts`) requiring recall@5 = 1.0, MRR $\ge$ 0.5, and synthesized L1/L2 records ranked above raw tool noise.
- **Conversational Invariants & Negative Constraint Learning**:
  Developer feedback (*"don't use raw pointers in request handlers"*, *"never mock the filesystem in tests"*, *"stop modifying the lockfile without running make"*, *"you made a mistake, that function requires three arguments"*) is semantically classified via `POST /v1/classify`, elevated to L2 invariants (`standing: true`), and continuously reinforced in the assistant's prompt across every turn with newest-first ordering.
- **Scalable 100GB Mipmap Architecture**:
  Stores up to 100GB of raw execution diffs and logs on disk via `libcorm` OS memory-mapped files (`mmap`) and `libsepal` Hamming sketches, while keeping LLM context lean via compact L1/L2 summaries and on-demand `zoomRef` drilldowns.
- **Standing Directive Reinforcement Sync**:
  Operational directives and invariants (`level: "L2"`, `standing: true`) are persisted to disk (`standing_directives.json`) and synchronized into the global cache. This guarantees that established invariants survive cross-session restarts and are automatically seeded into new `pi-quest` draft proposals.
- **`cormd` JSON Protocol Support**:
  High-throughput structured memory storage and retrieval over the native `cormd` daemon JSON IPC protocol.

---

## 5. Prerequisites & Core C Engines

`pi-mm` uses compiled C engines for sub-microsecond in-memory retrieval:

| Engine | Description | Build & Guide |
| :--- | :--- | :--- |
| **`libcorm`** | In-memory key-value store, unified recall kernel, and `cormd` daemon. | [libcorm](https://github.com/tty-pt/libcorm#installation--build) |
| **`libsepal`** | Pure-C Approximate Nearest Neighbor (ANN) dense vector store. | [libsepal](https://github.com/tty-pt/libsepal#installation--build) |
| **`libjoint`** | Interval-tree temporal presence engine for historical co-occurrence. | [libjoint](https://github.com/tty-pt/libjoint#installation--build) |
| **`liblemma`** | Diacritic-preserving full-text search tokenizer (`pão ≠ pao`). | [liblemma](https://github.com/tty-pt/liblemma#installation--build) |
| **`libislet`** | 2D spatial & interval-span indexing engine (file line-range intersection & spatial grids). | [libislet](https://github.com/tty-pt/libislet#installation--build) |
| **`axil-auren`** | Local LLM inference, embeddings, and fast decision judging. | [axil-auren](https://github.com/tty-pt/axil-auren#installation--build) |

Prebuilt packages are available via [tty.pt packages](https://github.com/tty-pt/ci/blob/main/docs/install.md) for APT, Homebrew, and pacman.

---

## 6. Development & Verification

```bash
npm --prefix .pi/extensions/pi-mm test             # Run hermetic test suite (500+ tests)
npm --prefix .pi/extensions/pi-mm run lint         # Lint all TypeScript source and scripts
npm --prefix .pi/extensions/pi-mm run eval:recall  # Benchmark recall intent classification against live auren
npm --prefix .pi/extensions/pi-mm run eval:surfaces # Benchmark directive, overview, and kind classification
npm --prefix .pi/extensions/pi-mm run eval:retrieval # Benchmark retrieval quality (recall@5, MRR, ranking)
npm --prefix .pi/extensions/pi-mm run test:playbook # Non-destructive bootstrap verification playbook
npm --prefix .pi/extensions/pi-mm run demo          # Interactive live bootstrap demonstration
npm --prefix .pi/extensions/pi-mm run zip           # Package distribution bundle
```

## License

BSD 2-Clause License. Copyright (c) 2025, tty-pt. See `LICENSE`.
