import { toISODate, levelWindow } from "../src/window.ts";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function date(s: string): Date {
  return new Date(`${s}T12:00:00`);
}

Deno.test("toISODate: local date formatting pads", () => {
  check(toISODate(date("2026-09-05")) === "2026-09-05", "padded day");
  check(toISODate(date("2026-11-15")) === "2026-11-15", "padded month");
  check(toISODate(date("2026-12-31")) === "2026-12-31", "plain");
});

Deno.test("levelWindow: level 0 → null (omit joint leaf)", () => {
  check(levelWindow(0, date("2026-09-15")) === null, "level 0 omits joint");
});

Deno.test("levelWindow: level 1 → today..tomorrow bounded window", () => {
  const w = levelWindow(1, date("2026-09-15"));
  check(w !== null && w.a === "2026-09-15" && w.b === "2026-09-16", "today..tomorrow");
});

Deno.test("levelWindow: level 2 → month..next month", () => {
  const w = levelWindow(2, date("2026-09-15"));
  check(w !== null && w.a === "2026-09-01" && w.b === "2026-10-01", "month..next month");
});

Deno.test("levelWindow: level 2 crosses year boundary", () => {
  const w = levelWindow(2, date("2026-12-15"));
  check(w !== null && w.a === "2026-12-01" && w.b === "2027-01-01", "year rollover");
});

Deno.test("levelWindow: level 2 in January", () => {
  const w = levelWindow(2, date("2026-01-15"));
  check(w !== null && w.a === "2026-01-01" && w.b === "2026-02-01", "january month");
});

Deno.test("levelWindow: invalid levels → null", () => {
  check(levelWindow(3, date("2026-09-15")) === null, "level 3 invalid");
  check(levelWindow(-1, date("2026-09-15")) === null, "negative invalid");
});