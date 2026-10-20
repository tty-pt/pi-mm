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

2. **`memory_recall(query, options?)`**:
   One-stop hybrid search across lexical (`lemma`) and semantic (`sepal`) axes fused deterministically with Reciprocal Rank Fusion ($k=60$).
   - `query`: natural language problem, error text, or symbol.
   - `project`: optional project filter/boost (e.g. `site`).
   - `includeEvidence: true`: automatically fetches and attaches supporting evidence trees.

3. **`memory_record(problem, approaches, ...)`**:
   Record task resolution and learnings without low-level JSON envelope wrangling:
   - `problem`: description of the task or bug.
   - `approaches`: array of `{ approach, outcome: "worked" | "failed" | "abandoned", reason }`.
   - `evidence`: optional array of active memory refs (`evidence: number[]`) required to attain `supported` status (dangling or contradicted refs are rejected).
   - `verification`: optional model-reported verification (`testsPassed?: string[]`, `verifiedDiff?: boolean`) recorded under `tested`.
   - `diffs`: code or command changes.
   - `outcome`: `"success"` or `"failure"`.

4. **`memory_review(ref, action, ...)`**:
   Inspect or update memory states:
   - `action: "inspect"`: views complete details, approaches, diffs, and evidence tree.
   - `action: "update_lifecycle"`: safely transitions state (e.g. `tested`, `supported`, `contradicted`, `superseded`) with required justification.

## Advanced Maintenance Tools (Optional)

By default, only the 3 primary tools above are registered for clean model focus. Low-level maintenance tools (`memory_store`, `memory_scan`, `memory_traverse`, `memory_consolidate`, `memory_lifecycle`, `memory_feedback`, `memory_think`, `memory_forget`, `memory_reset`) can be exposed by setting `"advancedTools": true` in `.pi/settings.json` under `pi-mm` or setting the environment variable `PI_MM_ADVANCED_TOOLS=true`.

## Operational Guidelines for Agents

1. **Rely on automatic context first:**
   Prior experience is already injected at the start of your turn. Review the `[Persistent Memory Context]` block before writing code.
2. **Recall for deeper searches:**
   When encountering a specific compiler error or unfamiliar symbol, run `memory_recall(query, { includeEvidence: true })`.
3. **Inspect evidence behind conclusions:**
   When verifying an invariant or rule, use `memory_review(ref, "inspect")` to examine underlying diffs and test results.
4. **Record failed and successful approaches:**
   When finishing a task, record what worked and what failed via `memory_record`. Include specific reasons.
5. **Truthful verification:**
   Do not claim verification without tests or verified diffs. Unverified fixes will be marked `tested`, while verified fixes will be marked `supported`.
6. **Contradict or supersede without erasing history:**
   When new evidence disproves an old conclusion, use `memory_review(oldRef, "update_lifecycle", { lifecycle: "superseded", reason, evidenceRef: newRef })`.

## Examples

```ts
// 1. Recall prior experience with supporting evidence
memory_recall("corm_open handle aliasing leak", { includeEvidence: true, project: "site" });

// 2. Record a structured task resolution with verified fix
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

// 3. Inspect evidence tree behind a rule
memory_review(2, "inspect");

// 4. Update lifecycle when an old theory is superseded
memory_review(1, "update_lifecycle", {
  lifecycle: "superseded",
  reason: "Superseded by verified handle aliasing implementation in Ref 2",
  evidenceRef: 2,
});
```
