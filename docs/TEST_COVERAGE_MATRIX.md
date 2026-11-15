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
| **Multi-Axis Codebase Mipmap Graph & Lore Fusion (`scope: "code"`)** | `README.md:54`, `SKILL.md:45` | `src/code/{lexer,scanner,store,graph,recall,manager}.ts` | `tests/code_scanner.test.ts`, `tests/code_store_and_graph.test.ts`, `tests/code_recall_integration.test.ts` | `code_recall_integration.test.ts` |
| **Ephemeral Semantic Session Memory & Mipmap Compaction (`scope: "session"`)** | `README.md:83`, `SKILL.md:54` | `src/session/{store,sink,lineage,recall,compaction,manager}.ts` | `tests/session_store.test.ts`, `tests/session_lineage.test.ts`, `tests/session_recall.test.ts`, `tests/session_compaction.test.ts` | `session_e2e_integration.test.ts` |
| **Standalone In-Process Node-API Corm Runner & Engine Floor Audit** | `README.md:26`, `CHANGELOG.md:45` | `src/napi_runner.ts`, `src/config.ts`, `src/versions.ts` | `tests/npm_standalone_install.test.ts`, `tests/versions.test.ts` | `npm_standalone_install.test.ts` |
| **AST-Bound Lore Drift Detection (`lore-bindings.json` / `stale_suspect`)** | `README.md:76`, `SKILL.md:50` | `src/code/lore_binding.ts`, `src/code/manager.ts` | `tests/revolutionary_features.test.ts` | `revolutionary_features.test.ts` |
| **Execution-Trace & Differential Failure Topology (`diagnose`)** | `README.md:73`, `SKILL.md:53` | `src/code/diagnose.ts`, `src/code/recall.ts` | `tests/revolutionary_features.test.ts` | `revolutionary_features.test.ts` |
| **Pre-Tool Counterfactual Guardrails (`guardrail`)** | `README.md:74`, `SKILL.md:54` | `src/hooks/guardrails.ts`, `src/hooks/events.ts` | `tests/revolutionary_features.test.ts` | `revolutionary_features.test.ts` |
| **Collective Swarm Stigmergy Across Parallel Sessions (`swarm-leases.json`)** | `README.md:78`, `SKILL.md:50` | `src/code/stigmergy.ts`, `src/hooks/events.ts` | `tests/revolutionary_features.test.ts` | `revolutionary_features.test.ts` |
| **First-Touch Module Dossiers, Cross-Boundary Pairs & XY Contract Flight Check** | `README.md:69`, `SKILL.md:50` | `src/code/dossier.ts`, `src/code/recall.ts` | `tests/revolutionary_features.test.ts` | `revolutionary_features.test.ts` |
| **Verification-Attested Promotion Ledger & Tier-0 Diff Gate Status** | `README.md:72`, `SKILL.md:52` | `src/hooks/verification_ledger.ts`, `src/tools/record.ts` | `tests/revolutionary_features.test.ts` | `revolutionary_features.test.ts` |
| **Higher-Order Callback, Designated Initializer & `xy_load` Call-Graph Stitching** | `README.md:58`, `SKILL.md:51` | `src/code/scanner.ts`, `src/code/store.ts` | `tests/revolutionary_features.test.ts`, `tests/code_store_and_graph.test.ts` | `revolutionary_features.test.ts` |
| **Working-Memory Context-Window Staleness Radar** | `README.md:77`, `SKILL.md:50` | `src/code/context_sync.ts`, `src/code/manager.ts`, `src/hooks/events.ts` | `tests/revolutionary_features.test.ts` | `revolutionary_features.test.ts` |
| **Evidence DAG Truth Maintenance Cascade** | `README.md:247`, `SKILL.md:72` | `src/tools/lifecycle.ts` | `tests/revolutionary_features.test.ts` | `revolutionary_features.test.ts` |
