import { isNumericRef, parseBareRefs, nextRef } from "../src/resolve.ts";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("parseBareRefs: picks bare numeric lines, skips score lines and sentinels", () => {
  const out = "1\n3\n2\n1 0.125000 2026-09-13T20:00:00:Beacon Harbor lights\n-1\n \n";
  const refs = parseBareRefs(out);
  check(refs.join(",") === "1,3,2", `bare numeric kept in order; got ${refs.join(",")}`);
});

Deno.test("parseBareRefs: empty input", () => {
  check(parseBareRefs("").length === 0, "empty stdout → none");
  check(parseBareRefs("   \n-1\n").length === 0, "whitespace + sentinel elided");
});

Deno.test("parseBareRefs: sentinel -1 never counted even when alone", () => {
  check(parseBareRefs("-1\n").length === 0, "-1 sentinel skipped");
});

Deno.test("nextRef: max+1, empty → 1", () => {
  check(nextRef([]) === 1, "empty → 1");
  check(nextRef([1, 3]) === 4, "max+1");
  check(nextRef([5]) === 6, "single");
  check(nextRef([1, 1, 2]) === 3, "duplicates tolerated");
});

Deno.test("isNumericRef: numeric strings only", () => {
  check(isNumericRef("1"), "small positive");
  check(isNumericRef("0"), "zero is a ref-shaped number");
  check(!isNumericRef("-1"), "negative is a sentinel, not a ref");
  check(!isNumericRef("beacon"), "text is not a ref");
  check(!isNumericRef("1.0"), "float is not a ref");
  check(!isNumericRef(""), "empty is not a ref");
});