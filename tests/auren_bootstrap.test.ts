import {
  MODEL_CATALOG,
  type CatalogModel,
  buildDefaultConfig,
  chooseDefaults,
  downloadModel,
  findAurenLauncher,
  findUserConfig,
  modelsDir,
  presentModels,
  shouldAutoDownload,
  tryAcquireLock,
  releaseLock,
  writeDefaultConfig,
  diagnoseAuren,
  describeProgress,
  describeModelStatus,
  ensureAuren,
  resetBootstrapForTests,
} from "../src/auren-bootstrap.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "auren-boot-"));
}

function fakeModel(over: Partial<CatalogModel> & { id: string; file: string }): CatalogModel {
  return {
    url: "http://127.0.0.1:1/x",
    bytes: 0,
    sha256: "0".repeat(64),
    tier: "small",
    capabilities: ["embed"],
    config: { n_ctx: 2048 },
    ...over,
  };
}

function touch(path: string, content = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

Deno.test("catalog: ids unique, hashes are 64 hex, urls https, sizes positive", () => {
  const ids = new Set<string>();
  for (const m of MODEL_CATALOG) {
    check(!ids.has(m.id), `duplicate id ${m.id}`);
    ids.add(m.id);
    check(/^[0-9a-f]{64}$/.test(m.sha256), `${m.id} sha256`);
    check(m.url.startsWith("https://huggingface.co/"), `${m.id} url`);
    check(m.bytes > 0, `${m.id} bytes`);
    check(m.file.endsWith(".gguf"), `${m.id} file`);
  }
  for (const id of ["olmoe", "qwen", "bge-base", "bge-small"]) check(ids.has(id), `catalog has ${id}`);
  const olmoe = MODEL_CATALOG.find((m) => m.id === "olmoe")!;
  check(olmoe.tier === "large", "olmoe is the large tier");
  check(MODEL_CATALOG.filter((m) => m.tier === "small").every((m) => m.bytes < 600 * 1024 * 1024), "small tier is under 600 MB");
});

Deno.test("chooseDefaults: judge olmoe > qwen, embed bge-base > bge-small", () => {
  const all = MODEL_CATALOG;
  let d = chooseDefaults(all);
  check(d.judge === "olmoe" && d.chat === "olmoe" && d.embed === "bge-base", "all present");
  d = chooseDefaults(all.filter((m) => m.id === "qwen" || m.id === "bge-small"));
  check(d.judge === "qwen" && d.chat === "qwen" && d.embed === "bge-small", "fallbacks");
  d = chooseDefaults(all.filter((m) => m.id === "bge-small"));
  check(d.judge === undefined && d.embed === "bge-small", "embed-only has no judge");
  d = chooseDefaults([]);
  check(d.judge === undefined && d.embed === undefined, "nothing present");
});

Deno.test("buildDefaultConfig: only present models, absolute paths, marker, null when empty", () => {
  const home = tmpHome();
  try {
    check(buildDefaultConfig([], home) === null, "null with no models");
    const q = MODEL_CATALOG.find((m) => m.id === "qwen")!;
    const b = MODEL_CATALOG.find((m) => m.id === "bge-small")!;
    const cfg = buildDefaultConfig([q, b], home) as Record<string, unknown>;
    const models = cfg["models"] as Array<Record<string, unknown>>;
    check(models.length === 2, "two models");
    check(String(models[0]["path"]).startsWith(join(home, ".models")), "absolute path under home/.models");
    check((cfg["defaults"] as Record<string, string>)["judge"] === "qwen", "defaults.judge");
    check(typeof cfg["_managedBy"] === "string", "managed marker");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("presentModels: detects catalog files on disk by file name", () => {
  const home = tmpHome();
  try {
    check(presentModels(MODEL_CATALOG, home).length === 0, "none yet");
    touch(join(modelsDir(home), "bge-small-en-v1.5.gguf"));
    const p = presentModels(MODEL_CATALOG, home);
    check(p.length === 1 && p[0].id === "bge-small", "bge-small detected");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("findUserConfig: honours env, ./auren.json, ~/.config, ~/auren.json, ~/.auren.json", () => {
  const home = tmpHome();
  const cwd = tmpHome();
  try {
    check(findUserConfig({ home, cwd, env: {} }) === null, "none");
    touch(join(home, ".auren.json"), "{}");
    check(findUserConfig({ home, cwd, env: {} }) === join(home, ".auren.json"), "~/.auren.json");
    touch(join(home, ".config", "auren", "config.json"), "{}");
    check(findUserConfig({ home, cwd, env: {} }) === join(home, ".config", "auren", "config.json"), "~/.config wins over ~/.auren.json");
    touch(join(home, "auren.json"), "{}");
    check(findUserConfig({ home, cwd, env: {} }) === join(home, "auren.json"), "~/auren.json wins");
    touch(join(cwd, "auren.json"), "{}");
    check(findUserConfig({ home, cwd, env: {} }) === join(cwd, "auren.json"), "./auren.json wins");
    const explicit = join(home, "explicit.json");
    touch(explicit, "{}");
    check(findUserConfig({ home, cwd, env: { AUREN_CONFIG_PATH: explicit } }) === explicit, "env wins");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

Deno.test("writeDefaultConfig: creates, is idempotent, never overwrites a user config, upgrades only its own", () => {
  const home = tmpHome();
  const cwd = tmpHome();
  try {
    const q = MODEL_CATALOG.find((m) => m.id === "qwen")!;
    touch(join(modelsDir(home), q.file));
    const r1 = writeDefaultConfig({ home, cwd, env: {} });
    check(r1.status === "written", `written, got ${r1.status}`);
    const path = join(home, ".config", "auren", "config.json");
    check(r1.path === path && existsSync(path), "default path");
    const r2 = writeDefaultConfig({ home, cwd, env: {} });
    check(r2.status === "unchanged", "idempotent");

    // a better model arrives: our own managed config is upgraded
    const o = MODEL_CATALOG.find((m) => m.id === "olmoe")!;
    touch(join(modelsDir(home), o.file));
    const r3 = writeDefaultConfig({ home, cwd, env: {} });
    check(r3.status === "updated", `updated, got ${r3.status}`);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    check(cfg.defaults.judge === "olmoe", "judge upgraded to olmoe");

    // a hand-written config is never touched
    writeFileSync(path, JSON.stringify({ models: [], custom: true }));
    const r4 = writeDefaultConfig({ home, cwd, env: {} });
    check(r4.status === "user-config", `user-config, got ${r4.status}`);
    check(JSON.parse(readFileSync(path, "utf8")).custom === true, "user file preserved");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

Deno.test("writeDefaultConfig: no models and no config reports no-models without creating a file", () => {
  const home = tmpHome();
  const cwd = tmpHome();
  try {
    const r = writeDefaultConfig({ home, cwd, env: {} });
    check(r.status === "no-models", `no-models, got ${r.status}`);
    check(!existsSync(join(home, ".config", "auren", "config.json")), "no file created");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

Deno.test("shouldAutoDownload: small auto, large only with consent or auto setting, never blocks all", () => {
  const small = fakeModel({ id: "s", file: "s.gguf", tier: "small" });
  const large = fakeModel({ id: "l", file: "l.gguf", tier: "large" });
  check(shouldAutoDownload(small, "ask", undefined) === true, "small asks nothing");
  check(shouldAutoDownload(small, "auto", undefined) === true, "small auto");
  check(shouldAutoDownload(small, "never", undefined) === false, "small never");
  check(shouldAutoDownload(large, "ask", undefined) === "ask", "large asks");
  check(shouldAutoDownload(large, "ask", true) === true, "large consented");
  check(shouldAutoDownload(large, "ask", false) === false, "large declined");
  check(shouldAutoDownload(large, "auto", undefined) === true, "large auto");
  check(shouldAutoDownload(large, "never", true) === false, "large never overrides consent");
});

interface Served {
  url: string;
  stop: () => Promise<void>;
  requests: Array<{ range: string | null }>;
}

function serve(body: Uint8Array): Served {
  const requests: Array<{ range: string | null }> = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const range = req.headers.get("range");
    requests.push({ range });
    if (range) {
      const m = /bytes=(\d+)-/.exec(range);
      const start = m ? Number(m[1]) : 0;
      return new Response(body.slice(start) as unknown as BodyInit, {
        status: 206,
        headers: { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` },
      });
    }
    return new Response(body as unknown as BodyInit, { status: 200, headers: { "content-length": String(body.length) } });
  });
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://127.0.0.1:${addr.port}/m.gguf`, stop: () => server.shutdown(), requests };
}

function sha(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

Deno.test("downloadModel: fetches, verifies sha256, renames atomically, reports progress", async () => {
  const home = tmpHome();
  const body = new TextEncoder().encode("hello model ".repeat(1000));
  const srv = serve(body);
  try {
    const m = fakeModel({ id: "t", file: "t.gguf", url: srv.url, bytes: body.length, sha256: sha(body) });
    const seen: number[] = [];
    const r = await downloadModel(m, { home, onProgress: (done) => seen.push(done) });
    check(r.status === "downloaded", `downloaded, got ${r.status}`);
    const final = join(modelsDir(home), "t.gguf");
    check(readFileSync(final).length === body.length, "final file written");
    check(!existsSync(final + ".part"), "no .part left");
    check(seen.length > 0 && seen[seen.length - 1] === body.length, "progress reached 100%");
    const again = await downloadModel(m, { home });
    check(again.status === "present", "second call is a no-op");
    check(srv.requests.length === 1, "no second request");
  } finally {
    await srv.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("downloadModel: resumes an interrupted .part with a Range request", async () => {
  const home = tmpHome();
  const body = new TextEncoder().encode("resume me please ".repeat(500));
  const srv = serve(body);
  try {
    const m = fakeModel({ id: "r", file: "r.gguf", url: srv.url, bytes: body.length, sha256: sha(body) });
    mkdirSync(modelsDir(home), { recursive: true });
    writeFileSync(join(modelsDir(home), "r.gguf.part"), body.slice(0, 1000));
    const r = await downloadModel(m, { home });
    check(r.status === "downloaded", `downloaded, got ${r.status}`);
    check(srv.requests[0].range === "bytes=1000-", `range header, got ${srv.requests[0].range}`);
    check(sha(readFileSync(join(modelsDir(home), "r.gguf"))) === sha(body), "content intact");
  } finally {
    await srv.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("downloadModel: sha256 mismatch is rejected and leaves no final file", async () => {
  const home = tmpHome();
  const body = new TextEncoder().encode("tampered ".repeat(100));
  const srv = serve(body);
  try {
    const m = fakeModel({ id: "bad", file: "bad.gguf", url: srv.url, bytes: body.length, sha256: "a".repeat(64) });
    const r = await downloadModel(m, { home });
    check(r.status === "failed" && /sha256/i.test(r.error ?? ""), `failed with sha256 error, got ${JSON.stringify(r)}`);
    check(!existsSync(join(modelsDir(home), "bad.gguf")), "no final file");
    check(!existsSync(join(modelsDir(home), "bad.gguf.part")), "corrupt .part discarded");
  } finally {
    await srv.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("downloadModel: unreachable network fails softly with a message", async () => {
  const home = tmpHome();
  try {
    const m = fakeModel({ id: "net", file: "net.gguf", url: "http://127.0.0.1:1/none.gguf", bytes: 10 });
    const r = await downloadModel(m, { home });
    check(r.status === "failed" && (r.error ?? "") !== "", "soft failure with message");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("downloadModel: a file the user already has is never replaced, even if its hash differs", async () => {
  const home = tmpHome();
  try {
    touch(join(modelsDir(home), "mine.gguf"), "my own quantisation");
    const m = fakeModel({ id: "mine", file: "mine.gguf", bytes: 999999 });
    const r = await downloadModel(m, { home });
    check(r.status === "present", "present");
    check(readFileSync(join(modelsDir(home), "mine.gguf"), "utf8") === "my own quantisation", "untouched");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("locks: exclusive, released, and a dead owner's lock is recovered", () => {
  const home = tmpHome();
  try {
    const lock = join(home, "x.lock");
    check(tryAcquireLock(lock) === true, "first acquires");
    check(tryAcquireLock(lock) === false, "second blocked while owner alive");
    releaseLock(lock);
    check(tryAcquireLock(lock) === true, "acquirable after release");
    releaseLock(lock);
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    check(tryAcquireLock(lock) === true, "dead pid lock is stale and recovered");
    releaseLock(lock);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

Deno.test("findAurenLauncher: repo script, system axil + module, or null; no hardcoded user paths", () => {
  const home = tmpHome();
  const cwd = tmpHome();
  const bin = tmpHome();
  const lib = tmpHome();
  try {
    check(findAurenLauncher({ home, cwd, env: { PATH: "" }, libDirs: [] }) === null, "nothing installed");

    touch(join(home, "axil-auren", "scripts", "auren-server"), "#!/bin/sh\n");
    chmodSync(join(home, "axil-auren", "scripts", "auren-server"), 0o755);
    let l = findAurenLauncher({ home, cwd, env: { PATH: "" }, libDirs: [] });
    check(l?.kind === "script" && l.command.endsWith("auren-server"), "repo script found under HOME");

    rmSync(join(home, "axil-auren"), { recursive: true, force: true });
    touch(join(bin, "axil"), "#!/bin/sh\n");
    chmodSync(join(bin, "axil"), 0o755);
    touch(join(lib, "libaxil-auren.so"), "elf");
    l = findAurenLauncher({ home, cwd, env: { PATH: bin }, libDirs: [lib] });
    check(l?.kind === "axil", "system axil found");
    check(l!.args.includes("-m") && l!.args.includes(join(lib, "libaxil-auren")), "module path passed without .so");
    check(!l!.args.includes("-d"), "no -d so axil self-detaches");

    touch(join(bin, "auren-server"), "#!/bin/sh\n");
    chmodSync(join(bin, "auren-server"), 0o755);
    l = findAurenLauncher({ home, cwd, env: { PATH: bin }, libDirs: [lib] });
    check(l?.kind === "script" && l.command === join(bin, "auren-server"), "PATH script preferred");
  } finally {
    for (const d of [home, cwd, bin, lib]) rmSync(d, { recursive: true, force: true });
  }
});

Deno.test("diagnoseAuren: names the exact missing piece with a doc link", () => {
  const home = tmpHome();
  const cwd = tmpHome();
  try {
    const d = diagnoseAuren({ home, cwd, env: { PATH: "" }, libDirs: [], running: false, downloads: [] });
    check(d.some((x) => x.code === "no-launcher" && x.link.startsWith("https://")), "no launcher");
    check(d.every((x) => !x.message.includes("/home/")), "no user path leakage");
    const ok = diagnoseAuren({ home, cwd, env: { PATH: "" }, libDirs: [], running: true, downloads: [] });
    check(ok.length === 0, "running server needs no notice");
    const dl = diagnoseAuren({ home, cwd, env: { PATH: "" }, libDirs: [], running: true, downloads: [{ id: "olmoe", done: 5, total: 10 }] });
    check(dl.some((x) => x.code === "downloading"), "downloading is reported as info");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

Deno.test("shouldAutoDownload: inference models without embed capability are never auto-downloaded", () => {
  const chatSmall = fakeModel({ id: "qwen", file: "qwen.gguf", tier: "small", capabilities: ["chat", "judge"] });
  const chatLarge = fakeModel({ id: "olmoe", file: "olmoe.gguf", tier: "large", capabilities: ["chat", "judge"] });
  check(shouldAutoDownload(chatSmall, "auto", undefined) === false, "small chat model returns false with auto");
  check(shouldAutoDownload(chatSmall, "ask", undefined) === false, "small chat model returns false with ask");
  check(shouldAutoDownload(chatLarge, "auto", true) === false, "large chat model returns false even with consent");
  check(shouldAutoDownload(chatLarge, "ask", undefined) === false, "large chat model returns false with ask");
});

Deno.test("describeProgress and describeModelStatus: non-blocking visual feedback formatting", () => {
  check(describeProgress({ phase: "idle", running: false, started: false, downloads: [], failures: [], pendingConsent: [], configPath: null, notices: [] }) === undefined, "no progress when not downloading");
  check(describeModelStatus({ phase: "idle", running: false, started: false, downloads: [], failures: [], pendingConsent: [], configPath: null, notices: [] }) === "🔌 off", "shows off when idle");

  const dlState = {
    phase: "downloading" as const,
    running: false,
    started: false,
    downloads: [{ id: "bge-base", done: 50, total: 100 }],
    failures: [],
    pendingConsent: [],
    configPath: null,
    notices: [],
  };
  check(describeProgress(dlState) === "⬇ bge-base (50%)", "progress includes model id and percentage");
  check(describeModelStatus(dlState) === "⬇ bge-base (50%)", "model status reflects download progress");

  const runningState = {
    phase: "ready" as const,
    running: true,
    started: false,
    activeModel: "bge-base",
    downloads: [],
    failures: [],
    pendingConsent: [],
    configPath: null,
    notices: [],
  };
  check(describeModelStatus(runningState) === "⚡ bge-base", "model status reflects active running model");
});

Deno.test("ensureAuren: skips downloading when an embedding model is already present on disk", async () => {
  const home = tmpHome();
  const cwd = tmpHome();
  resetBootstrapForTests();
  try {
    touch(join(modelsDir(home), "bge-small-en-v1.5.gguf"), "mock");
    let fetched = false;
    const fetchImpl: typeof fetch = () => {
      fetched = true;
      return Promise.reject(new Error("should not fetch"));
    };
    const st = await ensureAuren({
      home,
      cwd,
      fetchImpl,
      settings: { autoStart: false, autoDownloadModels: "auto" },
    });
    check(!fetched, "no download fetch was attempted because embedding model is already present");
    check(st.downloads.length === 0, "no downloads in progress");
  } finally {
    resetBootstrapForTests();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
