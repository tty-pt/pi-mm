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
2. **Automatic Model Provisioning**: Discovers models in `~/.models/` and auto-downloads lightweight fast models (`bge-base`, `bge-small`, `qwen2.5-0.5b`) with sha256 verification, while interactively requesting consent for large MoE models (`olmoe`).
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
| `judgeMode` | `"auto"` | Decision judge mode (`"auto"`, `"systemone"`, `"heuristic"`, `"off"`) |
| `judgeProtocol` | `"systemone"` | Judge wire protocol (`"systemone"`, `"systemzero"`, `"auto"`). SystemOne (closed multiple-choice, option-letter logits) is the default because SystemZero's binary logit probe scored only 3/8 with `qwen` and 6/8 with `olmoe` on a quest-vs-chat check |
| `judgeModel` | `"olmoe"` | Model used for judge calls |
| `judgeUrl` | `"http://127.0.0.1:4242"` | Endpoint URL for the local decision judge |
| `captureMode` | `"all"`, or `"judge"` when `judgeUrl` is set in your settings | What automatic conversational capture stores: `"all"` (every user turn), `"keyword"` (only turns starting with a capture keyword), `"judge"` (turns the decision tier says are worth remembering), `"off"` |
| `captureEmbed` | `"auto"` | Classify turns by embeddings in `captureMode: "judge"` (`"off"` restores the judge-only path). Env: `PI_MM_CAPTURE_EMBED` |
| `captureEmbedUrl` | the `judgeUrl` host | Server for classification embeddings. Independent of `embedUrl`, which feeds the memory index with its own model |
| `captureEmbedModel` | `"bge-base"` | Classification embedding model (a multilingual model improves non-English recall) |
| `captureMinSimilarity` | `0.6` | Cosine floor for any embedding verdict (0..1) |
| `captureMinMargin` | `0.075` | How far a "remember" verdict must beat "skip" (0..1); raise it to store less, lower it to store more |
| `captureExemplars` | `{}` | Your own example sentences, `{ "remember": [...], "skip": [...] }`, any language, merged with the shipped ones |
| `autoStartAuren` | `true` | Automatically launch `axil-auren` in the background if offline |
| `autoDownloadModels` | `"manual"` | Model download policy (`"manual"` prompts for heavy models, `"auto"` downloads without prompting) |
| `semanticSearch` | `true` | Enable dense vector embeddings and semantic recall via `libsepal` |
| `embedUrl` | `"http://127.0.0.1:4242/v1/embeddings"` | Embedding generation endpoint |
| `embedModel` | `"bge-base"` | Embedding model identifier (`"bge-base"` for 768-d, `"bge-small"` for 384-d) |
| `advancedTools` | `false` | Expose the 9 advanced low-level memory inspection tools |

### Automatic Capture: What Decides What

`captureMode` decides **whether anything is judged at all**. Recall questions ("do you remember ...") are never captured, in any mode. In `keyword` and `judge` modes a turn that starts with a capture keyword (`@remember`, `remember:`, `note:` by default) is always stored, without consulting anything; in `all` mode every other turn is stored too.

| `captureMode` | What stores a turn | If that is unavailable |
| :--- | :--- | :--- |
| `all` | Every user turn. No judge and no embeddings are consulted. | n/a |
| `keyword` | Only turns that start with a capture keyword | n/a |
| `judge` | **Embeddings** of your message (nearest remember/skip example) | The generative judge, then `judgeFallback` (`skip` stores nothing, `capture` stores the turn) |
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
npm --prefix .pi/extensions/pi-mm test             # Run test suite (400+ tests)
npm --prefix .pi/extensions/pi-mm run test:playbook # Non-destructive bootstrap verification playbook
npm --prefix .pi/extensions/pi-mm run demo          # Interactive live bootstrap demonstration
npm --prefix .pi/extensions/pi-mm run zip           # Package distribution bundle
```

## License

BSD 2-Clause License. Copyright (c) 2025, tty-pt. See `LICENSE`.
