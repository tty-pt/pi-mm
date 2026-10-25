# pi-mm Test Coverage Matrix

Audit of all documented workflow surfaces from `README.md` and `skills/pi-mm/SKILL.md` against test suites in `tests/`.

| Documented Workflow Surface | Source Citation | Implementation | Existing Test Coverage | Unified E2E Test |
| :--- | :--- | :--- | :--- | :--- |
| **Autonomous Turn Capture** | `README.md:28`, `SKILL.md:46` | `src/hooks/events.ts:1146` | `tests/capture_modes.test.ts`, `tests/episode.test.ts` | `intended_workflows_verification.test.ts` |
| **Conversational Directives (`@remember`)** | `README.md:144`, `SKILL.md:48` | `src/hooks/events.ts:1170` | `tests/capture_modes.test.ts`, `tests/cognitive_memory.test.ts` | `intended_workflows_verification.test.ts` |
| **Flashbulb Memory Anchors (`FLAG_IS_ANCHOR`)** | `README.md:144` | `src/payload.ts:18`, `src/tools/ranking.ts:145` | `tests/cognitive_memory.test.ts` | `intended_workflows_verification.test.ts` |
| **Latent Silence (Clean Prompt Contract)** | `README.md:25`, `SKILL.md:46` | `src/hooks/auto_recall.ts:214` | `tests/human_memory_and_mojibake_prevention.test.ts` | `intended_workflows_verification.test.ts` |
| **Proactive Subsystem Invariant Priming** | `README.md:154`, `SKILL.md:52` | `src/hooks/auto_recall.ts:55` | `tests/cognitive_memory.test.ts`, `tests/auto_recall.test.ts` | `intended_workflows_verification.test.ts` |
| **User Persona & Engineering Tenets** | `README.md:162`, `SKILL.md:50` | `src/hooks/auto_recall.ts:220` | `tests/cognitive_memory.test.ts` | `intended_workflows_verification.test.ts` |
| **On-Demand Explicit Recall (`memory_recall`)** | `README.md:190`, `SKILL.md:55` | `src/tools/recall.ts` | `tests/workflow_tools.test.ts`, `tests/quality_and_relevance.test.ts` | `intended_workflows_verification.test.ts` |
| **Structured Task Resolution (`memory_record`)** | `README.md:200`, `SKILL.md:65` | `src/tools/record.ts` | `tests/workflow_tools.test.ts`, `tests/epistemic_safety.test.ts` | `intended_workflows_verification.test.ts` |
| **Hierarchy Review & Lifecycle (`memory_review`)** | `README.md:210`, `SKILL.md:75` | `src/tools/review.ts`, `src/tools/lifecycle.ts` | `tests/workflow_tools.test.ts`, `tests/store_extended.test.ts` | `intended_workflows_verification.test.ts` |
| **Autonomous & Incremental Consolidation** | `SKILL.md:24`, `README.md:30` | `src/tools/consolidate.ts` | `tests/consolidate.test.ts`, `tests/technical_episodes_consolidation.test.ts` | `intended_workflows_verification.test.ts` |
| **Upward & Downward Evidence Traversal** | `SKILL.md:24`, `README.md:195` | `src/tools/traverse.ts` | `tests/traverse.test.ts` | `intended_workflows_verification.test.ts` |
| **Mistake Tracking & Contradiction** | `SKILL.md:35`, `README.md:225` | `src/tools/lifecycle.ts:90` | `tests/epistemic_safety.test.ts` | `intended_workflows_verification.test.ts` |
| **Multi-Turn Session History Excerpts** | `README.md:25` | `src/session_history.ts` | `tests/session_history_enrichment.test.ts` | `intended_workflows_verification.test.ts` |
