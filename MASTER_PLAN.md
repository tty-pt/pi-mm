# Master Implementation Plan: High-Density, Autonomous Memory Space (`pi-mm`)

> **Status:** Draft Architectural Blueprint & Engineering Specification  
> **Target Subsystem:** `pi-mm` (TypeScript Extension + C Kernel: `libcorm`, `liblemma`, `libsepal`, `libjoint`)  
> **Scope:** Architecture, Storage, Retrieval, Lifecycle, and Operational Reliability

---

## 1. Executive Summary & Forensic Baseline

The `pi-mm` extension implements persistent, hierarchical memory mipmaps for the Pi Coding Agent using multidimensional retrieval kernels. Memories exist as structured epistemic experiences across four mipmap tiers:
- **L0 (Immediate / Event)**: Raw tool executions, failure traces, verification confirmations.
- **L1 (Investigation / Story)**: Contextual task narratives, multi-turn conclusions, and user-shared background.
- **L2 (Scope Knowledge / Rules)**: Synthesized project milestones, domain architectural invariants, and negative constraints.
- **L3 (Universal Principles)**: Cross-scope generalizations and cross-cutting systems principles.

Following the successful rollout of **HTOK v4** (which eliminated 88.4% of payload null bytes and introduced 1-byte triad packing and tagged field enums) and **in-memory ephemeral vector stores** in `libsepal`, this document details the engineering specifications and master implementation plan for the next evolution of `pi-mm`.

---

## 2. The Five Target Dimensions

