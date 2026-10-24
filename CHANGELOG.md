# Changelog

All notable changes to the `@tty-pt/pi-mm` package will be documented in this file.

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
