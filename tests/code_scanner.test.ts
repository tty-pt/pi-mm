import assert from "node:assert";
import { scanSourceFile } from "../src/code/scanner.ts";
import { splitIdentifierWords, tokenizeSource } from "../src/code/lexer.ts";

Deno.test("code_scanner: C file with XY_IMPL, structs, functions, #include, xy_load, and comments/strings", () => {
  const cSource = [
    '#include <stdio.h>',
    '#include "song-types.h"',
    '#define MAX_SONGS 256',
    '',
    '/* Block comment with fake function:',
    '   void fake_in_comment(void) { ignored_call(); }',
    '*/',
    'struct song_entry {',
    '  int id;',
    '  const char *title;',
    '};',
    '',
    '/** Fetch a song by slug and render HTML */',
    'static int render_song_item(struct song_entry *entry) {',
    '  const char *str = "fake_in_string() { not_a_call(); }";',
    '  int rc = source_get_item(entry->id);',
    '  if (rc == 0) {',
    '    bud_render_node(str);',
    '  }',
    '  return rc;',
    '}',
    '',
    'XY_IMPL(int, song_install, (void)) {',
    '  xy_load("index");',
    '  xy_load("mpfd");',
    '  void *buf = malloc(64);',
    '  ops->load(buf);',
    '  free(buf);',
    '  register_route("POST", "/song/edit", render_song_item);',
    '  register_handler("GET:/api/song/:id/transpose", render_song_item);',
    '  return render_song_item(NULL);',
    '}',
  ].join("\n");

  const res = scanSourceFile("mods/song/song.c", cSource);

  assert.strictEqual(res.lineCount, 32);
  assert.ok(res.imports.includes("stdio.h"));
  assert.ok(res.imports.includes("song-types.h"));
  assert.ok(res.imports.includes("index"));
  assert.ok(res.imports.includes("mpfd"));

  const names = res.symbols.map((s) => s.name);
  assert.ok(names.includes("MAX_SONGS"), "should extract #define macro");
  assert.ok(names.includes("song_entry"), "should extract struct");
  assert.ok(names.includes("render_song_item"), "should extract static C function");
  assert.ok(names.includes("song_install"), "should extract XY_IMPL function");
  assert.ok(names.includes("POST /song/edit"), "should extract 2-arg (method, /path) route symbol");
  assert.ok(names.includes("GET /api/song/:id/transpose"), "should extract 1-arg (METHOD:/path) route symbol");
  assert.ok(!names.includes("fake_in_comment"), "must ignore symbols inside block comments");
  assert.ok(!names.includes("fake_in_string"), "must ignore symbols inside string literals");

  const renderSym = res.symbols.find((s) => s.name === "render_song_item")!;
  assert.strictEqual(renderSym.kind, "Function");
  assert.strictEqual(renderSym.startLine, 14);
  assert.strictEqual(renderSym.endLine, 21);
  assert.strictEqual(renderSym.docComment, "Fetch a song by slug and render HTML");
  assert.deepStrictEqual(renderSym.rawCallees, ["source_get_item", "bud_render_node"]);

  const xySym = res.symbols.find((s) => s.name === "song_install")!;
  assert.strictEqual(xySym.kind, "Function");
  assert.strictEqual(xySym.startLine, 23);
  assert.strictEqual(xySym.endLine, 32);
  assert.ok(xySym.rawCallees.includes("render_song_item"));
  assert.ok(!xySym.rawCallees.includes("malloc"), "must filter stdlib malloc from rawCallees");
  assert.ok(!xySym.rawCallees.includes("free"), "must filter stdlib free from rawCallees");
  assert.ok(!xySym.rawCallees.includes("load"), "must filter C struct pointer member call ops->load() from rawCallees");

  const routeSym = res.symbols.find((s) => s.name === "POST /song/edit")!;
  assert.strictEqual(routeSym.routeMethod, "POST");
  assert.strictEqual(routeSym.routePath, "/song/edit");
  assert.deepStrictEqual(routeSym.rawCallees, ["render_song_item"]);

  const compactRouteSym = res.symbols.find((s) => s.name === "GET /api/song/:id/transpose")!;
  assert.strictEqual(compactRouteSym.routeMethod, "GET");
  assert.strictEqual(compactRouteSym.routePath, "/api/song/:id/transpose");
  assert.deepStrictEqual(compactRouteSym.rawCallees, ["render_song_item"]);
});

Deno.test("code_scanner: TypeScript file with classes, methods, interfaces, arrow functions, and routes", () => {
  const tsSource = [
    'import { SessionStore } from "./store.ts";',
    '',
    'export interface RecallConfig {',
    '  limit: number;',
    '}',
    '',
    'export class CodeEngine {',
    '  /** Run a code query across axes */',
    '  async executeQuery(q: string): Promise<number> {',
    '    const clean = normalizeQuery(q);',
    '    return runKernelScan(clean);',
    '  }',
    '}',
    '',
    'export const buildHelper = (x: number) => {',
    '  return computeOffset(x);',
    '};',
    '',
    'export function registerRoutes(app: unknown) {',
    '  app.get("/v1/classify", handleClassify);',
    '}',
  ].join("\n");

  const res = scanSourceFile("src/code/engine.ts", tsSource);
  assert.deepStrictEqual(res.imports, ["./store.ts"]);

  const iface = res.symbols.find((s) => s.name === "RecallConfig")!;
  assert.strictEqual(iface.kind, "Interface");

  const cls = res.symbols.find((s) => s.name === "CodeEngine")!;
  assert.strictEqual(cls.kind, "Class");
  assert.strictEqual(cls.startLine, 7);
  assert.strictEqual(cls.endLine, 13);

  const method = res.symbols.find((s) => s.name === "executeQuery")!;
  assert.strictEqual(method.kind, "Method");
  assert.strictEqual(method.parentSymbol, "CodeEngine");
  assert.strictEqual(method.qualifiedName, "src/code/engine.ts:CodeEngine.executeQuery");
  assert.strictEqual(method.docComment, "Run a code query across axes");
  assert.deepStrictEqual(method.rawCallees, ["normalizeQuery", "runKernelScan"]);

  const arrow = res.symbols.find((s) => s.name === "buildHelper")!;
  assert.strictEqual(arrow.kind, "Function");
  assert.deepStrictEqual(arrow.rawCallees, ["computeOffset"]);

  const route = res.symbols.find((s) => s.kind === "Route")!;
  assert.strictEqual(route.routeMethod, "GET");
  assert.strictEqual(route.routePath, "/v1/classify");
});

Deno.test("code_lexer: splitIdentifierWords and zero-regex tokenization", () => {
  assert.deepStrictEqual(
    splitIdentifierWords("createDefaultRunner_v2"),
    ["create", "default", "runner", "v2"],
  );
  const tok = tokenizeSource("int a = 1; // comment\n", false);
  assert.strictEqual(tok.lineCount, 2);
});
