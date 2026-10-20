import { loadConfig } from "../src/config.ts";
import { DaemonQmapRunner } from "../src/daemon.ts";
import { ShellQmapRunner, buildListInvocation, buildGetInvocation, buildStoreInvocation, filespecFor, embedEnv } from "../src/qmap.ts";
import { decodePayload, encodePayload } from "../src/payload.ts";
import { withLock } from "../src/lock.ts";

async function compactDatabase() {
  const settingsPath = "/home/quirinpa/site/.pi/settings.json";
  let rawMm = {};
  try {
    const raw = JSON.parse(await Deno.readTextFile(settingsPath));
    rawMm = raw["pi-mm"] || {};
  } catch {
    /* ignore fallback defaults */
  }

  const cfg = loadConfig({
    qmapBin: "/usr/bin/corm",
    memDir: "/home/quirinpa/site/.pi/mm",
    ...rawMm,
  });

  const sockPath = `${cfg.memDir}/cormd.sock`;
  const fallback = new ShellQmapRunner(() => Promise.resolve({ stdout: "", stderr: "no fallback", code: 1 }));
  const runner = new DaemonQmapRunner(sockPath, fallback, 5000);
  const fspec = filespecFor(cfg.memDir, false);
  const axes = "/usr/lib:/usr/local/lib";
  const eEnv = embedEnv(cfg);

  console.log(`[compact_db] Connecting to ${sockPath}...`);
  const listRes = await runner.run(buildListInvocation(cfg.qmapBin, fspec, axes, cfg.memDir, eEnv));
  if (listRes.code !== 0) {
    console.error(`[compact_db] Failed to list records: ${listRes.stderr}`);
    Deno.exit(1);
  }

  const refs = listRes.stdout
    .trim()
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));

  console.log(`[compact_db] Found ${refs.length} records in ${cfg.memDir}/mem.db.`);

  let beforeBytes = 0;
  let afterBytes = 0;
  let updatedCount = 0;

  await withLock(cfg.memDir, async () => {
    for (const ref of refs) {
      const getRes = await runner.run(buildGetInvocation(cfg.qmapBin, fspec, ref, axes, cfg.memDir, eEnv));
      if (getRes.code !== 0 || !getRes.stdout.trim()) continue;

      const raw = getRes.stdout.trim();
      beforeBytes += raw.length;

      const decoded = decodePayload(raw);
      const compacted = encodePayload(decoded.date, decoded.envelope);
      afterBytes += compacted.length;

      if (compacted !== raw) {
        const storeRes = await runner.run(buildStoreInvocation(cfg.qmapBin, fspec, ref, compacted, axes, cfg.memDir, eEnv));
        if (storeRes.code === 0) {
          updatedCount++;
        }
      }
    }
  });

  const savedBytes = beforeBytes - afterBytes;
  const pctReduction = beforeBytes > 0 ? ((savedBytes / beforeBytes) * 100).toFixed(1) : "0.0";

  console.log(`\n=== Compaction Summary ===`);
  console.log(`Records processed: ${refs.length}`);
  console.log(`Records updated: ${updatedCount}`);
  console.log(`Before total payload: ${(beforeBytes / 1024).toFixed(1)} KB`);
  console.log(`After total payload: ${(afterBytes / 1024).toFixed(1)} KB`);
  console.log(`Saved: ${(savedBytes / 1024).toFixed(1)} KB (${pctReduction}% reduction)`);
}

if (import.meta.main) {
  await compactDatabase();
}
