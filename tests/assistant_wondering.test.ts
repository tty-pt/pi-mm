import assert from "node:assert";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { WONDERING_EXEMPLARS, WONDERING_KINDS } from "../src/judge/wondering-exemplars.ts";
import { evaluateAssistantWondering, extractAssistantThoughtsAndText } from "../src/hooks/wondering.ts";
import { registerHooks, type Pi, type PiCtx } from "../src/hooks/events.ts";
import type { ToolEnv } from "../src/tools/index.ts";
import type { CormRunner } from "../src/corm.ts";

Deno.test("wondering: exemplars are bilingual, non-empty, and kinds are defined", () => {
  assert.ok(WONDERING_KINDS.has("wondering"));
  assert.ok(WONDERING_KINDS.has("routine_action"));
  assert.strictEqual(WONDERING_KINDS.size, 2);

  const wonderList = WONDERING_EXEMPLARS["wondering"] ?? [];
  const actionList = WONDERING_EXEMPLARS["routine_action"] ?? [];
  assert.ok(wonderList.length >= 10, "wondering exemplars must have >= 10 entries");
  assert.ok(actionList.length >= 10, "routine_action exemplars must have >= 10 entries");

  assert.ok(wonderList.some((e) => /caching|FTS|corm_open|session/i.test(e)));
  assert.ok(wonderList.some((e) => /como|funciona|certeza/i.test(e)));
});

Deno.test("wondering: extractAssistantThoughtsAndText extracts text and thinking blocks", () => {
  const msg1 = {
    role: "assistant",
    content: [
      { type: "thinking", text: "I wonder how the caching layer works in this project" },
      { type: "text", text: "Let me check the implementation." },
    ],
  };
  const extracted1 = extractAssistantThoughtsAndText(msg1.content);
  assert.ok(extracted1.includes("caching layer works"));
  assert.ok(extracted1.includes("check the implementation"));

  const msg2 = {
    role: "assistant",
    content: "I am wondering where the database is stored.",
  };
  const extracted2 = extractAssistantThoughtsAndText(msg2.content);
  assert.strictEqual(extracted2, "I am wondering where the database is stored.");
});

