import { mkdir } from "node:fs/promises";
import type { PiCtx, PiToolSpec } from "../hooks/events.ts";
import type { EnvSource, ToolEnv } from "./index.ts";
import { axisPath, memDir, exportDetail, sepalConfigured } from "./index.ts";
import { filespecFor, buildStoreInvocation, buildGetInvocation, embedEnv } from "../qmap.ts";
import { allocateNextRef } from "./ref_allocator.ts";
import { payloadDate } from "../qmap.ts";
import { encodePayload, decodePayload } from "../payload.ts";
import { withLock } from "../lock.ts";
import type { MemoryEnvelope, MipmapLevel, LifecycleState, EpisodeRecord, MemoryContext } from "../types.ts";

const STORE_PARAMS = {
  type: "object",
  properties: {
    text: { type: "string", description: "Memory text or summary." },
    summary: { type: "string", description: "Summary or claim line." },
    level: { type: "string", enum: ["L0", "L1", "L2", "L3"], description: "Mipmap resolution level (default L0 for episodes, else L2)." },
    type: { type: "string", enum: ["episode", "investigation", "decision", "invariant", "pattern", "note"], description: "Memory category." },
    lifecycle: { type: "string", enum: ["observed", "hypothesized", "tested", "supported", "contradicted", "superseded"], description: "Initial lifecycle state (default supported)." },
    context: {
      type: "object",
      description: "Project/module/subsystem or spatial grid context.",
      properties: {
        project: { type: "string" },
        subsystem: { type: "string" },
        module: { type: "string" },
        path: { type: "string" },
        grid: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
        },
      },
    },
    episode: {
      type: "object",
      description: "L0 episode details.",
      properties: {
        request: { type: "string" },
        problem: { type: "string" },
        approaches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              approach: { type: "string" },
              outcome: { type: "string", enum: ["worked", "failed", "abandoned"] },
              reason: { type: "string" },
            },
            required: ["approach", "outcome"],
          },
        },
        steps: { type: "array", items: { type: "string" } },
        observations: { type: "array", items: { type: "string" } },
        findings: { type: "array", items: { type: "string" } },
        unresolved: { type: "array", items: { type: "string" } },
        diffs: { type: "array", items: { type: "string" } },
        outcome: { type: "string" },
        environment: { type: "object" },
      },
    },
    evidence: { type: "array", items: { type: "number" }, description: "Underlying evidence refs supporting this memory." },
    supersedes: { type: "number", description: "Ref of an older memory this conclusion replaces." },
    tags: { type: "array", items: { type: "string" }, description: "Categorization tags." },
    timestamp: { type: "string", description: "ISO timestamp (used as DATE prefix); default now." },
  },
  additionalProperties: false,
};

async function applySupersedes(
  env: ToolEnv,
  fspec: string,
  axes: string,
  cwd: string,
  eEnv: Record<string, string>,
  oldRef: number,
  newRef: number,
  nowIso: string,
): Promise<void> {
  const getOld = await env.runner.run(buildGetInvocation(env.cfg.qmapBin, fspec, oldRef, axes, cwd, eEnv));
  if (getOld.code === 0 && getOld.stdout.trim()) {
    const { date: oldDate, envelope: oldEnv } = decodePayload(getOld.stdout.trim());
    const prev = oldEnv.lifecycle;
    oldEnv.lifecycle = "superseded";
    oldEnv.supersededBy = newRef;
    oldEnv.history = oldEnv.history ?? [];
    oldEnv.history.push({
      from: prev,
      to: "superseded",
      timestamp: nowIso,
      reason: `Superseded by ref ${newRef}`,
      evidenceRef: newRef,
    });
    await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, oldRef, encodePayload(oldDate, oldEnv), axes, cwd, eEnv));
  }
}

async function storeSpatialGrid(
  env: ToolEnv,
  axes: string,
  cwd: string,
  ref: number,
  grid: { x: number; y: number },
): Promise<void> {
  const isletFspec = `${cwd}/mem-islet.db@islet:a:s`;
  try {
    await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, isletFspec, ref, `${grid.x},${grid.y}`, axes, cwd));
  } catch {
    // Spatial grid store is best-effort
  }
}

