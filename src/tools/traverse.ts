import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { EnvSource, ToolEnv } from "./index.ts";
import { axisPath, memDir, sepalConfigured } from "./index.ts";
import { filespecFor, buildGetInvocation, buildListInvocation, embedEnv } from "../qmap.ts";
import { decodePayload } from "../payload.ts";
import { parseBareRefs } from "../resolve.ts";
import type { MemoryEnvelope, MipmapLevel, LifecycleState, EpisodeRecord } from "../types.ts";

export interface TraversalNode {
  ref: number;
  level: MipmapLevel;
  lifecycle: LifecycleState;
  summary: string;
  type?: string;
  evidence?: number[];
  missingEvidence?: number[];
  children?: TraversalNode[];
  parents?: TraversalNode[];
  episode?: EpisodeRecord;
}

export async function fetchEnvelope(
  env: ToolEnv,
  fspec: string,
  axes: string,
  cwd: string,
  eEnv: Record<string, string>,
  ref: number,
): Promise<{ date: string; envelope: MemoryEnvelope } | null> {
  const res = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, ref, axes, cwd, eEnv));
  if (res.code !== 0 || !res.stdout.trim()) return null;
  return decodePayload(res.stdout.trim());
}

export async function traverseDown(
  env: ToolEnv,
  fspec: string,
  axes: string,
  cwd: string,
  eEnv: Record<string, string>,
  ref: number,
  depth: number,
  maxDepth: number,
  visited: Set<number>,
): Promise<TraversalNode | null> {
  if (visited.has(ref) || depth > maxDepth) return null;
  visited.add(ref);

  const item = await fetchEnvelope(env, fspec, axes, cwd, eEnv, ref);
  if (!item) return null;

  const node: TraversalNode = {
    ref,
    level: item.envelope.level,
    lifecycle: item.envelope.lifecycle,
    summary: item.envelope.summary,
    type: item.envelope.type,
    evidence: item.envelope.evidence,
    episode: item.envelope.episode,
    children: [],
  };

  const evidenceRefs = item.envelope.evidence ?? [];
  for (const childRef of evidenceRefs) {
    if (visited.has(childRef)) continue;
    const child = await traverseDown(env, fspec, axes, cwd, eEnv, childRef, depth + 1, maxDepth, visited);
    if (child) {
      node.children?.push(child);
    } else {
      node.missingEvidence = node.missingEvidence ?? [];
      node.missingEvidence.push(childRef);
    }
  }

  return node;
}

async function traverseUp(
  env: ToolEnv,
  fspec: string,
  axes: string,
  cwd: string,
  eEnv: Record<string, string>,
  ref: number,
  depth: number,
  maxDepth: number,
  visited: Set<number>,
  allRefs: number[],
): Promise<TraversalNode | null> {
  if (visited.has(ref) || depth > maxDepth) return null;
  visited.add(ref);

  const item = await fetchEnvelope(env, fspec, axes, cwd, eEnv, ref);
  if (!item) return null;

  const node: TraversalNode = {
    ref,
    level: item.envelope.level,
    lifecycle: item.envelope.lifecycle,
    summary: item.envelope.summary,
    type: item.envelope.type,
    evidence: item.envelope.evidence,
    episode: item.envelope.episode,
    parents: [],
  };

  if (depth < maxDepth) {
    for (const candRef of allRefs) {
      if (candRef === ref || visited.has(candRef)) continue;
      const cand = await fetchEnvelope(env, fspec, axes, cwd, eEnv, candRef);
      if (cand?.envelope.evidence?.includes(ref)) {
        const parentNode = await traverseUp(env, fspec, axes, cwd, eEnv, candRef, depth + 1, maxDepth, visited, allRefs);
        if (parentNode) node.parents?.push(parentNode);
      }
    }
  }

  return node;
}

export function renderTree(node: TraversalNode, prefix = "", isLast = true, isRoot = true): string {
  const branch = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const line = `${prefix}${branch}[${node.level}] Ref ${node.ref}: ${node.summary} (${node.lifecycle})\n`;
  const nextPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
  const children = node.children ?? node.parents ?? [];
  let out = line;
  for (let i = 0; i < children.length; i++) {
    out += renderTree(children[i], nextPrefix, i === children.length - 1, false);
  }
  return out;
}

export function makeTraverseTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_traverse",
    label: "Traverse Memory Mipmaps",
    description: "Traverse memory mipmaps bidirectionally: downward to inspect supporting evidence, or upward to discover higher-level patterns.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "number", description: "Root memory numeric ref." },
        direction: { type: "string", enum: ["down", "up"], description: "Traversal direction: 'down' to evidence, 'up' to abstractions (default down)." },
        depth: { type: "number", description: "Max traversal depth (default 2, max 5)." },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      try {
        const env = await envSource(ctx as PiCtx);
        const ref = Number(params["ref"]);
        const direction = (params["direction"] as "down" | "up") || "down";
        const maxDepth = Math.min(Math.max(Number(params["depth"]) || 2, 1), 5);

        if (!Number.isInteger(ref) || ref < 0) {
          return { content: [{ type: "text", text: "mm traverse: invalid ref" }], details: { error: "invalid-ref" } };
        }
        if (env.cfg.qmapBin === "") {
          return { content: [{ type: "text", text: "mm unavailable: qmap binary not found" }], details: { error: "no-qmap" } };
        }

        const embed = sepalConfigured(env.cfg);
        const cwd = memDir(env);
        const fspec = filespecFor(cwd, embed);
        const axes = axisPath(env);
        const eEnv = embedEnv(env.cfg);
        const visited = new Set<number>();

        let tree: TraversalNode | null = null;
        if (direction === "down") {
          tree = await traverseDown(env, fspec, axes, cwd, eEnv, ref, 0, maxDepth, visited);
        } else {
          const listRes = await env.runner.run(buildListInvocation(env.cfg.qmapBin, fspec, axes, cwd, eEnv));
          const allRefs = parseBareRefs(listRes.stdout);
          tree = await traverseUp(env, fspec, axes, cwd, eEnv, ref, 0, maxDepth, visited, allRefs);
        }

        if (!tree) {
          return { content: [{ type: "text", text: `mm traverse: ref ${ref} not found` }], details: { error: "not-found", ref } };
        }

        const rendered = renderTree(tree);
        return {
          content: [{ type: "text", text: rendered }],
          details: { root: ref, direction, maxDepth, visitedCount: visited.size, tree },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `mm unavailable: ${msg}` }], details: { error: msg } };
      }
    },
  };
}
