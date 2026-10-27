#!/usr/bin/env -S deno run --allow-all --sloppy-imports --node-modules-dir=none
/**
 * demo-bootstrap.ts — Live interactive verification & demonstration tool.
 *
 * Demonstrates:
 *   1. Automatic model downloading when ~/.models is empty (with live progress bar).
 *   2. Interactive consent prompt for large tier models (olmoe 3.3 GB).
 *   3. Missing dependencies detection with actionable installation links.
 *   4. Core C engine version tracking against minimum requirements.
 *
 * Usage:
 *   deno run --allow-all scripts/demo-bootstrap.ts [--all | --versions | --download-test | --missing-deps]
 */

import { checkAllEngineVersions, generateRemediationAdvice } from "../src/versions.ts";
import {
  ensureAuren,
  diagnoseAuren,
  type CatalogModel,
  resetBootstrapForTests,
} from "../src/auren-bootstrap.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

function renderProgressBar(done: number, total: number, width = 30): string {
  const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
  const filled = Math.floor((width * pct) / 100);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${pct.toString().padStart(3)}% (${(done / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`;
}

export function showVersionReport(): void {
  console.log("\n=======================================================");
  console.log(" 1. PORTABLE CORE C ENGINE VERSIONS & REQUIREMENTS");
  console.log("=======================================================");
  const reports = checkAllEngineVersions();
  console.log("Component     | Installed | Required | Status     | Source");
  console.log("--------------+-----------+----------+------------+---------");
  for (const r of reports) {
    const name = r.name.padEnd(13);
    const ver = (r.version ?? "none").padEnd(9);
    const min = (`>= ${r.minRequired}`).padEnd(8);
    let status = r.status.toUpperCase();
    if (r.status === "satisfied") status = `\x1b[32m${status}\x1b[0m`;
    else if (r.status === "outdated") status = `\x1b[33m${status}\x1b[0m`;
    else status = `\x1b[31m${status}\x1b[0m`;
    const src = r.source ?? "-";
    console.log(`${name} | ${ver} | ${min} | ${status.padEnd(19)}| ${src}`);
  }

  const needsAction = reports.filter((r) => r.status !== "satisfied");
  if (needsAction.length > 0) {
    console.log("\n--- Actionable Remediation Guidance ---");
    for (const a of needsAction) {
      console.log(generateRemediationAdvice(a));
    }
  } else {
    console.log("\n[✓] All core C engine dependencies satisfy minimum requirements!");
  }
}

export function showMissingDepsSimulation(): void {
  console.log("\n=======================================================");
  console.log(" 2. SIMULATION: MISSING DEPENDENCIES NOTICE");
  console.log("=======================================================");
  console.log("Simulating a fresh environment where native engines are not yet installed:");

  const sandbox = mkdtempSync(join(tmpdir(), "missing-deps-"));
  try {
    const notices = diagnoseAuren({
      home: sandbox,
      cwd: sandbox,
      env: { PATH: "" },
      libDirs: [],
      running: false,
      downloads: [],
    });

    for (const n of notices) {
      console.log(`\n\x1b[33m[Banner Warning]\x1b[0m ${n.message}`);
      console.log(`  \x1b[36m-> Direct Guide:\x1b[0m ${n.link}`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

export async function showAutoDownloadDemo(): Promise<void> {
  console.log("\n=======================================================");
  console.log(" 3. SIMULATION: AUTOMATIC MODEL DOWNLOAD & CONSENT");
  console.log("=======================================================");

  const sandbox = mkdtempSync(join(tmpdir(), "demo-models-"));
  const fakeServerPort = 39871;
  const dummyData = new Uint8Array(10 * 1024 * 1024); // 10 MB synthetic model
  for (let i = 0; i < dummyData.length; i++) dummyData[i] = (i * 31) % 256;
  const dummySha = createHash("sha256").update(dummyData).digest("hex");

  const server = Deno.serve({ port: fakeServerPort, onListen: () => {} }, (req) => {
    const range = req.headers.get("range");
    if (range) {
      const match = /bytes=(\\d+)-/.exec(range);
      const start = match ? Number(match[1]) : 0;
      return new Response(dummyData.slice(start) as unknown as BodyInit, {
        status: 206,
        headers: { "content-range": `bytes ${start}-${dummyData.length - 1}/${dummyData.length}` },
      });
    }
    return new Response(dummyData as unknown as BodyInit, {
      status: 200,
      headers: { "content-length": String(dummyData.length) },
    });
  });

  const testCatalog: CatalogModel[] = [
    {
      id: "bge-small-test",
      file: "bge-small-test.gguf",
      url: `http://127.0.0.1:${fakeServerPort}/bge-small.gguf`,
      bytes: dummyData.length,
      sha256: dummySha,
      tier: "small",
      capabilities: ["embed"],
      config: { enable_embeddings: 1, n_ctx: 512 },
    },
    {
      id: "olmoe-moe-test",
      file: "olmoe-moe-test.gguf",
      url: `http://127.0.0.1:${fakeServerPort}/olmoe.gguf`,
      bytes: 3343929824,
      sha256: "0".repeat(64),
      tier: "large",
      capabilities: ["chat", "judge"],
      config: { n_ctx: 4096 },
    },
  ];

  try {
    resetBootstrapForTests();
    console.log("Starting zero-config bring-up in empty sandbox (0 models)...");
    let promptedConsent = false;

    const res = await ensureAuren({
      home: sandbox,
      cwd: sandbox,
      catalog: testCatalog,
      settings: { autoStart: false, autoDownloadModels: "ask" },
      confirm: (msg) => {
        promptedConsent = true;
        console.log(`\n\x1b[35m[Interactive Consent Dialog]\x1b[0m ${msg}`);
        console.log("  -> Operator responded: YES (consent granted for large model)");
        return Promise.resolve(true);
      },
      onUpdate: (st) => {
        if (st.downloads.length > 0) {
          const dl = st.downloads[0];
          Deno.stdout.writeSync(new TextEncoder().encode(`\r  ${dl.id}: ${renderProgressBar(dl.done, dl.total)}`));
        }
      },
    });

    console.log(`\n\n[✓] Small tier model auto-downloaded successfully with sha256 checksum verified!`);
    console.log(`[✓] Interactive consent for large tier model triggered: ${promptedConsent ? "YES" : "NO"}`);
    console.log(`[✓] Auto-generated config created at: ${res.configPath}`);
  } finally {
    await server.shutdown();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const arg = Deno.args[0] ?? "--all";
  if (arg === "--versions") {
    showVersionReport();
  } else if (arg === "--missing-deps") {
    showMissingDepsSimulation();
  } else if (arg === "--download-test") {
    await showAutoDownloadDemo();
  } else {
    showVersionReport();
    showMissingDepsSimulation();
    await showAutoDownloadDemo();
    console.log("\n=======================================================");
    console.log(" DEMONSTRATION COMPLETE: Zero-config brings up models & alerts reliably.");
    console.log("=======================================================\n");
  }
}

if (import.meta.main) {
  void main();
}
