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

