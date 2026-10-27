import type { ToolEnv } from "./index.ts";
import { axisPath, memDir, sepalConfigured } from "./index.ts";
import { filespecFor, buildListInvocation, buildGetInvocation, embedEnv } from "../corm.ts";
import { decodePayload, isCleanSummaryText } from "../payload.ts";
import { parseBareRefs } from "../resolve.ts";
import type { MipmapLevel, LifecycleState, MemoryEnvelope } from "../types.ts";
import { debugLog } from "../debug.ts";
import { renderOverviewMarkdown } from "./overview_render.ts";

export interface OverviewItem {
  ref: number;
  level: MipmapLevel;
  lifecycle: LifecycleState;
  date: string;
  project?: string;
  subsystem?: string;
  type?: string;
  summary: string;
  evidenceRefs?: number[];
  approachOutcomes?: { worked: number; failed: number };
}

export interface MemoryOverviewEpoch {
  epoch: string;
  count: number;
  scopes: string[];
  highlights: OverviewItem[];
}

export interface MemoryOverviewResult {
  totalRecords: number;
  scannedRecords: number;
  activeSpan: {
    earliestDate?: string;
    latestDate?: string;
  };
  levelCounts: Record<MipmapLevel, number>;
  scopeCounts: Record<string, number>;
  personaTenets: OverviewItem[];
  principles: OverviewItem[];
  invariantsAndDecisions: OverviewItem[];
  recentMilestones: OverviewItem[];
  timeline: MemoryOverviewEpoch[];
  renderedOverview: string;
}

export interface MemoryOverviewOptions {
  project?: string;
  subsystem?: string;
  level?: MipmapLevel;
  limit?: number;
  maxScan?: number;
}

export function selectOverviewRefs(allRefs: number[], maxScan: number): number[] {
  if (allRefs.length <= maxScan) return allRefs;
  const olderQuota = Math.floor(maxScan * 0.25);
  const newerQuota = maxScan - olderQuota;
  const older = allRefs.slice(0, olderQuota);
  const newer = allRefs.slice(-newerQuota);
  return Array.from(new Set([...older, ...newer]));
}

export async function fetchOverviewItems(
  env: ToolEnv,
  bin: string,
  fspec: string,
  axes: string,
  cwd: string,
  eEnv: Record<string, string>,
  selectedRefs: number[],
): Promise<Array<{ ref: number; date: string; envelope: MemoryEnvelope }>> {
  const BATCH_SIZE = 50;
  const decodedItems: Array<{ ref: number; date: string; envelope: MemoryEnvelope }> = [];

  for (let i = 0; i < selectedRefs.length; i += BATCH_SIZE) {
    const chunk = selectedRefs.slice(i, i + BATCH_SIZE);
    const promises = chunk.map(async (ref) => {
      try {
        const res = await env.runner.run(buildGetInvocation(bin, fspec, ref, axes, cwd, eEnv));
        if (res.code === 0 && res.stdout.trim()) {
          const decoded = decodePayload(res.stdout.trim());
          if (isCleanSummaryText(decoded.envelope.summary) && !decoded.envelope.summary.startsWith("[Corrupted payload")) {
            return { ref, date: decoded.date, envelope: decoded.envelope };
          }
        }
      } catch {
        // Soft fallback per record
      }
      return null;
    });

    const chunkResults = await Promise.all(promises);
    for (const item of chunkResults) {
      if (item) decodedItems.push(item);
    }
  }
  return decodedItems;
}

function calculateApproachOutcomes(envelope: MemoryEnvelope) {
  const approaches = envelope.episode?.approaches;
  if (!approaches || approaches.length === 0) return undefined;
  let worked = 0, failed = 0;
  for (const a of approaches) {
    if (a.outcome === "worked") worked++;
    else failed++;
  }
  return { worked, failed };
}

