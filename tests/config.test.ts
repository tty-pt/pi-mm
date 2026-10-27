import { readMmConfig, loadConfig, applyEnv, resolveCormBin, resolveAxisPath, resolveSocketPath, resolveAdvancedTools, sepalConfigured, DEFAULT_CONFIG } from "../src/config.ts";
import { resolveMemDir } from "../src/tools/index.ts";
import { join } from "node:path";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("loadConfig: undefined → defaults", () => {
  const cfg = loadConfig(undefined);
  check(cfg.cormBin === "", "cormBin default empty");
  check(cfg.axisLibs === null, "axisLibs default null");
  check(cfg.memDir === ".pi/mm", "memDir default");
  check(cfg.scanLimit === 10, "scanLimit default");
});

Deno.test("loadConfig: valid overrides honored, invalid values fall back", () => {
  const cfg = loadConfig({
    cormBin: "/usr/bin/corm",
    axisLibs: "/a:/b",
    memDir: "mem",
    scanLimit: 5,
  });
  check(cfg.cormBin === "/usr/bin/corm", "cormBin override");
  check(cfg.axisLibs === "/a:/b", "axisLibs override");
  check(cfg.memDir === "mem", "memDir override");
  check(cfg.scanLimit === 5, "scanLimit override");

  const bad = loadConfig({ cormBin: 3, axisLibs: null, memDir: "", scanLimit: -2 });
  check(bad.cormBin === "", "cormBin non-string → default");
  check(bad.axisLibs === null, "axisLibs null → default");
  check(bad.memDir === DEFAULT_CONFIG.memDir, "memDir empty → default");
  check(bad.scanLimit === 10, "negative scanLimit → default");
});

Deno.test("applyEnv: fills only when settings unset; respects settings otherwise", () => {
  const fromSettings = loadConfig({ cormBin: "/usr/bin/corm", axisLibs: "/a:/b" });
  const merged = applyEnv(fromSettings, { CORM_BIN: "/env/corm", CORM_AXIS_PATH: "/env:/axes" });
  check(merged.cormBin === "/usr/bin/corm", "settings cormBin wins over env");
  check(merged.axisLibs === "/a:/b", "settings axisLibs wins over env");

  const bare = applyEnv(DEFAULT_CONFIG, { CORM_BIN: "/env/corm", CORM_AXIS_PATH: "/env:/axes" });
  check(bare.cormBin === "/env/corm", "env CORM_BIN fills unset cormBin");
  check(bare.axisLibs === "/env:/axes", "env CORM_AXIS_PATH fills unset axisLibs");
});

