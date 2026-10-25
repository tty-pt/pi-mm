import {
  FILESPEC,
  filespecFor,
  buildStoreInvocation,
  buildScanInvocation,
  buildListInvocation,
  buildGetInvocation,
  buildForgetInvocation,
  scanExpr,
  scanWindow,
  scanWindowArgs,
  embedEnv,
  parseResultLines,
  payloadDate,
} from "../src/corm.ts";
import type { MmConfig } from "../src/config.ts";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const BIN = "/usr/bin/corm";
const AXES = "/axes/joint:/axes/lemma";
const MEM = "/repo/.pi/mm";

function date(s: string): Date {
  return new Date(`${s}T12:00:00`);
}

Deno.test("FILESPEC matches the §8 roster-backed filespec", () => {
  check(FILESPEC === "mem.db@joint,lemma:a:b" || FILESPEC === "mem.db@joint,lemma:a:s", "roster + aindex-string primary");
});

Deno.test("store invocation is byte-identical to §8", () => {
  const inv = buildStoreInvocation(BIN, FILESPEC, 1, "2026-09-14:Beacon Harbor lights", AXES, MEM);
  check(inv.command === BIN, "command is the corm binary");
  check(inv.args.length === 3, "three args (flag, payload, filespec)");
  check(inv.args[0] === "-p", "store flag");
  check(inv.args[1] === "1:2026-09-14:Beacon Harbor lights", "ref:payload, no internal split");
  check(inv.args[2] === FILESPEC, "roster filespec last");
});

Deno.test("store invocation with binary payload adheres to stdin convention", () => {
  const binBytes = new Uint8Array([0x48, 0x54, 0x4f, 0x4b, 0x04]);
  const inv = buildStoreInvocation(BIN, FILESPEC, 42, binBytes, AXES, MEM);
  check(inv.command === BIN, "command is corm binary");
  check(inv.args.length === 3, "three args");
  check(inv.args[0] === "-p", "store flag");
  check(inv.args[1] === "42:-", "ref:- stdin convention");
  check(inv.args[2] === FILESPEC, "roster filespec last");
  check(inv.payloadBytes === binBytes, "payloadBytes preserved");
});

Deno.test("scan invocation is byte-identical to §8 (level-1 bounded window)", () => {
  const expr = scanExpr("beacon", 1, date("2026-09-15"));
  check(expr === "(joint AND lemma)", "expr exact");
  const inv = buildScanInvocation(BIN, FILESPEC, expr, 10, AXES, MEM);
  check(inv.args.join(" ") === `-X ${expr} -g . ${FILESPEC} -t 10`, "arg order byte-identical to §8");
});

Deno.test("scanExpr: level 0 omits the joint leaf (pure text)", () => {
  check(scanExpr("beacon", 0, date("2026-09-15")) === "lemma", "pure stoma");
});

Deno.test("scanExpr: level 2 bounds to the month window", () => {
  const expr = scanExpr("beacon", 2, date("2026-09-15"));
  check(expr === "(joint AND lemma)", "month window");
});

Deno.test("scanExpr: accent-sensitive text passes through verbatim (no transliteration)", () => {
  check(scanExpr("Pão", 0, date("2026-09-15")) === "lemma", "Pão verbatim");
});

Deno.test("scanExpr: level 0 with --until creates epoch-to-until window", () => {
  check(scanExpr("beacon", 0, date("2026-09-15"), "2026-09-20") === "(joint AND lemma)", "level-0 + until");
});

Deno.test("scanExpr: level 1 with --until caps b at until", () => {
  check(scanExpr("beacon", 1, date("2026-09-15"), "2026-09-15") === "(joint AND lemma)", "level-1 + until same day");
});

Deno.test("scanExpr: level 1 with --until past tomorrow uses tomorrow", () => {
  check(scanExpr("beacon", 1, date("2026-09-15"), "2026-10-01") === "(joint AND lemma)", "level-1 + until beyond window");
});

Deno.test("scanExpr: level 2 with --until caps at until", () => {
  check(scanExpr("beacon", 2, date("2026-09-15"), "2026-09-20") === "(joint AND lemma)", "level-2 + until within month");
});

Deno.test("forget / list / get invocations byte-identical to §8", () => {
  const forget = buildForgetInvocation(BIN, FILESPEC, 1, AXES, MEM);
  check(forget.args.join(" ") === `-d 1 ${FILESPEC}`, "forget");
  const list = buildListInvocation(BIN, FILESPEC, AXES, MEM);
  check(list.args.join(" ") === `-g . ${FILESPEC}`, "list");
  const get = buildGetInvocation(BIN, FILESPEC, 1, AXES, MEM);
  check(get.args.join(" ") === `-r -g 1 ${FILESPEC}`, "get uses -r for AINDEX ref");
});

Deno.test("filespecFor uses absolute path to avoid ./ alias clobber", () => {
  check(filespecFor(MEM) === `${MEM}/mem.db@joint,lemma:a:b` || filespecFor(MEM) === `${MEM}/mem.db@joint,lemma:a:s`, "absolute filespec");
  check(filespecFor(MEM, true) === `${MEM}/mem.db@joint,lemma,sepal:a:b` || filespecFor(MEM, true) === `${MEM}/mem.db@joint,lemma,sepal:a:s`, "sepal filespec");
  check(filespecFor(MEM, false) === `${MEM}/mem.db@joint,lemma:a:b` || filespecFor(MEM, false) === `${MEM}/mem.db@joint,lemma:a:s`, "embed=false unchanged");
});