Deno.test("wondering: evaluateAssistantWondering classifies cognitive wondering via mock endpoint", async () => {
  const mockFetch: typeof fetch = (_input, init) => {
    return (async () => {
      let bodyText = "";
      if (init?.body && typeof init.body === "string") {
        try {
          const json = JSON.parse(init.body);
          bodyText = json.text ?? "";
        } catch { /* ignore */ }
      }
      const isWondering = bodyText.includes("wonder") || bodyText.includes("how does") || bodyText.includes("not sure") || bodyText.includes("caching");
      return new Response(JSON.stringify({
        choice: isWondering ? "wondering" : "routine_action",
        similarity: isWondering ? 0.92 : 0.45,
        margin: isWondering ? 0.30 : 0.05,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    })();
  };

  const cfg: MmConfig = {
    ...DEFAULT_CONFIG,
    wonderingEmbed: "auto",
    captureEmbedUrl: "http://127.0.0.1:4242",
  };

  const isWonder1 = await evaluateAssistantWondering(
    "I wonder how the caching layer works in this project",
    cfg,
    mockFetch,
  );
  assert.strictEqual(isWonder1, true, "Wondering statement must be classified as true");

  const isWonder2 = await evaluateAssistantWondering(
    "I will now edit file src/main.c and run make",
    cfg,
    mockFetch,
  );
  assert.strictEqual(isWonder2, false, "Routine action must be classified as false");
});

Deno.test("wondering: message_end steers agent with epistemic hint on wondering without DB queries", async () => {
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();

  const fakePi: Pi = {
    on: (event: string, handler: (event: unknown, ctx?: unknown) => void) => {
      handlers.set(event, handler);
    },
    registerTool: () => {},
    exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    sendMessage: (msg: unknown, opts?: unknown) => {
      sentMessages.push({ message: msg, options: opts });
    },
  };

  let scanCalls = 0;
  const runner: CormRunner = {
    run: (_inv: unknown) => {
      scanCalls++;
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };

  const mockFetch: typeof fetch = (_input, init) => {
    return (async () => {
      let bodyText = "";
      if (init?.body && typeof init.body === "string") {
        try {
          const json = JSON.parse(init.body);
          bodyText = json.text ?? "";
        } catch { /* ignore */ }
      }
      const isWondering = bodyText.includes("wonder") || bodyText.includes("caching");
      return new Response(JSON.stringify({
        choice: isWondering ? "wondering" : "routine_action",
        similarity: isWondering ? 0.94 : 0.45,
        margin: isWondering ? 0.32 : 0.05,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    })();
  };

  const env: ToolEnv = {
    cwd: "/tmp/fake-cwd",
    runner,
    nowProvider: () => new Date("2026-10-16"),
    cfg: {
      ...DEFAULT_CONFIG,
      memDir: ".pi/mm",
      cormBin: "/usr/bin/corm",
      wonderingEmbed: "auto",
      captureEmbedUrl: "http://127.0.0.1:4242",
    },
  };

  const ctx: PiCtx = {
    cwd: "/tmp/fake-cwd",
    hasUI: false,
    mode: "headless",
  };

  registerHooks(fakePi, () => Promise.resolve(env), { fetchFn: mockFetch });

  // Simulate assistant emitting an exploratory wonder
  const messageEndHandler = handlers.get("message_end");
  assert.ok(messageEndHandler, "message_end handler must be registered");

  const assistantEvent = {
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "I wonder how the caching layer works in this project" },
      ],
    },
  };

  await messageEndHandler(assistantEvent, ctx);

  // Assert steering message was sent
  assert.ok(sentMessages.length >= 1, "Must steer agent when wondering is detected");
  const steer = sentMessages[0];
  assert.strictEqual((steer?.options as any)?.deliverAs, "steer");
  assert.ok((steer?.message as any)?.content?.includes("memory_recall"));
  assert.ok((steer?.message as any)?.content?.includes("Memory Hint"));

  // Assert zero database queries were executed
  assert.strictEqual(scanCalls, 0, "Must execute zero database scans when steering wondering agent");
});

Deno.test("wondering: message_end does not steer on routine action", async () => {
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();

  const fakePi: Pi = {
    on: (event: string, handler: (event: unknown, ctx?: unknown) => void) => {
      handlers.set(event, handler);
    },
    registerTool: () => {},
    exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    sendMessage: (msg: unknown, opts?: unknown) => {
      sentMessages.push({ message: msg, options: opts });
    },
  };

  const mockFetch: typeof fetch = (input) => {
    return (async () => {
      return new Response(JSON.stringify({
        choice: "routine_action",
        similarity: 0.90,
        margin: 0.25,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    })();
  };

  const env: ToolEnv = {
    cwd: "/tmp/fake-cwd",
    runner: { run: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }) },
    nowProvider: () => new Date("2026-10-16"),
    cfg: {
      ...DEFAULT_CONFIG,
      memDir: ".pi/mm",
      cormBin: "/usr/bin/corm",
      wonderingEmbed: "auto",
      captureEmbedUrl: "http://127.0.0.1:4242",
    },
  };

  registerHooks(fakePi, () => Promise.resolve(env), { fetchFn: mockFetch });

  const messageEndHandler = handlers.get("message_end");
  assert.ok(messageEndHandler);

  const routineEvent = {
    message: {
      role: "assistant",
      content: "I will now edit file src/main.c and run make test.",
    },
  };

  await messageEndHandler(routineEvent, { cwd: "/tmp/fake-cwd", hasUI: false, mode: "headless" });

  // Assert no steering message sent
  assert.strictEqual(sentMessages.length, 0, "Routine action must not trigger steering message");
});
