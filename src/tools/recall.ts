import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { EnvSource, ToolEnv } from "./index.ts";
import { axisPath, memDir, sepalConfigured } from "./index.ts";
import { filespecFor, embedEnv } from "../corm.ts";
import { executeHybridScan } from "./scan.ts";
import { fetchEnvelope, traverseDown, renderTree } from "./traverse.ts";
import { buildMemoryOverview } from "./overview.ts";
import type { FusedCandidate } from "./ranking.ts";
import { enrichCandidatesWithSessionHistory } from "../hooks/auto_recall.ts";
import type { SessionExcerpt } from "../session_history.ts";
import { canonicalSortByRef } from "../blocks.ts";
import type { MipmapLevel } from "../types.ts";

const RECALL_PARAMS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query: error message, symbol, concept, or natural language problem description. Omit or pass 'overview' for an all-time memory overview.",
    },
    zoomRef: {
      type: "number",
      description: "Zoom directly into a specific memory reference number, returning its complete multi-resolution details: approaches, diffs, and evidence tree.",
    },
    overview: {
      type: "boolean",
      description: "If true, returns a structured timeline and hierarchical overview across all operational time.",
    },
    project: { type: "string", description: "Filter or boost memories matching a specific project scope." },
    subsystem: { type: "string", description: "Filter or boost memories matching a specific subsystem." },
    level: { type: "string", enum: ["L0", "L1", "L2", "L3"], description: "Optional resolution level filter ('L0'|'L1'|'L2'|'L3')." },
    includeEvidence: { type: "boolean", description: "If true, automatically fetches and includes the supporting evidence tree for each memory." },
    limit: { type: "number", description: "Maximum number of memories to return (default 5 for search, 15 for overview, max 30)." },
  },
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

/**
 * Zooms into a specific memory reference number, fetching its full vertical context,
 * problem, attempted approaches, recorded diffs, verification status, and evidence tree.
 */
async function zoomInMemory(
  env: ToolEnv,
  ref: number,
) {
  const embed = sepalConfigured(env.cfg);
  const cwd = memDir(env);
  const fspec = filespecFor(cwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);

  const item = await fetchEnvelope(env, fspec, axes, cwd, eEnv, ref);
  if (!item) {
    return {
      content: [{ type: "text", text: `Memory Ref ${ref} not found in database.` }],
      details: { error: "not-found", ref },
    };
  }

  const { envelope, date } = item;
  const tree = await traverseDown(env, fspec, axes, cwd, eEnv, ref, 0, 3, new Set());
  const treeText = tree ? renderTree(tree).trim() : `[${envelope.level}] Ref ${ref}: ${envelope.summary}`;

  const scopeParts: string[] = [];
  if (envelope.context?.project) scopeParts.push(envelope.context.project);
  if (envelope.context?.subsystem) scopeParts.push(envelope.context.subsystem);
  const scopeStr = scopeParts.length > 0 ? ` [${scopeParts.join("/")}]` : "";

  const lines = [
    `=== Memory Zoom-In: Ref ${ref} ===`,
    `Level: ${envelope.level} | Lifecycle: ${envelope.lifecycle} | Type: ${envelope.type ?? "note"}${scopeStr}`,
    `Date: ${date} | Summary: ${envelope.summary}`,
  ];

  if (envelope.constraints && envelope.constraints.length > 0) {
    lines.push(`\nConstraints & Rules:`);
    for (const c of envelope.constraints) {
      lines.push(`- [RESTRICTION]: ${c}`);
    }
  }

  const ep = envelope.episode;
  if (ep) {
    if (ep.problem) {
      lines.push(`\nProblem Addressed:\n  ${ep.problem}`);
    }
    if (ep.approaches && ep.approaches.length > 0) {
      lines.push(`\nAttempted Approaches:`);
      for (const a of ep.approaches) {
        lines.push(`- [${a.outcome.toUpperCase()}] ${a.approach}${a.reason ? ": " + a.reason : ""}`);
      }
    }
    if (ep.findings && ep.findings.length > 0) {
      lines.push(`\nFindings:\n` + ep.findings.map((f) => `  • ${f}`).join("\n"));
    }
    if (ep.diffs && ep.diffs.length > 0) {
      const diffJoined = ep.diffs.join("\n");
      const diffClipped = diffJoined.length > 1500 ? diffJoined.slice(0, 1500) + "\n...[diff truncated]" : diffJoined;
      lines.push(`\nRecorded Diffs / Changes:\n${diffClipped}`);
    }
    if (ep.outcome) {
      lines.push(`\nOutcome: ${ep.outcome}`);
    }
  }

  lines.push(`\nEvidence Hierarchy (Mipmap Lineage):`);
  lines.push(treeText);

  lines.push(`\n---`);
  lines.push(`💡 To inspect supporting evidence in further detail, run: memory_recall({ zoomRef: <childRef> })`);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { ref, envelope, date, tree },
  };
}

