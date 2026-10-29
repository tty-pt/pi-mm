/**
 * auren-bootstrap — zero-configuration bring-up of the local axil-auren inference server.
 *
 * Self-contained on purpose (node: built-ins only, no imports from the host extension) so the
 * exact same file is vendored into pi-mm and pi-quest; either works without the other.
 * Keep the two copies byte-identical (pi-quest has a drift test).
 *
 * Responsibilities:
 *  - locate the server launcher (PATH, system install, source clones) and start it detached
 *  - locate a user auren config, or generate a default one modelled on the reference setup
 *  - download the default GGUF models (resumable, sha256-verified, cross-process locked)
 *  - say precisely what is missing when something cannot be automated
 */
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, openSync, closeSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const DEFAULT_AUREN_PORT = 4242;
export const DEFAULT_AUREN_URL = `http://127.0.0.1:${DEFAULT_AUREN_PORT}`;
/** "default" lets the server pick the role default from whatever models are installed. */
export const DEFAULT_AUREN_JUDGE_MODEL = "default";
export const DEFAULT_AUREN_EMBED_MODEL = "default";

export const DOCS_PIMM_PREREQUISITES = "https://github.com/tty-pt/pi-mm#prerequisites--core-c-engines";
export const DOCS_AUREN = "https://github.com/tty-pt/axil-auren#installation--build";
export const DOCS_SEPAL = "https://github.com/tty-pt/libsepal#installation--build";
export const DOCS_CORM = "https://github.com/tty-pt/libcorm#installation--build";
export const DOCS_LEMMA = "https://github.com/tty-pt/liblemma#installation--build";
export const DOCS_JOINT = "https://github.com/tty-pt/libjoint#installation--build";

const MANAGED_BY = "pi-auren-bootstrap";

// ───────────────────────────── model catalog ─────────────────────────────

export type ModelTier = "small" | "large";
export type DownloadPolicy = "auto" | "ask" | "never";

export interface CatalogModel {
  id: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  tier: ModelTier;
  capabilities: string[];
  /** Extra engine settings copied verbatim into the generated config entry. */
  config: Record<string, unknown>;
}

/** Verified against the Hugging Face x-linked-size / x-linked-etag headers. */
export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: "olmoe",
    file: "olmoe-1b-7b-instruct-q3_k_m.gguf",
    url: "https://huggingface.co/allenai/OLMoE-1B-7B-0924-Instruct-GGUF/resolve/main/olmoe-1b-7b-0924-instruct-q3_k_m.gguf",
    bytes: 3343929824,
    sha256: "1e589f85f43f619a7f4d8bbb3f5799dc268baebd4761b568a59002ef8033d7dc",
    tier: "large",
    capabilities: ["chat", "judge"],
    config: { n_ctx: 4096, n_gpu_layers: 0, temperature: 0.7 },
  },
  {
    id: "qwen",
    file: "qwen2.5-0.5b-instruct.gguf",
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    bytes: 491400032,
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
    tier: "small",
    capabilities: ["chat", "judge"],
    config: { n_ctx: 4096, n_gpu_layers: 0, temperature: 0.7 },
  },
  {
    id: "bge-base",
    file: "bge-base-en-v1.5.gguf",
    url: "https://huggingface.co/CompendiumLabs/bge-base-en-v1.5-gguf/resolve/main/bge-base-en-v1.5-q8_0.gguf",
    bytes: 117974304,
    sha256: "ad1afe72cd6654a558667a3db10878b049a75bfd72912e1dabb91310d671173c",
    tier: "small",
    capabilities: ["embed"],
    config: { enable_embeddings: 1, n_ctx: 512 },
  },
  {
    id: "bge-small",
    file: "bge-small-en-v1.5.gguf",
    url: "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf",
    bytes: 36806944,
    sha256: "ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514",
    tier: "small",
    capabilities: ["embed"],
    config: { enable_embeddings: 1, n_ctx: 512 },
  },
];

const JUDGE_PREFERENCE = ["olmoe", "qwen"];
const EMBED_PREFERENCE = ["bge-base", "bge-small"];

export interface AurenPaths {
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  libDirs?: string[];
}

function homeOf(p: AurenPaths): string {
  return p.home ?? homedir();
}
function envOf(p: AurenPaths): Record<string, string | undefined> {
  return p.env ?? (typeof process !== "undefined" ? process.env : {});
}
function cwdOf(p: AurenPaths): string {
  return p.cwd ?? (typeof process !== "undefined" ? process.cwd() : ".");
}

