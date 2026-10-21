# Changelog

All notable changes to the `@tty-pt/pi-mm` package will be documented in this file.

## 0.2.0

- **Content-Addressed Prompt Blocks**: Introduced `PromptBlock` representation and fast 64-bit FNV-1a hashing (`fnv1a64`) in `src/blocks.ts` for deterministic prompt section fingerprinting.
- **Stable Working Memory Ordering**: Recalled candidate memories in `src/tools/recall.ts` are canonically sorted by ascending `ref` ID (`canonicalSortByRef`) prior to formatting, eliminating floating-point score fluctuations from busting downstream LLM KV prompt caches.
- **Block Composition Utilities**: Added `createPromptBlock` and `composePromptBlocks` for structured, verifiable prompt assembly across system directives, tool declarations, and recalled memories.
- **Unit Test Coverage**: Added `tests/blocks.test.ts` covering 64-bit hashing, block creation, multi-block composition, and ref sorting determinism.

## 0.1.0

- Initial release of Memory Mipmaps extension for Pi Coding Agent.
- Hierarchical episodic memory persistence (L0-L3), Corm/qmap backing with Joint/Lemma/Sepal/Islet axes, Reciprocal Rank Fusion (RRF), and resident `cormd` support.