```
   ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
   │                               DIMENSION 5: OPERATIONAL RELIABILITY                               │
   │   • Comprehensive `/mm doctor` CLI diagnostic suite & real-time health telemetry                 │
   │   • Deterministic offline session replay simulator (`scripts/replay_session.ts`)                 │
   ├──────────────────────────────────────────────────────────────────────────────────────────────────┤
   │                               DIMENSION 4: EPISTEMIC LIFECYCLE & STATE                           │
   │   • Non-blocking asynchronous L2/L3 synthesis queue with bounded capacity & drain registry      │
   │   • Explicit Negative Rules & Constraint Invariants (`constraints` schema)                       │
   ├──────────────────────────────────────────────────────────────────────────────────────────────────┤
   │                               DIMENSION 3: CONTEXT INJECTION & AUTO-RECALL                       │
   │   • Prompt-Adaptive Guidance Compression (free 310 chars of budget for direct recall queries)    │
   │   • Whitespace & stemming normalization in auto-recall trigger detection                         │
   ├──────────────────────────────────────────────────────────────────────────────────────────────────┤
   │                               DIMENSION 2: RETRIEVAL ENGINE & HYBRID RANKING                     │
   │   • Parallelized multi-token fallback (Promise.all cuts fallback latency from ~50ms to ~10ms)    │
   │   • Wire `isCodeOrDocArtifact` into candidate ranking to eliminate code chatter                  │
   │   • Candidate-pool adaptive RRF smoothing constant (k dynamically scaled to candidate count)     │
   │   • 8-Bit Scalar Quantization (SQ8) in `libsepal` (75% RAM reduction + portable scalar fallback) │
   ├──────────────────────────────────────────────────────────────────────────────────────────────────┤
   │                               DIMENSION 1: STORAGE KERNEL & IPC PROTOCOL                         │
   │   • Direct Binary Invocation Protocol (eliminate `bytesToBinaryString` heap roundtrip)           │
   │   • Complete Single-File Purity: In-memory ephemeral temporal axis (`libjoint`)                 │
   │   • Physical contiguous page defragmentation & compaction (`corm vacuum`)                        │
   └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Deep Architectural Specifications

### 3.1. Dimension 1: Storage Kernel & IPC Streamlining

#### 3.1.1. Native Binary Invocation Protocol (`src/corm.ts`, `src/daemon.ts`)
* **Problem**: In `src/corm.ts:101-109`, binary `Uint8Array` payloads are converted to Latin-1 strings via `bytesToBinaryString()`, concatenated into `-p <ref>:<payloadStr>`. `src/daemon.ts:175-188` then parses the string via `colonIdx` and re-encodes it to bytes for IPC socket transmission.
* **Specification**:
  1. Add typed invocation fields:
     ```ts
     export interface Invocation {
       command: string;
       args: string[];
       env: Record<string, string>;
       cwd: string;
       payloadBytes?: Uint8Array;
       ref?: number;
       filespec?: string;
     }
     ```
  2. `buildStoreInvocation(bin, filespec, ref, payload, axes, memDir, extraEnv)` stores `payloadBytes` directly when passed a `Uint8Array`.
  3. `formatProtocolCommand(inv, reqId)` reads `inv.payloadBytes` and `inv.ref` directly, skipping string parsing and Latin-1 conversions.
* **Target Metric**: Zero stringification heap allocations for binary payloads; 100% test compatibility in `tests/daemon.test.ts`.

#### 3.1.2. Complete Single-File Purity: In-Memory Ephemeral `joint` Axis (`external/libjoint`)
* **Problem**: `mem.db-joint` creates a persistent secondary file on disk, requiring multi-file synchronization and recovery.
* **Specification**:
  1. Add `CORM_JOINT_EPHEMERAL=1` flag and `ephemeralJoint?: boolean` in `MmConfig` (opt-in with persistent disk fallback to preserve full backward compatibility).
  2. In `libjoint`'s `rec_axis_open(spec)`:
     - When `CORM_JOINT_EPHEMERAL=1`, call `corm_open(NULL)` to initialize an in-memory anonymous interval tree.
     - Discover primary database path via `CORM_AXIS_PRIMARY` or alongside-spec suffix stripping (`<primary>-joint` $\rightarrow$ `<primary>`).
     - Iterate primary records using `corm_iter`, extract the native 4-byte Unix epoch timestamp from HTOK v4 header byte offset 6, and insert intervals into RAM.
  3. **Performance Benchmark Requirement**: Cold-boot interval tree reconstruction must be verified $\le 5\text{ ms}$ for databases with $\ge 1,000$ records.
* **Target Metric**: Single-file storage purity on disk (`mem.db` as the sole persistent database file).

#### 3.1.3. Contiguous Page Defragmentation (`corm vacuum`)
* **Problem**: Updates and replacements can leave fragmented sparse pages in `libcorm`.
* **Specification**:
  1. Add `corm_vacuum(uint32_t hd, const char *out_path)` in `libcorm`.
  2. Iterates active keys via `corm_iter`, allocating contiguous records in a new database file, followed by an atomic rename.
  3. Integrate into `scripts/compact_db.ts`.

---

### 3.2. Dimension 2: Retrieval Engine & Hybrid Ranking

#### 3.2.1. Concurrent Multi-Token Fallback (`src/tools/scan.ts:80-110`)
* **Problem**: `scanTokenFallback` executes up to 6 individual token sub-queries sequentially:
  ```ts
  for (const w of words.slice(0, 6)) {
    const subRes = await env.runner.run(buildScanInvocation(...));
  }
  ```
* **Specification**:
  1. Refactor sequential loop to parallel execution:
     ```ts
     const subPromises = words.slice(0, 6).map(async (w) => {
       const subArgs = [
         ...scanWindowArgs(timeLevel, now, until),
         "--field=text", "--matched=1", "--query=" + w,
       ];
       return env.runner.run(buildScanInvocation(bin, filespecFor(cwd, false), expr, limit, axes, cwd, undefined, subArgs));
     });
     const results = await Promise.all(subPromises);
     ```
  2. Aggregate and deduplicate matches preserving first-seen rank order.
* **Target Metric**: Fallback latency drops from $\sim 50\text{ ms}$ to $\le 10\text{ ms}$.

#### 3.2.2. Activating `isCodeOrDocArtifact` in Candidate Filtering (`src/tools/ranking.ts:34`)
* **Problem**: `isCodeOrDocArtifact` is defined in `ranking.ts` but never called in `filterAndEnrich`.
* **Specification**:
  1. In `filterAndEnrich()`, evaluate `isCodeOrDocArtifact(cand, envelope)`:
     - When query is conversational or when `crit.mipmap` is not explicitly `L0`: Apply a $0.2\times$ downranking penalty to syntax artifacts, preventing code noise from polluting conversational memory retrieval.
* **Target Metric**: 0 code definition / `#include` artifacts returned for conversational inquiries.

