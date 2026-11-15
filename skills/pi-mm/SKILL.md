---
name: pi-mm
description: "Memory Mipmaps (pi-mm): persistent multi-resolution memory space. Primary tools: memory_recall, memory_record, memory_review (plus automatic before_agent_start context injection). Low-level administrative tools enabled via advancedTools setting."
---

# pi-mm — Memory Mipmaps

Persistent, evidence-preserving, multi-resolution memory space over local `libcorm` recall kernel and axes (`joint` time, `lemma` lexical FTS, `sepal` semantic ANN, `islet` spatial context). No daemon, zero network required. Memory lives in `.pi/mm/mem.db` (primary `CM_AINDEX:string` + roster `joint,lemma`; + `sepal` when embeddings are configured; + `islet` for spatial coordinates).

## Boundary rule (with pi-quest)

- **Quest** = current active task state (goals, findings, decisions, plan).
- **MM** = persistent cross-session episodic history & multiresolution memory space (what happened, failed vs successful attempts, and why).
- Never duplicate the same ephemeral fact in both.

## Mipmap Hierarchy (IDEA.md §2)

| Level | Name | Description | Key Contents |
|-------|------|-------------|--------------|
| **L3** | General Knowledge | Cross-project recurring lessons and patterns | Generalized architectural heuristics |
| **L2** | Project Understanding | Architectural decisions, invariants, conventions | Invariants, conventions, rules |
| **L1** | Investigations | Hypotheses, attempted fixes, causal explanations | Tested theories, root causes |
| **L0** | Experience | Original observations, tool results, diffs, tests | Raw episodes, commands, diffs |

Every higher-level abstraction remains connected to its underlying evidence via `evidence: number[]` refs. Never replace source evidence with a summary.

## Memory Lifecycle (IDEA.md §3)

Memories progress through explicit, epistemically grounded lifecycle states:
- `observed` — raw observation from a tool result, error, or unverified legacy note.
- `hypothesized` — proposed explanation, candidate theory, or speculative heuristic.
- `tested` — approach attempted in an experiment, worked in execution, or reported by a model without independent evidence validation.
- `supported` — verified conclusion backed by confirmed, active evidence references (`evidence: number[]`) pointing to non-contradicted stored records.
- `contradicted` — refuted claim with explicit justification or counter-evidence.
- `superseded` — replaced by a newer verified conclusion; terminal historical record.

## Primary Model-Facing Workflow

For routine coding tasks, agents use the 3 streamlined tools:

1. **Automatic Context Recall**:
   Pi automatically injects compact, relevant memory context before your turn starts via the `before_agent_start` hook. You do not need to call a memory tool just to check if prior experience exists.

