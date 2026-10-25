import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type PiCtx,
} from "../src/hooks/events.ts";
import {
  handleBeforeAgentStart,
  buildInjectedContext,
  enrichCandidatesWithSessionHistory,
} from "../src/hooks/auto_recall.ts";
import {
  resolveSessionFilePath,
  extractSessionExcerpts,
  extractTextFromMessage,
  parseSessionFileMessages,
} from "../src/session_history.ts";
import { encodePayload, decodePayload, isHtokPayload } from "../src/payload.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildListInvocation, buildStoreInvocation, buildGetInvocation, filespecFor } from "../src/corm.ts";
import { parseBareRefs } from "../src/resolve.ts";
import { DaemonCormRunner, ensureDaemon } from "../src/daemon.ts";
import type { FusedCandidate } from "../src/tools/ranking.ts";

const home = Deno.env.get("HOME") || "";
const cormBin = existsSync("/home/quirinpa/.local/bin/corm") ? "/home/quirinpa/.local/bin/corm" : "/usr/bin/corm";
const cormdBin = existsSync("/home/quirinpa/.local/bin/cormd") ? "/home/quirinpa/.local/bin/cormd" : "/usr/bin/cormd";
const axisPath = `${home}/.local/lib:/usr/local/lib:/usr/lib`;

function computeSemanticVector(text: string): number[] {
  const lower = text.toLowerCase();
  const grandpaScore = /(?:grandpa|grandfather|grand\s+daddy|airplanes?|planes?|cherry\s+tree|concorde|boeing)/i.test(lower) ? 0.9 : 0.05;
  const techScore = /(?:corm|socket|islet|daemon|buffer)/i.test(lower) ? 0.9 : 0.05;
  const otherScore = 0.1;
  const norm = Math.sqrt(grandpaScore * grandpaScore + techScore * techScore + otherScore * otherScore) || 1.0;
  return [grandpaScore / norm, techScore / norm, otherScore / norm];
}

// ----------------------------------------------------------------------------
// Test 1: Native Pi JSONL message parsing and content filtering
// ----------------------------------------------------------------------------
Deno.test("session_history: parses message blocks, filtering thinking and tool calls", async () => {
  // Test block filtering
  const mixedContent = [
    { type: "thinking", thinking: "Let me ponder this internally..." },
    { type: "text", text: "Here is the visible response to the user." },
    { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
  ];
  const extracted = extractTextFromMessage(mixedContent);
  assert.strictEqual(extracted, "Here is the visible response to the user.");

  // Test plain string content
  assert.strictEqual(extractTextFromMessage("Simple string content"), "Simple string content");

  // Create temporary synthetic JSONL session file
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-sess-test-" });
  const sessionPath = join(tmpDir, "session_test.jsonl");

  const lines = [
    JSON.stringify({ type: "session", id: "sess-1", timestamp: "2026-10-16T12:00:00Z" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "I talked to my grandfather about airplanes under the cherry tree." }] },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      parentId: "m1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The user is talking about planes with their grandpa." },
          { type: "text", text: "Which airplanes did you discuss?" },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m3",
      parentId: "m2",
      message: { role: "user", content: [{ type: "text", text: "Concorde, Boeing. All kinds." }] },
    }),
    JSON.stringify({
      type: "message",
      id: "m4",
      parentId: "m3",
      message: { role: "assistant", content: [{ type: "text", text: "Those are legendary aircraft!" }] },
    }),
  ];

  writeFileSync(sessionPath, lines.join("\n") + "\n", "utf8");

  const messages = await parseSessionFileMessages(sessionPath);
  assert.strictEqual(messages.length, 4, "Should parse 4 conversational messages");
  assert.strictEqual(messages[0].role, "user");
  assert.strictEqual(messages[0].text, "I talked to my grandfather about airplanes under the cherry tree.");
  assert.strictEqual(messages[1].role, "assistant");
  assert.strictEqual(messages[1].text, "Which airplanes did you discuss?");
  assert.strictEqual(messages[2].role, "user");
  assert.strictEqual(messages[2].text, "Concorde, Boeing. All kinds.");

  const excerpts = await extractSessionExcerpts(sessionPath, {
    originText: "airplanes with my grandfather under the cherry tree",
    maxFollowUps: 2,
    charBudget: 350,
  });

  assert.ok(excerpts.length >= 3, "Should extract conversation thread");
  assert.ok(excerpts.some((e) => e.role === "user" && e.text.includes("Concorde, Boeing")), "Excerpts must include follow-up planes");

  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

