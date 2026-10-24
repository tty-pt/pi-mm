<p align="center">
  <img src="cover.png" alt="pi-mm cover banner" width="100%">
</p>

<p align="center">
  <strong>Persistent, Hierarchical Recall & Memory Mipmaps for Pi Coding Agent</strong>
</p>

<p align="center">
  <a href="https://github.com/earendil-works/pi-coding-agent"><img src="https://img.shields.io/badge/Pi-Extension-19c7d4?logo=circle" alt="Pi Extension"></a>
  <a href="https://www.npmjs.com/package/@tty-pt/pi-mm"><img src="https://img.shields.io/npm/v/@tty-pt/pi-mm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/License-BSD--2--Clause-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/Storage-libcorm-16A34A" alt="libcorm">
  <img src="https://img.shields.io/badge/Judge-Jev%20System%20One-FF6B35" alt="Jev System One">
  <img src="https://img.shields.io/badge/Vector-libsepal%20ANN-008080" alt="libsepal">
</p>

# pi-mm: Intelligent Persistent Memory for Pi Coding Agent

`pi-mm` gives your [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) long-term memory that survives context compaction and cross-session restarts.

It combines native C database speed (`libcorm`) with intelligent decision judging (Jev System One) and dense vector embeddings (`libsepal`). By default, it operates completely autonomously: it injects relevant prior memories into context before each turn and captures new knowledge when tasks settle—without requiring manual tool calls.

---

## How It Works in Pi

`pi-mm` hooks directly into the standard Pi extension lifecycle:

1. **Before Agent Starts (`before_agent_start`)**:  
   When you send a prompt, `pi-mm` runs a hybrid search across lexical keywords ([liblemma](https://github.com/tty-pt/liblemma)) and vector embeddings ([libsepal](https://github.com/tty-pt/libsepal)). Relevant memories are automatically injected into the prompt context.
2. **When the Turn Concludes (`agent_settled`)**:  
   When the agent finishes its response, `pi-mm` evaluates the exchange using an intelligent judge to decide whether to `remember`, `update`, or `skip`. Meaningful technical conclusions and learnings are cleanly summarized and persisted to disk.
3. **Agent Tools**:  
   When the agent needs to explicitly search, record, or verify memories, it has access to a focused **3-tool workflow**: `memory_recall`, `memory_record`, and `memory_review`.

---

## Quickstart: Pair with Local `axil-auren` (60 Seconds)

You can pair `pi-mm` with [axil-auren](https://github.com/tty-pt/auren) (or any compatible OpenAI / Jev System One endpoint) for private, zero-cost, local inference and embeddings.

> 📖 **Full axil-auren Documentation**: See [auren README](https://github.com/tty-pt/auren) (or local [auren/README.md](../../../auren/README.md)) for installation and multi-model configuration details.

### 1. Download Fast GGUF Models (~530 MB total)

```bash
mkdir -p ~/.models

# Generative Chat & System One Judge (398 MB)
curl -L -o ~/.models/qwen2.5-0.5b-instruct.gguf \
  https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf

# Semantic Vector Embeddings (133 MB)
curl -L -o ~/.models/bge-small-en-v1.5.gguf \
  https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf
```

### 2. Start the `axil-auren` Multi-Model Daemon

```bash
AUREN_JUDGE_MODEL="qwen" \
AUREN_JUDGE_PATH=~/.models/qwen2.5-0.5b-instruct.gguf \
AUREN_CHAT_MODEL="qwen" \
AUREN_CHAT_PATH=~/.models/qwen2.5-0.5b-instruct.gguf \
AUREN_EMBED_MODEL="bge-small" \
AUREN_EMBED_PATH=~/.models/bge-small-en-v1.5.gguf \
axil -A -d -p 4242 -m $HOME/auren/lib/libaxil-auren
```

### 3. Enable in Pi

Add the configuration to your project's `.pi/settings.json` (or user `~/.pi/agent/settings.json`):

```json
{
  "pi-mm": {
    "judgeMode": "auto",
    "judgeUrl": "http://127.0.0.1:4242",
    "judgeModel": "qwen",
    "embedUrl": "http://127.0.0.1:4242/v1/embeddings",
    "embedModel": "bge-small",
    "semanticSearch": true
  }
}
```

Start Pi and test it:
```bash
pi
```
When you talk to Pi, `pi-mm` will automatically classify technical decisions with Qwen and generate 384-dimensional dense vectors with BGE for instant semantic recall in future sessions!

---

## Installation & Setup

`pi-mm` can be installed like any standard Pi extension:

### Package Installation (Recommended)
Install via npm / Pi extension registry:
```bash
pi install npm:@tty-pt/pi-mm
```

### Project-Specific Clone
Place or clone the extension into your repository's `.pi/extensions/` directory:
```bash
git clone https://github.com/tty-pt/pi-mm.git .pi/extensions/pi-mm
```

### Global User Extension
Place or clone the extension into your global Pi agent directory:
```bash
git clone https://github.com/tty-pt/pi-mm.git ~/.pi/agent/extensions/pi-mm
```

### Direct CLI Flag
Run directly during development:
```bash
pi --extension .pi/extensions/pi-mm
```

---

## Configuration Reference

`pi-mm` follows standard Pi configuration conventions. Options can be defined in `.pi/settings.json` under the `"pi-mm"` key or overridden via environment variables.

| `settings.json` Key | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `judgeMode` | `PI_MM_JUDGE_MODE` | `"auto"` | `"auto"` (use judge if reachable), `"heuristic"` (local regex), or `"off"`. |
| `judgeUrl` | `PI_MM_JUDGE_URL` | *(none)* | URL of System One judge (e.g. `http://127.0.0.1:4242`). |
| `judgeModel` | `PI_MM_JUDGE_MODEL` | `"qwen"` / `"default"` | Model identifier for decision judging. |
| `judgeKey` | `PI_MM_JUDGE_KEY` | *(none)* | Optional Bearer auth token for remote endpoints. |
| `judgeTimeoutMs` | `PI_MM_JUDGE_TIMEOUT_MS` | `15000` | Abort timeout in milliseconds for judge evaluation. |
| `judgeFallback` | `PI_MM_JUDGE_FALLBACK` | `"skip"` | Fallback on service failure: `"skip"` or `"capture"`. |
| `captureKeywords` | `PI_MM_CAPTURE_KEYWORDS` | `["@remember", "@memory", "remember:", "note:"]` | Trigger word families that bypass the judge and immediately save memory. |
| `embedUrl` | `CORM_SEPAL_EMBED_URL` | *(none)* | URL of vector embeddings endpoint (e.g. `http://127.0.0.1:4242/v1/embeddings`). |
| `embedModel` | `CORM_SEPAL_EMBED_MODEL` | *(none)* | Model identifier for embeddings (e.g. `bge-small`). |
| `embedKey` | `CORM_SEPAL_EMBED_KEY` | *(none)* | Optional Bearer token for remote embeddings. |
| `semanticSearch` | `PI_MM_SEMANTIC_SEARCH` | `false` | Enable dense vector indexing with `libsepal` (`true` / `false`). |
| `memDir` | `PI_MM_DIR` | `".pi/mm"` | Directory where memory databases and logs are stored. |
| `scanLimit` | `PI_MM_SCAN_LIMIT` | `10` | Maximum candidate results returned per recall query. |
| `advancedTools` | `PI_MM_ADVANCED_TOOLS` | `false` | Expose 9 low-level diagnostic tools (`memory_store`, `memory_think`, etc.). |
| *(diagnostics)* | `PI_MM_DEBUG_MEMORY` | `0` | Set `1` to enable structured lifecycle diagnostics and JSONL tracing to stderr. |
| *(diagnostics)* | `PI_MM_TRACE_FILE` | `"/tmp/pi_mm_trace.jsonl"` | Filepath for appending shared JSONL lifecycle events across processes. |
| *(diagnostics)* | `PI_MM_RUN_ID` | *(auto-generated)* | Correlates diagnostic trace events across separate processes in a test run. |

---

## Cognitive Memory Architecture

`pi-mm` models human memory dynamics through four pragmatic mechanisms:

### 1. Flashbulb Memory Anchors (`FLAG_IS_ANCHOR = 0x08`)
* Highly salient experiences (explicit `@remember` notes, multi-attempt breakthrough fixes, and user background stories) are permanently stamped with an anchor bit in the HTOK v4 binary header.
* Anchors receive an automatic **$+25\%$ salience multiplier** in hybrid ranking and are protected from temporal decay or window pruning.

### 2. Associative Co-occurrence Graph (`associations.json`)
* As the agent works, `pi-mm` tracks co-occurring domain entities in an atomic association graph (`.pi/mm/associations.json`).
* Implements **lateral spreading activation**: searching for `"airplanes"` proactively expands the candidate pool to include associated terms like `"grandpa"`, activating related memories without requiring verbatim keyword overlap.

### 3. Proactive Subsystem Invariant Priming
* When you mention project subsystems or file paths in your prompt (e.g. `mods/song`, `libcorm`), `pi-mm` proactively retrieves active L2 architectural rules and invariants before turn evaluation.
* The rules are injected as `[Primed Subsystem Invariants]` so the agent is immediately aware of domain constraints.

### 4. User Persona & Engineering Tenets
* Personal preferences, architectural tenets, and biographical context are segregated under `context: { project: "user" }`.
* Injected into prompts as `[User Persona & Engineering Tenets]` with strict token budget deduction, giving the agent authentic continuity across sessions.

---

## Diagnostic Commands (`/mm doctor`)

Run `/mm doctor` (or `/mm status`) in Pi to inspect real-time memory health and storage metrics:
```text
/mm doctor
```
Reports:
* **Primary Storage Health**: Physical size of `mem.db`, record counts, and exact HTOK null-byte density.
* **Secondary Axis Modes**: Joint temporal axis (persistent vs ephemeral in-memory), Sepal vector axis (ephemeral zero-disk mode vs persistent file), and embed cache binary size.
* **Endpoint Telemetry**: Live connectivity and latency for Jev System One judge and Sepal embeddings.
* **Trigger Words & Invariants**: Active trigger word families and capability pipeline status.

---

## Agent Tools (The Essential 3)

By default, `pi-mm` exposes only 3 high-level tools to keep the model's context window clean and avoid tool ambiguity:

### 1. `memory_recall`
Performs hybrid search fusing keyword matches ([libstoma](https://github.com/tty-pt/site/tree/main/external/libstoma)) and vector similarity ([libsepal](https://github.com/tty-pt/site/tree/main/external/libsepal)) via Reciprocal Rank Fusion ($k=60$).
- **`query`**: Natural-language question, topic, error message, or symbol.
- **`project`** / **`subsystem`**: Optional scope filters to boost matching memories.
- **`includeEvidence`**: When `true`, automatically fetches and attaches the full underlying evidence tree (diffs, shell commands, prior investigations).

### 2. `memory_record`
Explicitly records a resolved task, bug fix, or project invariant.
- **`problem`**: Description of what was addressed or investigated.
- **`approaches`**: List of attempted solutions with outcome (`"worked"`, `"failed"`, or `"abandoned"`) and reason.
- **`diffs`**: Associated git diffs, file edits, or terminal commands.
- **`evidence`**: Supporting memory reference IDs.
- **`verification`**: Verified test commands (`testsPassed: string[]`).

### 3. `memory_review`
Reviews memory hierarchies and manages factual confidence.
- **`action: "inspect"`**: Returns full episode details, approaches, and downward evidence trees.
- **`action: "update_lifecycle"`**: Updates confidence lifecycle (`tested`, `supported`, `contradicted`, `superseded`) with required justification and evidence validation.

---

## Design Guarantees: Private, Resilient, & Offline-First

* **Zero Lock-In & Offline-First**: Lexical search, temporal indexing, and storage run entirely locally in compiled C (`libcorm`). No cloud account or external connection is required.
* **Graceful Degradation**: If your LLM daemon is offline or restarting, `pi-mm` never crashes Pi. It marks `degraded: true` and falls back to deterministic local sentence heuristics.
* **Strict Directive Precedence**: When a user explicitly says *"remember this: ..."* or *"forget that"*, `pi-mm` immediately honors the command, bypassing LLM judge evaluation.
* **Epistemic Safety**: Memories cannot be arbitrarily marked as verified facts without proof. Automated records remain `tested` until backed by valid test execution evidence.

---

## Development & Testing

```bash
make -C .pi/extensions/pi-mm test     # Run all 250 unit and integration tests
make -C .pi/extensions/pi-mm lint     # Check formatting and linting
make -C .pi/extensions/pi-mm zip      # Package pi-mm-bundle.zip
```

## License

BSD 2-Clause License. Copyright (c) 2025, tty-pt. See `LICENSE`.