2. **`memory_recall({ query?, overview?, zoomRef?, scope?, session?, symbol?, symbols?, file?, kind?, parentSymbol?, neighbors?, trace?, direction?, depth?, diff?, diagnose?, guardrail?, zoomTurn?, toolIndex?, lineage?, lineRange?, maxLines?, fullOutput?, ... })`**:
   Multi-resolution memory & codebase retrieval: search semantically across topics, explore live codebase symbols and call graphs (`scope: "code"`), diagnose failure traces (`diagnose`), pre-flight planned edits (`guardrail`), inspect active/parallel session turns (`scope: "session"`), generate all-time overviews, or zoom into specific investigations.
   - `scope`: `"persistent"` (cross-session project memory), `"session"` (active/parallel session history), `"code"` (live codebase symbol graph, call graph, failure topology, and source slices), or `"all"` (unified).
   - `session`: target session selector for `scope: "session"` (`"current"`, `"parallel"`, `"all"`, session UUID prefix like `"01a1c8f7"`, or scratch-slot label like `"slot-6"`). Outputs explicit provenance badges (`[Current Session]`, `[Parallel Session ...]`, `[Past Session ...]`).
   - `query`: natural language problem, error text, or code symbol. Omit or pass `"overview"` to generate an all-time high-level memory overview. Inline shorthand queries like `ref:42` or `zoom:42` delegate directly to zoom-in.
   - `overview: true`: synthesizes a structured timeline across operational time, or an L3/L2 codebase architecture overview (modules, `#include`/`import`/`xy_load` dependencies, entry points/routes, call hotspots) when `scope: "code"`.
   - `symbol` / `symbols`: resolve and read concrete code symbol(s) with fail-closed ambiguity handling (`file`, `kind`, `parentSymbol` disambiguators; prioritizes `XY_IMPL` definitions over `XY_DECL` forward declarations), exact `file:startLine-endLine` source slicing (`lineRange: [start, end]`, `maxLines`, `fullOutput`), direct `neighbors` (`"none" | "callers" | "callees" | "both"`), cross-boundary pairs (`XY_DECL` $\leftrightarrow$ `XY_IMPL`, Server C $\leftrightarrow$ Isomorphic UX WASM), first-touch module dossiers, working-memory context-drift alerts, swarm stigmergy leases, and automatic fusion of linked `pi-mm` invariants (with `[STALE_SUSPECT]` AST drift detection) and past debugging episodes.
   - `trace`: multi-hop call graph traversal (`direction: "inbound" | "outbound" | "both"`, `depth: 3`), stitching direct calls, HTTP routes, higher-order function-pointer arguments, C struct designated-initializer callbacks, and `xy_load` edges while isolating languages/modules and filtering stdlib/built-in methods.
   - `diff: true`: maps `git diff` worktree hunks via `libislet` 2D interval spans to modified symbols (filtering out unedited git submodule directories), traces inbound callers up to `depth` hops, checks `XY_DECL` $\leftrightarrow$ `XY_IMPL` contract parity, and reports `[Tier-0 Module Verification Gate Status]` (`[VERIFIED ✓ after last edit]` vs `[UNVERIFIED ⚠️]`).
   - `diagnose`: stack trace, compiler diagnostic, or test failure string. Parses TS/JS, C/GDB, and Python frames without regexes, maps frames to enclosing AST symbols via `libislet`, and intersects the stack call-cone with `git diff` blast radius to pinpoint the **Causal Fault Intersection** (`modified_on_stack`, `modified_callee_of_stack`, `caller_of_modified_on_stack`).
   - `guardrail`: planned edit, command, or approach string. Pre-flights the action against contradicted memories, previously failed episode approaches, standing restrictions, and stale-suspect code-bound invariants.
   - `zoomRef: number`: zoom directly into a specific memory reference number, returning its complete multi-resolution details: problem statement, attempted approaches (worked/failed/abandoned), diffs, findings, outcome, and evidence tree.
   - `zoomTurn: number` / `toolIndex: number` / `lineRange: [start, end]` / `lineage: "active" | "all"`: progressive 3-tier retrieval (Index Card $\rightarrow$ Focused Excerpt $\rightarrow$ Exact Line Slice) across active session history.
   - `project` / `subsystem`: optional project filter/boost (e.g. `site`).
   - `level`: optional resolution level filter (`'L0'`, `'L1'`, `'L2'`, `'L3'`).
   - `includeEvidence: true`: automatically fetches and attaches supporting evidence trees.
   - `limit`: maximum number of memories to return (default 5 for search, 15 for overview, max 30).

3. **`memory_record(problem, approaches, ...)`**:
   Record task resolution and learnings without low-level JSON envelope wrangling:
   - `problem`: description of the task or bug.
   - `approaches`: array of `{ approach, outcome: "worked" | "failed" | "abandoned", reason }`.
   - `evidence`: optional array of active memory refs (`evidence: number[]`) required to attain `supported` status (dangling or contradicted refs are rejected).
   - `verification`: optional model-reported verification (`testsPassed?: string[]`, `verifiedDiff?: boolean`); recorded under `tested` unless `testsPassed` is corroborated by the session's passing verification ledger (`src/hooks/verification_ledger.ts`), which automatically promotes the episode to `supported`.
   - `diffs`: code or command changes.
   - `outcome`: `"success"` or `"failure"`.
   - `standing`: optional boolean; when `true`, elevates to an anchored L2 invariant, registers in `standing_directives.json`, and binds to referenced AST symbols in `lore-bindings.json`.

4. **`memory_review(ref, action, ...)`**:
   Inspect or update memory states:
   - `action: "inspect"`: views complete details, approaches, diffs, and evidence tree.
   - `action: "update_lifecycle"`: safely transitions state (e.g. `tested`, `supported`, `contradicted`, `superseded`) with required justification. Transitioning a memory to `contradicted` or `superseded` automatically triggers an **Evidence DAG Truth Maintenance Cascade**, downgrading dependent `supported`/`tested` conclusions to `hypothesized` and unregistering invalidated standing directives.

## Advanced Maintenance Tools (Optional)

By default, only the 3 primary tools above are registered for clean model focus. Low-level maintenance tools (`memory_store`, `memory_scan`, `memory_traverse`, `memory_consolidate`, `memory_lifecycle`, `memory_feedback`, `memory_think`, `memory_forget`, `memory_reset`) can be exposed by setting `"advancedTools": true` in `.pi/settings.json` under `pi-mm` or setting the environment variable `PI_MM_ADVANCED_TOOLS=true`.

## Operational Guidelines for Agents

1. **Rely on automatic context first:**
   Prior experience is already injected at the start of your turn. Review the `[Persistent Memory Context]` block before writing code.
2. **Overview for broad orientation:**
   When starting work in a project or answering broad questions about prior work across sessions, run `memory_recall({ overview: true })` (or `memory_recall({ scope: "code", overview: true })` for codebase architecture).
