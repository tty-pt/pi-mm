import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, applyEnv, resolveAxisPath } from "../src/config.ts";
import { checkAllEngineVersions } from "../src/versions.ts";
import { findSepalLib } from "../src/auren-bootstrap.ts";
import { SessionStore } from "../src/session/store.ts";
import { CodeStore } from "../src/code/store.ts";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

Deno.test("standalone npm install: pi-mm works with node_modules/@tty-pt/* prebuilds and zero system/external libs", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mm-standalone-npm-"));
  const key = `${process.platform}-${process.arch}`;

  try {
    const packages: Array<{
      short: string;
      repo: string;
      version: string;
      addonFile: string;
      libFile: string;
    }> = [
      { short: "stele", repo: "libstele", version: "1.7.0", addonFile: "stele_node.node", libFile: "libstele.so" },
      { short: "corm", repo: "libcorm", version: "2.4.0", addonFile: "corm_node.node", libFile: "libcorm.so" },
      { short: "joint", repo: "libjoint", version: "1.8.0", addonFile: "joint_node.node", libFile: "libjoint.so" },
      { short: "lemma", repo: "liblemma", version: "1.4.0", addonFile: "lemma_node.node", libFile: "liblemma.so" },
      { short: "sepal", repo: "libsepal", version: "1.5.0", addonFile: "sepal_node.node", libFile: "libsepal.so" },
      { short: "islet", repo: "libislet", version: "1.6.0", addonFile: "islet_node.node", libFile: "libislet.so" },
    ];

    for (const pkg of packages) {
      const pkgDir = join(tmp, "node_modules", "@tty-pt", pkg.short);
      const prebuildDir = join(pkgDir, "prebuilds", key);
      const distDir = join(pkgDir, "dist");
      mkdirSync(prebuildDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });

      const srcNpmDir = join(repoRoot, "external", pkg.repo, "npm");
      copyFileSync(join(srcNpmDir, "package.json"), join(pkgDir, "package.json"));
      const pcPath = join(srcNpmDir, `${pkg.short}.pc`);
      if (existsSync(pcPath)) {
        copyFileSync(pcPath, join(pkgDir, `${pkg.short}.pc`));
      }
      copyFileSync(join(srcNpmDir, "dist", "index.js"), join(distDir, "index.js"));

      const srcAddon = join(srcNpmDir, "build", "Release", pkg.addonFile);
      if (existsSync(srcAddon)) {
        copyFileSync(srcAddon, join(prebuildDir, `${pkg.short}.node`));
      }
      const srcLib = join(repoRoot, "external", pkg.repo, "lib", pkg.libFile);
      if (existsSync(srcLib)) {
        copyFileSync(srcLib, join(prebuildDir, pkg.libFile));
      }
    }

    // 1. Verify resolveAxisPath prefers node_modules/@tty-pt/<axis>/prebuilds/<key> over /usr/lib
    const resolvedAxes = resolveAxisPath(DEFAULT_CONFIG, tmp);
    const expectedAxes = [
      join(tmp, "node_modules", "@tty-pt", "joint", "prebuilds", key),
      join(tmp, "node_modules", "@tty-pt", "lemma", "prebuilds", key),
      join(tmp, "node_modules", "@tty-pt", "islet", "prebuilds", key),
    ].join(":");
    check(
      resolvedAxes === expectedAxes,
      `Expected resolveAxisPath to equal ${expectedAxes}, got ${resolvedAxes}`,
    );

    const cfgWithSepal = applyEnv(DEFAULT_CONFIG, {
      CORM_SEPAL_EMBED_URL: "http://127.0.0.1:4242",
      CORM_SEPAL_EMBED_MODEL: "bge-base",
    });
    const resolvedWithSepal = resolveAxisPath(cfgWithSepal, tmp);
    check(
      resolvedWithSepal === `${expectedAxes}:${join(tmp, "node_modules", "@tty-pt", "sepal", "prebuilds", key)}`,
      `Expected resolveAxisPath with sepal to include sepal prebuild dir, got ${resolvedWithSepal}`,
    );

    // 2. Verify findSepalLib resolves node_modules/@tty-pt/sepal/prebuilds/<key>/libsepal.so with includeDefaultDirs=false
    const sepalLib = findSepalLib(tmp, false);
    check(
      sepalLib === join(tmp, "node_modules", "@tty-pt", "sepal", "prebuilds", key, "libsepal.so"),
      `Expected findSepalLib to resolve node_modules libsepal.so, got ${sepalLib}`,
    );

    // 3. Verify checkAllEngineVersions satisfies all 5 C libraries strictly from node_modules/@tty-pt/*
    const reports = checkAllEngineVersions({ cwd: tmp, home: tmp, includeDefaultDirs: false });
    for (const eng of ["libcorm", "libjoint", "liblemma", "libsepal", "libislet"] as const) {
      const rep = reports.find((r) => r.name === eng)!;
      check(
        rep.installed && rep.status === "satisfied",
        `Expected ${eng} to be satisfied via node_modules without system dirs, got ${JSON.stringify(rep)}`,
      );
    }

    // 4. Verify SessionStore works in-process with cormBin set to a non-existent binary and axes resolved from node_modules
    const sessionStore = new SessionStore({
      sessionId: "standalone-npm-session",
      cwd: tmp,
      sessionDir: join(tmp, ".pi", "cache", "sessions", "standalone-npm-session"),
      cormBin: "/nonexistent/corm-cli-binary",
    });
    check(
      sessionStore.axisPath === expectedAxes,
      `Expected SessionStore.axisPath to use node_modules prebuilds, got ${sessionStore.axisPath}`,
    );

    await sessionStore.appendEvent({
      id: "ev-standalone-1",
      entryId: "entry-standalone-1",
      turnIndex: 1,
      role: "user",
      speaker: "user",
      summary: "Verify standalone npm prebuild execution without system libraries",
      text: "Testing joint and lemma axis loading from node_modules/@tty-pt/*/prebuilds",
      timestamp: "2026-11-14T20:00:00Z",
    });
    await sessionStore.flush(2000);

    const hits = await sessionStore.queryLexical("standalone prebuild", 5);
    check(hits.length === 1, `Expected 1 SessionStore queryLexical hit, got ${hits.length}`);
    check(hits[0].ref === 1, "Matched ref 1 from SessionStore C kernel");

    // 5. Verify CodeStore indexes and queries symbols + spatial islet spans using node_modules prebuilds
    const srcDir = join(tmp, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "widget.ts"),
      [
        "export function computeStandaloneWidget(alpha: number): number {",
        "  return alpha * 42;",
        "}",
      ].join("\n") + "\n",
    );

    const codeStore = new CodeStore({
      projectRoot: tmp,
      indexDir: join(tmp, ".pi", "cache", "code-index"),
      cormBin: "/nonexistent/corm-cli-binary",
      cormdBin: "",
    });
    check(
      codeStore.axisPath === expectedAxes,
      `Expected CodeStore.axisPath to use node_modules prebuilds, got ${codeStore.axisPath}`,
    );

    await codeStore.ensureIndexed();
    await codeStore.flush(2000);

    const codeHits = await codeStore.queryLexical("computeStandaloneWidget", 5);
    check(codeHits.length >= 1, `Expected CodeStore queryLexical hit for computeStandaloneWidget, got ${codeHits.length}`);
    const sym = await codeStore.getSymbol(codeHits[0].ref);
    check(
      sym?.name === "computeStandaloneWidget",
      `Expected top hit to be computeStandaloneWidget, got ${sym?.name}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
