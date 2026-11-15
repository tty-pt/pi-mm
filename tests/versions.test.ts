import {
  parsePkgConfigVersion,
  compareSemver,
  satisfiesMinVersion,
  parseGitDescribeTag,
  detectComponentVersion,
  checkAllEngineVersions,
  generateRemediationAdvice,
  formatRemediationToast,
  MIN_ENGINE_VERSIONS,
  REQUIRED_ENGINE_FEATURES,
  type EngineName,
} from "../src/versions.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("versions: parsePkgConfigVersion extracts version string from .pc content", () => {
  const pc = `
prefix=/usr/local
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: cormlib
Description: Multidimensional associative memory kernel
Version: 2.1.0
Libs: -L\${libdir} -lcorm
Cflags: -I\${includedir}
`;
  check(parsePkgConfigVersion(pc) === "2.1.0", "extracts standard semver");

  const pcWithComment = `
# Comment here
Name: auren
Version:   1.3.1-rc1   # pre-release
`;
  check(parsePkgConfigVersion(pcWithComment) === "1.3.1-rc1", "trims and handles inline comments");

  check(parsePkgConfigVersion("Name: empty\\nLibs: -lfoo") === null, "returns null when Version missing");
});

Deno.test("versions: compareSemver and satisfiesMinVersion handle standard and pre-release semver", () => {
  check(compareSemver("2.1.0", "2.0.0") > 0, "2.1.0 > 2.0.0");
  check(compareSemver("1.3.1", "1.3.1") === 0, "1.3.1 == 1.3.1");
  check(compareSemver("1.2.9", "1.3.0") < 0, "1.2.9 < 1.3.0");
  check(compareSemver("2.0.0", "1.99.99") > 0, "major version takes precedence");
  check(compareSemver("1.3.0-rc1", "1.3.0") < 0, "prerelease is lower than release");
  check(compareSemver("1.3.0-rc2", "1.3.0-rc1") > 0, "rc2 > rc1");

  check(satisfiesMinVersion("2.1.0", "2.0.0") === true, "2.1.0 satisfies >= 2.0.0");
  check(satisfiesMinVersion("2.0.0", "2.0.0") === true, "2.0.0 satisfies >= 2.0.0");
  check(satisfiesMinVersion("1.9.9", "2.0.0") === false, "1.9.9 fails >= 2.0.0");
});

Deno.test("versions: parseGitDescribeTag extracts clean semver from git describe output", () => {
  check(parseGitDescribeTag("v1.7.0-2-ga1fc123") === "1.7.0", "strips v prefix and commit hash");
  check(parseGitDescribeTag("v2.1.0") === "2.1.0", "handles exact tag");
  check(parseGitDescribeTag("1.3.1") === "1.3.1", "handles tag without v");
  check(parseGitDescribeTag("invalid-tag-format") === null, "returns null for non-semver tags");
});

