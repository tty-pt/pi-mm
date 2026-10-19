import { join } from "node:path";
import { makeStoreTool, makeScanTool, makeThinkTool, makeForgetTool, makeResetTool, type ToolEnv } from "../src/tools/index.ts";
import type { QmapRunner } from "../src/qmap.ts";
import { give } from "../src/tools/index.ts";
import { fakeRunner, runTool, okResult } from "./fake-qmap.ts";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const CWD = await Deno.makeTempDir({ prefix: "mm-tools-cwd-" });
const FS = `${CWD}/.pi/mm/mem.db@joint,lemma:a:s`;
const FS_SEPAL = `${CWD}/.pi/mm/mem.db@joint,lemma,sepal:a:s`;

function now(): Date {
  return new Date("2026-09-15T10:00:00");
}

function env(runner: QmapRunner, cfg: Partial<MmConfig> = {}): ToolEnv {
  try { Deno.removeSync(join(CWD, ".ref_seq")); } catch { /* ignore */ }
  try { Deno.removeSync(join(CWD, ".pi", "mm", ".ref_seq")); } catch { /* ignore */ }
  return {
    cwd: CWD,
    runner,
    nowProvider: now,
    cfg: { ...DEFAULT_CONFIG, qmapBin: "/usr/bin/qmap", ...cfg },
  };
}

function embedEnvCfg(): Partial<MmConfig> {
  return { embedUrl: "http://localhost:4242/v1/embeddings", embedModel: "nomic-embed-text" };
}

const ctx = { cwd: CWD };

Deno.test("memory_store: lists refs, picks nextRef, stores ref:payload, returns count", async () => {
  const runner = fakeRunner([
    okResult("1\n3\n"),
    okResult("ok\n"),
  ]);
  const tool = makeStoreTool(give(env(runner)));
  const res = await runTool(tool, { text: "hello world" }, ctx);
  check(runner.invocations.length === 2, `two invocations, got ${runner.invocations.length}`);
  check(runner.invocations[0].args.join(" ") === `-g . ${FS}`, "list first");
  check(runner.invocations[1].args[0] === "-p" && runner.invocations[1].args[1] === "4:2026-09-15:hello world" && runner.invocations[1].args[2] === FS, "store nextRef + date + text");
  const details = res.details as { ref: number; key: string };
  check(details.ref === 4, "returned ref 4");
  check(details.key === "@2026-09-15", "key is @date");
});

Deno.test("memory_store: explicit timestamp prefix wins over now", async () => {
  const runner = fakeRunner([okResult(""), okResult("ok\n")]);
  const tool = makeStoreTool(give(env(runner)));
  await runTool(tool, { text: "memo", timestamp: "2026-09-14T09:00:00" }, ctx);
  check(runner.invocations[1].args[1].startsWith("1:2026-09-14:"), "timestamp kept");
});

Deno.test("memory_store: empty text is a graceful non-error", async () => {
  const runner = fakeRunner();
  const tool = makeStoreTool(give(env(runner)));
  const res = await runTool(tool, { text: "   " }, ctx);
  check(runner.invocations.length === 0, "nothing invoked");
  check((res.content[0].text ?? "").startsWith("mm:"), "non-error diagnostic");
});

Deno.test("memory_scan: level 0 → pure lemma expr, parsed records", async () => {
  const runner = fakeRunner([
    okResult("1 0.125000 2026-09-13T20:00:00:Beacon Harbor lights\n3 0.125000 2026-09-14T12:00:00:Beacon Harbor lights\n"),
  ]);
  const tool = makeScanTool(give(env(runner)));
  const res = await runTool(tool, { topic: "beacon", level: 0 }, ctx);
  check(runner.invocations[0].args.join(" ") ===
    `-X lemma -g . ${FS} -t 10 --field=text --matched=1 --query=beacon`, "level-0 expr + default limit + query flag");
  const details = res.details as { records: Array<{ ref: number; score: string; record: string }> };
  check(details.records.length === 2, "two records");
  check(details.records[0].ref === 1 && details.records[0].score === "0.125000", "first record");
});

