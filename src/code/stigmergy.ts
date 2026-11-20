/**
 * Collective Swarm Stigmergy Across Parallel Sessions & Subagents (src/code/stigmergy.ts).
 * Maintains live spatial attention leases on (filePath, symbolName, startLine, endLine)
 * across concurrent Pi sessions and scratch slots so parallel agents see each other's
 * active mutations and investigations in real time.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRelPath } from "./payload_codec.ts";
import { deriveWorkspaceLabel, resolveSharedCoordinationDir } from "./lore_binding.ts";

export interface SwarmAttentionLease {
  sessionId: string;
  shortId: string;
  workspaceLabel?: string;
  filePath: string;
  symbolName?: string;
  qualifiedName?: string;
  startLine?: number;
  endLine?: number;
  action: "mutating" | "inspecting";
  intent?: string;
  updatedAtMs: number;
}

export interface SwarmStigmergyQuery {
  currentSessionId?: string;
  filePaths?: string[];
  symbolNames?: string[];
  neighborSymbolNames?: string[];
  nowMs?: number;
  ttlMs?: number;
}

export interface SwarmStigmergyMatch {
  lease: SwarmAttentionLease;
  overlapKind: "exact_symbol" | "same_file" | "call_graph_neighbor";
  ageSeconds: number;
}

const SWARM_LEASES_FILENAME = "swarm-leases.json";
export const DEFAULT_SWARM_LEASE_TTL_MS = 15 * 60 * 1000;
const MAX_SWARM_LEASES = 64;

const memoryLeasesByDir = new Map<string, SwarmAttentionLease[]>();

function loadRawLeases(rawIndexDir: string): SwarmAttentionLease[] {
  const indexDir = resolveSharedCoordinationDir(rawIndexDir);
  const filePath = join(indexDir, SWARM_LEASES_FILENAME);
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (x): x is SwarmAttentionLease =>
            Boolean(x && typeof x.sessionId === "string" && typeof x.filePath === "string" && typeof x.updatedAtMs === "number"),
        );
        memoryLeasesByDir.set(indexDir, valid);
        return valid;
      }
    } catch {
      // Fall back to in-memory
    }
  }
  return memoryLeasesByDir.get(indexDir) ?? [];
}

function saveRawLeases(rawIndexDir: string, leases: SwarmAttentionLease[]): void {
  const indexDir = resolveSharedCoordinationDir(rawIndexDir);
  memoryLeasesByDir.set(indexDir, leases);
  try {
    mkdirSync(indexDir, { recursive: true });
    const filePath = join(indexDir, SWARM_LEASES_FILENAME);
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(leases, null, 2), "utf8");
    renameSync(tmpPath, filePath);
  } catch {
    // Best-effort persistence
  }
}

export function clearSwarmLeasesCache(): void {
  memoryLeasesByDir.clear();
}

export function recordSwarmAttentionLease(
  indexDir: string,
  input: Omit<SwarmAttentionLease, "shortId" | "updatedAtMs"> & {
    shortId?: string;
    updatedAtMs?: number;
    ttlMs?: number;
  },
): SwarmAttentionLease | null {
  if (!input.sessionId || input.sessionId === "default-session" || input.sessionId === "unknown-session") {
    return null;
  }
  const nowMs = input.updatedAtMs ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_SWARM_LEASE_TTL_MS;
  const normFile = normalizeRelPath(input.filePath);
  const shortId = input.shortId || input.sessionId.slice(0, 8);

  const existing = loadRawLeases(indexDir).filter((l) => nowMs - l.updatedAtMs <= ttlMs);
  const lease: SwarmAttentionLease = {
    sessionId: input.sessionId,
    shortId,
    workspaceLabel: input.workspaceLabel ?? deriveWorkspaceLabel(indexDir),
    filePath: normFile,
    symbolName: input.symbolName,
    qualifiedName: input.qualifiedName,
    startLine: input.startLine,
    endLine: input.endLine,
    action: input.action,
    intent: input.intent ? input.intent.slice(0, 140) : undefined,
    updatedAtMs: nowMs,
  };

  const filtered = existing.filter(
    (l) => !(l.sessionId === lease.sessionId && l.filePath === lease.filePath && (l.symbolName || "") === (lease.symbolName || "")),
  );
  filtered.push(lease);
  const bounded = filtered.slice(-MAX_SWARM_LEASES);
  saveRawLeases(indexDir, bounded);
  return lease;
}

export function querySwarmStigmergy(
  indexDir: string,
  query: SwarmStigmergyQuery,
): SwarmStigmergyMatch[] {
  const nowMs = query.nowMs ?? Date.now();
  const ttlMs = query.ttlMs ?? DEFAULT_SWARM_LEASE_TTL_MS;
  const active = loadRawLeases(indexDir).filter((l) => nowMs - l.updatedAtMs <= ttlMs);
  if (active.length === 0) return [];

  const targetFiles = new Set((query.filePaths || []).map(normalizeRelPath));
  const targetSyms = new Set(query.symbolNames || []);
  const neighborSyms = new Set(query.neighborSymbolNames || []);

  const matches: SwarmStigmergyMatch[] = [];
  for (const lease of active) {
    if (query.currentSessionId && lease.sessionId === query.currentSessionId) continue;

    let overlapKind: SwarmStigmergyMatch["overlapKind"] | null = null;
    if (lease.symbolName && targetSyms.has(lease.symbolName)) {
      overlapKind = "exact_symbol";
    } else if (targetFiles.has(lease.filePath)) {
      overlapKind = "same_file";
    } else if (lease.symbolName && neighborSyms.has(lease.symbolName)) {
      overlapKind = "call_graph_neighbor";
    }

    if (overlapKind) {
      matches.push({
        lease,
        overlapKind,
        ageSeconds: Math.max(0, Math.floor((nowMs - lease.updatedAtMs) / 1000)),
      });
    }
  }

  return matches.sort((a, b) => {
    const mutA = a.lease.action === "mutating" ? 0 : 1;
    const mutB = b.lease.action === "mutating" ? 0 : 1;
    if (mutA !== mutB) return mutA - mutB;
    return a.ageSeconds - b.ageSeconds;
  });
}

export function formatSwarmStigmergySection(matches: SwarmStigmergyMatch[]): string {
  if (matches.length === 0) return "";
  const lines = [`=== Swarm Stigmergy (Live Parallel Session Activity) ===`];
  for (const m of matches.slice(0, 5)) {
    const l = m.lease;
    const slotTag = l.workspaceLabel ? ` (${l.workspaceLabel})` : "";
    const symPart = l.symbolName ? ` symbol \`${l.symbolName}\` in` : "";
    const spanPart = l.startLine && l.endLine ? `:${l.startLine}-${l.endLine}` : "";
    const relTag = m.overlapKind === "call_graph_neighbor" ? " [call-graph neighbor]" : "";
    const intentPart = l.intent ? ` — "${l.intent}"` : "";
    const verb = l.action === "mutating" ? "⚠️ ACTIVELY MUTATING" : "inspecting";
    lines.push(
      `  • [Parallel Session ${l.shortId}${slotTag}] ${verb}${symPart} ${l.filePath}${spanPart}${relTag} (${m.ageSeconds}s ago)${intentPart}`,
    );
  }
  return lines.join("\n");
}
