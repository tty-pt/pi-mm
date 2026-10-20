import { readMmConfig, loadConfig, applyEnv, resolveQmapBin, resolveAxisPath, resolveAdvancedTools, sepalConfigured, DEFAULT_CONFIG } from "../src/config.ts";
import { resolveMemDir } from "../src/tools/index.ts";
import { join } from "node:path";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("loadConfig: undefined → defaults", () => {
  const cfg = loadConfig(undefined);
  check(cfg.qmapBin === "", "qmapBin default empty");
  check(cfg.axisLibs === null, "axisLibs default null");
  check(cfg.memDir === ".pi/mm", "memDir default");
  check(cfg.scanLimit === 10, "scanLimit default");
});

Deno.test("loadConfig: valid overrides honored, invalid values fall back", () => {
  const cfg = loadConfig({
    qmapBin: "/usr/bin/qmap",
    axisLibs: "/a:/b",
    memDir: "mem",
    scanLimit: 5,
  });
  check(cfg.qmapBin === "/usr/bin/qmap", "qmapBin override");
  check(cfg.axisLibs === "/a:/b", "axisLibs override");
  check(cfg.memDir === "mem", "memDir override");
  check(cfg.scanLimit === 5, "scanLimit override");

  const bad = loadConfig({ qmapBin: 3, axisLibs: null, memDir: "", scanLimit: -2 });
  check(bad.qmapBin === "", "qmapBin non-string → default");
  check(bad.axisLibs === null, "axisLibs null → default");
  check(bad.memDir === DEFAULT_CONFIG.memDir, "memDir empty → default");
  check(bad.scanLimit === 10, "negative scanLimit → default");
});

Deno.test("applyEnv: fills only when settings unset; respects settings otherwise", () => {
  const fromSettings = loadConfig({ qmapBin: "/usr/bin/qmap", axisLibs: "/a:/b" });
  const merged = applyEnv(fromSettings, { QMAP_BIN: "/env/qmap", QMAP_AXIS_PATH: "/env:/axes" });
  check(merged.qmapBin === "/usr/bin/qmap", "settings qmapBin wins over env");
  check(merged.axisLibs === "/a:/b", "settings axisLibs wins over env");

  const bare = applyEnv(DEFAULT_CONFIG, { QMAP_BIN: "/env/qmap", QMAP_AXIS_PATH: "/env:/axes" });
  check(bare.qmapBin === "/env/qmap", "env QMAP_BIN fills unset qmapBin");
  check(bare.axisLibs === "/env:/axes", "env QMAP_AXIS_PATH fills unset axisLibs");
});

Deno.test("applyEnv: sepal embed env vars fill unset fields; settings win", () => {
  const envRec = {
    QMAP_SEPAL_EMBED_URL: "http://h:4242/v1/embeddings",
    QMAP_SEPAL_EMBED_MODEL: "nomic-embed-text",
    QMAP_SEPAL_EMBED_KEY: "secret",
  };
  const filled = applyEnv(DEFAULT_CONFIG, envRec);
  check(filled.embedUrl === "http://h:4242/v1/embeddings", "env fills url");
  check(filled.embedModel === "nomic-embed-text", "env fills model");
  check(filled.embedKey === "secret", "env fills key");

  const fromSettings = loadConfig({ embedUrl: "http://s:1/v1/embeddings", embedModel: "sm" });
  const merged = applyEnv(fromSettings, envRec);
  check(merged.embedUrl === "http://s:1/v1/embeddings", "settings url wins");
  check(merged.embedModel === "sm", "settings model wins");
  check(merged.embedKey === "secret", "key still from env (settings unset)");
});

Deno.test("sepalConfigured: true only when url+model both set", () => {
  check(sepalConfigured(DEFAULT_CONFIG) === false, "defaults false");
  check(sepalConfigured(applyEnv(DEFAULT_CONFIG, { QMAP_SEPAL_EMBED_URL: "http://h" })) === false, "url only false");
  check(sepalConfigured(applyEnv(DEFAULT_CONFIG, { QMAP_SEPAL_EMBED_MODEL: "m" })) === false, "model only false");
  check(
    sepalConfigured(applyEnv(DEFAULT_CONFIG, { QMAP_SEPAL_EMBED_URL: "http://h", QMAP_SEPAL_EMBED_MODEL: "m" })) === true,
    "pair true",
  );
});

Deno.test("resolveQmapBin: precedence settings → env → PATH → in-site → none", () => {
  const probe = (p: string): boolean => p === "/usr/bin/qmap" || p === "/env/qmap" ||
    p === "/opt/bin/qmap" || p === "/repo/external/libqmap/bin/qmap";
  const cfg = loadConfig({ qmapBin: "/usr/bin/qmap" });
  check(resolveQmapBin(cfg, "/repo", ["/opt/bin"], probe).source === "settings", "settings chosen");

  const fromEnv = applyEnv(DEFAULT_CONFIG, { QMAP_BIN: "/env/qmap" });
  check(resolveQmapBin(fromEnv, "/repo", ["/opt/bin"], probe).path === "/env/qmap", "env chosen");

  const fromPath = resolveQmapBin(DEFAULT_CONFIG, "/repo", ["/opt/bin"], probe);
  check(fromPath.source === "path" && fromPath.path === "/opt/bin/qmap", "PATH chosen");

  const fromInSite = resolveQmapBin(DEFAULT_CONFIG, "/repo", ["/no/qmap"], probe);
  check(fromInSite.source === "insite", "in-site fallback chosen");

  const none = resolveQmapBin(DEFAULT_CONFIG, "/nowhere", ["/no/qmap"], (p) => p === "/nowhere/external/libqmap/bin/qmap" && false);
  check(none.source === "none" && none.path === "", "none when nothing resolves");
});