function bucketOverviewItem(
  item: OverviewItem,
  envelope: MemoryEnvelope,
  personaTenets: OverviewItem[],
  principles: OverviewItem[],
  invariantsAndDecisions: OverviewItem[],
  recentMilestones: OverviewItem[],
): void {
  const proj = item.project;
  const sub = item.subsystem;
  const isPersona = proj === "user" || sub === "persona" || envelope.context?.subject === "user";
  if (isPersona) {
    personaTenets.push(item);
  } else if (item.level === "L3") {
    principles.push(item);
  } else if (item.level === "L2" || item.type === "invariant" || item.type === "decision") {
    invariantsAndDecisions.push(item);
  } else if (item.level === "L1") {
    recentMilestones.push(item);
  }
}

interface CollateContext {
  levelCounts: Record<MipmapLevel, number>;
  scopeCounts: Record<string, number>;
  activeSpan: { earliestDate?: string; latestDate?: string };
  personaTenets: OverviewItem[];
  principles: OverviewItem[];
  invariantsAndDecisions: OverviewItem[];
  recentMilestones: OverviewItem[];
  epochsMap: Map<string, { count: number; scopes: Set<string>; highlights: OverviewItem[] }>;
  options?: MemoryOverviewOptions;
}

function processDecodedItem(
  item: { ref: number; date: string; envelope: MemoryEnvelope },
  ctx: CollateContext,
): void {
  const envItem = item.envelope;
  ctx.levelCounts[envItem.level] = (ctx.levelCounts[envItem.level] || 0) + 1;

  const proj = envItem.context?.project;
  const sub = envItem.context?.subsystem;
  const scopeKey = [proj, sub].filter(Boolean).join("/") || "unscoped";
  ctx.scopeCounts[scopeKey] = (ctx.scopeCounts[scopeKey] || 0) + 1;

  if (item.date) {
    if (!ctx.activeSpan.earliestDate || item.date < ctx.activeSpan.earliestDate) ctx.activeSpan.earliestDate = item.date;
    if (!ctx.activeSpan.latestDate || item.date > ctx.activeSpan.latestDate) ctx.activeSpan.latestDate = item.date;
  }

  const filterProj = ctx.options?.project?.toLowerCase();
  const filterSub = ctx.options?.subsystem?.toLowerCase();
  const filterLvl = ctx.options?.level;

  if (filterLvl && envItem.level !== filterLvl) return;
  if (filterProj && proj?.toLowerCase() !== filterProj) return;
  if (filterSub && sub?.toLowerCase() !== filterSub) return;
  if (envItem.lifecycle === "contradicted" || envItem.lifecycle === "superseded") return;

  const overviewItem: OverviewItem = {
    ref: item.ref,
    level: envItem.level,
    lifecycle: envItem.lifecycle,
    date: item.date,
    project: proj,
    subsystem: sub,
    type: envItem.type,
    summary: envItem.summary,
    evidenceRefs: envItem.evidence,
    approachOutcomes: calculateApproachOutcomes(envItem),
  };

  bucketOverviewItem(overviewItem, envItem, ctx.personaTenets, ctx.principles, ctx.invariantsAndDecisions, ctx.recentMilestones);

  const epochKey = item.date ? (item.date.length >= 7 ? item.date.slice(0, 7) : item.date) : "undated";
  let epochEntry = ctx.epochsMap.get(epochKey);
  if (!epochEntry) {
    epochEntry = { count: 0, scopes: new Set<string>(), highlights: [] };
    ctx.epochsMap.set(epochKey, epochEntry);
  }
  epochEntry.count++;
  if (scopeKey !== "unscoped") epochEntry.scopes.add(scopeKey);
  if (envItem.level !== "L0" && epochEntry.highlights.length < 5) {
    epochEntry.highlights.push(overviewItem);
  }
}

