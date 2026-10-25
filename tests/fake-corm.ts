import type { PiExecResult, PiToolSpec } from "../src/hooks/events.ts";
import type { Invocation, CormRunner } from "../src/corm.ts";
import { bytesToBinaryString } from "../src/payload.ts";

export interface FakeRunner extends CormRunner {
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

export function okResult(stdout: string | Uint8Array): PiExecResult {
  if (stdout instanceof Uint8Array) {
    return { stdout: bytesToBinaryString(stdout), stderr: "", code: 0, stdoutBytes: stdout };
  }
  return { stdout, stderr: "", code: 0 };
}

export async function runTool(
  tool: PiToolSpec,
  params: Record<string, unknown>,
  ctx: { cwd: string; hasUI?: boolean; mode?: string } | import("../src/hooks/events.ts").PiCtx,
): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }> {
  return await tool.execute(
    "call-1",
    params,
    undefined,
    () => {},
    ctx as import("../src/hooks/events.ts").PiCtx,
  );
}