Deno.test("scanExpr: bare sepal ANDed into any window shape when embed ready", () => {
  check(
    scanExpr("beacon", 0, date("2026-09-15"), undefined, true) === "(lemma AND sepal)",
    "level-0 + bare sepal",
  );
  check(
    scanExpr("beacon", 1, date("2026-09-15"), undefined, true) === "(joint AND lemma AND sepal)",
    "level-1 + bare sepal",
  );
  check(
    scanExpr("beacon", 0, date("2026-09-15"), "2026-09-20", true) === "(joint AND lemma AND sepal)",
    "level-0 + until + bare sepal",
  );
  check(
    scanExpr("beacon", 0, date("2026-09-15"), undefined, false) === "lemma",
    "withEmbed=false → no sepal",
  );
});

Deno.test("scanWindowArgs: time-window flags mirror the scanExpr window", () => {
  check(scanWindowArgs(1, date("2026-09-15")).join(" ") === "--since=2026-09-15 --until=2026-09-16", "level-1 bounded today");
  check(scanWindowArgs(0, date("2026-09-15"), "2026-09-20").join(" ") === "--since=0 --until=2026-09-20", "level-0 + until epoch window");
  check(scanWindowArgs(0, date("2026-09-15")).length === 0, "level-0 no until → no window flags");
  check(scanWindowArgs(2, date("2026-09-15")).join(" ") === "--since=2026-09-01 --until=2026-10-01", "level-2 month window");
});

Deno.test("scanWindow: cap b at until when inside the window; else keep window", () => {
  check(scanWindow(1, date("2026-09-15"), "2026-09-15")!.b === "2026-09-15", "until inside day caps b");
  check(scanWindow(1, date("2026-09-15"), "2026-10-01")!.b === "2026-09-16", "until beyond window keeps b");
  check(scanWindow(0, date("2026-09-15")) === null, "level-0 no until → null");
});

Deno.test("buildScanInvocation: extraArgs appended after -t limit", () => {
  const inv = buildScanInvocation(BIN, FILESPEC, "x", 5, AXES, MEM, undefined, ["--query=beacon", "--min-sim=0.2"]);
  check(inv.args.join(" ") === `-X x -g . ${FILESPEC} -t 5 --query=beacon --min-sim=0.2`, "extraArgs appended");
});

Deno.test("embedEnv: configured pair produces env vars; unconfigured or partial → empty", () => {
  const full = { embedUrl: "http://h:4242/v1/embeddings", embedModel: "m", embedKey: "k" } as MmConfig;
  const env = embedEnv(full);
  check(env["CORM_SEPAL_EMBED_URL"] === "http://h:4242/v1/embeddings", "url var");
  check(env["CORM_SEPAL_EMBED_MODEL"] === "m", "model var");
  check(env["CORM_SEPAL_EMBED_KEY"] === "k", "key var");
  check(embedEnv({} as MmConfig).CORM_SEPAL_EMBED_URL === undefined, "empty cfg → no url");
  check(embedEnv({ embedUrl: "http://h" } as MmConfig).CORM_SEPAL_EMBED_MODEL === undefined, "url-only → no model");
  check(embedEnv({ embedModel: "m" } as MmConfig).CORM_SEPAL_EMBED_URL === undefined, "model-only → no url");
});

Deno.test("invocations carry CORM_AXIS_PATH env and memDir cwd", () => {
  const inv = buildScanInvocation(BIN, FILESPEC, "x", 10, AXES, MEM);
  check(inv.env.CORM_AXIS_PATH === AXES, "CORM_AXIS_PATH set");
  check(inv.cwd === MEM, "cwd = memDir");
});

Deno.test("parseResultLines: scored and pure-filter renderings", () => {
  const scored = parseResultLines("1 0.125000 2026-09-13T20:00:00:Beacon Harbor lights\n3 0.125000 2026-09-14T12:00:00:Beacon Harbor lights\n");
  check(scored.length === 2, "two records");
  check(scored[0].ref === 1 && scored[0].score === "0.125000", "scored ref+score");
  check(scored[0].record === "2026-09-13T20:00:00:Beacon Harbor lights", "record intact with colons");
  const flat = parseResultLines("1 raw record\n");
  check(flat.length === 1 && flat[0].score === undefined && flat[0].record === "raw record", "pure-filter record");
});

Deno.test("parseResultLines: empty and dangling stderr lines", () => {
  check(parseResultLines("").length === 0, "empty");
  check(parseResultLines("dangling warning\n").length === 0, "non-ref lines skipped");
});

Deno.test("payloadDate: ISO-keep, non-ISO falls back to now date", () => {
  check(payloadDate("2026-09-14T12:30:00", date("2026-09-15")) === "2026-09-14", "ISO prefix kept");
  check(payloadDate("beacon", date("2026-09-15")) === "2026-09-15", "non-ISO → now date");
  check(payloadDate(undefined, date("2026-09-15")) === "2026-09-15", "absent → now date");
});
