import assert from "node:assert";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { CodeStore } from "../src/code/store.ts";
import { CodeRecallEngine } from "../src/code/recall.ts";
import { detectWorktreeChangesImpact, parseUnifiedDiffHunks, traceSymbolPath } from "../src/code/graph.ts";

Deno.test("code_store_and_graph: incremental indexing, call graph trace, overview, diff impact, and fail-closed symbol read", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-code-graph-test-" });
  try {
    const dbFile = join(tmpDir, "db.ts");
    const serviceFile = join(tmpDir, "service.ts");
    const handlerFile = join(tmpDir, "handler.ts");

    writeFileSync(dbFile, [
      "/** Query low-level storage records */",
      "export function fetchStorageRow(id: number): string {",
      "  return String(id);",
      "}",
      "",
      "export function helperShared(): void {}",
    ].join("\n"), "utf-8");

    writeFileSync(serviceFile, [
      'import { fetchStorageRow } from "./db.ts";',
      "",
      "/** Domain service for order lookup */",
      "export function loadOrder(orderId: number): string {",
      "  return fetchStorageRow(orderId);",
      "}",
      "",
      "export function helperShared(): void {}",
    ].join("\n"), "utf-8");

    writeFileSync(handlerFile, [
      'import { loadOrder } from "./service.ts";',
      "",
      "export function handleOrderRequest(reqId: number): string {",
      "  return loadOrder(reqId);",
      "}",
    ].join("\n"), "utf-8");

    const store = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "code-index"),
      persistToCorm: false,
    });
    const engine = new CodeRecallEngine(store);

    // 1. Initial index
    const firstIdx = await store.indexProject();
    assert.strictEqual(firstIdx.scannedFiles, 3);
    assert.strictEqual(firstIdx.totalSymbols, 5);

    // 2. Second index with unchanged mtimes -> 0 scanned files
    const secondIdx = await store.indexProject();
    assert.strictEqual(secondIdx.scannedFiles, 0);

    // 3. Call graph trace (inbound & outbound across 2 hops: handleOrderRequest -> loadOrder -> fetchStorageRow)
    const traceRes = traceSymbolPath(store, "loadOrder", { direction: "both", depth: 2 });
    assert.strictEqual(traceRes.status, "ok");
    assert.strictEqual(traceRes.inboundTree?.children.length, 1);
    assert.strictEqual(traceRes.inboundTree?.children[0].name, "handleOrderRequest");
    assert.strictEqual(traceRes.outboundTree?.children.length, 1);
    assert.strictEqual(traceRes.outboundTree?.children[0].name, "fetchStorageRow");

    // 4. Multi-hop inbound trace from leaf (fetchStorageRow <- loadOrder <- handleOrderRequest)
    const leafTrace = traceSymbolPath(store, "fetchStorageRow", { direction: "inbound", depth: 3 });
    assert.strictEqual(leafTrace.status, "ok");
    assert.strictEqual(leafTrace.inboundTree?.children[0].name, "loadOrder");
    assert.strictEqual(leafTrace.inboundTree?.children[0].children[0].name, "handleOrderRequest");

    // 5. Fail-closed ambiguity on helperShared, resolved when file filter is passed
    const ambigOut = await engine.execute({ symbol: "helperShared" });
    assert.ok(ambigOut.rendered.includes("Ambiguous Symbol"));
    assert.ok(ambigOut.rendered.includes("db.ts"));
    assert.ok(ambigOut.rendered.includes("service.ts"));

    const resolvedOut = await engine.execute({ symbol: "helperShared", file: "db.ts" });
    assert.ok(resolvedOut.rendered.includes("db.ts:helperShared"));
    assert.ok(!resolvedOut.rendered.includes("Ambiguous Symbol"));

    // 6. Overview mode
    const ovOut = await engine.execute({ overview: true });
    assert.strictEqual(ovOut.mode, "overview");
    assert.ok(ovOut.rendered.includes("Indexed Files: 3 | Total Symbols: 5"));
    assert.ok(ovOut.rendered.includes("loadOrder"));

    // 7. Unified diff blast radius (modifying line 2 of db.ts impacts loadOrder at hop 1 and handleOrderRequest at hop 2)
    const fakeDiff = [
      "diff --git a/db.ts b/db.ts",
      "--- a/db.ts",
      "+++ b/db.ts",
      "@@ -2,2 +2,3 @@",
      "+  // modified line inside fetchStorageRow",
    ].join("\n");
    const hunks = parseUnifiedDiffHunks(fakeDiff);
    assert.strictEqual(hunks.length, 1);
    assert.strictEqual(hunks[0].filePath, "db.ts");
    assert.strictEqual(hunks[0].startLine, 2);

    const impact = await detectWorktreeChangesImpact(store, fakeDiff, 2);
    assert.strictEqual(impact.modifiedSymbols.length, 1);
    assert.strictEqual(impact.modifiedSymbols[0].name, "fetchStorageRow");
    assert.strictEqual(impact.impactedCallers.length, 2);
    assert.strictEqual(impact.impactedCallers[0].symbol.name, "loadOrder");
    assert.strictEqual(impact.impactedCallers[0].depth, 1);
    assert.strictEqual(impact.impactedCallers[1].symbol.name, "handleOrderRequest");
    assert.strictEqual(impact.impactedCallers[1].depth, 2);

    // 8. Cross-session manifest hydration: new CodeStore instance loads manifest.json with 0 files re-scanned
    const storeReloaded = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "code-index"),
      persistToCorm: false,
      sweepThrottleMs: 0,
    });
    const reloadIdx = await storeReloaded.ensureIndexed(500, true);
    assert.strictEqual(reloadIdx.scannedFiles, 0, "should re-scan 0 files when mtimes & sizes match persisted manifest.json");
    assert.strictEqual(reloadIdx.totalSymbols, 5);

    // 9. Incremental modification of 1 file + deletion of 1 file
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(serviceFile, [
      'import { fetchStorageRow } from "./db.ts";',
      "",
      "export function loadOrder(orderId: number): string {",
      "  return fetchStorageRow(orderId);",
      "}",
      "",
      "export function validateOrder(orderId: number): boolean {",
      "  return orderId > 0;",
      "}",
    ].join("\n"), "utf-8");
    await Deno.remove(handlerFile);

    const deltaIdx = await storeReloaded.ensureIndexed(500, true);
    assert.strictEqual(deltaIdx.scannedFiles, 1, "should only re-scan the 1 modified file");
    assert.strictEqual(deltaIdx.totalSymbols, 4, "should have 2 symbols in db.ts + 2 in service.ts, and 0 from deleted handler.ts");
    assert.ok(storeReloaded.getSymbolsByName("validateOrder").length === 1);
    assert.strictEqual(storeReloaded.getSymbolsByName("handleOrderRequest").length, 0);

    // 10. Symbol-level diffing: unchanged symbol (loadOrder) keeps its ref when sibling symbol in same file changes
    const loadOrderRefBefore = storeReloaded.getSymbolsByName("loadOrder")[0].ref;
    const validateOrderRefBefore = storeReloaded.getSymbolsByName("validateOrder")[0].ref;
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(serviceFile, [
      'import { fetchStorageRow } from "./db.ts";',
      "",
      "export function loadOrder(orderId: number): string {",
      "  return fetchStorageRow(orderId);",
      "}",
      "",
      "export function validateOrder(orderId: number, strict = true): boolean {",
      "  return strict ? orderId > 0 : orderId >= 0;",
      "}",
    ].join("\n"), "utf-8");
    await storeReloaded.ensureIndexed(500, true);
    const loadOrderRefAfter = storeReloaded.getSymbolsByName("loadOrder")[0].ref;
    const validateOrderRefAfter = storeReloaded.getSymbolsByName("validateOrder")[0].ref;
    assert.strictEqual(loadOrderRefAfter, loadOrderRefBefore, "unchanged symbol in modified file must reuse its existing ref");
    assert.notStrictEqual(validateOrderRefAfter, validateOrderRefBefore, "modified symbol signature must receive a new ref");

    // 11. Startup fast-path: fresh CodeStore with default sweepThrottleMs loads manifest in ensureIndexed() without sweeping disk
    const storeFastStart = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "code-index"),
      persistToCorm: false,
    });
    const fastIdx = await storeFastStart.ensureIndexed(500, false);
    assert.strictEqual(fastIdx.scannedFiles, 0, "fresh CodeStore should hydrate manifest in ensureIndexed without re-scanning");
    assert.strictEqual(fastIdx.totalSymbols, 4);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("code_store_and_graph: priority scanning, language/module call isolation, XY_IMPL vs XY_DECL disambiguation, and submodule diff filtering", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-code-improvements-" });
  try {
    await Deno.mkdir(join(tmpDir, "mods", "song"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "include"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "external", "libfoo"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "docs", "archive"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "tests", "unit"), { recursive: true });

    // 1. Header with XY_DECL prototype
    writeFileSync(join(tmpDir, "include", "song.h"), [
      "XY_DECL(int, song_transpose, (const char *id));",
    ].join("\n"), "utf-8");

    // 2. Implementation in mods/song/song.c calling song_transpose and shared_load
    writeFileSync(join(tmpDir, "mods", "song", "song.c"), [
      "XY_IMPL(int, song_transpose, (const char *id)) {",
      "  return shared_load(id);",
      "}",
      "",
      "int song_caller(void) {",
      "  return song_transpose(\"abc\");",
      "}",
    ].join("\n"), "utf-8");

    // 3. C implementation of shared_load in external/libfoo/foo.c
    writeFileSync(join(tmpDir, "external", "libfoo", "foo.c"), [
      "int shared_load(const char *id) {",
      "  return 0;",
      "}",
    ].join("\n"), "utf-8");

    // 4. Python file with same function name `shared_load` (must NOT be linked from C caller)
    writeFileSync(join(tmpDir, "external", "libfoo", "helper.py"), [
      "def shared_load(x):",
      "  return x",
    ].join("\n"), "utf-8");

    // 5. Archived file in docs/archive (must be ignored by scanner)
    writeFileSync(join(tmpDir, "docs", "archive", "old.py"), [
      "def shared_load(x):",
      "  return x",
    ].join("\n"), "utf-8");

    // 6. Test file with mock `shared_load` and ASSERT_EQ macro (must not hijack production calls or hotspots)
    writeFileSync(join(tmpDir, "tests", "unit", "mock_test.c"), [
      "#define ASSERT_EQ(a, b) ((a) == (b))",
      "int shared_load(const char *id) { return -1; }",
      "int main(void) { ASSERT_EQ(1, 1); return 0; }",
    ].join("\n"), "utf-8");

    // Test priority scanning with a tight maxFiles cap (mods/ and include/ must come before external/)
    const cappedStore = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "capped-index"),
      persistToCorm: false,
    });
    await cappedStore.indexProject(2);
    const cappedFiles = cappedStore.getAllFiles().map((f) => f.filePath);
    assert.deepStrictEqual(cappedFiles, ["mods/song/song.c", "include/song.h"], "mods/ and include/ must be indexed ahead of external/ and tests/");

    // Full index of tmpDir
    const store = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "full-index"),
      persistToCorm: false,
    });
    const engine = new CodeRecallEngine(store);
    await store.indexProject(50);

    const allPaths = store.getAllFiles().map((f) => f.filePath);
    assert.ok(!allPaths.some((p) => p.includes("docs/archive")), "docs/archive must be excluded");

    // XY_IMPL should win over XY_DECL when reading or tracing `song_transpose` without ambiguity error
    const readRes = await engine.execute({ symbol: "song_transpose" });
    assert.ok(!readRes.rendered.includes("Ambiguous Symbol"), "XY_IMPL should automatically disambiguate over XY_DECL prototype");
    assert.ok(readRes.rendered.includes("mods/song/song.c:song_transpose"));

    // Call graph trace from C `song_transpose` must resolve `shared_load` ONLY to C `external/libfoo/foo.c:shared_load`
    // and NOT to Python `helper.py:shared_load` or test mock `tests/unit/mock_test.c:shared_load`
    const traceRes = traceSymbolPath(store, "song_transpose", { direction: "both", depth: 2 });
    assert.strictEqual(traceRes.status, "ok");
    assert.strictEqual(traceRes.inboundTree?.children.length, 1);
    assert.strictEqual(traceRes.inboundTree?.children[0].qualifiedName, "mods/song/song.c:song_caller");
    assert.strictEqual(traceRes.outboundTree?.children.length, 1);
    assert.strictEqual(traceRes.outboundTree?.children[0].qualifiedName, "external/libfoo/foo.c:shared_load");

    // Overview must prioritize mods/song and exclude ASSERT_EQ / test files from hotspots
    const ov = await engine.execute({ overview: true });
    assert.ok(!ov.rendered.includes("ASSERT_EQ"), "hotspots must exclude test assertion macros");

    // Submodule gitlink diff (mode 160000 / Subproject commit) must be ignored while real file hunks are parsed
    const diffWithSubmodule = [
      "diff --git a/.pi/extensions/pi-mm b/.pi/extensions/pi-mm",
      "index 1111111..2222222 160000",
      "--- a/.pi/extensions/pi-mm",
      "+++ b/.pi/extensions/pi-mm",
      "@@ -1 +1 @@",
      "-Subproject commit 1111111111111111111111111111111111111111",
      "+Subproject commit 2222222222222222222222222222222222222222",
      "diff --git a/mods/song/song.c b/mods/song/song.c",
      "index 3333333..4444444 100644",
      "--- a/mods/song/song.c",
      "+++ b/mods/song/song.c",
      "@@ -2,1 +2,2 @@",
      "+  // edited inside song_transpose",
    ].join("\n");

    const hunks = parseUnifiedDiffHunks(diffWithSubmodule);
    assert.strictEqual(hunks.length, 1, "must ignore 160000 submodule gitlink diff");
    assert.strictEqual(hunks[0].filePath, "mods/song/song.c");

    const impact = await detectWorktreeChangesImpact(store, diffWithSubmodule, 2);
    assert.deepStrictEqual(impact.changedFiles, ["mods/song/song.c"]);
    assert.strictEqual(impact.modifiedSymbols[0].name, "song_transpose");
    assert.strictEqual(impact.impactedCallers[0].symbol.name, "song_caller");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("code_store_and_graph: .pi/extensions traversal, symlink cycle safety, word-boundary query scoring, and import-guided call graph resolution", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-code-precision-" });
  const extTargetDir = await Deno.makeTempDir({ prefix: "mm-code-symlink-target-" });
  try {
    // 1. Setup .pi/extensions, .pi/skills, and ignored .pi/mm, .pi/cache, .pi/quest
    await Deno.mkdir(join(tmpDir, ".pi", "extensions", "pi-mm", "src"), { recursive: true });
    await Deno.mkdir(join(tmpDir, ".pi", "skills", "custom-skill"), { recursive: true });
    await Deno.mkdir(join(tmpDir, ".pi", "mm"), { recursive: true });
    await Deno.mkdir(join(tmpDir, ".pi", "cache"), { recursive: true });
    await Deno.mkdir(join(tmpDir, ".pi", "quest"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "htdocs"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "mods", "alpha"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "mods", "beta"), { recursive: true });
    await Deno.mkdir(join(tmpDir, "mods", "caller"), { recursive: true });

    writeFileSync(join(tmpDir, ".pi", "extensions", "pi-mm", "src", "engine.ts"), [
      "/** Core pi-mm memory recall engine */",
      "export function executePiMmRecall(query: string): string {",
      "  return query;",
      "}",
    ].join("\n"), "utf-8");

    writeFileSync(join(tmpDir, ".pi", "skills", "custom-skill", "helper.ts"), [
      "export function runSkillHelper(): void {}",
    ].join("\n"), "utf-8");

    // Ignored .pi directories must NEVER be indexed
    writeFileSync(join(tmpDir, ".pi", "mm", "should_ignore.ts"), "export function ignoredMm(): void {}\n", "utf-8");
    writeFileSync(join(tmpDir, ".pi", "cache", "should_ignore.ts"), "export function ignoredCache(): void {}\n", "utf-8");
    writeFileSync(join(tmpDir, ".pi", "quest", "should_ignore.ts"), "export function ignoredQuest(): void {}\n", "utf-8");

    // Symlinked extension directory + recursive self-symlink cycle
    writeFileSync(join(extTargetDir, "linked_ext.ts"), [
      "export function linkedExtensionEntry(): number { return 42; }",
    ].join("\n"), "utf-8");
    await Deno.symlink(extTargetDir, join(tmpDir, ".pi", "extensions", "linked-ext"));
    await Deno.symlink(tmpDir, join(extTargetDir, "cycle-back-to-root"));

    // 2. Decoy symbol containing "mm" as an internal substring ("compileWasmModuleCached" / "comment" / "summary")
    writeFileSync(join(tmpDir, "htdocs", "stele-client.js"), [
      "/** Compiles and caches a WebAssembly summary comment */",
      "async function compileWasmModuleCached(url) {",
      "  return url;",
      "}",
    ].join("\n"), "utf-8");

    // 3. Import-guided call graph disambiguation:
    // Both mods/alpha/alpha.c and mods/beta/beta.c define `render_widget()`,
    // while mods/caller/caller.c explicitly calls `xy_load("beta")` and `#include "beta.h"`.
    writeFileSync(join(tmpDir, "mods", "alpha", "alpha.c"), [
      "int render_widget(int x) { return x + 1; }",
    ].join("\n"), "utf-8");
    writeFileSync(join(tmpDir, "mods", "beta", "beta.c"), [
      "int render_widget(int x) { return x + 2; }",
    ].join("\n"), "utf-8");
    writeFileSync(join(tmpDir, "mods", "caller", "caller.c"), [
      '#include "beta.h"',
      "void init_caller(void) {",
      '  xy_load("beta");',
      "  render_widget(10);",
      "}",
    ].join("\n"), "utf-8");

    const store = new CodeStore({
      projectRoot: tmpDir,
      indexDir: join(tmpDir, ".pi", "cache", "code-index"),
      persistToCorm: false,
    });
    const engine = new CodeRecallEngine(store);
    await store.indexProject(100);

    const indexedPaths = store.getAllFiles().map((f) => f.filePath);
    assert.ok(indexedPaths.includes(".pi/extensions/pi-mm/src/engine.ts"), "must index .pi/extensions/pi-mm");
    assert.ok(indexedPaths.includes(".pi/skills/custom-skill/helper.ts"), "must index .pi/skills");
    assert.ok(indexedPaths.includes(".pi/extensions/linked-ext/linked_ext.ts"), "must traverse symlinked directory in .pi/extensions");
    assert.ok(!indexedPaths.some((p) => p.startsWith(".pi/mm/") || p.startsWith(".pi/cache/") || p.startsWith(".pi/quest/")), "must ignore .pi/mm, .pi/cache, and .pi/quest");

    // Querying "pi-mm" must rank `executePiMmRecall` first and MUST NOT match `compileWasmModuleCached` via 2-char "mm" substring
    const searchRes = await engine.execute({ query: "pi-mm", limit: 5 });
    assert.ok(searchRes.symbols.length >= 1, "should find pi-mm symbols");
    assert.strictEqual(searchRes.symbols[0].name, "executePiMmRecall");
    assert.ok(
      !searchRes.symbols.some((s) => s.name === "compileWasmModuleCached"),
      "compileWasmModuleCached must not match 'pi-mm' via 2-letter 'mm' substring",
    );

    // Import-guided call graph: `init_caller` in mods/caller/caller.c must link to `mods/beta/beta.c:render_widget`
    // and NOT `mods/alpha/alpha.c:render_widget` because caller.c imports beta.h / xy_load("beta").
    const callerTrace = traceSymbolPath(store, "init_caller", { direction: "outbound", depth: 2 });
    assert.strictEqual(callerTrace.status, "ok");
    assert.strictEqual(callerTrace.outboundTree?.children.length, 1);
    assert.strictEqual(callerTrace.outboundTree?.children[0].qualifiedName, "mods/beta/beta.c:render_widget");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    await Deno.remove(extTargetDir, { recursive: true });
  }
});

