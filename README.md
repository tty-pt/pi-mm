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
| `judgeMode` | `"auto"` | Decision judge protocol (`"auto"`, `"systemzero"`, `"systemone"`, `"heuristic"`, `"off"`) |
| `judgeUrl` | `"http://127.0.0.1:4242"` | Endpoint URL for the local decision judge |
| `autoStartAuren` | `true` | Automatically launch `axil-auren` in the background if offline |
| `autoDownloadModels` | `"manual"` | Model download policy (`"manual"` prompts for heavy models, `"auto"` downloads without prompting) |
| `semanticSearch` | `true` | Enable dense vector embeddings and semantic recall via `libsepal` |
| `embedUrl` | `"http://127.0.0.1:4242/v1/embeddings"` | Embedding generation endpoint |
| `embedModel` | `"bge-base"` | Embedding model identifier (`"bge-base"` for 768-d, `"bge-small"` for 384-d) |
| `advancedTools` | `false` | Expose the 9 advanced low-level memory inspection tools |

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