function defaultLifecycle(level: MipmapLevel, type: string | undefined): LifecycleState {
  if (level === "L0" || type === "episode") return "observed";
  return "supported";
}

function buildEnvelope(params: Record<string, unknown>, summary: string, ep?: EpisodeRecord): { envelope: MemoryEnvelope; isStructured: boolean } {
  const level: MipmapLevel = (params["level"] as MipmapLevel) || (ep ? "L0" : "L2");
  const type = (params["type"] as MemoryEnvelope["type"]) || (ep ? "episode" : "note");
  const lifecycle: LifecycleState = (params["lifecycle"] as LifecycleState) || defaultLifecycle(level, type);
  const envelope: MemoryEnvelope = {
    level,
    type,
    lifecycle,
    summary,
    context: params["context"] as MemoryContext | undefined,
    episode: ep,
    evidence: Array.isArray(params["evidence"]) ? (params["evidence"] as number[]) : undefined,
    supersedes: typeof params["supersedes"] === "number" ? params["supersedes"] : undefined,
    tags: Array.isArray(params["tags"]) ? (params["tags"] as string[]) : undefined,
  };
  const isStructured = Boolean(
    ep || params["level"] || params["context"] || params["evidence"] ||
    params["supersedes"] || params["tags"] || params["lifecycle"]
  );
  return { envelope, isStructured };
}

export async function executeStore(envSource: EnvSource, params: Record<string, unknown>, ctx: PiCtx): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }> {
  try {
    const env = await envSource(ctx);
    const textParam = typeof params["text"] === "string" ? params["text"].trim() : "";
    const summaryParam = typeof params["summary"] === "string" ? params["summary"].trim() : "";
    const ep = params["episode"] as EpisodeRecord | undefined;
    const summary = summaryParam || textParam || ep?.problem || ep?.request || "";
    if (!summary && !ep) {
      return { content: [{ type: "text", text: "mm: store requires text, summary, or episode (degradation: soft)" }], details: { error: "empty-content" } };
    }
    const date = payloadDate(typeof params["timestamp"] === "string" ? params["timestamp"] : undefined, env.nowProvider());
    const axes = axisPath(env);
    const cwd = memDir(env);
    if (env.cfg.qmapBin === "") return { content: [{ type: "text", text: `mm unavailable: qmap binary not found` }], details: { error: "no-qmap" } };
    try { await mkdir(cwd, { recursive: true }); } catch { /* best-effort */ }

    const embed = sepalConfigured(env.cfg);
    const fspec = filespecFor(cwd, embed);
    const eEnv = embedEnv(env.cfg);
    return await withLock(cwd, async () => {
      const ref = await allocateNextRef(cwd, env.runner, env.cfg.qmapBin, fspec, axes, eEnv);
      const { envelope, isStructured } = buildEnvelope(params, summary, ep);
      const payload = isStructured ? encodePayload(date, envelope) : `${date}:${summary}`;

      const res = await env.runner.run(buildStoreInvocation(env.cfg.qmapBin, fspec, ref, payload, axes, cwd, eEnv));
      if (res.code !== 0) {
        return { content: [{ type: "text", text: `mm store failed (exit ${res.code}): ${res.stderr || res.stdout}` }], details: { ref, key: `@${date}`, error: res.stderr || res.stdout } };
      }
      if (typeof params["supersedes"] === "number") await applySupersedes(env, fspec, axes, cwd, eEnv, params["supersedes"], ref, date);
      if (envelope.context?.grid) await storeSpatialGrid(env, axes, cwd, ref, envelope.context.grid);
      return exportDetail({ ref, key: `@${date}`, level: envelope.level, lifecycle: envelope.lifecycle, summary });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `mm unavailable: ${msg}` }], details: { error: msg } };
  }
}

export function makeStoreTool(envSource: EnvSource): PiToolSpec {
  return {
    name: "memory_store",
    label: "Store Memory",
    description: "Store a memory (raw text or structured mipmap L0-L3 envelope) at a generated ref. Returns the ref and @key.",
    parameters: STORE_PARAMS,
    execute: (_id, params, _sig, _upd, ctx) => executeStore(envSource, params, ctx as PiCtx),
  };
}
