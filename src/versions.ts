/**
 * versions.ts — portable native C engine version detector and requirements engine.
 *
 * Self-contained on purpose (node: built-ins only) so the exact same file is vendored
 * into both pi-mm and pi-quest. Neither depends on external tools like pkg-config,
 * which may not be installed on minimal systems or containers.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type EngineName =
  | "axil"
  | "libcorm"
  | "libsepal"
  | "liblemma"
  | "libjoint"
  | "libislet"
  | "axil-auren";

export interface EngineFeatureFloor {
  engine: EngineName;
  feature: string;
  minVersion: string;
}

export const REQUIRED_ENGINE_FEATURES: readonly EngineFeatureFloor[] = [
  { engine: "libcorm", feature: "LIST / GET / PUT / DEL / DEL_ALL / QUERY / RECONCILE CLI & cormd TCP/UDS protocol", minVersion: "2.0.0" },
  { engine: "libcorm", feature: "HTOK v4 native binary packing (corm_htok_pack / corm_htok_unpack), PUT_JSON, GET_JSON", minVersion: "2.2.0" },
  { engine: "libsepal", feature: "HNSW / sketch hybrid approximate vector index & recall axis plugin", minVersion: "1.0.0" },
  { engine: "libsepal", feature: "rec_axis_store_typed for HTOK v4 binary vector embedding ingestion", minVersion: "1.2.0" },
  { engine: "liblemma", feature: "Lexical inverted index & recall axis plugin", minVersion: "1.0.0" },
  { engine: "liblemma", feature: "3-gram index, lemma_tok_encode/decode, and rec_axis_store_typed for HTOK v4", minVersion: "1.1.0" },
  { engine: "libjoint", feature: "Interval tree temporal axis plugin (rec_axis_fill_interval)", minVersion: "1.0.0" },
  { engine: "libjoint", feature: "rec_axis_store_typed for HTOK v4 temporal interval ingestion", minVersion: "1.5.0" },
  { engine: "libislet", feature: "Morton Z-order 2D/3D spatial index & cormr.h recall axis plugin (rec_axis_fill_bbox_2)", minVersion: "1.2.0" },
  { engine: "axil", feature: "Browser axil-bridge.js, WebSocket/HTTP transport & /api/v1 proxy endpoints", minVersion: "1.6.0" },
  { engine: "axil-auren", feature: "POST /v1/embeddings (128D) & /v1/rerank HTTP endpoints", minVersion: "1.3.0" },
  { engine: "axil-auren", feature: "Unified non-generative POST /v1/systemone & /api/v1/systemone/ (choice gating, exemplars, Jev)", minVersion: "1.4.0" },
];

export const MIN_ENGINE_VERSIONS: Record<EngineName, string> = {
  axil: "1.6.0",
  libcorm: "2.2.0",
  libsepal: "1.2.0",
  liblemma: "1.1.0",
  libjoint: "1.5.0",
  libislet: "1.2.0",
  "axil-auren": "1.4.0",
};

export const DOCS_ENGINE_GUIDES: Record<EngineName, string> = {
  axil: "https://github.com/tty-pt/axil#installation--build",
  libcorm: "https://github.com/tty-pt/libcorm#installation--build",
  libsepal: "https://github.com/tty-pt/libsepal#installation--build",
  liblemma: "https://github.com/tty-pt/liblemma#installation--build",
  libjoint: "https://github.com/tty-pt/libjoint#installation--build",
  libislet: "https://github.com/tty-pt/libislet#installation--build",
  "axil-auren": "https://github.com/tty-pt/axil-auren#installation--build",
};

const PC_ALIASES: Record<EngineName, string[]> = {
  axil: ["axil.pc"],
  libcorm: ["corm.pc", "cormlib.pc", "libcorm.pc"],
  libsepal: ["sepal.pc", "sepallib.pc", "libsepal.pc"],
  liblemma: ["lemma.pc", "liblemma.pc"],
  libjoint: ["joint.pc", "libjoint.pc"],
  libislet: ["islet.pc", "libislet.pc"],
  "axil-auren": ["auren.pc", "axil-auren.pc", "libaxil-auren.pc"],
};

const NPM_SHORT_NAMES: Partial<Record<EngineName, string>> = {
  axil: "axil",
  libcorm: "corm",
  libsepal: "sepal",
  liblemma: "lemma",
  libjoint: "joint",
  libislet: "islet",
  "axil-auren": "auren",
};

export type VersionSource = "pkgconfig" | "npm" | "git" | "daemon" | "fallback";
export type VersionStatus = "satisfied" | "outdated" | "missing";

export interface ComponentVersionReport {
  name: EngineName;
  installed: boolean;
  version: string | null;
  minRequired: string;
  status: VersionStatus;
  source: VersionSource | null;
  path?: string;
}

export interface VersionDetectOptions {
  cwd?: string;
  home?: string;
  searchDirs?: string[];
  includeDefaultDirs?: boolean;
}

export function parsePkgConfigVersion(content: string): string | null {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = /^Version:\s*([^\s#]+)/i.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

export function parseGitDescribeTag(tag: string): string | null {
  const clean = tag.trim().replace(/^v/i, "");
  const match = /^(\d+\.\d+(?:\.\d+)?)/.exec(clean);
  return match ? match[1] : null;
}

interface ParsedSemver { major: number; minor: number; patch: number; prerelease?: string; }

function parseSemver(v: string): ParsedSemver | null {
  const trimmed = v.trim().replace(/^v/i, "");
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(trimmed);
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] !== undefined ? Number(m[2]) : 0, patch: m[3] !== undefined ? Number(m[3]) : 0, prerelease: m[4] };
}

export function compareSemver(a: string, b: string): number {
  const pA = parseSemver(a);
  const pB = parseSemver(b);
  if (!pA || !pB) return a.localeCompare(b);
  if (pA.major !== pB.major) return pA.major > pB.major ? 1 : -1;
  if (pA.minor !== pB.minor) return pA.minor > pB.minor ? 1 : -1;
  if (pA.patch !== pB.patch) return pA.patch > pB.patch ? 1 : -1;
  if (pA.prerelease && !pB.prerelease) return -1;
  if (!pA.prerelease && pB.prerelease) return 1;
  if (pA.prerelease && pB.prerelease) return pA.prerelease.localeCompare(pB.prerelease);
  return 0;
}

export function satisfiesMinVersion(actual: string, minRequired: string): boolean {
  return compareSemver(actual, minRequired) >= 0;
}

const DEFAULT_PC_DIRS = [
  "/usr/lib/pkgconfig", "/usr/local/lib/pkgconfig", "/usr/share/pkgconfig",
  "/usr/lib/x86_64-linux-gnu/pkgconfig", "/usr/lib/aarch64-linux-gnu/pkgconfig", "/opt/homebrew/lib/pkgconfig",
];

function findPcFile(aliases: string[], searchDirs: string[]): { path: string; version: string } | null {
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    for (const alias of aliases) {
      const full = join(dir, alias);
      if (!existsSync(full)) continue;
      try {
        const ver = parsePkgConfigVersion(readFileSync(full, "utf8"));
        if (ver) return { path: full, version: ver };
      } catch { /* ignore */ }
    }
  }
  return null;
}

