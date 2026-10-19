async function* walkTs(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkTs(p);
    else if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) yield p;
  }
}
const SRC = new URL("../src", import.meta.url).pathname;
const BUDGET_FILE_LOC = 350;
const BUDGET_FN_LOC = 80;
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
  if (loc > BUDGET_FILE_LOC) { console.error(`FAIL file ${short}: ${loc} LOC > ${BUDGET_FILE_LOC}`); failures++; }
  for (const fn of estimateFnSize(text)) if (fn.loc > BUDGET_FN_LOC) { console.error(`FAIL func ${fn.name} in ${short}: ${fn.loc} LOC > ${BUDGET_FN_LOC}`); failures++; }
}
if (failures > 0) { console.error(`complexity: ${failures} violation(s)`); Deno.exit(1); }
console.log("complexity: ok");