// ----------------------------------------------------------------------------
// Test 2: Graceful fallback when sessionFile is missing or invalid
// ----------------------------------------------------------------------------
Deno.test("session_history: graceful fallback when session file is absent or invalid", async () => {
  const resolved = await resolveSessionFilePath("/non/existent/path/session.jsonl", "non-existent-id");
  assert.strictEqual(resolved, null, "Should return null for missing session path");

  const excerpts = await extractSessionExcerpts("/non/existent/path/session.jsonl");
  assert.deepStrictEqual(excerpts, [], "Should return empty array without throwing");

  const candidate: FusedCandidate = {
    ref: 1,
    record: "2026-10-16:{}",
    origin: "lemma",
    rrfScore: 0.05,
    envelope: {
      level: "L1",
      type: "note",
      lifecycle: "supported",
      summary: "I talked to my grandfather about airplanes under the cherry tree",
      episode: {
        sessionId: "sess-missing-id",
        sessionFile: "/missing/session.jsonl",
      },
    },
  };

  const excerptsMap = await enrichCandidatesWithSessionHistory([candidate], "planes", "/tmp");
  assert.strictEqual(excerptsMap.has(1), false, "Candidate with missing session file has no excerpts");

  const context = buildInjectedContext([candidate], 1500, excerptsMap);
  assert.ok(context.includes("I talked to my grandfather about airplanes under the cherry tree"));
  assert.strictEqual(context.includes("Session Excerpts:"), false, "Omits session excerpt section when missing");
});

// ----------------------------------------------------------------------------
// Test 3: Budget enforcement and role distinction
// ----------------------------------------------------------------------------
Deno.test("session_history: enforces context budget and preserves role distinction", () => {
  const candidate: FusedCandidate = {
    ref: 1,
    record: "2026-10-16:{}",
    origin: "lemma",
    rrfScore: 0.05,
    envelope: {
      level: "L1",
      type: "note",
      lifecycle: "supported",
      summary: "Talked with grandfather",
    },
  };

  const excerptsMap = new Map();
  excerptsMap.set(1, [
    { role: "user", text: "I talked to my grandfather about airplanes under the cherry tree." },
    { role: "assistant", text: "Which airplanes did you discuss?" },
    { role: "user", text: "Concorde, Boeing. All kinds." },
  ]);

  const context = buildInjectedContext([candidate], 1000, excerptsMap);
  assert.ok(context.includes("User: \"I talked to my grandfather about airplanes under the cherry tree.\""));
  assert.ok(context.includes("Assistant: \"Which airplanes did you discuss?\""));
  assert.ok(context.includes("User: \"Concorde, Boeing. All kinds.\""));
  assert.ok(context.length <= 1000, "Context length must be strictly within budget");
});