function findRepoRoot(startDir: string): string | null {
  for (let curr = startDir, i = 0; i < 6; i++) {
    if (existsSync(join(curr, "external"))) return curr;
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

const gitVersionCache = new Map<string, { path: string; version: string } | null>();

function findGitVersion(comp: EngineName, cwd: string, home: string): { path: string; version: string } | null {
  const repoRoot = findRepoRoot(cwd);
  const short = comp.replace(/^lib/, "");
  const candidateDirs = [
    join(cwd, "external", comp), join(cwd, "external", short),
    ...(repoRoot ? [join(repoRoot, "external", comp), join(repoRoot, "external", short)] : []),
    join(cwd, "..", comp), join(home, comp),
  ];
  for (const dir of candidateDirs) {
    if (!existsSync(join(dir, ".git"))) continue;
    const resolvedDir = resolve(dir);
    if (gitVersionCache.has(resolvedDir)) {
      const cached = gitVersionCache.get(resolvedDir) ?? null;
      if (cached) return cached;
      continue;
    }
    try {
      const out = execSync("git describe --tags --always", { cwd: dir, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 1000 });
      const ver = parseGitDescribeTag(out);
      const result = ver ? { path: dir, version: ver } : null;
      gitVersionCache.set(resolvedDir, result);
      if (result) return result;
    } catch {
      gitVersionCache.set(resolvedDir, null);
    }
  }
  return null;
}

function findNpmPackageDirs(comp: EngineName, cwd: string, includeModuleRelative = true, home = homedir()): string[] {
  const short = NPM_SHORT_NAMES[comp];
  if (!short) return [];
  const dirs: string[] = [];
  const add = (d: string) => { if (d && !dirs.includes(d) && existsSync(d)) dirs.push(d); };
  for (let curr = cwd, i = 0; i < 4; i++) {
    add(join(curr, "node_modules", "@tty-pt", short));
    add(join(curr, ".pi", "agent", "npm", "node_modules", "@tty-pt", short));
    add(join(curr, ".pi", "npm", "node_modules", "@tty-pt", short));
    add(join(curr, ".pi", "extensions", "pi-mm", "node_modules", "@tty-pt", short));
    add(join(curr, ".pi", "extensions", "pi-quest", "node_modules", "@tty-pt", short));
    const parent = dirname(curr);
    if (!parent || parent === curr) break;
    curr = parent;
  }
  for (const base of [cwd, home]) {
    add(join(base, "node_modules", "@tty-pt", short));
    add(join(base, ".pi", "agent", "npm", "node_modules", "@tty-pt", short));
    add(join(base, ".pi", "npm", "node_modules", "@tty-pt", short));
  }
  if (includeModuleRelative) {
    try {
      const req = createRequire(import.meta.url);
      try { add(dirname(req.resolve(`@tty-pt/${short}/package.json`))); } catch {
        for (let d = dirname(req.resolve(`@tty-pt/${short}`)), i = 0; i < 4; i++, d = dirname(d)) {
          if (existsSync(join(d, "package.json"))) { add(d); break; }
        }
      }
    } catch { /* ignore */ }
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      for (const rel of ["..", "../..", "../../..", "../../../..", "../../../../.."]) {
        add(resolve(here, rel, "node_modules", "@tty-pt", short));
      }
      add(resolve(here, "../..", short));
    } catch { /* ignore */ }
  }
  return dirs;
}

function findNpmPackageJsonVersion(dirs: string[]): { path: string; version: string } | null {
  for (const dir of dirs) {
    const pkgJsonPath = join(dir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim() !== "") {
        return { path: pkgJsonPath, version: parsed.version.trim() };
      }
    } catch { /* ignore */ }
  }
  return null;
}

