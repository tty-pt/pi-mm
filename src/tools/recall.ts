import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { EnvSource, ToolEnv } from "./index.ts";
import { axisPath, memDir, sepalConfigured } from "./index.ts";
import { filespecFor, embedEnv } from "../qmap.ts";
import { executeHybridScan } from "./scan.ts";
import { traverseDown, renderTree } from "./traverse.ts";
import type { FusedCandidate } from "./ranking.ts";
import { enrichCandidatesWithSessionHistory } from "../hooks/auto_recall.ts";
import type { SessionExcerpt } from "../session_history.ts";

const RECALL_PARAMS = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query: error message, symbol, concept, or natural language problem description." },
    project: { type: "string", description: "Filter or boost memories matching a specific project scope." },
    subsystem: { type: "string", description: "Filter or boost memories matching a specific subsystem." },
    level: { type: "string", enum: ["L0", "L1", "L2", "L3"], description: "Optional resolution level filter ('L0'|'L1'|'L2'|'L3')." },
    includeEvidence: { type: "boolean", description: "If true, automatically fetches and includes the supporting evidence tree for each memory." },
    limit: { type: "number", description: "Maximum number of memories to return (default 5, max 20)." },
  },
  required: ["query"],
  additionalProperties: false,
};

function formatResult(cand: FusedCandidate, evidenceText?: string, excerpts?: SessionExcerpt[]): string {
  const ref = cand.ref;
  const env = cand.envelope;
  const level = env?.level ?? cand.level ?? "L2";
  const lifecycle = env?.lifecycle ?? cand.lifecycle ?? "supported";
  const isHypothesis = lifecycle === "hypothesized";
  const scopeParts: string[] = [];
  if (env?.context?.project) scopeParts.push(env.context.project);
  if (env?.context?.subsystem) scopeParts.push(env.context.subsystem);
  const scopeStr = scopeParts.length > 0 ? ` [${scopeParts.join("/")}]` : "";
  const lifecycleLabel = isHypothesis ? "[HYPOTHESIS]" : lifecycle;

  const summary = env?.summary ?? cand.summary ?? cand.record.slice(0, 120);
  let text = `[Ref ${ref}] (${level}, ${lifecycleLabel}${scopeStr}): ${summary}\n  Origin: ${cand.origin} (score: ${cand.score ?? "1.0"})`;

  if (evidenceText) {
    text += `\n  Supporting Evidence:\n${evidenceText.split("\n").map((l) => "    " + l).join("\n")}`;
  } else if (env?.evidence && env.evidence.length > 0) {
    text += `\n  Cites evidence refs: [${env.evidence.join(", ")}]`;
  }

  if (excerpts && excerpts.length > 0) {
    text += `\n  Source Session Excerpts:\n` + excerpts.map((e) => `    ${e.role === "user" ? "User" : "Assistant"}: "${e.text}"`).join("\n");
  }

  return text;
}

async function attachEvidence(
  env: ToolEnv,
  records: FusedCandidate[],
): Promise<Map<number, string>> {
  const embed = sepalConfigured(env.cfg);
  const cwd = memDir(env);
  const fspec = filespecFor(cwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);
  const evidenceMap = new Map<number, string>();

  for (const rec of records) {
    if (rec.envelope?.evidence && rec.envelope.evidence.length > 0) {
      try {
        const tree = await traverseDown(env, fspec, axes, cwd, eEnv, rec.ref, 0, 1, new Set());
        if (tree) evidenceMap.set(rec.ref, renderTree(tree).trim());
      } catch {
        // Fallback gracefully without evidence tree
      }
    }
  }
  return evidenceMap;
}

async function executeRecall(
  envSource: EnvSource,
  params: Record<string, unknown>,
  ctx: PiCtx,
) {
  try {
    const env = await envSource(ctx);
    const query = typeof params["query"] === "string" ? params["query"].trim() : "";
    if (!query) {
      return { content: [{ type: "text", text: "mm recall: empty query" }], details: { results: [] } };
    }
    if (env.cfg.qmapBin === "") {
      return { content: [{ type: "text", text: "mm unavailable: qmap binary not found" }], details: { error: "no-qmap", results: [] } };
    }

    const limit = Math.min(Math.max(Number(params["limit"]) || 5, 1), 20);
    const { records, details } = await executeHybridScan(env, {
      topic: query,
      project: typeof params["project"] === "string" ? params["project"].trim() : undefined,
      subsystem: typeof params["subsystem"] === "string" ? params["subsystem"].trim() : undefined,
      level: params["level"],
      limit,
      embed: true,
    });

    if (records.length === 0) {
      return {
        content: [{ type: "text", text: `No memories found matching "${query}".` }],
        details: { query, results: [], scanDetails: details },
      };
    }

    let evidenceMap: Map<number, string> | undefined;
    if (params["includeEvidence"] === true) {
      evidenceMap = await attachEvidence(env, records);
    }

    const excerptsMap = await enrichCandidatesWithSessionHistory(records, query, ctx.cwd);

    const lines = [`Found ${records.length} relevant memory record(s) for "${query}":\n`];
    for (const rec of records) {
      lines.push(formatResult(rec, evidenceMap?.get(rec.ref), excerptsMap.get(rec.ref)));
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { query, count: records.length, results: records, scanDetails: details },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `mm recall error: ${msg}` }], details: { error: msg, results: [] } };
  }
}

export function makeRecallTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_recall",
    label: "Recall Relevant Memories",
    description: "Hybrid memory search combining text keywords and semantic embeddings with Reciprocal Rank Fusion. Returns compact ranked results and optional supporting evidence trees.",
    parameters: RECALL_PARAMS,
    execute: (_id, params, _sig, _upd, ctx) => executeRecall(envSource, params, ctx as PiCtx),
  };
}
