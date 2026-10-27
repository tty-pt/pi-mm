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
  type EngineName,
} from "../src/versions.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    // Fake partial install in tmp: corm is up to date, sepal is outdated
    writeFileSync(join(tmp, "corm.pc"), "Name: corm\nVersion: 2.1.0\n");
    writeFileSync(join(tmp, "sepal.pc"), "Name: sepal\nVersion: 1.0.0\n"); // below min 1.2.0

    const reports = checkAllEngineVersions({ searchDirs: [tmp], cwd: tmp });
    check(reports.length === Object.keys(MIN_ENGINE_VERSIONS).length, "all components evaluated");

    const cormReport = reports.find((r) => r.name === "libcorm")!;
    check(cormReport.installed === true, "corm installed");
    check(cormReport.version === "2.1.0", "corm version 2.1.0");
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
      minRequired: "1.3.0",
      status: "missing",
      source: null,
    });
    check(missingToast.includes("axil-auren is not installed"), "toast mentions not installed");
    check(missingToast.includes("See:"), "toast includes doc link");

    const satisfiedToast = formatRemediationToast(cormReport);
    check(satisfiedToast === "", "satisfied component produces empty toast");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