export function modelsDir(home: string = homedir()): string {
  return join(home, ".models");
}

export function cacheDir(home: string = homedir()): string {
  return join(home, ".cache", "auren");
}

export function serverLogPath(home: string = homedir()): string {
  return join(cacheDir(home), "server.log");
}

export function managedConfigPath(home: string = homedir()): string {
  return join(home, ".config", "auren", "config.json");
}

export function presentModels(catalog: CatalogModel[], home: string = homedir()): CatalogModel[] {
  return catalog.filter((m) => existsSync(join(modelsDir(home), m.file)));
}

export function chooseDefaults(models: CatalogModel[]): { chat?: string; judge?: string; embed?: string } {
  const ids = new Set(models.map((m) => m.id));
  const judge = JUDGE_PREFERENCE.find((id) => ids.has(id));
  const embed = EMBED_PREFERENCE.find((id) => ids.has(id));
  return { chat: judge, judge, embed };
}

export function buildDefaultConfig(present: CatalogModel[], home: string = homedir()): Record<string, unknown> | null {
  if (present.length === 0) return null;
  const defaults = chooseDefaults(present);
  const defs: Record<string, string> = {};
  for (const [k, v] of Object.entries(defaults)) if (v) defs[k] = v;
  return {
    _managedBy: MANAGED_BY,
    models: present.map((m) => ({
      id: m.id,
      path: join(modelsDir(home), m.file),
      capabilities: m.capabilities,
      ...m.config,
    })),
    defaults: defs,
    max_resident: 2,
  };
}

// ───────────────────────────── config discovery ─────────────────────────────

/** Config discovery order shared with the CLI launcher: env, ./auren.json, ~/auren.json, ~/.config/auren/config.json, ~/.auren.json. */
export function findUserConfig(p: AurenPaths): string | null {
  const home = homeOf(p);
  const envPath = envOf(p)["AUREN_CONFIG_PATH"];
  if (envPath && envPath.trim() !== "" && existsSync(envPath)) return envPath;
  const candidates = [
    join(cwdOf(p), "auren.json"),
    join(home, "auren.json"),
    managedConfigPath(home),
    join(home, ".auren.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function isManagedConfig(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return parsed["_managedBy"] === MANAGED_BY;
  } catch {
    return false;
  }
}

export interface WriteConfigResult {
  status: "written" | "updated" | "unchanged" | "user-config" | "no-models";
  path: string | null;
}

/** Create or refresh our own generated config; never touch a config the user wrote. */
export function writeDefaultConfig(p: AurenPaths, catalog: CatalogModel[] = MODEL_CATALOG): WriteConfigResult {
  const home = homeOf(p);
  const found = findUserConfig(p);
  const target = managedConfigPath(home);
  if (found && !(found === target && isManagedConfig(found))) {
    return { status: "user-config", path: found };
  }
  const cfg = buildDefaultConfig(presentModels(catalog, home), home);
  if (!cfg) return { status: found ? "unchanged" : "no-models", path: found };
  const text = JSON.stringify(cfg, null, 2) + "\n";
  if (found) {
    if (readFileSync(found, "utf8") === text) return { status: "unchanged", path: found };
    writeFileSync(found, text);
    return { status: "updated", path: found };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  return { status: "written", path: target };
}

// ───────────────────────────── policy & locks ─────────────────────────────

/** true = download now, false = do not, "ask" = needs the operator's consent. */
export function shouldAutoDownload(
  model: CatalogModel,
  setting: DownloadPolicy,
  consent: boolean | undefined,
): boolean | "ask" {
  if (setting === "never") return false;
  // Auto-download only models with embedding capabilities; inference/chat models are not needed
  if (!model.capabilities.includes("embed")) return false;
  if (setting === "auto") return true;
  if (model.tier === "small") return true;
  if (consent === true) return true;
  if (consent === false) return false;
  return "ask";
}

const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

export function tryAcquireLock(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") return false;
      let stale = false;
      try {
        const info = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; at?: number };
        stale = typeof info.pid !== "number" || !pidAlive(info.pid) || Date.now() - (info.at ?? 0) > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (!stale) return false;
      try {
        unlinkSync(path);
      } catch { /* raced with another recoverer */ }
    }
  }
  return false;
}