// ----------------------------------------------------------------------------
// Test 4: End-to-End Multi-Turn Session History Recall (The Decisive Test)
// ----------------------------------------------------------------------------
Deno.test("session_history: End-to-End Multi-Turn Aircraft Recall across Session A -> Session B", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-e2e-aircraft-" });
  const sockPath = join(tmpDir, "cormd.sock");

  const sessionA_Id = "01a146ab-sess-a-aircraft";
  const sessionA_Dir = join(tmpDir, "sessions");
  mkdirSync(sessionA_Dir, { recursive: true });
  const sessionA_File = join(sessionA_Dir, `${sessionA_Id}.jsonl`);

  const sessionB_Id = "01a146ac-sess-b-aircraft";
  const sessionB_File = join(sessionA_Dir, `${sessionB_Id}.jsonl`);

  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const input = typeof body.input === "string" ? body.input : "";
    const vec = computeSemanticVector(input);
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-semantic-model",
      object: "list",
    }), { headers: { "Content-Type": "application/json" } });
  });

  const embedPort = embedServer.addr.port;
  const embedUrl = `http://127.0.0.1:${embedPort}/v1/embeddings`;
  const embedModel = "mock-semantic-model";

  try {
    const fspec = filespecFor(tmpDir, true);
    const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: embedModel };
    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      axisLibs: axisPath,
      memDir: tmpDir,
      embedUrl,
      embedModel,
    };

    await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath,
      embedEnv: eEnv,
      cwd: tmpDir,
    });

    const shellExec = async (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd ?? tmpDir,
        env: { ...(opts?.env ?? {}), ...eEnv, CORM_AXIS_PATH: axisPath },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    const createEnv = (sessId: string, sessFile: string) => ({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T12:00:00Z"),
      cwd: tmpDir,
      sessionId: sessId,
      sessionFile: sessFile,
    });

    // ------------------------------------------------------------------------
    // Part 1: Simulate Session A
    // ------------------------------------------------------------------------
    // Write native Pi session log for Session A on disk
    const sessionALines = [
      JSON.stringify({ type: "session", id: sessionA_Id, timestamp: "2026-10-16T12:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({
        type: "message",
        id: "m_a1",
        parentId: null,
        timestamp: "2026-10-16T12:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "I talked to my grandfather about airplanes under the cherry tree." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a2",
        parentId: "m_a1",
        timestamp: "2026-10-16T12:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Which airplanes did you discuss?" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a3",
        parentId: "m_a2",
        timestamp: "2026-10-16T12:00:03.000Z",
        message: { role: "user", content: [{ type: "text", text: "Concorde, Boeing. All kinds." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a4",
        parentId: "m_a3",
        timestamp: "2026-10-16T12:00:04.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Those are legendary aircraft! The Concorde was supersonic while Boeing defined modern flight." }] },
      }),
    ];
    writeFileSync(sessionA_File, sessionALines.join("\n") + "\n", "utf8");

    // Store compact CORM memory for Turn 1 in Session A with authentic sessionFile reference
    const envPayload = encodePayload("2026-10-16", {
      level: "L1",
      type: "note",
      lifecycle: "supported",
      summary: "I talked to my grandfather about airplanes under the cherry tree",
      episode: {
        problem: "I talked to my grandfather about airplanes under the cherry tree.",
        findings: ["I talked to my grandfather about airplanes under the cherry tree."],
        outcome: "success",
        sessionId: sessionA_Id,
        sessionFile: sessionA_File,
        leafId: "m_a1",
      },
    });
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, envPayload, axisPath, tmpDir, eEnv));

    // Verify CORM only stored the compact memory (transcript was NOT duplicated in CORM)
    assert.ok(isHtokPayload(envPayload), "encodePayload must emit HTOK binary container");
    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    const refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, 1, "CORM must contain only 1 compact memory record");

    const getRes = await daemonRunner.run(buildGetInvocation(cormBin, fspec, 1, axisPath, tmpDir, eEnv));
    const { envelope } = decodePayload(getRes.stdout.trim());
    assert.strictEqual(envelope.summary, "I talked to my grandfather about airplanes under the cherry tree");
    assert.strictEqual(envelope.episode?.sessionFile, sessionA_File);
    assert.ok(!envelope.summary.includes("Concorde"), "CORM summary must NOT hold the second turn");

    // ------------------------------------------------------------------------
    // Part 2: Session B - Fresh context, retrieving via auto_recall
    // ------------------------------------------------------------------------
    const ctxB: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionB_Id,
      sessionManager: {
        getSessionId: () => sessionB_Id,
        getSessionFile: () => sessionB_File,
        getLeafId: () => "leaf_b1",
      },
    };

    const envSourceB = (_ctx: PiCtx) => Promise.resolve(createEnv(sessionB_Id, sessionB_File));

    // Prompt 1 in Session B: "Do you remember what I talked about with my grandfather?"
    const recallEvent1 = {
      messageType: "user" as const,
      prompt: "Do you remember what I talked about with my grandfather?",
      systemPromptOptions: { sections: {} },
    };

    const recallResult1 = await handleBeforeAgentStart(recallEvent1, ctxB, envSourceB);
    assert.ok(recallResult1, "handleBeforeAgentStart must return memory context for grandfather query");
    const injectedContent1 = recallResult1.message?.content || "";

    // Verify injected context has compact memory AND recovered session history with planes!
    assert.ok(injectedContent1.includes("I talked to my grandfather about airplanes under the cherry tree"), "Must include compact memory");
    assert.ok(injectedContent1.includes("Session Excerpts:"), "Must include session excerpts header");
    assert.ok(injectedContent1.includes("Which airplanes did you discuss?"), "Must include assistant follow-up question");
    assert.ok(injectedContent1.includes("Concorde, Boeing. All kinds."), "Must recover 'Concorde, Boeing' from source session file");

    // Prompt 2 in Session B: "Which specific planes did we mention?"
    const recallEvent2 = {
      messageType: "user" as const,
      prompt: "Which specific planes did we mention?",
      systemPromptOptions: { sections: {} },
    };

    const recallResult2 = await handleBeforeAgentStart(recallEvent2, ctxB, envSourceB);
    assert.ok(recallResult2, "handleBeforeAgentStart must return memory context for planes query");
    const injectedContent2 = recallResult2.message?.content || "";

    assert.ok(injectedContent2.includes("Concorde, Boeing"), "Prompt 2 must also inject the recovered Concorde/Boeing details");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Test 5: Real Multi-turn Pilot & Route Recall with Farewell Filter & Graceful Fallback
