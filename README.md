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

You can pair `pi-mm` with [axil-auren](https://github.com/tty-pt/axil-auren) (or any compatible OpenAI / Jev System One endpoint) for private, zero-cost, local inference and embeddings.

> 📖 **Full axil-auren Documentation**: See [axil-auren README & Install Guide](https://github.com/tty-pt/axil-auren#installation--build) (or local [axil-auren/README.md](../../../axil-auren/README.md)) for installation and multi-model configuration details.

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
axil -A -d -p 4242 -m libaxil-auren
```

Verify that the local inference and embedding endpoint answers:
```bash
curl -s http://127.0.0.1:4242/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"bge-small","input":"health check"}'
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

## Prerequisites & Core C Engines

`pi-mm` leverages ultra-fast, native C engines to index and store memories with microsecond latency. Follow the official installation and build guides for each component:

| Engine | Description | Installation & Build Guide |
| :--- | :--- | :--- |
| **`libcorm`** | In-memory multidimensional key-value store, unified recall kernel, and resident `cormd` daemon. | [libcorm Installation & Build](https://github.com/tty-pt/libcorm#installation--build) |
| **`libsepal`** | Pure-C semantic Approximate Nearest Neighbor (ANN) vector store powering dense memory embeddings. | [libsepal Installation & Build](https://github.com/tty-pt/libsepal#installation--build) |
| **`libjoint`** | Interval-tree temporal presence engine for historical co-occurrence and time-window queries. | [libjoint Installation & Build](https://github.com/tty-pt/libjoint#installation--build) |
| **`liblemma`** | Diacritic-preserving full-text search tokenizer (`pão ≠ pao`) and memory-mapped inverted lexical index. | [liblemma Installation & Build](https://github.com/tty-pt/liblemma#installation--build) |
| **`axil-auren`** | Local LLM inference, OpenAI-compatible embeddings, and Jev-compatible System One decision judge. | [axil-auren Installation & Build](https://github.com/tty-pt/axil-auren#installation--build) |

### Prebuilt Package Installation & Updates

Prebuilt packages for Linux (APT / Alpine / Arch / Fedora-RHEL), macOS (Homebrew), Windows (winget / MSYS2), and OpenBSD are distributed via the [tty.pt package repository](https://github.com/tty-pt/ci/blob/main/docs/install.md).

#### Debian / Ubuntu / WSL2 (APT)
Configure the `tty.pt` APT repository and signing key:
```bash
sudo mkdir -p /etc/apt/keyrings
wget -qO- https://tty.pt/apt/keyrings/archive-key.gpg | sudo tee /etc/apt/keyrings/ttypt.asc > /dev/null
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/ttypt.asc] https://tty.pt/deb stable main" | sudo tee /etc/apt/sources.list.d/ttypt.list
```

Install or update the core memory engines and recall axes:
```bash
sudo apt update
sudo apt install -y axil libcorm libjoint liblemma libsepal
```

To install the optional local LLM inference and embeddings server (**`axil-auren`** on port 4242), enable Ubuntu's `universe` component first (needed for Vulkan and GLSL dependencies):
```bash
sudo add-apt-repository universe && sudo apt update
sudo apt install -y axil-auren
```

To update existing installations specifically:
```bash
sudo apt update
sudo apt --only-upgrade install -y axil libcorm libjoint liblemma libsepal axil-auren
```

> **Packaging Notes**:
> * **`libjoint` v1.6.1+**: In v1.6.0, internal test binaries were mistakenly included in the package bin path, colliding with `/usr/bin/test` from `coreutils`. This has been resolved in v1.6.1+ where `INSTALL_BIN` is strictly cleared.
> * **`axil-auren`**: Optional local server daemon. If `universe` is disabled, APT will report that `axil-auren` has no installation candidate. If you already use Ollama (`http://localhost:11434/v1`) or any OpenAI-compatible API for embeddings, `axil-auren` is not required.

#### macOS (Homebrew)
```bash
brew tap tty-pt/tap https://github.com/tty-pt/tap.git
brew install axil axil-auren libsepal liblemma libjoint libcorm
# To update:
brew upgrade axil axil-auren libsepal liblemma libjoint libcorm
```

#### Arch Linux (pacman)
```bash
sudo pacman-key --add <(wget -qO- https://tty.pt/pacman/key-ttypt.pub)
echo -e "\n[ttypt]\nSigLevel = Required DatabaseOptional\nServer = https://tty.pt/pacman/\$arch" | sudo tee -a /etc/pacman.conf
sudo pacman -Sy ttypt/axil ttypt/axil-auren ttypt/libsepal ttypt/liblemma ttypt/libjoint ttypt/libcorm
```

#### Fedora / RHEL (dnf)
```bash
curl -O https://tty.pt/rpm/ttypt.repo && sudo mv ttypt.repo /etc/yum.repos.d/
sudo rpm --import https://tty.pt/rpm/RPM-GPG-KEY-ttypt
sudo dnf install -y axil axil-auren libsepal liblemma libjoint libcorm
```

### Build & Update from Source

If compiling directly from source repositories:
```bash
# Prerequisites on Debian/Ubuntu:
sudo apt update && sudo apt install -y build-essential git pkg-config libcurl4-openssl-dev

# Clone or update and build each repository:
for repo in axil libcorm libjoint liblemma libsepal axil-auren; do
  if [ -d "$repo" ]; then
    echo "Updating $repo..."
    (cd "$repo" && git pull && make clean && make && sudo make install)
  else
    echo "Cloning and building $repo..."
    git clone "https://github.com/tty-pt/${repo}.git"
    (cd "$repo" && make && sudo make install)
  fi
done
sudo ldconfig
```

---

## Installation & Setup

`pi-mm` can be installed and updated like any standard Pi extension:

### Option A: Pi Extension Registry (Recommended)
Install or update via npm / Pi extension registry:
```bash
# Initial install:
pi install npm:@tty-pt/pi-mm

# Update to latest release:
pi install npm:@tty-pt/pi-mm
```

### Option B: Project-Specific Extension (Submodule or Directory)
Place or clone the extension into your repository's `.pi/extensions/` directory:
```bash
# Clone directly:
git clone https://github.com/tty-pt/pi-mm.git .pi/extensions/pi-mm

# Or add as git submodule:
git submodule add https://github.com/tty-pt/pi-mm.git .pi/extensions/pi-mm

# Update an existing clone or submodule:
git submodule update --remote .pi/extensions/pi-mm
# or:
cd .pi/extensions/pi-mm && git pull origin main
```

### Option C: Global User Extension (Available across all projects)
Place or clone the extension into your global Pi agent directory:
```bash
# Initial install:
git clone https://github.com/tty-pt/pi-mm.git ~/.pi/agent/extensions/pi-mm

# Update to latest:
cd ~/.pi/agent/extensions/pi-mm && git pull origin main
```

### Option D: Direct CLI Flag (Development)
Run directly against local source:
```bash
pi --extension .pi/extensions/pi-mm
```

---

## Configuration Reference

`pi-mm` follows standard Pi configuration conventions. Options can be defined in `.pi/settings.json` under the `"pi-mm"` (or `"mm"`) key, or overridden via environment variables.

### Global Settings Fallback
If a repository does not have a local `.pi/settings.json`, `pi-mm` automatically checks global configuration files in the following order:
1. `PI_SETTINGS_PATH` (explicit file override)
2. `${PI_CODING_AGENT_DIR}/settings.json`
3. `~/.pi/agent/settings.json`
4. `~/.pi/settings.json`

Project-level settings always override global settings on a key-by-key basis.

### Complete Options Table

| `settings.json` Key | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `cormBin` | `CORM_BIN` | *(auto)* | Path to the `corm` CLI binary. Auto-detects in `PATH` or `<cwd>/external/libcorm/bin/corm`. |
| `cormdBin` | `CORMD_BIN` | *(auto)* | Path to the `cormd` daemon binary. Auto-detects alongside `corm`, in `PATH`, or in `<cwd>/external/libcorm/bin/cormd`. |
| `socketPath` | `PI_MM_SOCKET` / `MM_SOCKET` | *(auto)* | Path to the `cormd` Unix domain socket. Defaults to `<memDir>/cormd.sock`, with automatic routing to `$XDG_RUNTIME_DIR/pi-mm/` or `/tmp/pi-mm/` on filesystems lacking AF_UNIX support (such as WSL Windows mounts under `/mnt/*` / DrvFs). |
| `runtimeDir` | `PI_MM_RUNTIME_DIR` / `MM_RUNTIME_DIR` | *(auto)* | Custom base directory for ephemeral sockets and IPC endpoints. |
| `axisLibs` | `CORM_AXIS_PATH` / `CORM_AXIS_LIBS` | *(auto)* | Colon-separated directory path for CORM axis libraries (`libjoint`, `liblemma`, `libislet`, `libsepal`). Defaults to local `<cwd>/external/lib*/lib` if present, with automatic fallback to system libraries (`/usr/lib/ttypt`, `/usr/lib`, `/usr/local/lib`). |
| `memDir` | `PI_MM_DIR` | `".pi/mm"` | Directory where memory databases, vector indexes, and association graphs are stored. |
| `scanLimit` | `PI_MM_SCAN_LIMIT` | `10` | Maximum candidate results returned per recall query. |
| `advancedTools` | `PI_MM_ADVANCED_TOOLS` | `false` | Expose 9 low-level diagnostic and maintenance tools (`memory_store`, `memory_think`, `memory_consolidate`, etc.). |
| `semanticSearch` | `PI_MM_SEMANTIC_SEARCH` / `MM_SEMANTIC_SEARCH` | `false` | Enable dense vector indexing with `libsepal` (`true` / `false`). |
| `embedUrl` | `CORM_SEPAL_EMBED_URL` | *(none)* | URL of vector embeddings endpoint (e.g. `http://127.0.0.1:4242/v1/embeddings`). Falls back to `AUREN_URL` / `QLLM_URL`. |
| `embedModel` | `CORM_SEPAL_EMBED_MODEL` | *(none)* | Model identifier for embeddings (e.g. `bge-small`). Falls back to `AUREN_MODEL`. |
| `embedKey` | `CORM_SEPAL_EMBED_KEY` | *(none)* | Optional Bearer token for remote embeddings. Falls back to `AUREN_KEY`. |
| `ephemeralSepal` | `PI_MM_SEPAL_EPHEMERAL` / `CORM_SEPAL_EPHEMERAL` | `false` | Run the Sepal vector axis purely in RAM (zero disk files created for vectors). |
| `ephemeralJoint` | `CORM_JOINT_EPHEMERAL` | `false` | Run the Joint temporal axis purely in RAM (ephemeral interval trees). |
| `captureMode` | `PI_MM_CAPTURE_MODE` / `MM_CAPTURE_MODE` | `"all"` | Automatic capture policy: `"all"` (capture technical turns), `"keyword"` (only on trigger prefixes), `"judge"` (System One classification), or `"off"`. |
| `captureKeyword` | `PI_MM_CAPTURE_KEYWORD` / `MM_CAPTURE_KEYWORD` | `"@remember"` | Primary trigger word bypassing judge to store memory immediately. |
| `captureKeywords` | `PI_MM_CAPTURE_KEYWORDS` / `MM_CAPTURE_KEYWORDS` | `["@remember", "@memory", "remember:", "note:"]` | Array of trigger word families that immediately save memory. |
| `judgeMode` | `PI_MM_JUDGE_MODE` / `MM_JUDGE_MODE` | `"auto"` | Strategy for decision judge: `"auto"` (use judge if reachable), `"heuristic"` (local regex), or `"off"`. |
| `judgeUrl` | `PI_MM_JUDGE_URL` / `MM_JUDGE_URL` / `JEV_URL` | *(none)* | URL of System One judge (e.g. `http://127.0.0.1:4242`). Falls back to `AUREN_URL`. |
| `judgeModel` | `PI_MM_JUDGE_MODEL` / `MM_JUDGE_MODEL` / `JEV_MODEL` | `"qwen"` | Model identifier for decision judging. Falls back to `AUREN_MODEL`. |
| `judgeKey` | `PI_MM_JUDGE_KEY` / `MM_JUDGE_KEY` / `JEV_KEY` | *(none)* | Optional Bearer auth token for remote endpoints. Falls back to `AUREN_KEY`. |
| `judgeTimeoutMs` | `PI_MM_JUDGE_TIMEOUT_MS` / `MM_JUDGE_TIMEOUT_MS` | `15000` | Abort timeout in milliseconds for judge evaluation. |
| `judgeFallback` | `PI_MM_JUDGE_FALLBACK` / `MM_JUDGE_FALLBACK` | `"skip"` | Fallback on judge service failure: `"skip"` (fail closed) or `"capture"`. |
| `consolidateL2Threshold` | `PI_MM_CONSOLIDATE_L2_THRESHOLD` / `MM_CONSOLIDATE_L2_THRESHOLD` | `3` | Number of related episodes required to trigger L2 semantic invariant consolidation. |
| `consolidateL3Threshold` | `PI_MM_CONSOLIDATE_L3_THRESHOLD` / `MM_CONSOLIDATE_L3_THRESHOLD` | `2` | Number of verified L2 invariants required to trigger L3 architectural model synthesis. |
| `consolidateMaxAgeHours` | `PI_MM_CONSOLIDATE_MAX_AGE_HOURS` / `MM_CONSOLIDATE_MAX_AGE_HOURS` | *(none)* | Maximum age of memories considered for batch consolidation. |
| `consolidateBatchLimit` | `PI_MM_CONSOLIDATE_BATCH_LIMIT` / `MM_CONSOLIDATE_BATCH_LIMIT` | `20` | Maximum candidate memories consolidated in a single run. |
| `synthUrl` | `PI_MM_SYNTH_URL` / `MM_SYNTH_URL` | *(none)* | OpenAI-compatible chat completion URL for memory consolidation synthesis. |
| `synthModel` | `PI_MM_SYNTH_MODEL` / `MM_SYNTH_MODEL` | *(none)* | Model identifier for memory consolidation synthesis. |
| `synthKey` | `PI_MM_SYNTH_KEY` / `MM_SYNTH_KEY` | *(none)* | Bearer authorization key for memory consolidation synthesis. |
| `synthTimeoutMs` | `PI_MM_SYNTH_TIMEOUT_MS` / `MM_SYNTH_TIMEOUT_MS` | `15000` | Abort timeout in milliseconds for consolidation LLM synthesis. |
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

## Diagnostic & Timeline Commands (`/mm doctor`, `/mm overview`, `/mm timeline`)

Run `/mm doctor`, `/mm status`, `/mm overview`, `/mm timeline`, or `/mm` in Pi to inspect real-time memory health, storage metrics, and operational history:

### 1. Health Diagnostics (`/mm doctor` or `/mm status`)
```text
/mm doctor
```
Reports:
* **Decision Judge Connectivity**: Status (200 OK or OFFLINE), active endpoint URL, latency in ms, and detected models.
* **Embeddings Endpoint**: Vector endpoint status, latency, or disabled/unconfigured state.
* **Pipeline Capabilities**: Active configuration description (`capture`, `judge`, `semantic`, `lemma`).
* **Trigger Word Families**: Configured trigger word markers (`@remember`, `@memory`, etc.).
* **Primary Storage Health**: Exact size of `mem.db` in KB, byte count, and HTOK null-byte density percentage.
* **Secondary Axis Modes**: Joint temporal axis (persistent vs ephemeral in-memory), Sepal vector axis (ephemeral zero-disk mode vs persistent file), and embed cache binary size.
* **Epistemic Roster**: Total indexed record count across memory tiers.

### 2. All-Time Timeline Overview (`/mm overview` or `/mm timeline`)
```text
/mm overview
```
Reports:
* **Operational Span**: Earliest to latest active operational dates across recorded sessions.
* **Tier Distribution**: Counts of principles (L3), invariants (L2), task milestones (L1), and raw observations (L0).
* **Universal Principles (L3)**: High-level architectural heuristics and lessons learned.
* **Invariants & Decisions (L2)**: Active system-wide architectural rules and project constraints.
* **Timeline Epochs**: Chronological grouping of memory activity by date/epoch with key highlights.

---

## Agent Tools

### The Essential 3 (Active by Default)

By default, `pi-mm` exposes only 3 high-level tools to keep the model's context window clean and avoid tool ambiguity:

### 1. `memory_recall`
Multi-resolution memory retrieval: search semantically across topics, generate all-time high-level overviews, or zoom in to inspect specific memory investigations, approaches, diffs, and evidence trees.
- **`query`**: Natural-language question, topic, error message, or symbol. Omit or pass `"overview"` to generate an all-time high-level memory overview. Inline shorthand queries like `ref:42` or `zoom:42` automatically delegate to vertical zoom-in.
- **`overview`**: When `true`, synthesizes a structured timeline and hierarchical overview of active principles (L3), invariants (L2), milestones (L1), and chronological epochs across all operational time.
- **`zoomRef`**: Reference number of a specific memory to drill down into vertically. Returns full problem description, attempted approaches (worked/failed/abandoned), diffs, findings, outcomes, and full upward/downward evidence trees.
- **`project`** / **`subsystem`**: Optional scope filters to boost matching memories.
- **`level`**: Optional resolution filter (`'L0'`, `'L1'`, `'L2'`, `'L3'`).
- **`includeEvidence`**: When `true`, automatically fetches and attaches the full underlying evidence tree (diffs, shell commands, prior investigations).
- **`limit`**: Maximum number of memories to return (default 5 for search, 15 for overview, max 30).

### 2. `memory_record`
Explicitly records a resolved task, bug fix, or project invariant.
- **`problem`**: Description of what was addressed or investigated.
- **`approaches`**: List of attempted solutions with outcome (`"worked"`, `"failed"`, or `"abandoned"`) and reason.
- **`diffs`**: Associated git diffs, file edits, or terminal commands.
- **`evidence`**: Supporting memory reference IDs.
- **`verification`**: Verified test commands (`testsPassed: string[]`) and verified diff confirmation.

### 3. `memory_review`
Reviews memory hierarchies and manages factual confidence.
- **`ref`**: Memory reference number to inspect or review.
- **`action: "inspect"`**: Returns full episode details, approaches, and downward evidence trees.
- **`action: "update_lifecycle"`**: Updates confidence lifecycle (`tested`, `supported`, `contradicted`, `superseded`) with required justification and evidence validation.

---

### The Advanced 9 Tools (Enabled via `advancedTools: true`)

Set `"advancedTools": true` in settings or export `PI_MM_ADVANCED_TOOLS=1` to expose fine-grained memory management tools:

| Advanced Tool | Parameters | Description |
| :--- | :--- | :--- |
| `memory_store` | `content`, `level`, `tags`, `project`, `subsystem`, `lifecycle`, `source` | Stores a raw memory block directly into `libcorm` with explicit level (L0-L3) and epistemic metadata. |
| `memory_scan` | `pattern`, `level`, `lifecycle`, `limit`, `project`, `subsystem` | Linear memory scan filtering on token substrings, level, and lifecycle status. |
| `memory_think` | `prompt`, `depth`, `temperature` | Multi-hop associative reasoning and spreading activation across domain concepts. |
| `memory_forget` | `ref`, `reason` | Soft deletes or tombstones a memory record from active recall. |
| `memory_reset` | `confirm: true` | Clears all memory databases and resets the `cormd` store. |
| `memory_traverse` | `startRef`, `maxHops`, `direction` | Graph traversal across concept co-occurrence edges and memory association networks. |
| `memory_lifecycle` | `action`, `refs`, `targetLifecycle`, `reason` | Bulk transition or query lifecycle confidence across memory cohorts. |
| `memory_feedback` | `ref`, `signal: "positive" \| "negative"`, `note` | Records reinforcement / reward feedback signals to adjust ranking salience. |
| `memory_consolidate` | `batchLimit`, `targetLevel`, `maxAgeHours` | Manually triggers offline consolidation of L1 episodes into L2 invariants and L3 models. |

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
