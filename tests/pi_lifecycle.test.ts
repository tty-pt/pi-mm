import assert from "node:assert";
import install from "../index.ts";
import type { Pi, PiToolSpec, PiExecResult } from "../src/hooks/events.ts";

function fakePiRuntime(runnerResults: PiExecResult[]): {
  pi: Pi;
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  tools: PiToolSpec[];
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools: PiToolSpec[] = [];
  let idx = 0;

  const pi: Pi = {
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: PiToolSpec): void {
      tools.push(tool);
    },
    exec(_cmd: string, _args: string[]): Promise<PiExecResult> {
      if (idx < runnerResults.length) {
        return Promise.resolve(runnerResults[idx++]);
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  return { pi, handlers, tools };
}

Deno.test("pi_lifecycle: extension registers lifecycle hooks and tools", () => {
  const { pi, handlers, tools } = fakePiRuntime([]);
  install(pi);

  // Assert lifecycle hooks are registered
  assert.ok(handlers.has("session_start"), "session_start hook must be registered");
  assert.ok(handlers.has("tool_result"), "tool_result hook must be registered");
  assert.ok(handlers.has("agent_settled"), "agent_settled hook must be registered");
  assert.ok(handlers.has("turn_end"), "turn_end hook must be registered");
  assert.ok(handlers.has("before_agent_start"), "before_agent_start hook must be registered");

  // Assert primary workflow tools are registered
  const toolNames = tools.map((t) => t.name);
  assert.ok(toolNames.includes("memory_recall"));
  assert.ok(toolNames.includes("memory_record"));
  assert.ok(toolNames.includes("memory_review"));
});

Deno.test("pi_lifecycle: before_agent_start hook executes and injects context", async () => {
  const fakeHit = "1 0.5 2026-03-30:" + JSON.stringify({
    level: "L2",
    type: "invariant",
    lifecycle: "supported",
    summary: "Always check corm_open handle aliasing",
  }) + "\n";

  const { pi, handlers } = fakePiRuntime([{ stdout: fakeHit, stderr: "", code: 0 }]);
  install(pi);

  const beforeStartHandlers = handlers.get("before_agent_start") ?? [];
  assert.ok(beforeStartHandlers.length > 0, "before_agent_start handler must exist");

  const ctx = { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" };
  const event = { messageType: "user", prompt: "Fix the corm_open leak" };

  const result = await (beforeStartHandlers[0](event, ctx) as Promise<unknown>);
  assert.ok(result);
  const msgResult = result as { message?: { customType: string; content: string } };
  assert.strictEqual(msgResult.message?.customType, "memory_context");
  assert.ok(msgResult.message?.content.includes("Always check corm_open handle aliasing"));
});
