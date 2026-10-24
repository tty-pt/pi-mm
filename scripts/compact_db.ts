import { loadConfig, resolveCormBin, resolveAxisPath } from "../src/config.ts";
import { DaemonCormRunner } from "../src/daemon.ts";
import { ShellCormRunner, buildListInvocation, buildGetInvocation, buildStoreInvocation, filespecFor, embedEnv } from "../src/corm.ts";
import { decodePayload, encodePayload } from "../src/payload.ts";
import { withLock } from "../src/lock.ts";
import { join, isAbsolute } from "node:path";

async function compactDatabase() {
  const cwd = Deno.cwd();
  const settingsPath = join(cwd, ".pi", "settings.json");
  let rawMm: Record<string, unknown> = {};
  try {
    const rawText = await Deno.readTextFile(settingsPath);
    const raw = JSON.parse(rawText);
    rawMm = (raw && typeof raw === "object" && (raw["pi-mm"] || raw["mm"])) || {};
  } catch {
    /* ignore fallback defaults */
  }

  const rawMemDir = (rawMm["memDir"] as string | undefined) || join(cwd, ".pi", "mm");
  const memDir = isAbsolute(rawMemDir) ? rawMemDir : join(cwd, rawMemDir);

  const cfg = loadConfig({
    memDir,
    ...rawMm,
  });

  const pathDirs = (Deno.env.get("PATH") || "").split(":");
  const resolved = resolveCormBin(cfg, cwd, pathDirs, (p) => {
    try {
      return Deno.statSync(p).isFile;
    } catch {
      return false;
    }
  });
  const cormBin = resolved.path || cfg.cormBin || "corm";
  const axes = resolveAxisPath(cfg, cwd);

  const sockPath = join(memDir, "cormd.sock");
  const fallback = new ShellCormRunner(async (cmd, args, options) => {
    const p = new Deno.Command(cmd, {
      args,
      cwd: options?.cwd,
      env: options?.env,
      stdin: options?.stdin ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    });
    let out;
    if (options?.stdin) {
      const child = p.spawn();
      const w = child.stdin.getWriter();
      await w.write(options.stdin);
      await w.close();
      out = await child.output();
    } else {
      out = await p.output();
    }
    const dec = new TextDecoder();
    return {
      stdout: dec.decode(out.stdout),
      stderr: dec.decode(out.stderr),
      code: out.code,
    };
  });

  const runner = new DaemonCormRunner(sockPath, fallback, 5000);
  const fspec = filespecFor(memDir, false);
  const eEnv = embedEnv(cfg);

  console.log(`[compact_db] Connecting via ${sockPath}...`);
  const listRes = await runner.run(buildListInvocation(cormBin, fspec, axes, memDir, eEnv));
  if (listRes.code !== 0) {
    console.error(`[compact_db] Failed to list records: ${listRes.stderr}`);
    Deno.exit(1);
  }

  const refs = listRes.stdout
    .trim()
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));

  console.log(`[compact_db] Found ${refs.length} records in ${memDir}/mem.db.`);

  let beforeBytes = 0;
  let afterBytes = 0;
  let beforeNulls = 0;
  let afterNulls = 0;
  let updatedCount = 0;
  let diffsStripped = 0;

  await withLock(memDir, async () => {
    for (const ref of refs) {
      const getRes = await runner.run(buildGetInvocation(cormBin, fspec, ref, axes, memDir, eEnv));
      if (getRes.code !== 0 || !getRes.stdout.trim()) continue;

      const raw = getRes.stdout.trim();
      beforeBytes += raw.length;
      for (let i = 0; i < raw.length; i++) {
        if (raw.charCodeAt(i) === 0) beforeNulls++;
      }

      const decoded = decodePayload(raw);

      // Section 3.5: Strip heavy debug diffs from superseded L0/L1 records
      if (decoded.envelope.lifecycle === "superseded" && decoded.envelope.episode?.diffs) {
        decoded.envelope.episode.diffs = undefined;
        diffsStripped++;
      }

      // Re-encode into HTOK v4 format
      const compacted = encodePayload(decoded.date, decoded.envelope);
      const compactedBytes = typeof compacted === "string" ? new TextEncoder().encode(compacted) : compacted;
      afterBytes += compactedBytes.length;
      for (let i = 0; i < compactedBytes.length; i++) {
        if (compactedBytes[i] === 0) afterNulls++;
      }

      const storeRes = await runner.run(buildStoreInvocation(cormBin, fspec, ref, compacted, axes, memDir, eEnv));
      if (storeRes.code === 0) {
        updatedCount++;
      }
    }
  });

  const savedBytes = beforeBytes - afterBytes;
  const pctReduction = beforeBytes > 0 ? ((savedBytes / beforeBytes) * 100).toFixed(1) : "0.0";
  const nullReduction = beforeNulls > 0 ? (((beforeNulls - afterNulls) / beforeNulls) * 100).toFixed(1) : "0.0";

  console.log(`\n=== Compaction Summary ===`);
  console.log(`Records processed: ${refs.length}`);
  console.log(`Records updated to HTOK v4: ${updatedCount}`);
  console.log(`Superseded records with diffs stripped: ${diffsStripped}`);
  console.log(`Before total payload: ${(beforeBytes / 1024).toFixed(1)} KB (nulls: ${beforeNulls})`);
  console.log(`After total payload: ${(afterBytes / 1024).toFixed(1)} KB (nulls: ${afterNulls})`);
  console.log(`Payload Size Saved: ${(savedBytes / 1024).toFixed(1)} KB (${pctReduction}% reduction)`);
  console.log(`Payload Null Byte Reduction: ${nullReduction}%`);
}

if (import.meta.main) {
  await compactDatabase();
}
