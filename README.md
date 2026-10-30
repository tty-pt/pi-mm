<p align="center">
  <img src="https://raw.githubusercontent.com/tty-pt/pi-mm/main/cover.png" alt="pi-mm cover" width="100%" />
</p>

# pi-mm: Intelligent Persistent Memory for Pi Coding Agent

[![npm version](https://img.shields.io/npm/v/@tty-pt/pi-mm.svg?color=blue)](https://www.npmjs.com/package/@tty-pt/pi-mm)
[![License: BSD-2-Clause](https://img.shields.io/badge/License-BSD--2--Clause-blue.svg)](LICENSE)
[![Zero-Config](https://img.shields.io/badge/zero--config-auren-16A34A)](https://github.com/tty-pt/axil-auren)

> Multi-resolution persistent memory for the Pi Coding Agent powered by native C engines (`libcorm`, `libsepal`, `liblemma`).

`pi-mm` gives your [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) long-term memory that survives context compaction and cross-session restarts. It automatically injects relevant prior technical decisions into context before each turn and captures new learnings when tasks conclude—with **zero manual configuration**.

---

## 1. Quickstart: Zero-Configuration Bring-Up

Install the extension:

```bash
pi install npm:@tty-pt/pi-mm
```

`pi-mm` works out of the box:
1. **Automatic Daemon Startup**: Checks if `axil-auren` is running on port 4242. If offline, it brings up the local server automatically.
2. **Automatic Model Provisioning**: Discovers models in `~/.models/` and auto-downloads the required fast embedding model (`bge-base`, 117 MB) with sha256 verification. Heavy and unused inference/chat models are never downloaded. Shows non-blocking visual progress (`⬇ bge-base (42%)`) and usage status (`⚡ bge-base`) in the status bar (`mm-judge`).
3. **Proactive Dependency Checks**: On `session_start`, `pi-mm` automatically checks core C engines (`libcorm`, `libsepal`, `liblemma`, `libjoint`, `axil`, `axil-auren`) and displays actionable remediation toasts if anything is missing.

### Verify Memory Health

Inside Pi, run:
```text
/mm doctor
```
Outputs live endpoint connectivity, latency, loaded models, storage footprint, and core C engine versions.

---

## 2. Agent Tools Reference

By default, `pi-mm` exposes 3 focused tools to keep the agent's context clean and avoid tool ambiguity:

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `memory_recall` | `query`, `overview`, `zoomRef`, `project`, `level`, `includeEvidence` | Multi-resolution retrieval: search semantically, generate all-time timeline overviews (`overview: true`), or zoom vertically into a specific investigation (`zoomRef: 42`). |
| `memory_record` | `problem`, `approaches`, `diffs`, `findings`, `outcome`, `verification` | Explicitly records an episode, bug fix, or project invariant with verified test commands. |
| `memory_review` | `ref`, `action`, `lifecycle`, `reason`, `evidenceRef` | Inspects memory evidence hierarchy (`action: "inspect"`) or transitions factual lifecycle status (`action: "update_lifecycle"`). |

*Advanced fine-grained tools (`memory_store`, `memory_scan`, `memory_think`, `memory_forget`, etc.) can be enabled via `"advancedTools": true`.*

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
| `captureMinSimilarity` | `0.6` | Cosine floor for any embedding verdict (0..1) |
| `captureMinMargin` | `0.075` | How far a "remember" verdict must beat "skip" (0..1); raise it to store less, lower it to store more |
| `captureExemplars` | `{}` | Your own example sentences, `{ "remember": [...], "skip": [...] }`, any language, merged with the shipped ones |
| `judgeFallback` | `"skip"` | Deterministic fallback when the classifier server is offline (`"skip"` or `"capture"`) |
| `autoStartAuren` | `true` | Automatically launch `axil-auren` in the background if offline |
| `autoDownloadModels` | `"manual"` | Model download policy (`"manual"` prompts for heavy models, `"auto"` downloads without prompting) |
| `semanticSearch` | `true` | Enable dense vector embeddings and semantic recall via `libsepal` |
| `embedUrl` | `"http://127.0.0.1:4242/v1/embeddings"` | Embedding generation endpoint |
| `embedModel` | `"bge-base"` | Embedding model identifier (`"bge-base"` for 768-d, `"bge-small"` for 384-d) |
| `advancedTools` | `false` | Expose the 9 advanced low-level memory inspection tools |
| `recallEmbed` | `"auto"` | Classify user prompts by embeddings (`POST /v1/classify`) to detect recall intent (`"auto"` or `"off"`). Env: `PI_MM_RECALL_EMBED` |
| `recallMinSimilarity` | `0.6` | Cosine floor for recall intent embedding classification (0..1) |
| `recallMinMargin` | `0.08` | How far a `"recall_past"` verdict must beat `"standalone"` (0..1) |
| `recallExemplars` | `{}` | Your own example sentences, `{ "recall_past": [...], "standalone": [...] }`, merged with shipped ones |
| `recallFallback` | `"regex"` | Fallback when classifier endpoint is offline: `"regex"` (deterministic heuristics) or `"skip"` |
| `recallAction` | `"hint"` | Action on recall inquiry or architectural wonder: `"hint"` (default, zero DB queries, emits epistemic hint advising agent to use `memory_recall` via inference) or `"query"` (legacy auto-injection). Env: `PI_MM_RECALL_ACTION` |
| `wonderingEmbed` | `"auto"` | Classify assistant turns and thoughts by embeddings (`POST /v1/classify`) to detect cognitive wonderings and architectural curiosity (`"auto"` or `"off"`). Env: `PI_MM_WONDERING_EMBED` |
| `wonderingMinSimilarity` | `0.6` | Cosine floor for assistant wondering embedding classification (0..1) |
| `wonderingMinMargin` | `0.08` | How far a `"wondering"` verdict must beat `"routine_action"` (0..1) |
| `directiveEmbed` | `"auto"` | Classify user prompts by embeddings (`POST /v1/classify`) to detect standing directives/rules (`"auto"` or `"off"`). Env: `PI_MM_DIRECTIVE_EMBED` |
| `directiveMinSimilarity` | `0.6` | Cosine floor for standing directive classification (0..1) |
| `directiveMinMargin` | `0.08` | How far a `"standing_directive"` verdict must beat `"transient_task"` (0..1) |
| `directiveExemplars` | `{}` | Custom examples `{ "standing_directive": [...], "transient_task": [...] }` merged with shipped ones |
| `directiveFallback` | `"regex"` | Fallback when endpoint is offline: `"regex"` or `"skip"` |
| `overviewEmbed` | `"auto"` | Classify direct memory inquiries by embeddings (`POST /v1/classify`) to detect open-ended overviews (`"auto"` or `"off"`). Env: `PI_MM_OVERVIEW_EMBED` |
| `overviewMinSimilarity` | `0.6` | Cosine floor for overview routing classification (0..1) |
| `overviewMinMargin` | `0.08` | How far an `"overview_query"` verdict must beat `"specific_query"` (0..1) |
| `overviewExemplars` | `{}` | Custom examples `{ "overview_query": [...], "specific_query": [...] }` merged with shipped ones |
| `overviewFallback` | `"regex"` | Fallback when endpoint is offline: `"regex"` or `"skip"` |
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

1. **Lifting Unprompted Suppression**: In general conversational turns without memory keywords, context injection is conservative. When `recall_past` intent is confirmed by embeddings, unprompted context filtering is lifted, allowing vector and hybrid retrieval to surface relevant memories even without exact subsystem matches.
2. **Actionable Agent Steering**: When recall intent is positive, `pi-mm` augments the agent's system prompt sections (`memory_context`) with explicit guidance directing the model to inspect `memory_recall` (and `zoomRef` if candidate records are retrieved) before guessing or invoking irrelevant bash or grep tools.
3. **Resilient Offline Fallback**: If `axil-auren` is offline or unconfigured, `pi-mm` seamlessly falls back to deterministic regex heuristics (`recallFallback: "regex"`).

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

---

## 5. Prerequisites & Core C Engines

`pi-mm` uses compiled C engines for sub-microsecond in-memory retrieval:

| Engine | Description | Build & Guide |
| :--- | :--- | :--- |
| **`libcorm`** | In-memory key-value store, unified recall kernel, and `cormd` daemon. | [libcorm](https://github.com/tty-pt/libcorm#installation--build) |
| **`libsepal`** | Pure-C Approximate Nearest Neighbor (ANN) dense vector store. | [libsepal](https://github.com/tty-pt/libsepal#installation--build) |
| **`libjoint`** | Interval-tree temporal presence engine for historical co-occurrence. | [libjoint](https://github.com/tty-pt/libjoint#installation--build) |
| **`liblemma`** | Diacritic-preserving full-text search tokenizer (`pão ≠ pao`). | [liblemma](https://github.com/tty-pt/liblemma#installation--build) |
| **`axil-auren`** | Local LLM inference, embeddings, and fast decision judging. | [axil-auren](https://github.com/tty-pt/axil-auren#installation--build) |

Prebuilt packages are available via [tty.pt packages](https://github.com/tty-pt/ci/blob/main/docs/install.md) for APT, Homebrew, and pacman.

---

## 6. Development & Verification

```bash
npm --prefix .pi/extensions/pi-mm test             # Run hermetic test suite (450+ tests)
npm --prefix .pi/extensions/pi-mm run lint         # Lint all TypeScript source and scripts
npm --prefix .pi/extensions/pi-mm run eval:recall  # Benchmark recall intent classification against live auren
npm --prefix .pi/extensions/pi-mm run eval:surfaces # Benchmark directive, overview, and kind classification
npm --prefix .pi/extensions/pi-mm run test:playbook # Non-destructive bootstrap verification playbook
npm --prefix .pi/extensions/pi-mm run demo          # Interactive live bootstrap demonstration
npm --prefix .pi/extensions/pi-mm run zip           # Package distribution bundle
```

## License

BSD 2-Clause License. Copyright (c) 2025, tty-pt. See `LICENSE`.
