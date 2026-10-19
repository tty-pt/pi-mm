import type { PiExecResult, PiToolSpec } from "../src/hooks/events.ts";
import type { Invocation, QmapRunner } from "../src/qmap.ts";

export interface FakeRunner extends QmapRunner {
  invocations: Invocation[];
  results: PiExecResult[];
  set: (results: PiExecResult[]) => void;
  respond: (stdout: string, code?: number, stderr?: string) => void;
}

export function fakeRunner(initial?: PiExecResult[]): FakeRunner {
  const invocations: Invocation[] = [];
  const results: PiExecResult[] = [...(initial ?? [])];
  const runner = {
    invocations,
    results,
    set(value: PiExecResult[]): void {
      results.length = 0;
      results.push(...value);
    },
    respond(stdout: string, code = 0, stderr = ""): void {
      results.length = 0;
      results.push({ stdout, stderr, code });
    },
    run(invocation: Invocation): Promise<PiExecResult> {
      invocations.push(invocation);
      const next = results.shift();
      return Promise.resolve(next ?? { stdout: "", stderr: "", code: 0 });
    },
  };
  return runner;
}

export function okResult(stdout: string, stderr = ""): PiExecResult {
  return { stdout, stderr, code: 0 };
}

export function failResult(stdout: string, stderr: string, code = 1): PiExecResult {
  return { stdout, stderr, code };
}

export function fakePi(exec?: (command: string, args: string[]) => Promise<PiExecResult>) {
  const tools: PiToolSpec[] = [];
  return {
    tools,
    on(): void {},
    registerTool(tool: PiToolSpec): void { tools.push(tool); },
    exec: exec ?? (() => Promise.resolve({ stdout: "", stderr: "", code: 0 })),
  };
}

export function runTool(
  tool: PiToolSpec,
  params: Record<string, unknown>,
  ctx: { cwd: string },
): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }> {
  const cwd = ctx.cwd;
  return tool.execute("", params, undefined, undefined, { cwd, hasUI: false, mode: "test" });
}