Deno.test("memory_scan: level 1 bounds the joint window from the injected clock", async () => {
  const runner = fakeRunner([okResult("2 1.000000 2026-09-14T12:00:00:anything\n")]);
  const tool = makeScanTool(give(env(runner)));
  await runTool(tool, { topic: "beacon", level: 1 }, ctx);
  const args = runner.invocations[0].args.join(" ");
  check(args.includes("(joint AND lemma)"), `day window expr; got ${args}`);
  check(args.includes("--since=2026-09-15 --until=2026-09-16"), `window flags; got ${args}`);
  check(args.includes("-t 10"), "limit passes through");
});

Deno.test("memory_scan: zero matches → empty non-error", async () => {
  const runner = fakeRunner([okResult("")]);
  const tool = makeScanTool(give(env(runner)));
  const res = await runTool(tool, { topic: "nope" }, ctx);
  const details = res.details as { records: unknown[] };
  check(details.records.length === 0, "no match is not an error");
  check(runner.invocations.length === 1, "scan still ran");
});

Deno.test("memory_scan: level 0 with --until → epoch-to-until window", async () => {
  const runner = fakeRunner([okResult("1 0.125000 2026-09-14:Beacon Harbor lights\n")]);
  const tool = makeScanTool(give(env(runner)));
  await runTool(tool, { topic: "beacon", until: "2026-09-16" }, ctx);
  const args = runner.invocations[0].args.join(" ");
  check(args.includes("(joint AND lemma)"), `epoch-to-until expr; got ${args}`);
  check(args.includes("--since=0 --until=2026-09-16"), `epoch-to-until window flags; got ${args}`);
});

Deno.test("memory_scan: level 1 with --until caps b at until", async () => {
  const runner = fakeRunner([okResult("3 0.125000 2026-09-15:anything\n")]);
  const tool = makeScanTool(give(env(runner)));
  await runTool(tool, { topic: "beacon", level: 1, until: "2026-09-15" }, ctx);
  const args = runner.invocations[0].args.join(" ");
  check(args.includes("(joint AND lemma)"), `capped expr; got ${args}`);
  check(args.includes("--since=2026-09-15 --until=2026-09-15"), `capped at until; got ${args}`);
});

Deno.test("memory_think: numeric key gets raw payload; extract splits date/text", async () => {
  const runner = fakeRunner([okResult("2026-09-14T20:00:00:Beacon Harbor lights\n")]);
  const tool = makeThinkTool(give(env(runner)));
  const res = await runTool(tool, { key: "4" }, ctx);
  check(runner.invocations[0].args.join(" ") === `-r -g 4 ${FS}`, "classic get uses -r");
  const d = res.details as { date: string; text: string };
  check(d.date === "2026-09-14T20:00:00", "extract date default");
  check(d.text === "Beacon Harbor lights", "extract text default");

  const runner2 = fakeRunner([okResult("2026-09-14T20:00:00:Beacon Harbor lights\n")]);
  const res2 = await runTool(makeThinkTool(give(env(runner2))), { key: "4", extract: "text" }, ctx);
  check((res2.details as { text: string }).text === "Beacon Harbor lights", "extract=text");
  const runner3 = fakeRunner([okResult("2026-09-14T20:00:00:Beacon Harbor lights\n")]);
  const res3 = await runTool(makeThinkTool(give(env(runner3))), { key: "4", extract: "date" }, ctx);
  check((res3.details as { date: string }).date === "2026-09-14T20:00:00", "extract=date");
});

Deno.test("memory_think: text key resolves via scan top-1, then gets", async () => {
  const runner = fakeRunner([
    okResult("2 1.000000 2026-09-14T12:00:00:memo found\n"),
    okResult("2026-09-14T12:00:00:memo found\n"),
  ]);
  const tool = makeThinkTool(give(env(runner)));
  const res = await runTool(tool, { key: "beacon" }, ctx);
  check(runner.invocations.length === 2, "scan then get");
  check(runner.invocations[0].args.includes("-X"), "resolution scan");
  check(runner.invocations[0].args.join(" ").endsWith(`-g . ${FS} -t 1 --field=text --matched=1 --query=beacon`), "limit 1 scan + query flag");
  check(runner.invocations[1].args.join(" ") === `-r -g 2 ${FS}`, "get resolved ref");
  check((res.details as { ref: number }).ref === 2, "ref 2 resolved");
});