Deno.test("applyEnv: sepal embed env vars fill unset fields; settings win", () => {
  const envRec = {
    CORM_SEPAL_EMBED_URL: "http://h:4242/v1/embeddings",
    CORM_SEPAL_EMBED_MODEL: "nomic-embed-text",
    CORM_SEPAL_EMBED_KEY: "secret",
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
  check(sepalConfigured(applyEnv(DEFAULT_CONFIG, { CORM_SEPAL_EMBED_URL: "http://h" })) === false, "url only false");
  check(sepalConfigured(applyEnv(DEFAULT_CONFIG, { CORM_SEPAL_EMBED_MODEL: "m" })) === false, "model only false");
  check(
    sepalConfigured(applyEnv(DEFAULT_CONFIG, { CORM_SEPAL_EMBED_URL: "http://h", CORM_SEPAL_EMBED_MODEL: "m" })) === true,
    "pair true",
  );
});

Deno.test("resolveCormBin: precedence settings → env → PATH → in-site → none", () => {
  const probe = (p: string): boolean => p === "/usr/bin/corm" || p === "/env/corm" ||
    p === "/opt/bin/corm" || p === "/repo/external/libcorm/bin/corm";
  const cfg = loadConfig({ cormBin: "/usr/bin/corm" });
  check(resolveCormBin(cfg, "/repo", ["/opt/bin"], probe).source === "settings", "settings chosen");

  const fromEnv = applyEnv(DEFAULT_CONFIG, { CORM_BIN: "/env/corm" });
  check(resolveCormBin(fromEnv, "/repo", ["/opt/bin"], probe).path === "/env/corm", "env chosen");

  const fromPath = resolveCormBin(DEFAULT_CONFIG, "/repo", ["/opt/bin"], probe);
  check(fromPath.source === "path" && fromPath.path === "/opt/bin/corm", "PATH chosen");

  const fromInSite = resolveCormBin(DEFAULT_CONFIG, "/repo", ["/no/corm"], probe);
  check(fromInSite.source === "insite", "in-site fallback chosen");

  const none = resolveCormBin(DEFAULT_CONFIG, "/nowhere", ["/no/corm"], (p) => p === "/nowhere/external/libcorm/bin/corm" && false);
  check(none.source === "none" && none.path === "", "none when nothing resolves");
});

Deno.test("resolveAxisPath: explicit list, local monorepo, and system-wide fallback", () => {
  check(resolveAxisPath(loadConfig({ axisLibs: "/x:/y" }), "/repo") === "/x:/y", "explicit axisLibs");

  // In-site monorepo check when local directory exists
  const localJoint = join("/repo", "external", "libjoint", "lib");
  check(
    resolveAxisPath(DEFAULT_CONFIG, "/repo", (p) => p === localJoint) ===
      join("/repo", "external", "libjoint", "lib") + ":" + join("/repo", "external", "liblemma", "lib") + ":" + join("/repo", "external", "libislet", "lib"),
    "in-site joint:lemma:islet when local monorepo exists",
  );

  // System-wide library fallback when local monorepo does not exist
  check(
    resolveAxisPath(DEFAULT_CONFIG, "/repo", (p) => p === "/usr/lib/libjoint.so") === "/usr/lib",
    "system-wide /usr/lib fallback when local does not exist",
  );

  // Default fallback when neither local nor system libraries exist
  check(
    resolveAxisPath(DEFAULT_CONFIG, "/repo", () => false) ===
      join("/repo", "external", "libjoint", "lib") + ":" + join("/repo", "external", "liblemma", "lib") + ":" + join("/repo", "external", "libislet", "lib"),
    "fallback when nothing resolves",
  );
});

Deno.test("readMmConfig: no settings file → defaults", async () => {
  const cfg = await readMmConfig("/definitely/not/a/real/pi/config/dir");
  check(cfg.memDir === ".pi/mm", "defaults on missing settings");
});

Deno.test("readMmConfig: applies global settings when project settings is absent", async () => {
  const fakeHome = Deno.makeTempDirSync({ prefix: "mm-global-home-" });
  const fakeCwd = Deno.makeTempDirSync({ prefix: "mm-project-cwd-" });
  try {
    const globalAgentDir = join(fakeHome, ".pi", "agent");
    Deno.mkdirSync(globalAgentDir, { recursive: true });
    Deno.writeTextFileSync(
      join(globalAgentDir, "settings.json"),
      JSON.stringify({
        "pi-mm": {
          embedUrl: "http://127.0.0.1:11434/v1/embeddings",
          embedModel: "nomic-embed-text",
          embedKey: "global-secret",
        },
      }),
    );

    const cfg = await readMmConfig(fakeCwd, { HOME: fakeHome, PI_SETTINGS_PATH: "", PI_CODING_AGENT_DIR: "" });
    check(cfg.embedUrl === "http://127.0.0.1:11434/v1/embeddings", "embedUrl inherited from global");
    check(cfg.embedModel === "nomic-embed-text", "embedModel inherited from global");
    check(cfg.embedKey === "global-secret", "embedKey inherited from global");
    check(sepalConfigured(cfg) === true, "sepalConfigured is true from global settings");
  } finally {
    Deno.removeSync(fakeHome, { recursive: true });
    Deno.removeSync(fakeCwd, { recursive: true });
  }
});

Deno.test("readMmConfig: project settings override global settings", async () => {
  const fakeHome = Deno.makeTempDirSync({ prefix: "mm-global-home-" });
  const fakeCwd = Deno.makeTempDirSync({ prefix: "mm-project-cwd-" });
  try {
    const globalAgentDir = join(fakeHome, ".pi", "agent");
    Deno.mkdirSync(globalAgentDir, { recursive: true });
    Deno.writeTextFileSync(
      join(globalAgentDir, "settings.json"),
      JSON.stringify({
        "pi-mm": {
          embedUrl: "http://global-host:11434/v1/embeddings",
          embedModel: "global-model",
          scanLimit: 5,
        },
      }),
    );

    const projectPiDir = join(fakeCwd, ".pi");
    Deno.mkdirSync(projectPiDir, { recursive: true });
    Deno.writeTextFileSync(
      join(projectPiDir, "settings.json"),
      JSON.stringify({
        "pi-mm": {
          embedUrl: "http://project-host:11434/v1/embeddings",
          scanLimit: 20,
        },
      }),
    );

    const cfg = await readMmConfig(fakeCwd, { HOME: fakeHome, PI_SETTINGS_PATH: "", PI_CODING_AGENT_DIR: "" });
    check(cfg.embedUrl === "http://project-host:11434/v1/embeddings", "project embedUrl overrides global");
    check(cfg.embedModel === "global-model", "global embedModel preserved when unset in project");
    check(cfg.scanLimit === 20, "project scanLimit overrides global");
    check(sepalConfigured(cfg) === true, "sepalConfigured is true");
  } finally {
    Deno.removeSync(fakeHome, { recursive: true });
    Deno.removeSync(fakeCwd, { recursive: true });
  }
});

Deno.test("readMmConfig: project settings without pi-mm preserves global settings", async () => {
  const fakeHome = Deno.makeTempDirSync({ prefix: "mm-global-home-" });
  const fakeCwd = Deno.makeTempDirSync({ prefix: "mm-project-cwd-" });
  try {
    const globalAgentDir = join(fakeHome, ".pi", "agent");
    Deno.mkdirSync(globalAgentDir, { recursive: true });
    Deno.writeTextFileSync(
      join(globalAgentDir, "settings.json"),
      JSON.stringify({
        "pi-mm": {
          embedUrl: "http://127.0.0.1:11434/v1/embeddings",
          embedModel: "bge-m3",
        },
      }),
    );

    const projectPiDir = join(fakeCwd, ".pi");
    Deno.mkdirSync(projectPiDir, { recursive: true });
    Deno.writeTextFileSync(
      join(projectPiDir, "settings.json"),
      JSON.stringify({
        "theme": "tokyo-night",
      }),
    );

    const cfg = await readMmConfig(fakeCwd, { HOME: fakeHome, PI_SETTINGS_PATH: "", PI_CODING_AGENT_DIR: "" });
    check(cfg.embedUrl === "http://127.0.0.1:11434/v1/embeddings", "global embedUrl used");
    check(cfg.embedModel === "bge-m3", "global embedModel used");
    check(sepalConfigured(cfg) === true, "sepalConfigured is true");
  } finally {
    Deno.removeSync(fakeHome, { recursive: true });
    Deno.removeSync(fakeCwd, { recursive: true });
  }
});

Deno.test("readMmConfig: supports mm key in global settings", async () => {
  const fakeHome = Deno.makeTempDirSync({ prefix: "mm-global-home-" });
  const fakeCwd = Deno.makeTempDirSync({ prefix: "mm-project-cwd-" });
  try {
    const globalAgentDir = join(fakeHome, ".pi", "agent");
    Deno.mkdirSync(globalAgentDir, { recursive: true });
    Deno.writeTextFileSync(
      join(globalAgentDir, "settings.json"),
      JSON.stringify({
        "mm": {
          embedUrl: "http://127.0.0.1:11434/v1/embeddings",
          embedModel: "all-minilm",
        },
      }),
    );

    const cfg = await readMmConfig(fakeCwd, { HOME: fakeHome, PI_SETTINGS_PATH: "", PI_CODING_AGENT_DIR: "" });
    check(cfg.embedUrl === "http://127.0.0.1:11434/v1/embeddings", "mm key embedUrl used");
    check(cfg.embedModel === "all-minilm", "mm key embedModel used");
    check(sepalConfigured(cfg) === true, "sepalConfigured is true");
  } finally {
    Deno.removeSync(fakeHome, { recursive: true });
    Deno.removeSync(fakeCwd, { recursive: true });
  }
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

Deno.test("resolveAdvancedTools: falls back to global settings when project settings is absent", () => {
  const fakeHome = Deno.makeTempDirSync({ prefix: "mm-global-home-" });
  const fakeCwd = Deno.makeTempDirSync({ prefix: "mm-project-cwd-" });
  try {
    const globalAgentDir = join(fakeHome, ".pi", "agent");
    Deno.mkdirSync(globalAgentDir, { recursive: true });
    Deno.writeTextFileSync(
      join(globalAgentDir, "settings.json"),
      JSON.stringify({ "pi-mm": { advancedTools: true } }),
    );

    const adv = resolveAdvancedTools(fakeCwd, { HOME: fakeHome, PI_SETTINGS_PATH: "", PI_CODING_AGENT_DIR: "" });
    check(adv === true, "reads advancedTools true from global settings");
  } finally {
    Deno.removeSync(fakeHome, { recursive: true });
    Deno.removeSync(fakeCwd, { recursive: true });
  }
});

Deno.test("resolveAdvancedTools: project setting overrides global setting", () => {
  const fakeHome = Deno.makeTempDirSync({ prefix: "mm-global-home-" });
  const fakeCwd = Deno.makeTempDirSync({ prefix: "mm-project-cwd-" });
  try {
    const globalAgentDir = join(fakeHome, ".pi", "agent");
    Deno.mkdirSync(globalAgentDir, { recursive: true });
    Deno.writeTextFileSync(
      join(globalAgentDir, "settings.json"),
      JSON.stringify({ "pi-mm": { advancedTools: true } }),
    );

    const projectPiDir = join(fakeCwd, ".pi");
    Deno.mkdirSync(projectPiDir, { recursive: true });
    Deno.writeTextFileSync(
      join(projectPiDir, "settings.json"),
      JSON.stringify({ "pi-mm": { advancedTools: false } }),
    );

    const adv = resolveAdvancedTools(fakeCwd, { HOME: fakeHome, PI_SETTINGS_PATH: "", PI_CODING_AGENT_DIR: "" });
    check(adv === false, "project false overrides global true");
  } finally {
    Deno.removeSync(fakeHome, { recursive: true });
    Deno.removeSync(fakeCwd, { recursive: true });
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

Deno.test("resolveSocketPath: default, explicit, runtimeDir, and DrvFs auto-fallback", () => {
  // 1. Default: inside memDir for Linux paths
  check(
    resolveSocketPath(DEFAULT_CONFIG, "/home/user/project/.pi/mm") === "/home/user/project/.pi/mm/cormd.sock",
    "default socket inside memDir",
  );

  // 2. Explicit setting override
  const custom = loadConfig({ socketPath: "/tmp/custom-socket.sock" });
  check(
    resolveSocketPath(custom, "/home/user/project/.pi/mm") === "/tmp/custom-socket.sock",
    "explicit socketPath honored",
  );

  // 3. PI_MM_SOCKET environment override
  const envCustom = applyEnv(DEFAULT_CONFIG, { PI_MM_SOCKET: "/tmp/env-socket.sock" });
  check(
    resolveSocketPath(envCustom, "/home/user/project/.pi/mm") === "/tmp/env-socket.sock",
    "env PI_MM_SOCKET honored",
  );

  // 4. runtimeDir setting override
  const runtime = loadConfig({ runtimeDir: "/var/run/custom" });
  const runtimeRes = resolveSocketPath(runtime, "/home/user/project/.pi/mm");
  check(
    runtimeRes.startsWith("/var/run/custom/cormd-") && runtimeRes.endsWith(".sock"),
    "runtimeDir override honored with hash",
  );

  // 5. Auto-fallback for WSL DrvFs (/mnt/*) paths where unix sockets fail
  const drvFsRes = resolveSocketPath(DEFAULT_CONFIG, "/mnt/l/JOGO/.pi/mm");
  check(!drvFsRes.startsWith("/mnt/"), "DrvFs auto-fallback routes outside /mnt/");
  check(
    (drvFsRes.includes("/pi-mm/cormd-") || drvFsRes.startsWith("/tmp/")) && drvFsRes.endsWith(".sock"),
    "DrvFs auto-fallback uses /tmp or XDG_RUNTIME_DIR with hash",
  );
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
Deno.test("loadConfig/applyEnv: autoStartAuren and autoDownloadModels default, validate and honour env", () => {
  const d = loadConfig(undefined);
  check(d.autoStartAuren === true && d.autoDownloadModels === "ask", "defaults");
  const c = loadConfig({ autoStartAuren: false, autoDownloadModels: "never" });
  check(c.autoStartAuren === false && c.autoDownloadModels === "never", "settings honoured");
  const bad = loadConfig({ autoStartAuren: "no", autoDownloadModels: "sometimes" });
  check(bad.autoStartAuren === true && bad.autoDownloadModels === "ask", "invalid values fall back");
  const e = applyEnv(loadConfig(undefined), { PI_MM_AUTO_START_AUREN: "0", PI_MM_AUTO_DOWNLOAD_MODELS: "auto" });
  check(e.autoStartAuren === false && e.autoDownloadModels === "auto", "env overrides");
});