function buildReport(name: EngineName, minRequired: string, found: { path: string; version: string } | null, source: VersionSource | null): ComponentVersionReport {
  if (!found || !source) return { name, installed: false, version: null, minRequired, status: "missing", source: null };
  const status = satisfiesMinVersion(found.version, minRequired) ? "satisfied" : "outdated";
  return { name, installed: true, version: found.version, minRequired, status, source, path: found.path };
}

export function detectComponentVersion(name: EngineName, opts: VersionDetectOptions = {}): ComponentVersionReport | null {
  const cwd = opts.cwd ?? (typeof process !== "undefined" ? process.cwd() : ".");
  const home = opts.home ?? homedir();
  const includeDefaults = opts.includeDefaultDirs !== false;
  const repoRoot = includeDefaults ? findRepoRoot(cwd) : null;
  const npmDirs = findNpmPackageDirs(name, cwd, includeDefaults, home);
  const short = name.replace(/^lib/, "");
  const searchDirs = [
    ...(opts.searchDirs ?? []), ...npmDirs,
    ...(includeDefaults
      ? [
          join(home, ".local", "lib", "pkgconfig"), join(cwd, "external", name), join(cwd, "external", short),
          ...(repoRoot ? [join(repoRoot, "external", name), join(repoRoot, "external", short)] : []),
          join(home, name), ...DEFAULT_PC_DIRS,
        ]
      : []),
  ];
  const minRequired = MIN_ENGINE_VERSIONS[name];
  const pc = findPcFile(PC_ALIASES[name] ?? [`${name}.pc`], searchDirs);
  if (pc) return buildReport(name, minRequired, pc, "pkgconfig");
  const npmPkg = findNpmPackageJsonVersion(npmDirs);
  if (npmPkg) return buildReport(name, minRequired, npmPkg, "npm");
  if (includeDefaults) {
    const git = findGitVersion(name, cwd, home);
    if (git) return buildReport(name, minRequired, git, "git");
  }
  return buildReport(name, minRequired, null, null);
}

export function checkAllEngineVersions(opts: VersionDetectOptions = {}): ComponentVersionReport[] {
  const names = Object.keys(MIN_ENGINE_VERSIONS) as EngineName[];
  return names.map((name) => detectComponentVersion(name, opts)!);
}

export function generateRemediationAdvice(report: ComponentVersionReport): string {
  const guide = DOCS_ENGINE_GUIDES[report.name] ?? "https://github.com/tty-pt";
  const npmShort = NPM_SHORT_NAMES[report.name];
  if (report.status === "satisfied") {
    return `${report.name} is up to date (${report.version} >= ${report.minRequired}).`;
  }
  if (report.status === "outdated") {
    return [
      `[!] ${report.name} is outdated: installed version is ${report.version}, but >= ${report.minRequired} is required.`,
      ...(npmShort ? [`    -> NPM update: npm install @tty-pt/${npmShort}@latest`] : []),
      `    -> Package update: sudo apt update && sudo apt --only-upgrade install -y ${report.name}`,
      `    -> Source build: cd external/${report.name} && git pull && sudo make install`,
      `    -> Guide: ${guide}`,
    ].join("\n");
  }
  return [
    `[!] ${report.name} is not installed (requires >= ${report.minRequired}).`,
    ...(npmShort ? [`    -> NPM install: npm install @tty-pt/${npmShort}`] : []),
    `    -> Package install: sudo apt update && sudo apt install -y ${report.name}`,
    `    -> Guide: ${guide}`,
  ].join("\n");
}

export function formatRemediationToast(report: ComponentVersionReport): string {
  const guide = DOCS_ENGINE_GUIDES[report.name] ?? "https://github.com/tty-pt";
  const npmShort = NPM_SHORT_NAMES[report.name];
  const npmHint = npmShort ? `npm install @tty-pt/${npmShort}@latest or ` : "";
  if (report.status === "satisfied") return "";
  if (report.status === "outdated") {
    return `${report.name} is outdated (${report.version} < ${report.minRequired}). Upgrade: ${npmHint}cd external/${report.name} && git pull && make install. See: ${guide}`;
  }
  return `${report.name} is not installed (requires >= ${report.minRequired}). ${npmShort ? `Install: npm install @tty-pt/${npmShort}. ` : ""}See: ${guide}`;
}