Deno.test("memory_forget: numeric key deletes via roster file", async () => {
  const runner = fakeRunner([okResult("")]);
  const tool = makeForgetTool(give(env(runner)));
  const res = await runTool(tool, { key: "4" }, ctx);
  check(runner.invocations[0].args.join(" ") === `-d 4 ${FS}`, "forget args");
  check((res.details as { removed: boolean }).removed === true, "removed");
});

Deno.test("memory_forget: text key scans first then deletes", async () => {
  const runner = fakeRunner([okResult("2 1.000000 payload\n"), okResult("")]);
  const tool = makeForgetTool(give(env(runner)));
  const res = await runTool(tool, { key: "beacon" }, ctx);
  check(runner.invocations.length === 2, "scan then forget");
  check(runner.invocations[1].args.join(" ") === `-d 2 ${FS}`, "forget resolved ref");
  check((res.details as { ref: number }).ref === 2, "forgot ref 2");
});

Deno.test("memory_reset: enumerate + forget loop skips the -1 sentinel", async () => {
  const runner = fakeRunner([
    okResult("1\n3\n-1\n"),
    okResult(""),
    okResult(""),
  ]);
  const tool = makeResetTool(give(env(runner)));
  const res = await runTool(tool, {}, ctx);
  check(runner.invocations.length === 3, "list + 2 forgets");
  check(runner.invocations[0].args.join(" ") === `-g . ${FS}`, "list first");
  check(runner.invocations[1].args.join(" ") === `-d 1 ${FS}`, "forget 1");
  check(runner.invocations[2].args.join(" ") === `-d 3 ${FS}`, "forget 3");
  const d = res.details as { refsForgotten: number };
  check(d.refsForgotten === 2, "two forgotten, sentinel skipped");
});

Deno.test("memory_reset: idempotent — empty listing forgets nothing", async () => {
  const runner = fakeRunner([okResult("")]);
  const tool = makeResetTool(give(env(runner)));
  const res = await runTool(tool, {}, ctx);
  check((res.details as { refsForgotten: number }).refsForgotten === 0, "no-op rerun");
  check(runner.invocations.length === 1, "only list ran");
});

Deno.test("degradation: no qmap binary → every tool returns a non-error diagnostic", async () => {
  const runner = fakeRunner();
  const badEnv = { ...env(runner), cfg: { ...DEFAULT_CONFIG, qmapBin: "" } };
  for (const tool of [
    makeStoreTool(give(badEnv)),
    makeScanTool(give(badEnv)),
    makeThinkTool(give(badEnv)),
    makeForgetTool(give(badEnv)),
    makeResetTool(give(badEnv)),
  ]) {
    const res = await runTool(tool, { key: "x", topic: "x", text: "x" }, ctx);
    check((res.content[0].text ?? "").startsWith("mm unavailable"), "degradation diagnostic");
  }
  check(runner.invocations.length === 0, "nothing shelled out");
});

Deno.test("degradation: nonzero exec exit still returns a non-error result with stderr", async () => {
  const runner = fakeRunner([{ stdout: "", stderr: "joint missing", code: 1 }]);
  const tool = makeScanTool(give(env(runner)));
  const res = await runTool(tool, { topic: "x" }, ctx);
  check((res.content[0].text ?? "").includes("joint missing"), "stderr surfaced");
});