Deno.test("resolveAxisPath: explicit list used; null → in-site joint:lemma:islet under cwd", () => {
  check(resolveAxisPath(loadConfig({ axisLibs: "/x:/y" }), "/repo") === "/x:/y", "explicit axisLibs");
  check(
    resolveAxisPath(DEFAULT_CONFIG, "/repo") ===
      join("/repo", "external", "libjoint", "lib") + ":" + join("/repo", "external", "liblemma", "lib") + ":" + join("/repo", "external", "libislet", "lib"),
    "in-site joint:lemma:islet default",
  );
});

Deno.test("readMmConfig: no settings file → defaults", async () => {
  const cfg = await readMmConfig("/definitely/not/a/real/pi/config/dir");
  check(cfg.memDir === ".pi/mm", "defaults on missing settings");
});

Deno.test("resolveMemDir: handles both absolute and relative directories without double-rooting", () => {
  const rel = resolveMemDir("/home/user/project", ".pi/mm");
  check(rel === "/home/user/project/.pi/mm", "relative resolves under cwd");

  const abs = resolveMemDir("/home/user/project", "/tmp/isolated-mem-dir");
  check(abs === "/tmp/isolated-mem-dir", "absolute path preserves exact root without concatenation");
});

Deno.test("resolveAdvancedTools: defaults to false when unconfigured", () => {
  const dir = Deno.makeTempDirSync({ prefix: "mm-adv-default-" });
  try {
    check(resolveAdvancedTools(dir) === false, "defaults to false");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("resolveAdvancedTools: reads advancedTools from .pi/settings.json via readFileSync", () => {
  const dir = Deno.makeTempDirSync({ prefix: "mm-adv-settings-" });
  try {
    Deno.mkdirSync(join(dir, ".pi"), { recursive: true });
    Deno.writeTextFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ "pi-mm": { advancedTools: true } }),
    );
    check(resolveAdvancedTools(dir) === true, "reads true from settings");

    Deno.writeTextFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ "pi-mm": { advancedTools: false } }),
    );
    check(resolveAdvancedTools(dir) === false, "reads false from settings");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("resolveAdvancedTools: PI_MM_ADVANCED_TOOLS env var takes precedence", () => {
  const dir = Deno.makeTempDirSync({ prefix: "mm-adv-env-" });
  try {
    Deno.mkdirSync(join(dir, ".pi"), { recursive: true });
    Deno.writeTextFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ "pi-mm": { advancedTools: false } }),
    );
    Deno.env.set("PI_MM_ADVANCED_TOOLS", "true");
    check(resolveAdvancedTools(dir) === true, "env true overrides settings false");

    Deno.env.set("PI_MM_ADVANCED_TOOLS", "false");
    Deno.writeTextFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ "pi-mm": { advancedTools: true } }),
    );
    check(resolveAdvancedTools(dir) === false, "env false overrides settings true");
  } finally {
    Deno.env.delete("PI_MM_ADVANCED_TOOLS");
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("applyEnv: AUREN_URL takes precedence over QLLM_URL", () => {
  const envRec = {
    AUREN_URL: "http://localhost:4242",
    AUREN_MODEL: "auren-model",
    AUREN_KEY: "auren-token",
    QLLM_URL: "http://localhost:9999",
    QLLM_MODEL: "qllm-model",
    QLLM_KEY: "qllm-token",
  };
  const filled = applyEnv(DEFAULT_CONFIG, envRec);
  check(filled.embedUrl === "http://localhost:4242/v1/embeddings", "AUREN_URL sets embedUrl");
  check(filled.judgeUrl === "http://localhost:4242/api/v1/systemone/", "AUREN_URL sets judgeUrl");
  check(filled.synthUrl === "http://localhost:4242/v1/chat/completions", "AUREN_URL sets synthUrl");
  check(filled.embedModel === "auren-model", "AUREN_MODEL sets embedModel");
  check(filled.embedKey === "auren-token", "AUREN_KEY sets embedKey");

  // Fallback to QLLM_URL when AUREN_URL is absent
  const fallbackRec = {
    QLLM_URL: "http://localhost:9999",
    QLLM_MODEL: "qllm-model",
  };
  const fallbackFilled = applyEnv(DEFAULT_CONFIG, fallbackRec);
  check(fallbackFilled.embedUrl === "http://localhost:9999/v1/embeddings", "QLLM_URL fallback embedUrl");
  check(fallbackFilled.embedModel === "qllm-model", "QLLM_MODEL fallback embedModel");
});