async function executeOverviewRecall(
  env: ToolEnv,
  params: Record<string, unknown>,
) {
  const limit = Math.min(Math.max(Number(params["limit"]) || 15, 1), 30);
  const overview = await buildMemoryOverview(env, {
    project: typeof params["project"] === "string" ? params["project"].trim() : undefined,
    subsystem: typeof params["subsystem"] === "string" ? params["subsystem"].trim() : undefined,
    level: params["level"] as MipmapLevel | undefined,
    limit,
  });

  return {
    content: [{ type: "text", text: overview.renderedOverview }],
    details: { overview, totalRecords: overview.totalRecords },
  };
}

async function executeTargetedHybridRecall(
  env: ToolEnv,
  query: string,
  params: Record<string, unknown>,
  cwd: string,
) {
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
      content: [{ type: "text", text: `No memories found matching "${query}".\nTip: Call memory_recall({ overview: true }) for a high-level timeline overview across all memories.` }],
      details: { query, results: [], scanDetails: details },
    };
  }

  let evidenceMap: Map<number, string> | undefined;
  if (params["includeEvidence"] === true) {
    evidenceMap = await attachEvidence(env, records);
  }

  const excerptsMap = await enrichCandidatesWithSessionHistory(records, query, cwd);
  const sortedRecords = canonicalSortByRef(records);

  const lines = [`Found ${sortedRecords.length} relevant memory record(s) for "${query}":\n`];
  for (const rec of sortedRecords) {
    lines.push(formatResult(rec, evidenceMap?.get(rec.ref), excerptsMap.get(rec.ref)));
  }

  lines.push(`\nTip: To zoom into any of these memories, call memory_recall({ zoomRef: <ref> }).`);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { query, count: sortedRecords.length, results: sortedRecords, scanDetails: details },
  };
}

async function executeRecall(
  envSource: EnvSource,
  params: Record<string, unknown>,
  ctx: PiCtx,
) {
  try {
    const env = await envSource(ctx);
    const bin = env.cfg.cormBin;
    if (!bin) {
      return { content: [{ type: "text", text: "mm unavailable: corm binary not found" }], details: { error: "no-corm", results: [] } };
    }

    // 1. Direct Zoom-In by Reference ID
    if (typeof params["zoomRef"] === "number" && Number.isInteger(params["zoomRef"])) {
      return await zoomInMemory(env, params["zoomRef"]);
    }

    const rawQuery = typeof params["query"] === "string" ? params["query"].trim() : "";

    // Check if query is an inline zoom command (e.g. "ref:42" or "zoom:42")
    const zoomMatch = /^(?:ref|zoom):?\s*(\d+)$/i.exec(rawQuery);
    if (zoomMatch) {
      return await zoomInMemory(env, Number(zoomMatch[1]));
    }

    // 2. High-Level Memory Overview Mode
    const isOverview = params["overview"] === true || rawQuery === "" || rawQuery.toLowerCase() === "overview" || rawQuery === "*";
    if (isOverview) {
      return await executeOverviewRecall(env, params);
    }

    // 3. Targeted Hybrid Semantic & Lexical Recall
    return await executeTargetedHybridRecall(env, rawQuery, params, ctx.cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `mm recall error: ${msg}` }], details: { error: msg, results: [] } };
  }
}

export function makeRecallTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_recall",
    label: "Recall Relevant Memories",
    description: "Multi-resolution memory retrieval: search semantically across topics, generate all-time high-level overviews, or zoom in to inspect specific memory investigations, approaches, diffs, and evidence trees.",
    parameters: RECALL_PARAMS,
    execute: (_id, params, _sig, _upd, ctx) => executeRecall(envSource, params, ctx as PiCtx),
  };
}
