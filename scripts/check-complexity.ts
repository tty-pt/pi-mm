async function* walkTs(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkTs(p);
    else if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.includes(".test.") && entry.name !== "vocab_base.ts") yield p;
  }
}
const SRC = new URL("../src", import.meta.url).pathname;
const DEFAULT_BUDGET_FILE_LOC = 350;
const DEFAULT_BUDGET_FN_LOC = 80;

// Subsystem architectural baselines for core kernel modules
const SUBSYSTEM_BUDGETS: Record<string, { file: number; fn: number }> = {
  "tools/consolidate.ts": { file: 2000, fn: 500 },
  "hooks/events.ts": { file: 2300, fn: 500 },
  "payload.ts": { file: 1400, fn: 500 },
  "daemon.ts": { file: 750, fn: 250 },
  "tools/consolidation_journal.ts": { file: 800, fn: 150 },
  "config.ts": { file: 1300, fn: 260 },
  "auren-bootstrap.ts": { file: 1000, fn: 120 },
  "hooks/auto_recall.ts": { file: 1150, fn: 250 },
  "hooks/reinforcement.ts": { file: 350, fn: 130 },
  "session/compaction.ts": { file: 350, fn: 150 },
  "session/store.ts": { file: 1350, fn: 800 },
  "session/recall.ts": { file: 500, fn: 300 },
  "session/manager.ts": { file: 480, fn: 160 },
  "session_history.ts": { file: 450, fn: 220 },
  "code/store.ts": { file: 750, fn: 680 },
  "code/scanner.ts": { file: 420, fn: 100 },
  "code/graph.ts": { file: 420, fn: 110 },
  "code/manager.ts": { file: 400, fn: 100 },
  "code/lore_binding.ts": { file: 400, fn: 100 },
  "code/diagnose.ts": { file: 400, fn: 100 },
  "napi_runner.ts": { file: 350, fn: 120 },
  "tools/scan.ts": { file: 350, fn: 120 },
  "tools/ranking.ts": { file: 350, fn: 110 },
  "tools/recall.ts": { file: 600, fn: 160 },
  "tools/index.ts": { file: 350, fn: 100 },
  "index.ts": { file: 420, fn: 220 },
  "judge/adapter.ts": { file: 350, fn: 100 },
  "synth/adapter.ts": { file: 350, fn: 100 },
};

function estimateFnSize(text: string): Array<{ name: string; loc: number }> {
  const lines = text.split("\n");
  const fns: Array<{ name: string; start: number }> = [];
  const re = /^\s*(export\s+)?(async\s+)?function\s+(\w+)|^\s*(export\s+)?(async\s+)?(const|let)\s+(\w+)\s*=\s*\(.*\)\s*=>/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) fns.push({ name: m[3] || m[7] || `anon@${i + 1}`, start: i });
  }
  return fns.map((f, idx) => ({ name: f.name, loc: (idx + 1 < fns.length ? fns[idx + 1].start : lines.length) - f.start }));
}
let failures = 0;
for await (const path of walkTs(SRC)) {
  const text = await Deno.readTextFile(path);
  const short = path.slice(SRC.length + 1);
  const loc = text.split("\n").length;
  const budget = SUBSYSTEM_BUDGETS[short] ?? { file: DEFAULT_BUDGET_FILE_LOC, fn: DEFAULT_BUDGET_FN_LOC };
  if (loc > budget.file) { console.error(`FAIL file ${short}: ${loc} LOC > ${budget.file}`); failures++; }
  for (const fn of estimateFnSize(text)) if (fn.loc > budget.fn) { console.error(`FAIL func ${fn.name} in ${short}: ${fn.loc} LOC > ${budget.fn}`); failures++; }
}
if (failures > 0) { console.error(`complexity: ${failures} violation(s)`); Deno.exit(1); }
console.log("complexity: ok");