3. **Recall for deeper searches & fault localization:**
   When encountering a stack trace, compiler error, or test failure, run `memory_recall({ diagnose: "<trace or error output>" })` to compute the Causal Fault Intersection against `git diff` and retrieve past bug lore.
4. **Pre-flight risky changes with Counterfactual Guardrails:**
   Before executing a non-trivial refactor or architectural change, run `memory_recall({ guardrail: "<planned edit or command>", file: "<path>", symbol: "<name>" })` to check against contradicted memories, failed approaches, standing restrictions, and stale invariants.
5. **Zoom in to inspect investigations:**
   To inspect the full approaches (worked/failed), diffs, and evidence tree of a prior investigation, run `memory_recall({ zoomRef: <ref> })`.
6. **Inspect evidence behind conclusions:**
   When verifying an invariant or rule, use `memory_review(ref, "inspect")` or `memory_recall({ zoomRef: ref })` to examine underlying diffs and test results.
7. **Record failed and successful approaches:**
   When finishing a task, record what worked and what failed via `memory_record`. Include specific reasons.
8. **Truthful verification & Tier-0 gates:**
   Do not claim verification without running the module's Tier-0 verification command. Check `memory_recall({ diff: true })` to confirm all modified modules report `[VERIFIED ✓ after last edit]`.
9. **Contradict or supersede without erasing history:**
   When new evidence disproves an old conclusion, use `memory_review(oldRef, "update_lifecycle", { lifecycle: "superseded", reason, evidenceRef: newRef })`.
10. **Standing Directives & Invariants:**
    Operational rules, architectural constraints, and standing policies stated by the operator are automatically detected via semantic embeddings (`directiveEmbed: "auto"`) and stored as anchored L2 invariants. You can also explicitly record rules via `/mm rule <directive>` or by passing `standing: true` to `memory_record`.
11. **Overview vs. Targeted Recall:**
    When asked open-ended synthesis or retrospective questions (*"what have we accomplished so far?"*, *"resumo do que investigamos"*), `pi-mm` automatically injects all-time overview mipmaps (`overviewEmbed: "auto"`). Use targeted queries for specific compiler errors or code symbols.

## Examples

```ts
// 1. All-time high-level memory overview & timeline
memory_recall({ overview: true });

// 2. Direct zoom into a specific memory to inspect approaches, diffs, and evidence tree
memory_recall({ zoomRef: 42 });

// 3. Recall prior experience with supporting evidence
memory_recall({ query: "corm_open handle aliasing leak", includeEvidence: true, project: "site" });

// 4. Record a structured task resolution with verified fix
memory_record({
  problem: "Investigate fd leak on duplicate corm_open",
  approaches: [
    { approach: "Increase file descriptor limit", outcome: "failed", reason: "Masked the leak rather than fixing root cause" },
    { approach: "Add live handle table alias check", outcome: "worked", reason: "Reuses existing handle on identical (file, map)" }
  ],
  findings: ["corm_open duplicate open was allocating fresh fd"],
  diffs: ["--- a/libcorm.c\n+++ b/libcorm.c\n+ alias check"],
  verification: { testsPassed: ["test_corm_alias_roundtrip"], verifiedDiff: true },
  outcome: "success",
  project: "site",
  subsystem: "libcorm",
});

// 5. Inspect evidence tree behind a rule
memory_review(2, "inspect");

// 6. Update lifecycle when an old theory is superseded (triggers Truth Maintenance Cascade)
memory_review(1, "update_lifecycle", {
  lifecycle: "superseded",
  reason: "Superseded by verified handle aliasing implementation in Ref 2",
  evidenceRef: 2,
});

// 7. Read concrete codebase symbol with direct callers/callees, cross-boundary pairs, dossier & fused lore
memory_recall({ symbol: "render_song_item", file: "song.c", neighbors: "both", lineRange: [1, 80] });

// 8. Trace multi-hop inbound & outbound call graph or inspect git diff blast radius & Tier-0 verification gates
memory_recall({ trace: "song_detail_handler", direction: "both", depth: 3 });
memory_recall({ diff: true, depth: 2 });

// 9. Diagnose a stack trace or compiler failure against git diff blast radius
memory_recall({ diagnose: "Error: bad token at parse_chat_route (mods/chat/chat.c:705:9)", depth: 2 });

// 10. Pre-flight a planned edit against counterfactual guardrails
memory_recall({ guardrail: "call corm_put directly inside mods/song/ux/song.c", file: "mods/song/ux/song.c" });

// 11. Progressive session recall, parallel slot inspection, and exact turn line slicing
memory_recall({ scope: "session", session: "current", query: "handle aliasing" });
memory_recall({ scope: "session", session: "parallel", query: "water shader" });
memory_recall({ scope: "session", zoomTurn: 4, lineRange: [10, 40] });
```