#### 3.2.3. Candidate-Pool Adaptive RRF Smoothing ($k$)
* **Problem**: Fixed $k = 60$ creates negligible score differences ($1.6\%$) on small candidate pools ($< 50$ records).
* **Specification**:
  1. Calculate dynamic smoothing parameter:
     $$k = \max(10, \min(60, |\text{candidates}| \times 2))$$
  2. **Boundary Testing**: Explicitly test and assert safety for $|\text{candidates}| = 0$ ($k=10$) and $|\text{candidates}| = 1$ ($k=10$), ensuring no division by zero or negative denominators.
* **Target Metric**: Score separation between top-1 and top-2 candidates increases from $\approx 1.6\%$ to $\ge 15\%$ on small memory sets.

#### 3.2.4. 8-Bit Scalar Quantization (SQ8) in `libsepal` (`external/libsepal/src/libsepal.c`)
* **Problem**: Vectors consume 3,072 bytes per record (768 floats $\times$ 4 bytes), consuming ~3 MB RAM per 1,000 in-memory records.
* **Specification**:
  1. Quantize 32-bit floats into signed 8-bit integers:
     $$\text{scale} = \frac{\max(v) - \min(v)}{254}, \quad q_i = \text{round}\left(\frac{v_i - \min(v)}{\text{scale}}\right) - 127$$
  2. Vector storage layout: `[min: float32] [scale: float32] [int8_t bytes: dim]`.
  3. Fast Dot Product Math:
     - **AVX2 SIMD Path**: Uses `_mm256_maddubs_epi16` and `_mm256_hadd_epi32` for 32 operations per cycle.
     - **Portable Scalar Fallback Path**: Standard integer loop accumulator (`int32_t sum += a[i] * b[i]`) when AVX2 is absent at compile/run time.
* **Target Metric**: In-memory vector footprint reduced by **75%** (from 3,072 to 776 bytes per record); cosine rank correlation $\ge 0.99$.

---

### 3.3. Dimension 3: Context Injection & Auto-Recall Dynamics

#### 3.3.1. Prompt-Adaptive Guidance Compression (`src/hooks/auto_recall.ts:100-130`)
* **Problem**: A static 310-character guidance block is injected into prompt context even on direct memory questions (*"What do you remember?"*), consuming 20% of the character budget and providing contradictory instructions.
* **Specification**:
  1. In `buildInjectedContext()`, evaluate `isQuestionMemory(prompt)`:
     - When `isQuestionMemory(prompt) === true`: Omit the 310-character behavioral boilerplate.
     - When `isQuestionMemory(prompt) === false`: Include the concise boundary instructions for operational turns.
* **Target Metric**: Direct memory inquiries receive up to 310 additional characters of high-signal memories and transcript excerpts.

#### 3.3.2. Trigger Normalization in `shouldTriggerAutoRecall`
* **Specification**:
  1. Normalize input with whitespace and punctuation trimming.
  2. Exclude common single-word acknowledgments and affirmations with variant punctuation.

---

### 3.4. Dimension 4: Epistemic State Machine & Lifecycle Safety

#### 3.4.1. Asynchronous Non-Blocking Consolidation (`src/hooks/events.ts`)
* **Problem**: `runAutoConsolidation` runs synchronously within `onTurnEnd` and `agent_settled`. L2/L3 synthesis HTTP chat completions block the agent loop for 1–2 seconds.
* **Specification**:
  1. Decouple L2/L3 synthesis into an asynchronous queue:
     - `onTurnEnd` and `agent_settled` record dirty scope transitions in `.consolidation.json` in $O(1)$ time ($< 15\text{ ms}$).
     - Background synthesis runs out-of-band via tracked promises.
  2. **Session Drain Registry**:
     - Implement `SessionDrainRegistry`: tracks active background promises.
     - Before process exit or CLI test runner termination, await `SessionDrainRegistry.drain(timeoutMs: 5000)` to ensure all pending journal writes finish cleanly without unhandled promise rejections.
  3. **Queue Capacity & Backpressure Policy**:
     - Maximum queue capacity: **50 scopes**.
     - If dirty queue exceeds 50 scopes under high-throughput batch runs, apply oldest-unmodified scope prioritization and drop transient duplicate triggers.
* **Target Metric**: Agent turn settlement latency $\le 15\text{ ms}$ (eliminating the 1–2s freeze).

#### 3.4.2. Structured Negative Knowledge & Constraints (`src/types.ts`)
* **Specification**:
  1. Add `constraints?: string[]` to `EpisodeRecord` and `MemoryEnvelope`.
  2. Update L2 synthesis prompt to extract explicit "Do NOT" rules from failed approaches.
  3. When injecting context, render negative constraints with prominent `[RESTRICTION]` markers.

