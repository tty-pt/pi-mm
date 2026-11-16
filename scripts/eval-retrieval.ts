#!/usr/bin/env -S deno run --allow-all --sloppy-imports
// Opt-in live retrieval evaluation against a real pi-mm store (NOT part of `npm test`).
//
//   deno run --allow-all --sloppy-imports scripts/eval-retrieval.ts [projectDir] [golden.json]
//
// Reports recall@5 and MRR for golden query -> expected-ref pairs. The golden file is a JSON
// array of { "query": string, "relevant": number[] }. Without a file, the built-in golden set
// below (captured from the site project's .pi/mm store, 2026-11-06) is used.
// Requires a running cormd for the store (started automatically by pi-mm sessions).
import { join } from "node:path";
import { readToolEnv } from "../src/tools/index.ts";
import { resolveMemDir } from "../src/tools/index.ts";
import { resolveSocketPath } from "../src/config.ts";
import { DaemonCormRunner } from "../src/daemon.ts";
import { executeHybridScan } from "../src/tools/scan.ts";

interface Golden { query: string; relevant: number[] }

const BUILTIN: Golden[] = [
  { query: "seven water realism", relevant: [40921, 40934, 40936, 41373, 41709] },
];

export function recallAtK(ranked: number[], relevant: number[], k: number): number {
  const top = new Set(ranked.slice(0, k));
  return relevant.length === 0 ? 0 : relevant.filter((r) => top.has(r)).length / relevant.length;
}

export function reciprocalRank(ranked: number[], relevant: number[]): number {
  const i = ranked.findIndex((r) => relevant.includes(r));
  return i < 0 ? 0 : 1 / (i + 1);
}

if (import.meta.main) {
  const project = Deno.args[0] ?? Deno.cwd();
  const golden: Golden[] = Deno.args[1] ? JSON.parse(await Deno.readTextFile(Deno.args[1])) : BUILTIN;
  const fallback = { run: () => Promise.resolve({ code: 1, stdout: "", stderr: "cormd not running" }) };
  const base = await readToolEnv(project, fallback);
  const sock = resolveSocketPath(base.cfg, resolveMemDir(project, base.cfg.memDir));
  const env = { ...base, runner: new DaemonCormRunner(sock, fallback) };
  let r5 = 0, mrr = 0;
  for (const g of golden) {
    const t0 = performance.now();
    const { records } = await executeHybridScan(env, { topic: g.query, embed: true, includeL0: true, limit: 10 });
    const ranked = records.map((r) => r.ref);
    const a = recallAtK(ranked, g.relevant, 5), b = reciprocalRank(ranked, g.relevant);
    r5 += a; mrr += b;
    console.log(`${JSON.stringify(g.query)}: recall@5=${a.toFixed(2)} RR=${b.toFixed(2)} ${(performance.now() - t0).toFixed(0)}ms ranked=${JSON.stringify(ranked)}`);
  }
  console.log(`mean recall@5=${(r5 / golden.length).toFixed(3)} MRR=${(mrr / golden.length).toFixed(3)} (n=${golden.length}, store=${join(project, ".pi/mm")})`);
}
