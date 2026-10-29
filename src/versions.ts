/**
 * versions.ts — portable native C engine version detector and requirements engine.
 *
 * Self-contained on purpose (node: built-ins only) so the exact same file is vendored
 * into both pi-mm and pi-quest. Neither depends on external tools like pkg-config,
 * which may not be installed on minimal systems or containers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

export type EngineName = "axil" | "libcorm" | "libsepal" | "liblemma" | "libjoint" | "axil-auren";

export const MIN_ENGINE_VERSIONS: Record<EngineName, string> = {
  axil: "1.6.0",
  libcorm: "2.0.0",
  libsepal: "1.2.0",
  liblemma: "1.1.0",
  libjoint: "1.5.0",
  "axil-auren": "1.3.0",
};

export const DOCS_ENGINE_GUIDES: Record<EngineName, string> = {
  axil: "https://github.com/tty-pt/axil#installation--build",
  libcorm: "https://github.com/tty-pt/libcorm#installation--build",
  libsepal: "https://github.com/tty-pt/libsepal#installation--build",
  liblemma: "https://github.com/tty-pt/liblemma#installation--build",
  libjoint: "https://github.com/tty-pt/libjoint#installation--build",
  "axil-auren": "https://github.com/tty-pt/axil-auren#installation--build",
};

const PC_ALIASES: Record<EngineName, string[]> = {
  axil: ["axil.pc"],
  libcorm: ["corm.pc", "cormlib.pc", "libcorm.pc"],
  libsepal: ["sepal.pc", "sepallib.pc", "libsepal.pc"],
  liblemma: ["lemma.pc", "liblemma.pc"],
  libjoint: ["joint.pc", "libjoint.pc"],
  "axil-auren": ["auren.pc", "axil-auren.pc", "libaxil-auren.pc"],
};

export type VersionSource = "pkgconfig" | "git" | "daemon" | "fallback";
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
}

/**
 * Extracts the version string from the text of a pkg-config (.pc) file.
 */