export function collateOverview(
  decodedItems: Array<{ ref: number; date: string; envelope: MemoryEnvelope }>,
  totalRecords: number,
  targetLimit: number,
  options?: MemoryOverviewOptions,
): MemoryOverviewResult {
  const collateCtx: CollateContext = {
    levelCounts: { L0: 0, L1: 0, L2: 0, L3: 0 },
    scopeCounts: {},
    activeSpan: {},
    personaTenets: [],
    principles: [],
    invariantsAndDecisions: [],
    recentMilestones: [],
    epochsMap: new Map(),
    options,
  };

  for (const item of decodedItems) {
    processDecodedItem(item, collateCtx);
  }

  const timeline: MemoryOverviewEpoch[] = [];
  for (const ep of Array.from(collateCtx.epochsMap.keys()).sort()) {
    const data = collateCtx.epochsMap.get(ep)!;
    timeline.push({ epoch: ep, count: data.count, scopes: Array.from(data.scopes).sort(), highlights: data.highlights });
  }

  const renderedOverview = renderOverviewMarkdown({
    totalRecords,
    scannedRecords: decodedItems.length,
    activeSpan: collateCtx.activeSpan,
    levelCounts: collateCtx.levelCounts,
    scopeCounts: collateCtx.scopeCounts,
    personaTenets: collateCtx.personaTenets.slice(-targetLimit),
    principles: collateCtx.principles.slice(-targetLimit),
    invariantsAndDecisions: collateCtx.invariantsAndDecisions.slice(-targetLimit),
    recentMilestones: collateCtx.recentMilestones.slice(-targetLimit),
    timeline,
  });

  return {
    totalRecords,
    scannedRecords: decodedItems.length,
    activeSpan: collateCtx.activeSpan,
    levelCounts: collateCtx.levelCounts,
    scopeCounts: collateCtx.scopeCounts,
    personaTenets: collateCtx.personaTenets,
    principles: collateCtx.principles,
    invariantsAndDecisions: collateCtx.invariantsAndDecisions,
    recentMilestones: collateCtx.recentMilestones,
    timeline,
    renderedOverview,
  };
}

export async function buildMemoryOverview(
  env: ToolEnv,
  options?: MemoryOverviewOptions,
): Promise<MemoryOverviewResult> {
  const bin = env.cfg.cormBin;
  if (!bin) {
    return {
      totalRecords: 0,
      scannedRecords: 0,
      activeSpan: {},
      levelCounts: { L0: 0, L1: 0, L2: 0, L3: 0 },
      scopeCounts: {},
      personaTenets: [],
      principles: [],
      invariantsAndDecisions: [],
      recentMilestones: [],
      timeline: [],
      renderedOverview: "Memory overview unavailable: corm binary not configured.",
    };
  }

  const embed = sepalConfigured(env.cfg);
  const cwd = memDir(env);
  const fspec = filespecFor(cwd, embed);
  const axes = axisPath(env);
  const eEnv = embedEnv(env.cfg);

  const listRes = await env.runner.run(buildListInvocation(bin, fspec, axes, cwd, eEnv));
  const allRefs = parseBareRefs(listRes.stdout);
  const totalRecords = allRefs.length;

  if (totalRecords === 0) {
    return {
      totalRecords: 0,
      scannedRecords: 0,
      activeSpan: {},
      levelCounts: { L0: 0, L1: 0, L2: 0, L3: 0 },
      scopeCounts: {},
      personaTenets: [],
      principles: [],
      invariantsAndDecisions: [],
      recentMilestones: [],
      timeline: [],
      renderedOverview: "No stored memories found in database.",
    };
  }

  const maxScan = Math.min(Math.max(options?.maxScan ?? 250, 20), 1000);
  const targetLimit = Math.min(Math.max(options?.limit ?? 20, 1), 50);
  const selectedRefs = selectOverviewRefs(allRefs, maxScan);
  const decodedItems = await fetchOverviewItems(env, bin, fspec, axes, cwd, eEnv, selectedRefs);

  debugLog("recall", "buildMemoryOverview generated overview", {
    totalRecords,
    scanned: decodedItems.length,
    selected: selectedRefs.length,
  });

  return collateOverview(decodedItems, totalRecords, targetLimit, options);
}