// ----------------------------------------------------------------------------
Deno.test("session_history: Section 4 Scenario - Boeing 787 and Lisbon-Madeira recovered across sessions", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-sess-787-" });
  const sockPath = join(tmpDir, "cormd.sock");

  const sessionA_Id = "01a146e0-sess-a-787";
  const sessionA_Dir = join(tmpDir, "sessions");
  mkdirSync(sessionA_Dir, { recursive: true });
  const sessionA_File = join(sessionA_Dir, `${sessionA_Id}.jsonl`);

  const sessionB_Id = "01a146e1-sess-b-787";
  const sessionB_File = join(sessionA_Dir, `${sessionB_Id}.jsonl`);

  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const input = typeof body.input === "string" ? body.input : "";
    const vec = computeSemanticVector(input);
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-model",
      object: "list",
    }), { headers: { "Content-Type": "application/json" } });
  });

  const embedPort = embedServer.addr.port;
  const embedUrl = `http://127.0.0.1:${embedPort}/v1/embeddings`;
  const embedModel = "mock-model";

  try {
    const fspec = filespecFor(tmpDir, true);
    const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: embedModel };

    await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath,
      embedEnv: eEnv,
      cwd: tmpDir,
    });

    const shellExec = async (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd ?? tmpDir,
        env: { ...(opts?.env ?? {}), ...eEnv, CORM_AXIS_PATH: axisPath },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    // Session A transcript:
    // Turn 1: grandfather / airplanes under cherry tree
    // Turn 2: great pilot who flew for three companies
    // Turn 3: mostly flew Boeing 787 aircraft
    // Turn 4: usual route was Lisbon to Madeira
    // Turn 5: Bye. I need to go.
    const sessionALines = [
      JSON.stringify({ type: "session", id: sessionA_Id, timestamp: "2026-10-16T14:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({
        type: "message",
        id: "m_a1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "Once I talked to my grandfather about airplanes under the cherry tree." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a2",
        parentId: "m_a1",
        message: { role: "assistant", content: [{ type: "text", text: "What a nice memory! Did he tell you about his flying career?" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a3",
        parentId: "m_a2",
        message: { role: "user", content: [{ type: "text", text: "He was a great pilot who flew for three companies." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a4",
        parentId: "m_a3",
        message: { role: "assistant", content: [{ type: "text", text: "That is impressive! What kinds of aircraft did he operate?" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a5",
        parentId: "m_a4",
        message: { role: "user", content: [{ type: "text", text: "He mostly flew Boeing 787 aircraft." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a6",
        parentId: "m_a5",
        message: { role: "assistant", content: [{ type: "text", text: "The Boeing 787 is a modern widebody plane. Which routes did he fly?" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a7",
        parentId: "m_a6",
        message: { role: "user", content: [{ type: "text", text: "The usual route was Lisbon to Madeira." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a8",
        parentId: "m_a7",
        message: { role: "assistant", content: [{ type: "text", text: "The route into Funchal Madeira is famous for its crosswind approaches." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a9",
        parentId: "m_a8",
        message: { role: "user", content: [{ type: "text", text: "Bye. I need to go." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a10",
        parentId: "m_a9",
        message: { role: "assistant", content: [{ type: "text", text: "Goodbye! Take care." }] },
      }),
    ];
    writeFileSync(sessionA_File, sessionALines.join("\n") + "\n", "utf8");

    // Store ONE single compact memory in CORM for Session A
    const envPayload = encodePayload("2026-10-16", {
      level: "L1",
      type: "note",
      lifecycle: "supported",
      summary: "Once I talked to my grandfather about airplanes under the cherry tree",
      episode: {
        problem: "Once I talked to my grandfather about airplanes under the cherry tree.",
        findings: [
          "Once I talked to my grandfather about airplanes under the cherry tree",
          "He was a great pilot who flew for three companies",
          "He mostly flew Boeing 787 aircraft",
          "The usual route was Lisbon to Madeira",
        ],
        outcome: "success",
        sessionId: sessionA_Id,
        sessionFile: sessionA_File,
        leafId: "m_a1",
      },
    });
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, envPayload, axisPath, tmpDir, eEnv));

    // Verify CORM only stored ONE record
    const listRes = await daemonRunner.run(buildListInvocation(cormBin, fspec, axisPath, tmpDir, eEnv));
    const refs = parseBareRefs(listRes.stdout);
    assert.strictEqual(refs.length, 1, "CORM must contain only 1 compact memory record, not a duplicated transcript");

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      axisLibs: axisPath,
      memDir: tmpDir,
      embedUrl,
      embedModel,
    };

    const ctxB: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionB_Id,
      sessionManager: {
        getSessionId: () => sessionB_Id,
        getSessionFile: () => sessionB_File,
        getLeafId: () => "leaf_b1",
      },
    };

    const envSourceB = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-16T15:00:00Z"),
      cwd: tmpDir,
      sessionId: sessionB_Id,
      sessionFile: sessionB_File,
    });

    // ------------------------------------------------------------------------
    // Session B Query 1: "Do you remember what I told you about my grandfather?"
    // ------------------------------------------------------------------------
    const res1 = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Do you remember what I told you about my grandfather?",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);

    assert.ok(res1, "Query 1 must return injected memory context");
    const content1 = res1.message?.content || "";
    assert.ok(content1.includes("Session Excerpts:"), "Query 1 must include Session Excerpts");
    assert.ok(content1.includes("Boeing 787"), "Query 1 excerpts must include Boeing 787");
    assert.ok(content1.includes("Lisbon to Madeira"), "Query 1 excerpts must include Lisbon to Madeira");
    assert.strictEqual(content1.includes("Bye. I need to go"), false, "Must strictly exclude trivial farewell");

    // ------------------------------------------------------------------------
    // Session B Query 2: "What kinds of airplanes did he fly?"
    // ------------------------------------------------------------------------
    const res2 = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "What kinds of airplanes did he fly?",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);

    assert.ok(res2, "Query 2 must return injected memory context");
    const content2 = res2.message?.content || "";
    assert.ok(content2.includes("Boeing 787"), "Query 2 must recover Boeing 787 from session history");
    assert.ok(content2.includes("pilot who flew"), "Query 2 must recover pilot context");

    // ------------------------------------------------------------------------
    // Session B Query 3: "Which route did he usually fly?"
    // ------------------------------------------------------------------------
    const res3 = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Which route did he usually fly?",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);

    assert.ok(res3, "Query 3 must return injected memory context");
    const content3 = res3.message?.content || "";
    assert.ok(content3.includes("Lisbon to Madeira"), "Query 3 must recover Lisbon to Madeira route");

    // ------------------------------------------------------------------------
    // Test Graceful Degradation when source session file is unavailable
    // ------------------------------------------------------------------------
    rmSync(sessionA_File); // Remove session file
    const resFallback = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Do you remember what I told you about my grandfather?",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);

    assert.ok(resFallback, "Must gracefully degrade and still return compact memory");
    const contentFallback = resFallback.message?.content || "";
    assert.ok(contentFallback.includes("Once I talked to my grandfather about airplanes under the cherry tree"), "Compact memory must remain");
    assert.strictEqual(contentFallback.includes("Session Excerpts:"), false, "Excerpts omitted gracefully when file absent");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ----------------------------------------------------------------------------
// Test 6: Boeing 747, Route Recovery, Superseded Exclusion, and L0 Scoping
// ----------------------------------------------------------------------------
Deno.test("session_history: Boeing 747 short turn recovery, superseded exclusion, and L0 scoping", async () => {
  const tmpDir = Deno.makeTempDirSync({ prefix: "mm-sess-747-" });
  const sockPath = join(tmpDir, "cormd.sock");

  const sessionA_Id = "01a146f0-sess-a-747";
  const sessionA_Dir = join(tmpDir, "sessions");
  mkdirSync(sessionA_Dir, { recursive: true });
  const sessionA_File = join(sessionA_Dir, `${sessionA_Id}.jsonl`);

  const sessionB_Id = "01a146f1-sess-b-747";
  const sessionB_File = join(sessionA_Dir, `${sessionB_Id}.jsonl`);

  const embedServer = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json();
    const input = typeof body.input === "string" ? body.input : "";
    const vec = computeSemanticVector(input);
    return new Response(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: "embedding" }],
      model: "mock-model",
      object: "list",
    }), { headers: { "Content-Type": "application/json" } });
  });

  const embedPort = embedServer.addr.port;
  const embedUrl = `http://127.0.0.1:${embedPort}/v1/embeddings`;
  const embedModel = "mock-model";

  try {
    const fspec = filespecFor(tmpDir, true);
    const eEnv = { CORM_SEPAL_EMBED_URL: embedUrl, CORM_SEPAL_EMBED_MODEL: embedModel };

    await ensureDaemon({
      cormdBin,
      filespec: fspec,
      socketPath: sockPath,
      axisPath,
      embedEnv: eEnv,
      cwd: tmpDir,
    });

    const shellExec = async (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd ?? tmpDir,
        env: { ...(opts?.env ?? {}), ...eEnv, CORM_AXIS_PATH: axisPath },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
    };

    const daemonRunner = new DaemonCormRunner(sockPath, { run: (inv) => shellExec(inv.command, inv.args, inv) });

    // Session A transcript:
    // Turn 1: "I once spoke with my grandpa about airplanes under the cherry tree."
    // Turn 2: "Boing 747."
    // Turn 3: "He flew from Lisbon to Madeira and back."
    // Turn 4: "Bye. I need to go."
    const sessionALines = [
      JSON.stringify({ type: "session", id: sessionA_Id, timestamp: "2026-10-17T10:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({
        type: "message",
        id: "m_a1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "I once spoke with my grandpa about airplanes under the cherry tree." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a2",
        parentId: "m_a1",
        message: { role: "assistant", content: [{ type: "text", text: "That sounds like a wonderful memory! What plane did he talk about?" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a3",
        parentId: "m_a2",
        message: { role: "user", content: [{ type: "text", text: "Boing 747." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a4",
        parentId: "m_a3",
        message: { role: "assistant", content: [{ type: "text", text: "The Queen of the Skies! What routes did he fly?" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a5",
        parentId: "m_a4",
        message: { role: "user", content: [{ type: "text", text: "He flew from Lisbon to Madeira and back." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a6",
        parentId: "m_a5",
        message: { role: "assistant", content: [{ type: "text", text: "A classic Atlantic route!" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a7",
        parentId: "m_a6",
        message: { role: "user", content: [{ type: "text", text: "Bye. I need to go." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m_a8",
        parentId: "m_a7",
        message: { role: "assistant", content: [{ type: "text", text: "Goodbye! Take care." }] },
      }),
    ];
    writeFileSync(sessionA_File, sessionALines.join("\n") + "\n", "utf8");

    // Ref 1: Obsolete superseded memory
    const supersededPayload = encodePayload("2026-10-15", {
      level: "L1",
      type: "note",
      lifecycle: "superseded",
      summary: "I talked with my grandpa about an old Cessna airplane",
      supersededBy: 2,
    });
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 1, supersededPayload, axisPath, tmpDir, eEnv));

    // Ref 2: Active active memory
    const activePayload = encodePayload("2026-10-17", {
      level: "L1",
      type: "note",
      lifecycle: "supported",
      summary: "I once spoke with my grandpa about airplanes under the cherry tree",
      episode: {
        problem: "I once spoke with my grandpa about airplanes under the cherry tree",
        findings: [
          "I once spoke with my grandpa about airplanes under the cherry tree",
          "Boing 747",
          "He flew from Lisbon to Madeira and back",
        ],
        outcome: "success",
        sessionId: sessionA_Id,
        sessionFile: sessionA_File,
        leafId: "m_a1",
      },
    });
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 2, activePayload, axisPath, tmpDir, eEnv));

    // Ref 3: Technical L0 tool execution episode
    const l0Payload = encodePayload("2026-10-17", {
      level: "L0",
      type: "episode",
      lifecycle: "tested",
      summary: ".pi/extensions/pi-mm/scripts/test.sh: grep grandpa ./tests",
      episode: {
        problem: "grep grandpa",
        findings: [".pi/extensions/pi-mm/scripts/test.sh: grep grandpa"],
        outcome: "success",
      },
    });
    await daemonRunner.run(buildStoreInvocation(cormBin, fspec, 3, l0Payload, axisPath, tmpDir, eEnv));

    const cfg = {
      ...DEFAULT_CONFIG,
      cormBin: cormBin,
      cormdBin,
      axisLibs: axisPath,
      memDir: tmpDir,
      embedUrl,
      embedModel,
    };

    const ctxB: PiCtx = {
      cwd: tmpDir,
      hasUI: false,
      mode: "agent",
      sessionId: sessionB_Id,
      sessionManager: {
        getSessionId: () => sessionB_Id,
        getSessionFile: () => sessionB_File,
        getLeafId: () => "leaf_b1",
      },
    };

    const envSourceB = (_ctx: PiCtx) => Promise.resolve({
      cfg,
      runner: daemonRunner,
      nowProvider: () => new Date("2026-10-17T11:00:00Z"),
      cwd: tmpDir,
      sessionId: sessionB_Id,
      sessionFile: sessionB_File,
    });

    // ------------------------------------------------------------------------
    // Session B Query 1: "Do you remember me speaking about my grandpa?"
    // ------------------------------------------------------------------------
    const res1 = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Do you remember me speaking about my grandpa?",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);

    assert.ok(res1, "Query 1 must return injected memory context");
    const content1 = res1.message?.content || "";

    // Must return active Ref 2 and its recovered session history
    assert.ok(content1.includes("[Ref 2]"), "Must recall active Ref 2");
    assert.strictEqual(content1.includes("[Ref 1]"), false, "Must strictly exclude superseded Ref 1");
    assert.strictEqual(content1.includes("[Ref 3]"), false, "Must strictly exclude L0 script Ref 3 from conversational query");
    assert.ok(content1.includes("Boing 747"), "Must recover 'Boing 747' from source session file");
    assert.ok(content1.includes("Lisbon to Madeira"), "Must recover 'Lisbon to Madeira' from source session file");

    // ------------------------------------------------------------------------
    // Session B Query 2: "Which airplane did he fly, and which route?"
    // ------------------------------------------------------------------------
    const res2 = await handleBeforeAgentStart({
      messageType: "user",
      prompt: "Which airplane did he fly, and which route?",
      systemPromptOptions: { sections: {} },
    }, ctxB, envSourceB);

    assert.ok(res2, "Query 2 must return injected memory context in a single cycle");
    const content2 = res2.message?.content || "";
    assert.ok(content2.includes("[Ref 2]"), "Query 2 must recall active Ref 2");
    assert.strictEqual(content2.includes("[Ref 1]"), false, "Must not return superseded memory");
    assert.ok(content2.includes("Boing 747"), "Single cycle must supply Boing 747 to model context");
    assert.ok(content2.includes("Lisbon to Madeira"), "Single cycle must supply route to model context");

    // Clean up
    const lockData = JSON.parse(await Deno.readTextFile(join(tmpDir, ".cormd.lock")));
    process.kill(lockData.pid, "SIGTERM");
  } finally {
    await embedServer.shutdown();
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});