export function parsePkgConfigVersion(content: string): string | null {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = /^Version:\s*([^\s#]+)/i.exec(line);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Parses and cleans a semver tag from `git describe --tags` (e.g. "v1.7.0-2-ga1fc123" -> "1.7.0").
 */
export function parseGitDescribeTag(tag: string): string | null {
  const clean = tag.trim().replace(/^v/i, "");
  const match = /^(\d+\.\d+(?:\.\d+)?)/.exec(clean);
  return match ? match[1] : null;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseSemver(v: string): ParsedSemver | null {
  const trimmed = v.trim().replace(/^v/i, "");
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(trimmed);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
    prerelease: match[4],
  };
}

/**
 * Standard semver comparator: returns 1 if a > b, 0 if a == b, -1 if a < b.
 */
export function compareSemver(a: string, b: string): number {
  const pA = parseSemver(a);
  const pB = parseSemver(b);
  if (!pA || !pB) return a.localeCompare(b);

  if (pA.major !== pB.major) return pA.major > pB.major ? 1 : -1;
  if (pA.minor !== pB.minor) return pA.minor > pB.minor ? 1 : -1;
  if (pA.patch !== pB.patch) return pA.patch > pB.patch ? 1 : -1;

  if (pA.prerelease && !pB.prerelease) return -1;
  if (!pA.prerelease && pB.prerelease) return 1;
  if (pA.prerelease && pB.prerelease) {
    return pA.prerelease.localeCompare(pB.prerelease);
  }
  return 0;
}

/**
 * Returns true if the actual version meets or exceeds the required minimum.
 */
export function satisfiesMinVersion(actual: string, minRequired: string): boolean {
  return compareSemver(actual, minRequired) >= 0;
}

const DEFAULT_PC_DIRS = [
  "/usr/lib/pkgconfig",
  "/usr/local/lib/pkgconfig",
  "/usr/share/pkgconfig",
  "/usr/lib/x86_64-linux-gnu/pkgconfig",
  "/usr/lib/aarch64-linux-gnu/pkgconfig",
  "/opt/homebrew/lib/pkgconfig",
];

function findPcFile(aliases: string[], searchDirs: string[]): { path: string; version: string } | null {
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    for (const alias of aliases) {
      const full = join(dir, alias);
      if (existsSync(full)) {
        try {
          const text = readFileSync(full, "utf8");
          const ver = parsePkgConfigVersion(text);
          if (ver) return { path: full, version: ver };
        } catch {
          // ignore unreadable
        }
      }
    }
  }
  return null;
}

function findRepoRoot(startDir: string): string | null {
  let curr = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(curr, "external"))) {
      return curr;
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

function findGitVersion(comp: EngineName, cwd: string, home: string): { path: string; version: string } | null {
  const repoRoot = findRepoRoot(cwd);
  const candidateDirs = [
    join(cwd, "external", comp),
    join(cwd, "external", comp.replace(/^lib/, "")),
    ...(repoRoot ? [join(repoRoot, "external", comp), join(repoRoot, "external", comp.replace(/^lib/, ""))] : []),
    join(cwd, "..", comp),
    join(home, comp),
  ];

  for (const dir of candidateDirs) {
    if (existsSync(join(dir, ".git"))) {
      try {
        const out = execSync("git describe --tags --always", {
          cwd: dir,
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
          timeout: 1000,
        });
        const ver = parseGitDescribeTag(out);
        if (ver) return { path: dir, version: ver };
      } catch {
        // best effort
      }
    }
  }
  return null;
}

/**
 * Portable detection of a specific engine component's installed version.
 */
export function detectComponentVersion(
  name: EngineName,
  opts: VersionDetectOptions = {},
): ComponentVersionReport | null {
  const cwd = opts.cwd ?? (typeof process !== "undefined" ? process.cwd() : ".");
  const home = opts.home ?? homedir();
  const repoRoot = findRepoRoot(cwd);
  const searchDirs = [
    ...(opts.searchDirs ?? []),
    join(home, ".local", "lib", "pkgconfig"),
    join(cwd, "external", name),
    join(cwd, "external", name.replace(/^lib/, "")),
    ...(repoRoot ? [join(repoRoot, "external", name), join(repoRoot, "external", name.replace(/^lib/, ""))] : []),
    join(home, name),
    ...DEFAULT_PC_DIRS,
  ];

  const minRequired = MIN_ENGINE_VERSIONS[name];
  const aliases = PC_ALIASES[name] ?? [`${name}.pc`];

  // 1. Check direct .pc files
  const pc = findPcFile(aliases, searchDirs);
  if (pc) {
    const status = satisfiesMinVersion(pc.version, minRequired) ? "satisfied" : "outdated";
    return {
      name,
      installed: true,
      version: pc.version,
      minRequired,
      status,
      source: "pkgconfig",
      path: pc.path,
    };
  }

  // 2. Check git checkouts in workspace or HOME
  const git = findGitVersion(name, cwd, home);
  if (git) {
    const status = satisfiesMinVersion(git.version, minRequired) ? "satisfied" : "outdated";
    return {
      name,
      installed: true,
      version: git.version,
      minRequired,
      status,
      source: "git",
      path: git.path,
    };
  }

  return {
    name,
    installed: false,
    version: null,
    minRequired,
    status: "missing",
    source: null,
  };
}

/**
 * Checks all defined core C engines against the minimum version requirements.
 */
export function checkAllEngineVersions(opts: VersionDetectOptions = {}): ComponentVersionReport[] {
  const names = Object.keys(MIN_ENGINE_VERSIONS) as EngineName[];
  return names.map((name) => detectComponentVersion(name, opts)!);
}

/**
 * Generates exact, actionable commands to update an outdated or missing component.
 */
export function generateRemediationAdvice(report: ComponentVersionReport): string {
  const guide = DOCS_ENGINE_GUIDES[report.name] ?? "https://github.com/tty-pt";
  if (report.status === "satisfied") {
    return `${report.name} is up to date (${report.version} >= ${report.minRequired}).`;
  }

  if (report.status === "outdated") {
    return [
      `[!] ${report.name} is outdated: installed version is ${report.version}, but >= ${report.minRequired} is required.`,
      `    -> Package update: sudo apt update && sudo apt --only-upgrade install -y ${report.name}`,
      `    -> Source build: cd external/${report.name} && git pull && sudo make install`,
      `    -> Guide: ${guide}`,
    ].join("\n");
  }

  return [
    `[!] ${report.name} is not installed (requires >= ${report.minRequired}).`,
    `    -> Package install: sudo apt update && sudo apt install -y ${report.name}`,
    `    -> Guide: ${guide}`,
  ].join("\n");
}

/**
 * Formats a concise, single-line remediation toast for proactive TUI session_start notices.
 */
export function formatRemediationToast(report: ComponentVersionReport): string {
  const guide = DOCS_ENGINE_GUIDES[report.name] ?? "https://github.com/tty-pt";
  if (report.status === "satisfied") return "";
  if (report.status === "outdated") {
    return `${report.name} is outdated (${report.version} < ${report.minRequired}). Upgrade: cd external/${report.name} && git pull && make install. See: ${guide}`;
  }
  return `${report.name} is not installed (requires >= ${report.minRequired}). See: ${guide}`;
}

