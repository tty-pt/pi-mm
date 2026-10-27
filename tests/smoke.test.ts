import install from "../index.ts";
import type { Pi, PiToolSpec } from "../src/hooks/events.ts";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function fakePi(): Pi & { tools: PiToolSpec[] } {
  const tools: PiToolSpec[] = [];
  const pi = {
    tools,
    on(): void {},
    appendEntry(): void {},
    registerTool(tool: PiToolSpec): void { tools.push(tool); },
    exec(): Promise<{ stdout: string; stderr: string; code: number }> {
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };
  return pi as Pi & { tools: PiToolSpec[] };
}

Deno.test("manifest declares the pi extension entry point", async () => {
  const raw = await Deno.readTextFile(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(raw);
  const exts: unknown = pkg?.pi?.extensions;
  check(Array.isArray(exts) && exts.includes("index.ts"), "pi.extensions must include index.ts");
});

Deno.test("manifest declares the pi-mm skill", async () => {
  const raw = await Deno.readTextFile(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(raw);
  const skills: unknown = pkg?.pi?.skills;
  check(Array.isArray(skills) && skills.includes("skills/pi-mm/SKILL.md"), "pi.skills must include skills/pi-mm/SKILL.md");
});

Deno.test("entry default-exports an installer function", () => {
  check(typeof install === "function", "default export must be a function");
});

Deno.test("installer registers primary workflow tools by default", () => {
  const api = fakePi();
  install(api);
  const names = api.tools.map((t) => t.name);
  const expectedPrimary = ["memory_recall", "memory_record", "memory_review"];
  for (const expected of expectedPrimary) {
    check(names.includes(expected), `expected tool ${expected}; got ${names.join(", ")}`);
  }
  check(names.length === 3, `expected exactly 3 primary tools by default, got ${names.length}`);
});

Deno.test("installer registers all 12 tools when advancedTools is enabled", () => {
  const api = fakePi();
  Deno.env.set("PI_MM_ADVANCED_TOOLS", "true");
  try {
    install(api);
    const names = api.tools.map((t) => t.name);
    const expectedAll = [
      "memory_recall",
      "memory_record",
      "memory_review",
      "memory_store",
      "memory_scan",
      "memory_think",
      "memory_forget",
      "memory_reset",
      "memory_traverse",
      "memory_consolidate",
      "memory_lifecycle",
      "memory_feedback",
    ];
    for (const expected of expectedAll) {
      check(names.includes(expected), `expected tool ${expected}; got ${names.join(", ")}`);
    }
    check(names.length === 12, `expected exactly 12 tools registered, got ${names.length}`);
  } finally {
    Deno.env.delete("PI_MM_ADVANCED_TOOLS");
  }
});

Deno.test("installer registers mm-report entry renderer and dispatches via /mm doctor", async () => {
  let registeredRendererType: string | null = null;
  // deno-lint-ignore no-explicit-any
  let registeredRendererFn: any = null;
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const appendedEntries: { type: string; data: unknown }[] = [];

  const fakeFullPi = {
    ...fakePi(),
    registerEntryRenderer(type: string, renderer: unknown) {
      registeredRendererType = type;
      registeredRendererFn = renderer;
    },
    registerCommand(name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, spec);
    },
    appendEntry(type: string, data: unknown) {
      appendedEntries.push({ type, data });
    },
  };

  // deno-lint-ignore no-explicit-any
  install(fakeFullPi as any);

  // 1. Verify renderer registration
  check(registeredRendererType === "mm-report", "must register 'mm-report' entry renderer");
  check(typeof registeredRendererFn === "function", "renderer function must be provided");

  // 2. Verify command registration
  check(commands.has("mm"), "must register '/mm' slash command");

  // 3. Execute /mm doctor
  const cmd = commands.get("mm")!;
  await cmd.handler("doctor", { cwd: "." });

  check(appendedEntries.length === 1, "must append exactly one entry for /mm doctor");
  check(appendedEntries[0].type === "mm-report", "appended entry type must be 'mm-report'");
  // deno-lint-ignore no-explicit-any
  const data = appendedEntries[0].data as any;
  check(data.title.includes("Doctor"), "report title must mention Doctor");
  check(Array.isArray(data.lines) && data.lines.length >= 3, "report must include status lines");

  // 4. Test createMmReportComponent formatting
  const comp = registeredRendererFn({ data }, {}, {
    fg: (_color: string, text: string) => `[STYLE]${text}[/STYLE]`,
    bold: (text: string) => `[BOLD]${text}[/BOLD]`,
  });
  const lines = comp.render(80);
  check(lines.length > 5, "component must render styled lines");
  check(lines[0].includes("─"), "must include top border");
  check(lines[lines.length - 1].includes("─"), "must include bottom border");
});

Deno.test("/mm doctor accurately counts indexed records using corm list", async () => {
  const appendedEntries: { type: string; data: unknown }[] = [];
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();

  // Mock runner that returns 3 records on corm list
  const fakePiInstance = {
    ...fakePi(),
    registerEntryRenderer() {},
    registerCommand(name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, spec);
    },
    appendEntry(type: string, data: unknown) {
      appendedEntries.push({ type, data });
    },
    exec(_command: string, args: string[]) {
      if (args.includes("-g") && args.includes(".")) {
        return Promise.resolve({ stdout: "101\n102\n103\n", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  // deno-lint-ignore no-explicit-any
  install(fakePiInstance as any);
  const cmd = commands.get("mm")!;

  // Use a temporary test directory with a mock mem.db
  const tmpDir = await Deno.makeTempDir({ prefix: "fake-mm-doctor-test-" });
  try {
    const memDir = `${tmpDir}/.pi/mm`;
    await Deno.mkdir(memDir, { recursive: true });
    await Deno.writeTextFile(`${memDir}/mem.db`, "mock-db-bytes");
    await Deno.writeTextFile(`${memDir}/mem.db.roster`, "mock-binary-roster");

    await cmd.handler("doctor", { cwd: tmpDir });

    check(appendedEntries.length === 1, "must append doctor report entry");
    // deno-lint-ignore no-explicit-any
    const data = appendedEntries[0].data as any;
    const countLine = data.lines.find((l: string) => l.includes("Total Indexed Records"));
    check(Boolean(countLine), "must report Total Indexed Records");
    check(countLine.includes("3"), `must report exactly 3 records, got: ${countLine}`);

    const rosterLine = data.lines.find((l: string) => l.includes("Bound Axes"));
    check(Boolean(rosterLine), "must report Bound Axes line");
    check(rosterLine.includes("Bound Axes"), `must report Bound Axes line, got: ${rosterLine}`);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});