Deno.test("versions: detectComponentVersion discovers .pc file in custom search directory", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pc-test-"));
  try {
    const pcContent = "Name: sepallib\nVersion: 1.3.0\n";
    writeFileSync(join(tmp, "sepal.pc"), pcContent);

    const res = detectComponentVersion("libsepal", { searchDirs: [tmp], cwd: tmp });
    check(res !== null, "discovered component");
    check(res?.version === "1.3.0", "extracted version");
    check(res?.source === "pkgconfig", "source is pkgconfig");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

Deno.test("versions: checkAllEngineVersions reports status against MIN_ENGINE_VERSIONS", () => {
  const tmp = mkdtempSync(join(tmpdir(), "eng-test-"));
  try {
    // Fake partial install in tmp: corm is up to date (2.2.0), sepal is outdated (1.0.0)
    writeFileSync(join(tmp, "corm.pc"), "Name: corm\nVersion: 2.2.0\n");
    writeFileSync(join(tmp, "sepal.pc"), "Name: sepal\nVersion: 1.0.0\n"); // below min 1.2.0

    const reports = checkAllEngineVersions({ searchDirs: [tmp], cwd: tmp });
    check(reports.length === Object.keys(MIN_ENGINE_VERSIONS).length, "all components evaluated");

    const cormReport = reports.find((r) => r.name === "libcorm")!;
    check(cormReport.installed === true, "corm installed");
    check(cormReport.version === "2.2.0", "corm version 2.2.0");
    check(cormReport.status === "satisfied", "corm satisfied");

    const sepalReport = reports.find((r) => r.name === "libsepal")!;
    check(sepalReport.installed === true, "sepal installed");
    check(sepalReport.version === "1.0.0", "sepal version 1.0.0");
    check(sepalReport.status === "outdated", "sepal marked outdated");

    const advice = generateRemediationAdvice(sepalReport);
    check(advice.includes("libsepal"), "advice mentions component");
    check(advice.includes("1.2.0"), "advice mentions required version");

    const toast = formatRemediationToast(sepalReport);
    check(toast.includes("libsepal is outdated"), "toast mentions outdated component");
    check(toast.includes("1.0.0 < 1.2.0"), "toast shows version delta");
    check(toast.includes("Upgrade:"), "toast includes upgrade hint");

    const missingToast = formatRemediationToast({
      name: "axil-auren",
      installed: false,
      version: null,
      minRequired: "1.4.0",
      status: "missing",
      source: null,
    });
    check(missingToast.includes("axil-auren is not installed"), "toast mentions not installed");
    check(missingToast.includes("See:"), "toast includes doc link");

    const satisfiedToast = formatRemediationToast(cormReport);
    check(satisfiedToast === "", "satisfied component produces empty toast");

    // Verify corm 2.1.0 is flagged outdated against min 2.2.0
    writeFileSync(join(tmp, "corm.pc"), "Name: corm\nVersion: 2.1.0\n");
    const outdatedCorm = detectComponentVersion("libcorm", { searchDirs: [tmp], cwd: tmp })!;
    check(outdatedCorm.status === "outdated", "corm 2.1.0 is outdated when min is 2.2.0");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

Deno.test("versions: MIN_ENGINE_VERSIONS satisfies all REQUIRED_ENGINE_FEATURES floors", () => {
  const coveredEngines = new Set<EngineName>();
  for (const item of REQUIRED_ENGINE_FEATURES) {
    coveredEngines.add(item.engine);
    const minConfigured = MIN_ENGINE_VERSIONS[item.engine];
    check(
      Boolean(minConfigured),
      `Engine ${item.engine} referenced in REQUIRED_ENGINE_FEATURES must exist in MIN_ENGINE_VERSIONS`,
    );
    check(
      satisfiesMinVersion(minConfigured, item.minVersion),
      `MIN_ENGINE_VERSIONS[${item.engine}] (${minConfigured}) is lower than required floor ${item.minVersion} for feature: ${item.feature}`,
    );
  }
  for (const engine of Object.keys(MIN_ENGINE_VERSIONS) as EngineName[]) {
    check(
      coveredEngines.has(engine),
      `Engine ${engine} in MIN_ENGINE_VERSIONS must have at least one entry in REQUIRED_ENGINE_FEATURES`,
    );
  }
});

Deno.test("versions: detectComponentVersion resolves node_modules/@tty-pt/* without system libs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "npm-ver-test-"));
  try {
    const cormDir = join(tmp, "node_modules", "@tty-pt", "corm");
    const jointDir = join(tmp, "node_modules", "@tty-pt", "joint");
    Deno.mkdirSync(cormDir, { recursive: true });
    Deno.mkdirSync(jointDir, { recursive: true });

    // 1. Package with bundled .pc file
    writeFileSync(join(cormDir, "corm.pc"), "Name: corm\nVersion: 2.4.0\n");
    // 2. Package with package.json only
    writeFileSync(join(jointDir, "package.json"), JSON.stringify({ name: "@tty-pt/joint", version: "1.8.0" }));

    const cormRep = detectComponentVersion("libcorm", { cwd: tmp, home: tmp, includeDefaultDirs: false })!;
    check(cormRep.installed === true, "libcorm detected via node_modules .pc");
    check(cormRep.version === "2.4.0", "libcorm version 2.4.0");
    check(cormRep.status === "satisfied", "libcorm satisfied");

    const jointRep = detectComponentVersion("libjoint", { cwd: tmp, home: tmp, includeDefaultDirs: false })!;
    check(jointRep.installed === true, "libjoint detected via node_modules package.json");
    check(jointRep.version === "1.8.0", "libjoint version 1.8.0");
    check(jointRep.status === "satisfied", "libjoint satisfied");
    check(jointRep.source === "npm", "libjoint source is npm");

    const axilDir = join(tmp, "node_modules", "@tty-pt", "axil");
    const aurenDir = join(tmp, ".pi", "agent", "npm", "node_modules", "@tty-pt", "auren");
    Deno.mkdirSync(axilDir, { recursive: true });
    Deno.mkdirSync(aurenDir, { recursive: true });
    writeFileSync(join(axilDir, "package.json"), JSON.stringify({ name: "@tty-pt/axil", version: "1.8.1" }));
    writeFileSync(join(aurenDir, "package.json"), JSON.stringify({ name: "@tty-pt/auren", version: "1.5.1" }));

    const axilRep = detectComponentVersion("axil", { cwd: tmp, home: tmp, includeDefaultDirs: false })!;
    check(axilRep.installed === true && axilRep.version === "1.8.1" && axilRep.status === "satisfied", "axil detected via node_modules/@tty-pt/axil");

    const aurenRep = detectComponentVersion("axil-auren", { cwd: tmp, home: tmp, includeDefaultDirs: false })!;
    check(aurenRep.installed === true && aurenRep.version === "1.5.1" && aurenRep.status === "satisfied", "axil-auren detected via .pi/agent/npm/node_modules/@tty-pt/auren");

    const missingRep = detectComponentVersion("liblemma", { cwd: tmp, home: tmp, includeDefaultDirs: false })!;
    check(missingRep.installed === false && missingRep.status === "missing", "uninstalled liblemma is missing when includeDefaultDirs=false");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