---

### 3.5. Dimension 5: Operational Reliability, Tooling & Verification

#### 3.5.1. Comprehensive `/mm doctor` CLI & Health Suite
* **Specification**:
  1. Implement structured diagnostic inspection reporting:
     - Primary storage: record count, physical byte size, HTOK null-byte density.
     - Secondary axes: Lemma (docs indexed), Joint (persistent vs in-memory mode), Sepal (vector count, in-memory RAM, embed cache hit rate).
     - Epistemic lifecycle distribution: count of L0, L1, L2, L3 records; ratio of `supported` vs `observed`.

#### 3.5.2. Deterministic Offline Session Replay Simulator (`scripts/replay_session.ts`)
* **Specification**:
  1. CLI utility that reads a session JSONL transcript and simulates:
     - `isInformativeExecution()` noise-gate filtering.
     - `summarizeToolEvent()` approach extraction.
     - Epistemic state assignment.
  2. Prints a before/after diff of memories that would be committed, enabling regression-free testing of noise filters.

---

## 4. Master Phased Implementation Roadmap

```
  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
  │ PHASE 1: Storage Kernel & IPC Streamlining                                                      │
  │ • Direct binary Invocation refactoring (corm.ts & daemon.ts)                                    │
  │ • Ephemeral libjoint in-memory mode (opt-in + persistent fallback)                              │
  │ • corm_vacuum contiguous page defragmentation in scripts/compact_db.ts                          │
  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ PHASE 2: Retrieval Engine & Hybrid Ranking                                                       │
  │ • Promise.all concurrent token fallback in scanTokenFallback (scan.ts)                          │
  │ • Wire isCodeOrDocArtifact into filterAndEnrich (ranking.ts)                                    │
  │ • Adaptive RRF smoothing constant k (ranking.ts) with |cands|=0,1 edge cases                   │
  │ • 8-Bit Scalar Quantization (SQ8) in libsepal.c (AVX2 SIMD + portable scalar fallback)          │
  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ PHASE 3: Context Injection & Auto-Recall Dynamics                                                │
  │ • Prompt-adaptive guidance compression via isQuestionMemory (auto_recall.ts)                    │
  │ • Trigger normalization & whitespace/punctuation cleaning (auto_recall.ts)                       │
  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ PHASE 4: Epistemic State Machine & Lifecycle Safety                                              │
  │ • Non-blocking async consolidation queue with SessionDrainRegistry & max 50 capacity (events.ts) │
  │ • Structured constraints schema & negative rule synthesis (types.ts & synth/adapter.ts)         │
  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ PHASE 5: Operational Reliability, Tooling & Verification                                         │
  │ • /mm doctor diagnostic inspection command (src/index.ts)                                       │
  │ • scripts/replay_session.ts offline transcript simulator                                        │
  │ • Comprehensive test suite verification (350+ tests) & unified bundle packaging                 │
  └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Effort vs. Impact Tradeoff Matrix

| Initiative | Dimension | Effort | Impact | Primary Benefit |
|---|---|:---:|:---:|---|
| **Parallel Token Fallback** | Retrieval | Low | High | Cuts fallback latency from ~50ms to ~10ms |
| **Prompt-Adaptive Guidance** | Context Injection | Low | High | Frees 310 chars of budget for actual memories |
| **Wire `isCodeOrDocArtifact`** | Retrieval | Low | Medium | Eliminates code syntax clutter from conversational search |
| **Direct Binary Invocations** | Architecture | Low | Medium | Eliminates V8 heap string allocations |
| **Ephemeral `joint` Parity** | Storage | Medium | High | Achieves 100% single-file purity on disk (`mem.db` only) |
| **Async Background Synthesis** | Lifecycle | Medium | High | Eliminates 1–2s turn settlement freezes |
| **8-Bit Vector Quantization (SQ8)** | Storage / Retrieval | Medium | High | Cuts in-memory semantic vector RAM by 75% |
| **Session Replay Simulator** | Tooling | Medium | Medium | Enables offline regression testing of noise filters |
| **Contiguous Page Vacuuming** | Storage | High | Medium | Eliminates fragmented disk space after heavy deletes |
