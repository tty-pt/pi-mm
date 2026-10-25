#!/usr/bin/env -S deno run --allow-all --sloppy-imports
/**
 * scripts/test-real-embedding.ts
 *
 * Opt-in Real Native Embedding Retrieval Smoke Test
 * Uses actual libcorm binary and libsepal.so meaning axis against a live configured embedding endpoint.
 *
 * Reports:
 *   - PASS: when live endpoint is configured, reachable, and correctly performs semantic retrieval.
 *   - SKIPPED: when live endpoint is unconfigured or unreachable (truthful reporting, never falsified).
 */

import { executeHybridScan } from "../src/tools/scan.ts";
import { makeStoreTool } from "../src/tools/store.ts";
import { give, type ToolEnv } from "../src/tools/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

export async function runRealEmbeddingSmokeTest(_siteRoot?: string): Promise<{ status: "PASS" | "SKIPPED" | "FAIL"; reason?: string }> {
  console.log("=== Real Native Embedding Integration Smoke Test ===");

  const home = Deno.env.get("HOME") || "";
  const cormBin = "/usr/bin/corm";
  const sepalLib = "/usr/lib/libsepal.so";
  const jointLib = "/usr/lib/libjoint.so";
  const lemmaLib = `${home}/.local/lib/liblemma.so`;

  try {
    for (const f of [cormBin, sepalLib, jointLib, lemmaLib]) {
      const st = await Deno.stat(f);
      if (!st.isFile) throw new Error(`${f} is not a file`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Status: SKIPPED (Required native C binaries/libraries unavailable: ${msg})`);
    return { status: "SKIPPED", reason: msg };
  }

  const embedUrl = Deno.env.get("CORM_SEPAL_EMBED_URL");
  const embedModel = Deno.env.get("CORM_SEPAL_EMBED_MODEL") || "nomic-embed-text";

  if (!embedUrl) {
    console.log("Status: SKIPPED (Real embedding endpoint not configured: CORM_SEPAL_EMBED_URL unset)");
    console.log("Note: Set CORM_SEPAL_EMBED_URL and CORM_SEPAL_EMBED_MODEL to run live semantic tests.");
    return { status: "SKIPPED", reason: "unconfigured" };
  }

  // Probe endpoint connectivity with a 1500ms timeout
  try {
    const probe = await fetch(embedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "test", model: embedModel }),
      signal: AbortSignal.timeout(1500),
    });
    if (!probe.ok && probe.status !== 400) {
      console.log(`Status: SKIPPED (Embedding endpoint returned HTTP ${probe.status})`);
      return { status: "SKIPPED", reason: `HTTP ${probe.status}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Status: SKIPPED (Embedding endpoint probe failed: ${msg})`);
    return { status: "SKIPPED", reason: msg };
  }

  // Execute real live embedding smoke test
  const tmpDir = await Deno.makeTempDir({ prefix: "mm-real-embed-" });
  try {
    const axisLibs = `${home}/.local/lib:/usr/local/lib:/usr/lib`;
    const ctx = { cwd: tmpDir, hasUI: false, mode: "agent" };

    const env: ToolEnv = {
      cwd: tmpDir,
      runner: {
        run: async (inv) => {
          const p = new Deno.Command(inv.command, {
            args: inv.args,
            cwd: inv.cwd ?? tmpDir,
            env: inv.env ?? {},
            stdout: "piped",
            stderr: "piped",
          });
          const out = await p.output();
          return {
            code: out.code,
            stdout: new TextDecoder().decode(out.stdout),
            stderr: new TextDecoder().decode(out.stderr),
          };
        },
      },
      nowProvider: () => new Date("2026-10-15T12:00:00Z"),
      cfg: {
        ...DEFAULT_CONFIG,
        cormBin,
        axisLibs,
        memDir: tmpDir,
        embedUrl,
        embedModel,
      },
    };

    const storeTool = makeStoreTool(give(env));

    // Store records using real libsepal embedding axis
    await storeTool.execute("store_1", {
      summary: "Investigation into descriptor exhaustion leak in corm_open",
      level: "L0",
      type: "episode",
      lifecycle: "supported",
      timestamp: "2026-10-15",
    }, undefined, undefined, ctx);

    await storeTool.execute("store_2", {
      summary: "ANSI terminal cursor jump rendering glitch in axil-nd",
      level: "L0",
      type: "episode",
      lifecycle: "supported",
      timestamp: "2026-10-15",
    }, undefined, undefined, ctx);

    // Paraphrased query with low lexical overlap
    const { records } = await executeHybridScan(env, {
      topic: "leaking file handles when reopening databases",
      embed: true,
      limit: 3,
    });

    if (records.length === 0) {
      console.log("Status: FAIL (No records retrieved via live semantic search)");
      return { status: "FAIL", reason: "no-records" };
    }

    const top = records[0];
    if (top.ref !== 1) {
      console.log(`Status: FAIL (Expected Ref 1, got Ref ${top.ref})`);
      return { status: "FAIL", reason: "mismatched-target" };
    }

    // Also verify that lexical-only search still operates when embeddings are disabled
    const { records: lexRecords } = await executeHybridScan(env, {
      topic: "corm_open",
      embed: false,
      limit: 3,
    });

    const lexOk = lexRecords.some((r) => r.ref === 1);
    if (!lexOk) {
      console.log("Status: FAIL (Lexical-only fallback failed to locate exact keyword)");
      return { status: "FAIL", reason: "lexical-fallback-failed" };
    }

    console.log(`Status: PASS (Ref ${top.ref} retrieved with origin "${top.origin}")`);
    console.log("Verified: Real embedding generation, vector indexing, cosine search, and lexical fallback.");
    return { status: "PASS" };
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

if (import.meta.main) {
  const siteRoot = (() => {
    const cwd = Deno.cwd();
    if (cwd.includes(".pi/extensions/pi-mm")) {
      return cwd.split(".pi/extensions/pi-mm")[0].replace(/\/$/, "");
    }
    return cwd;
  })();
  const result = await runRealEmbeddingSmokeTest(siteRoot);
  if (result.status === "FAIL") {
    Deno.exit(1);
  }
}