export function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch { /* already gone */ }
}

// ───────────────────────────── downloads ─────────────────────────────

export interface DownloadOptions {
  home?: string;
  onProgress?: (done: number, total: number) => void;
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  status: "present" | "downloaded" | "busy" | "failed";
  error?: string;
}

function freeBytes(dir: string): number | null {
  try {
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }).statfsSync;
    if (!statfs) return null;
    const s = statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

export async function downloadModel(model: CatalogModel, opts: DownloadOptions = {}): Promise<DownloadResult> {
  const home = opts.home ?? homedir();
  const dir = modelsDir(home);
  const finalPath = join(dir, model.file);
  const part = finalPath + ".part";
  if (existsSync(finalPath)) return { status: "present" };
  mkdirSync(dir, { recursive: true });

  const lock = finalPath + ".lock";
  if (!tryAcquireLock(lock)) return { status: "busy" };
  try {
    if (existsSync(finalPath)) return { status: "present" };
    const doFetch = opts.fetchImpl ?? fetch;

    let offset = existsSync(part) ? statSync(part).size : 0;
    const free = freeBytes(dir);
    if (free !== null && free < (model.bytes - offset) * 1.05) {
      return { status: "failed", error: `not enough free disk space in ${dir} (need ${Math.ceil((model.bytes - offset) / 1048576)} MB)` };
    }

    let res: Response;
    try {
      res = await doFetch(model.url, offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {});
    } catch (err) {
      return { status: "failed", error: `network error: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (res.status === 416) {
      // the .part is already complete or garbage; verify below, or restart once
      if (offset !== model.bytes) {
        try { unlinkSync(part); } catch { /* ignore */ }
        return { status: "failed", error: "server rejected the resume range; will retry from scratch" };
      }
    } else if (res.status === 200 && offset > 0) {
      offset = 0; // server ignored Range: restart
      try { unlinkSync(part); } catch { /* ignore */ }
    } else if (res.status !== 200 && res.status !== 206) {
      return { status: "failed", error: `HTTP ${res.status} from ${new URL(model.url).host}` };
    }

    if (res.status !== 416) {
      if (!res.body) return { status: "failed", error: "empty response body" };
      const fd = openSync(part, offset > 0 ? "a" : "w");
      let done = offset;
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done: eof } = await reader.read();
          if (eof) break;
          if (value && value.length > 0) {
            fs.writeSync(fd, value);
            done += value.length;
            opts.onProgress?.(done, model.bytes);
          }
        }
      } catch (err) {
        return { status: "failed", error: `download interrupted: ${err instanceof Error ? err.message : String(err)}` };
      } finally {
        closeSync(fd);
      }
    }

    const size = statSync(part).size;
    if (size < model.bytes) return { status: "failed", error: `download incomplete (${size}/${model.bytes} bytes); will resume` };
    if (size > model.bytes) {
      unlinkSync(part);
      return { status: "failed", error: `unexpected size ${size} (expected ${model.bytes})` };
    }
    const digest = await sha256File(part);
    if (digest !== model.sha256) {
      unlinkSync(part);
      return { status: "failed", error: `sha256 mismatch for ${model.file} (got ${digest.slice(0, 12)}…)` };
    }
    fs.renameSync(part, finalPath);
    return { status: "downloaded" };
  } finally {
    releaseLock(lock);
  }
}

// ───────────────────────────── launcher discovery ─────────────────────────────

export interface Launcher {
  kind: "script" | "axil";
  command: string;
  args: string[];
  workdir?: string;
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function onPath(name: string, env: Record<string, string | undefined>): string | null {
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

const DEFAULT_LIB_DIRS = ["/usr/lib", "/usr/local/lib", "/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/opt/homebrew/lib"];

export function findAurenLaunchers(p: AurenPaths & { port?: number }): Launcher[] {
  const env = envOf(p);
  const home = homeOf(p);
  const cwd = cwdOf(p);
  const port = String(p.port ?? DEFAULT_AUREN_PORT);
  const out: Launcher[] = [];

  const explicit = env["AUREN_SERVER_SCRIPT"] || env["AUREN_SERVER_BIN"];
  if (explicit && existsSync(explicit)) out.push({ kind: "script", command: explicit, args: [] });

  const onPathScript = onPath("auren-server", env);
  if (onPathScript) out.push({ kind: "script", command: onPathScript, args: [] });

  for (const root of [join(home, "axil-auren"), join(cwd, "external", "axil-auren"), join(cwd, "..", "axil-auren")]) {
    const script = join(root, "scripts", "auren-server");
    if (existsSync(script)) out.push({ kind: "script", command: script, args: [], workdir: root });
  }

  const axil = onPath("axil", env);
  if (axil) {
    const libDirs = p.libDirs ?? [join(home, ".local", "lib"), ...DEFAULT_LIB_DIRS];
    for (const dir of libDirs) {
      for (const ext of [".so", ".dylib"]) {
        if (existsSync(join(dir, `libaxil-auren${ext}`))) {
          out.push({ kind: "axil", command: axil, args: ["-A", "-p", port, "-m", join(dir, "libaxil-auren")] });
        }
      }
    }
  }
  return out;
}

export function findAurenLauncher(p: AurenPaths & { port?: number }): Launcher | null {
  return findAurenLaunchers(p)[0] ?? null;
}

/** Back-compat helper: path of a launcher script, if any. */
export function findAurenServer(cwd: string = process.cwd()): string | null {
  const l = findAurenLaunchers({ cwd }).find((x) => x.kind === "script");
  return l ? l.command : null;
}

export function findSepalLib(cwd: string = process.cwd()): string | null {
  const envLib = typeof process !== "undefined" ? process.env?.["SEPAL_LIB"] : undefined;
  if (envLib && existsSync(envLib)) return envLib;
  const candidates = [
    join(cwd, "external", "libsepal", "lib", "libsepal.so"),
    join(homedir(), ".local", "lib", "libsepal.so"),
    "/usr/local/lib/libsepal.so",
    "/usr/lib/libsepal.so",
    "/lib/libsepal.so",
    "/usr/lib/x86_64-linux-gnu/libsepal.so",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// ───────────────────────────── server probe / lifecycle ─────────────────────────────

export async function isAurenRunning(url: string = DEFAULT_AUREN_URL, timeoutMs = 250): Promise<boolean> {
  const base = url
    .replace(/\/+$/, "")
    .replace(/\/api\/v1\/systemone$/, "")
    .replace(/\/api\/v1\/systemzero\/?$/, "")
    .replace(/\/v1$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/models`, { method: "GET", signal: ctrl.signal });
    return res.ok || res.status === 404 || res.status === 405;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface Notice {
  code: "no-launcher" | "no-models" | "not-running" | "downloading" | "download-failed" | "needs-consent" | "autostart-off";
  severity: "info" | "warning";
  message: string;
  link: string;
}

export interface DownloadProgress {
  id: string;
  done: number;
  total: number;
}

export interface DiagnoseInput extends AurenPaths {
  running: boolean;
  downloads: DownloadProgress[];
  failures?: Array<{ id: string; error: string }>;
  pendingConsent?: CatalogModel[];
  autoStart?: boolean;
  port?: number;
}

/** Turn the current situation into the minimal set of operator-facing notices. */
export function diagnoseAuren(d: DiagnoseInput): Notice[] {
  const notices: Notice[] = [];
  for (const dl of d.downloads) {
    const pct = dl.total > 0 ? Math.floor((dl.done / dl.total) * 100) : 0;
    notices.push({
      code: "downloading",
      severity: "info",
      message: `Downloading local model "${dl.id}" (${pct}%)…`,
      link: DOCS_PIMM_PREREQUISITES,
    });
  }
  for (const f of d.failures ?? []) {
    notices.push({
      code: "download-failed",
      severity: "warning",
      message: `Could not download model "${f.id}": ${f.error}. It will be retried next session.`,
      link: DOCS_PIMM_PREREQUISITES,
    });
  }
  for (const m of d.pendingConsent ?? []) {
    notices.push({
      code: "needs-consent",
      severity: "info",
      message: `Optional model "${m.id}" (${(m.bytes / 1073741824).toFixed(1)} GB) was not downloaded. Set autoDownloadModels to "auto" to fetch it.`,
      link: DOCS_PIMM_PREREQUISITES,
    });
  }
  if (d.running) return notices;

  const launcher = findAurenLauncher({ ...d, port: d.port });
  if (!launcher) {
    notices.push({
      code: "no-launcher",
      severity: "warning",
      message: "axil-auren is not installed (no auren-server, and no axil + libaxil-auren found). Decision judging and semantic recall use built-in heuristics until it is installed.",
      link: DOCS_AUREN,
    });
    return notices;
  }
  if (d.autoStart === false) {
    notices.push({
      code: "autostart-off",
      severity: "info",
      message: "axil-auren is installed but not running, and auto-start is disabled.",
      link: DOCS_AUREN,
    });
    return notices;
  }
  const cfg = findUserConfig(d);
  if (!cfg && presentModels(MODEL_CATALOG, homeOf(d)).length === 0 && d.downloads.length === 0) {
    notices.push({
      code: "no-models",
      severity: "warning",
      message: "axil-auren has no models yet: none are configured and none could be downloaded automatically.",
      link: DOCS_PIMM_PREREQUISITES,
    });
    return notices;
  }
  if (d.downloads.length === 0) {
    notices.push({
      code: "not-running",
      severity: "warning",
      message: `axil-auren is installed but did not start on port ${d.port ?? DEFAULT_AUREN_PORT}. See ${serverLogPath(homeOf(d))}.`,
      link: DOCS_AUREN,
    });
  }
  return notices;
}

function readProc(pid: string, name: string): string | null {
  try {
    return readFileSync(`/proc/${pid}/${name}`, "utf8");
  } catch {
    return null;
  }
}

/** Stop a server we generated config for (Linux). Never touches a server running a user-written config. */
export function stopManagedServer(port: number, configPath: string): boolean {
  let killed = false;
  let pids: string[] = [];
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return false;
  }
  for (const pid of pids) {
    const cmd = readProc(pid, "cmdline");
    if (!cmd || !cmd.includes("libaxil-auren")) continue;
    const args = cmd.split("\0");
    const pIdx = args.indexOf("-p");
    if (pIdx < 0 || args[pIdx + 1] !== String(port)) continue;
    const environ = readProc(pid, "environ") ?? "";
    if (!environ.split("\0").includes(`AUREN_CONFIG_PATH=${configPath}`)) continue;
    try {
      process.kill(Number(pid), "SIGTERM");
      killed = true;
    } catch { /* gone */ }
  }
  return killed;
}

export interface SpawnResult {
  started: boolean;
  launcher?: Launcher;
  error?: string;
}

export async function startAurenServer(
  p: AurenPaths & { port?: number; readyTimeoutMs?: number; configPath?: string | null },
): Promise<SpawnResult> {
  const port = p.port ?? DEFAULT_AUREN_PORT;
  const url = `http://127.0.0.1:${port}`;
  const launchers = findAurenLaunchers({ ...p, port });
  if (launchers.length === 0) return { started: false, error: "no launcher found" };
  const logPath = serverLogPath(homeOf(p));
  mkdirSync(dirname(logPath), { recursive: true });
  let lastError = "";
  for (const launcher of launchers) {
    try {
      const out = openSync(logPath, "a");
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(envOf(p))) if (typeof v === "string") env[k] = v;
      env["AUREN_PORT"] = String(port);
      if (p.configPath) env["AUREN_CONFIG_PATH"] = p.configPath;
      const child = spawn(launcher.command, launcher.args, {
        detached: true,
        stdio: ["ignore", out, out],
        cwd: launcher.workdir ?? cwdOf(p),
        env,
      });
      child.on("error", () => { /* surfaced through readiness timeout */ });
      child.unref();
      closeSync(out);
      const deadline = Date.now() + (p.readyTimeoutMs ?? 20000);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (await isAurenRunning(url, 300)) return { started: true, launcher };
      }
      lastError = `${launcher.command} did not answer on ${url} in time`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { started: false, error: lastError };
}

// ───────────────────────────── orchestration ─────────────────────────────

export interface BootstrapSettings {
  autoStart?: boolean;
  autoDownloadModels?: DownloadPolicy;
}

export interface BootstrapState {
  phase: "idle" | "checking" | "downloading" | "starting" | "ready" | "unavailable";
  running: boolean;
  started: boolean;
  activeModel?: string;
  downloads: DownloadProgress[];
  failures: Array<{ id: string; error: string }>;
  pendingConsent: CatalogModel[];
  configPath: string | null;
  notices: Notice[];
}

export interface EnsureOptions extends AurenPaths {
  port?: number;
  settings?: BootstrapSettings;
  /** Ask the operator before large downloads. Absent (headless) => remember nothing and report a notice. */
  confirm?: (message: string) => Promise<boolean>;
  onUpdate?: (state: BootstrapState) => void;
  fetchImpl?: typeof fetch;
  catalog?: CatalogModel[];
  readyTimeoutMs?: number;
}

const liveState: BootstrapState = {
  phase: "idle",
  running: false,
  started: false,
  downloads: [],
  failures: [],
  pendingConsent: [],
  configPath: null,
  notices: [],
};
let inflight: Promise<BootstrapState> | null = null;
let lastFinishedAt = 0;
let activeHooks: Pick<EnsureOptions, "confirm" | "onUpdate"> = {};
/** A finished run is reused for this long so per-tool-call callers stay cheap. */
const RERUN_AFTER_MS = 10 * 60 * 1000;

export function getBootstrapState(): BootstrapState {
  return { ...liveState, downloads: [...liveState.downloads], failures: [...liveState.failures], notices: [...liveState.notices] };
}

/** Compact progress text for a status bar, e.g. "⬇ bge-base (42%)"; undefined when nothing is downloading. */
export function describeProgress(state: BootstrapState = liveState): string | undefined {
  if (state.downloads.length === 0) return undefined;
  const dl = state.downloads[0];
  const pct = dl.total > 0 ? Math.floor((dl.done / dl.total) * 100) : 0;
  return `⬇ ${dl.id} (${pct}%)`;
}

/** Model usage status text for a status bar or reporting widget. */
export function describeModelStatus(state: BootstrapState = liveState): string | undefined {
  if (state.downloads.length > 0) return describeProgress(state);
  if (state.running && state.activeModel) return `⚡ ${state.activeModel}`;
  return undefined;
}

function readPrefs(home: string): { largeModels?: boolean } {
  try {
    return JSON.parse(readFileSync(join(cacheDir(home), "prefs.json"), "utf8")) as { largeModels?: boolean };
  } catch {
    return {};
  }
}

function writePrefs(home: string, prefs: { largeModels?: boolean }): void {
  try {
    mkdirSync(cacheDir(home), { recursive: true });
    writeFileSync(join(cacheDir(home), "prefs.json"), JSON.stringify(prefs));
  } catch { /* best effort */ }
}

/**
 * Bring axil-auren up with as little operator involvement as possible. Idempotent and
 * process-wide singleton: concurrent callers share one run. Never throws.
 */
export function ensureAuren(opts: EnsureOptions = {}): Promise<BootstrapState> {
  // Late callers (e.g. a UI-aware session hook after a tool-env probe) can still attach their hooks.
  if (opts.confirm) activeHooks.confirm = opts.confirm;
  if (opts.onUpdate) activeHooks.onUpdate = opts.onUpdate;
  if (inflight) return inflight;
  if (lastFinishedAt > 0 && Date.now() - lastFinishedAt < RERUN_AFTER_MS) return Promise.resolve(getBootstrapState());
  activeHooks = { confirm: opts.confirm, onUpdate: opts.onUpdate };
  inflight = run(opts)
    .catch((err) => {
      liveState.phase = "unavailable";
      liveState.failures.push({ id: "bootstrap", error: err instanceof Error ? err.message : String(err) });
      return getBootstrapState();
    })
    .finally(() => {
      inflight = null;
      lastFinishedAt = Date.now();
    });
  return inflight;
}

export function resetBootstrapForTests(): void {
  inflight = null;
  lastFinishedAt = 0;
  activeHooks = {};
  Object.assign(liveState, {
    phase: "idle",
    running: false,
    started: false,
    activeModel: undefined,
    downloads: [],
    failures: [],
    pendingConsent: [],
    configPath: null,
    notices: [],
  });
}

async function run(opts: EnsureOptions): Promise<BootstrapState> {
  const home = homeOf(opts);
  const port = opts.port ?? DEFAULT_AUREN_PORT;
  const url = `http://127.0.0.1:${port}`;
  const settings = opts.settings ?? {};
  const policy: DownloadPolicy = settings.autoDownloadModels ?? "ask";
  const catalog = opts.catalog ?? MODEL_CATALOG;
  const autoStart = settings.autoStart !== false;

  const publish = () => {
    const present = presentModels(catalog, home);
    const active = present.find((m) => m.capabilities.includes("embed"))?.id ?? present[0]?.id;
    liveState.activeModel = liveState.running ? active : undefined;
    liveState.notices = diagnoseAuren({
      ...opts,
      running: liveState.running,
      downloads: liveState.downloads,
      failures: liveState.failures,
      pendingConsent: liveState.pendingConsent,
      autoStart,
      port,
    });
    try { activeHooks.onUpdate?.(getBootstrapState()); } catch { /* UI is best effort */ }
  };

  liveState.phase = "checking";
  liveState.failures = [];
  liveState.pendingConsent = [];
  liveState.running = await isAurenRunning(url, 400);

  const userCfg = findUserConfig(opts);
  const managed = !userCfg || (userCfg === managedConfigPath(home) && isManagedConfig(userCfg));

  const ensureServer = async (restart: boolean): Promise<void> => {
    const cfg = writeDefaultConfig(opts, catalog);
    liveState.configPath = cfg.path;
    if (cfg.status === "no-models") return;
    if (liveState.running && restart && cfg.path && (cfg.status === "updated" || cfg.status === "written")) {
      if (stopManagedServer(port, cfg.path)) {
        for (let i = 0; i < 20 && (await isAurenRunning(url, 200)); i++) await new Promise((r) => setTimeout(r, 250));
        liveState.running = false;
      }
    }
    if (liveState.running || !autoStart) return;
    liveState.phase = "starting";
    publish();
    const res = await startAurenServer({ ...opts, port, configPath: cfg.path, readyTimeoutMs: opts.readyTimeoutMs });
    liveState.running = res.started || (await isAurenRunning(url, 300));
    liveState.started = liveState.started || res.started;
  };

  // 1. Use whatever is already on disk right away.
  await ensureServer(false);
  publish();

  // 2. Fetch missing default models, but only when the operator has not brought their own config.
  if (managed) {
    const prefs = readPrefs(home);
    const presentEmbeddings = catalog.filter((m) => m.capabilities.includes("embed") && existsSync(join(modelsDir(home), m.file)));
    if (presentEmbeddings.length === 0) {
      // Auto-download only the single preferred missing embedding model
      const missingEmbeddings = catalog
        .filter((m) => m.capabilities.includes("embed"))
        .filter((m) => !existsSync(join(modelsDir(home), m.file)));
      const targetModel = missingEmbeddings.find((m) => m.id === "bge-base") ?? missingEmbeddings[0];
      const missing = targetModel ? [targetModel] : [];
      for (const model of missing) {
        let decision = shouldAutoDownload(model, policy, prefs.largeModels);
        if (decision === "ask") {
          if (activeHooks.confirm) {
            const ok = await activeHooks.confirm(
              `pi can download the local model "${model.id}" (${(model.bytes / 1073741824).toFixed(1)} GB) for fast in-memory classification. Download it now?`,
            );
            prefs.largeModels = ok;
            writePrefs(home, prefs);
            decision = ok;
          } else {
            liveState.pendingConsent.push(model);
            continue;
          }
        }
        if (decision !== true) continue;

        liveState.phase = "downloading";
        const progress: DownloadProgress = { id: model.id, done: 0, total: model.bytes };
        liveState.downloads = [...liveState.downloads, progress];
        let lastPublish = 0;
        const r = await downloadModel(model, {
          home,
          fetchImpl: opts.fetchImpl,
          onProgress: (done, total) => {
            progress.done = done;
            progress.total = total;
            const now = Date.now();
            if (now - lastPublish > 500) {
              lastPublish = now;
              publish();
            }
          },
        });
        liveState.downloads = liveState.downloads.filter((d) => d.id !== model.id);
        if (r.status === "failed") liveState.failures.push({ id: model.id, error: r.error ?? "unknown error" });
        if (r.status === "downloaded") await ensureServer(true);
        publish();
      }
    }
  }

  liveState.phase = liveState.running ? "ready" : "unavailable";
  publish();
  return getBootstrapState();
}

export async function ensureAurenDaemon(
  cwd: string = process.cwd(),
  options?: { url?: string; autoStart?: boolean },
): Promise<{ running: boolean; started: boolean; endpoint: string; launcherPath?: string; error?: string }> {
  const st = await ensureAuren({ cwd, settings: { autoStart: options?.autoStart } });
  const endpoint = options?.url ?? DEFAULT_AUREN_URL;
  return {
    running: st.running,
    started: st.started,
    endpoint,
    error: st.failures.length > 0 ? st.failures.map((f) => f.error).join("; ") : (st.running ? undefined : "not running"),
  };
}