Deno.test("memory_scan: embed=true with sepal configured → independent lexical and semantic paths with flags", async () => {
  const runner = fakeRunner([
    okResult("1 0.125000 2026-09-14:Beacon Harbor lights\n"),
    okResult("1 0.850000 2026-09-14:Beacon Harbor lights\n"),
  ]);
  const tool = makeScanTool(give(env(runner, { ...embedEnvCfg() })));
  const res = await runTool(tool, { topic: "beacon", embed: true }, ctx);
  check(runner.invocations.length === 2, `two independent invocations; got ${runner.invocations.length}`);
  const lexArgs = runner.invocations[0].args.join(" ");
  const semArgs = runner.invocations[1].args.join(" ");
  check(lexArgs.includes("-X lemma"), `lexical path uses lemma; got ${lexArgs}`);
  check(lexArgs.includes("--field=text"), `--field flag carries the field; got ${lexArgs}`);
  check(lexArgs.includes("--matched=1"), `--matched flag carries the flag; got ${lexArgs}`);
  check(lexArgs.includes("--query=beacon"), `--query flag carries the text; got ${lexArgs}`);
  check(semArgs.includes("-X sepal"), `semantic path uses sepal; got ${semArgs}`);
  check(semArgs.includes("--query=beacon"), `semantic query carries text; got ${semArgs}`);
  check(semArgs.includes("--min-sim=0.2"), `--min-sim flag carries the floor; got ${semArgs}`);
  check(runner.invocations[1].args[4] === FS_SEPAL, `sepal aware filespec; got ${runner.invocations[1].args[4]}`);
  check(runner.invocations[1].env["QMAP_SEPAL_EMBED_URL"] === "http://localhost:4242/v1/embeddings", "embed url env var");
  const d = res.details as { records: Array<{ ref: number; origin?: string }>; embed?: string };
  check(d.records.length === 1, "records returned");
  check(d.records[0].origin === "both", "fused origin is both");
  check(d.embed === undefined, "no embed diagnostic on the flags path");
});

Deno.test("memory_scan: embed=true but sepal unconfigured → soft fallback diagnostic", async () => {
  const runner = fakeRunner([okResult("1 0.125000 2026-09-14:Beacon Harbor lights\n")]);
  const tool = makeScanTool(give(env(runner)));
  const res = await runTool(tool, { topic: "beacon", embed: true }, ctx);
  const args = runner.invocations[0].args.join(" ");
  check(!args.includes("sepal"), `no sepal leaf on fallback; got ${args}`);
  check(args.includes("--query=beacon"), `text still rides --query on fallback; got ${args}`);
  check(runner.invocations[0].args[4] === FS, `plain filespec on fallback; got ${runner.invocations[0].args[4]}`);
  const d = res.details as { embed: string };
  check(d.embed === "unconfigured", "diagnostic embed=unconfigured");
});

Deno.test("memory_store/memory_think/memory_forget/memory_reset: sepal-aware filespec + embed env when configured", async () => {
  const runner = fakeRunner([okResult(""), okResult("ok\n")]);
  const res = await runTool(makeStoreTool(give(env(runner, { ...embedEnvCfg() }))), { text: "memo" }, ctx);
  check(runner.invocations[0].args[2] === FS_SEPAL, "store list sepal filespec");
  check(runner.invocations[1].args[2] === FS_SEPAL, "store write sepal filespec");
  check(runner.invocations[1].env["QMAP_SEPAL_EMBED_MODEL"] === "nomic-embed-text", "store embed env");
  check((res.details as { ref: number }).ref === 1, "store ok");

  const runner2 = fakeRunner([okResult("2026-09-14T20:00:00:Beacon Harbor lights\n")]);
  await runTool(makeThinkTool(give(env(runner2, { ...embedEnvCfg() }))), { key: "5" }, ctx);
  check(runner2.invocations[0].args[3] === FS_SEPAL, "think sepal filespec");

  const runner3 = fakeRunner([okResult("")]);
  await runTool(makeForgetTool(give(env(runner3, { ...embedEnvCfg() }))), { key: "5" }, ctx);
  check(runner3.invocations[0].args[2] === FS_SEPAL, "forget sepal filespec");

  const runner4 = fakeRunner([okResult(""), okResult("")]);
  await runTool(makeResetTool(give(env(runner4, { ...embedEnvCfg() }))), {}, ctx);
  check(runner4.invocations[0].args[2] === FS_SEPAL, "reset list sepal filespec");
});