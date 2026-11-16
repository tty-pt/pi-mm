import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  SessionStore,
  listCandidateSessionCacheRoots,
  extractWorkspaceLabel,
} from "./store.ts";
import { SessionSink } from "./sink.ts";
import { SessionLineageTracker } from "./lineage.ts";
import { SessionRecallEngine } from "./recall.ts";
import type { SessionOriginKind, SessionStoreOptions } from "./types.ts";
import { resolveSessionFilePath } from "../session_history.ts";
import { debugLog } from "../debug.ts";

export interface SessionContextInstances {
  store: SessionStore;
  sink: SessionSink;
  tracker: SessionLineageTracker;
  engine: SessionRecallEngine;
  origin?: SessionOriginKind;
  sourceMemoryRef?: number;
}

export interface DiscoveredSessionEntry {
  sessionId: string;
  shortId: string;
  sessionDir: string;
  manifestPath: string;
  mtimeMs: number;
  origin: SessionOriginKind;
  workspaceLabel?: string;
  sourceMemoryRef?: number;
  instances: SessionContextInstances;
}

export interface DiscoverPeerSessionsOptions {
  cwd?: string;
  currentSessionId: string;
  maxAgeMs?: number;
  maxPeers?: number;
  includeAllAges?: boolean;
  sessionOpts?: Omit<SessionStoreOptions, "sessionId">;
}

export interface EnsureSessionIndexedOptions {
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  sourceRef?: number;
  sessionOpts?: Omit<SessionStoreOptions, "sessionId">;
}

const DEFAULT_PARALLEL_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_PEERS = 8;

const activeSessions = new Map<string, SessionContextInstances>();
const persistentSessionRefs = new Map<string, number>();

function resolveExistingSessionDir(sessionId: string, cwd?: string, explicitDir?: string): string | undefined {
  if (explicitDir) return explicitDir;
  const roots = listCandidateSessionCacheRoots(cwd);
  for (const root of roots) {
    const candidate = join(root, sessionId);
    if (existsSync(join(candidate, "events.json"))) {
      return candidate;
    }
  }
  return undefined;
}

export function extractSessionIdFromJsonlFileSync(filePath: string): { sessionId?: string; cwd?: string } {
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, "utf-8");
    const nlIdx = raw.indexOf("\n");
    const firstLine = (nlIdx >= 0 ? raw.slice(0, nlIdx) : raw).trim();
    if (firstLine.startsWith("{")) {
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      if (parsed["type"] === "session") {
        const id = typeof parsed["id"] === "string" ? parsed["id"].trim() : undefined;
        const cwd = typeof parsed["cwd"] === "string" ? parsed["cwd"].trim() : undefined;
        if (id) return { sessionId: id, cwd };
      }
    }
  } catch {
    // Fallback to filename stem
  }
  const base = basename(filePath);
  const stem = base.endsWith(".jsonl")
    ? base.slice(0, -6)
    : base.endsWith(".json")
    ? base.slice(0, -5)
    : base;
  return { sessionId: stem || undefined };
}

export function getSessionInstances(
  sessionId: string = "default-session",
  options?: Omit<SessionStoreOptions, "sessionId">,
): SessionContextInstances {
  const existing = activeSessions.get(sessionId);
  if (existing) {
    if (options) {
      existing.store.configure(options);
      if (options.cwd && !existing.store.getMetadata().cwd) {
        existing.store.setWorkspaceCwd(options.cwd);
      }
      if (options.sessionFile) existing.store.setSessionFile(options.sessionFile);
    }
    existing.store.refreshFromDiskIfNeeded(existing.tracker);
    const ref = persistentSessionRefs.get(sessionId);
    if (ref !== undefined) {
      existing.sourceMemoryRef = ref;
    }
    return existing;
  }

  const existingDir = resolveExistingSessionDir(sessionId, options?.cwd, options?.sessionDir);

  const store = new SessionStore({
    sessionId,
    cwd: options?.cwd,
    sessionDir: existingDir ?? options?.sessionDir,
    workspaceLabel: options?.workspaceLabel,
    sessionFile: options?.sessionFile,
    cormBin: options?.cormBin,
    axisLibs: options?.axisLibs,
    embedUrl: options?.embedUrl,
    embedModel: options?.embedModel,
    embedKey: options?.embedKey,
    ephemeralSepal: options?.ephemeralSepal,
  });

  const tracker = new SessionLineageTracker();
  store.attachTracker(tracker);

  let maxTurn = 1;
  let lastEntryId: string | undefined;
  let lastParentId: string | undefined;
  for (const ev of store.getAllEvents()) {
    if (ev.entryId) {
      tracker.addEntry(ev.entryId, ev.parentId);
      lastEntryId = ev.entryId;
      lastParentId = ev.parentId;
    }
    if (ev.turnIndex > maxTurn) maxTurn = ev.turnIndex;
  }

  const sink = new SessionSink(store, tracker);
  if (lastEntryId) {
    sink.setTurn(maxTurn, lastEntryId, lastParentId);
  }
  const engine = new SessionRecallEngine(store, tracker);

  const sourceMemoryRef = persistentSessionRefs.get(sessionId);
  const instances: SessionContextInstances = {
    store,
    sink,
    tracker,
    engine,
    sourceMemoryRef,
  };
  activeSessions.set(sessionId, instances);

  debugLog("session", "Created new session context instances", { sessionId });
  return instances;
}

export function registerPersistentSessionRef(sessionId: string, memoryRef: number): void {
  if (!sessionId || !Number.isInteger(memoryRef)) return;
  persistentSessionRefs.set(sessionId, memoryRef);
  const existing = activeSessions.get(sessionId);
  if (existing) {
    existing.sourceMemoryRef = memoryRef;
    if (!existing.origin) existing.origin = "persistent-ref";
  }
}

export function getPersistentSessionRef(sessionId: string): number | undefined {
  return persistentSessionRefs.get(sessionId);
}

/**
 * Ensures a historical or sibling session is hydrated into a SessionStore in .pi/cache/sessions/<sessionId>.
 */
export async function ensureSessionIndexed(
  options: EnsureSessionIndexedOptions,
): Promise<SessionContextInstances | null> {
  const resolvedPath = await resolveSessionFilePath(
    options.sessionFile,
    options.sessionId,
    options.cwd,
  );

  let sessionId = options.sessionId?.trim();
  let fileCwd: string | undefined;
  if (resolvedPath) {
    const header = extractSessionIdFromJsonlFileSync(resolvedPath);
    if (!sessionId && header.sessionId) {
      sessionId = header.sessionId;
    }
    fileCwd = header.cwd;
  }

  if (!sessionId) {
    return null;
  }

  if (options.sourceRef !== undefined) {
    registerPersistentSessionRef(sessionId, options.sourceRef);
  }

  const inst = getSessionInstances(sessionId, {
    ...options.sessionOpts,
    cwd: fileCwd || options.cwd || options.sessionOpts?.cwd,
    sessionFile: resolvedPath ?? options.sessionFile,
  });

  if (options.sourceRef !== undefined) {
    inst.sourceMemoryRef = options.sourceRef;
    if (!inst.origin) inst.origin = "persistent-ref";
  }

  if (resolvedPath) {
    inst.store.setSessionFile(resolvedPath);
    if (fileCwd) inst.store.setWorkspaceCwd(fileCwd);
    inst.store.hydrateFromJsonlFile(resolvedPath, inst.tracker);
  }

  if (inst.store.getEventCount() === 0) {
    return null;
  }

  return inst;
}

/**
 * Lazily discovers the current session, active parallel sessions across worktrees/terminals,
 * and any historical sessions mounted via persistent memory references.
 */
export function discoverPeerSessions(
  options: DiscoverPeerSessionsOptions,
): DiscoveredSessionEntry[] {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_PARALLEL_MAX_AGE_MS;
  const maxPeers = options.maxPeers ?? DEFAULT_MAX_PEERS;
  const now = Date.now();
  const roots = listCandidateSessionCacheRoots(options.cwd);

  const candidateDirs = new Map<string, { sessionDir: string; manifestPath: string; mtimeMs: number }>();

  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const entries = readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionId = entry.name;
        const sessionDir = join(root, sessionId);
        const manifestPath = join(sessionDir, "events.json");
        if (!existsSync(manifestPath)) continue;
        try {
          const st = statSync(manifestPath);
          const prev = candidateDirs.get(sessionId);
          if (!prev || st.mtimeMs > prev.mtimeMs) {
            candidateDirs.set(sessionId, {
              sessionDir,
              manifestPath,
              mtimeMs: st.mtimeMs,
            });
          }
        } catch {
          // Ignore unreadable manifest
        }
      }
    } catch {
      // Ignore unreadable root
    }
  }

  // Also include any in-memory active sessions not yet on disk
  for (const [sessionId, inst] of activeSessions.entries()) {
    if (!candidateDirs.has(sessionId) && inst.store.getEventCount() > 0) {
      let mtimeMs = now;
      if (existsSync(inst.store.manifestPath)) {
        try {
          mtimeMs = statSync(inst.store.manifestPath).mtimeMs;
        } catch {
          // use now
        }
      }
      candidateDirs.set(sessionId, {
        sessionDir: inst.store.sessionDir,
        manifestPath: inst.store.manifestPath,
        mtimeMs,
      });
    }
  }

  const buildEntry = (
    sessionId: string,
    info: { sessionDir: string; manifestPath: string; mtimeMs: number },
    origin: SessionOriginKind,
  ): DiscoveredSessionEntry | null => {
    const instances = getSessionInstances(sessionId, {
      ...options.sessionOpts,
      cwd: origin === "current" ? (options.cwd ?? options.sessionOpts?.cwd) : undefined,
      sessionDir: info.sessionDir,
    });
    instances.store.refreshFromDiskIfNeeded(instances.tracker);
    if (instances.store.getEventCount() === 0 && sessionId !== options.currentSessionId) {
      return null;
    }
    const meta = instances.store.getMetadata();
    const sourceMemoryRef = persistentSessionRefs.get(sessionId) ?? instances.sourceMemoryRef;
    return {
      sessionId,
      shortId: meta.shortId,
      sessionDir: info.sessionDir,
      manifestPath: info.manifestPath,
      mtimeMs: info.mtimeMs,
      origin,
      workspaceLabel: meta.workspaceLabel || extractWorkspaceLabel(meta.cwd),
      sourceMemoryRef,
      instances,
    };
  };

  const results: DiscoveredSessionEntry[] = [];
  const currentInfo = candidateDirs.get(options.currentSessionId);
  if (currentInfo) {
    const currEntry = buildEntry(options.currentSessionId, currentInfo, "current");
    if (currEntry) results.push(currEntry);
  } else {
    const currInst = getSessionInstances(options.currentSessionId, {
      ...options.sessionOpts,
      cwd: options.cwd ?? options.sessionOpts?.cwd,
    });
    const meta = currInst.store.getMetadata();
    results.push({
      sessionId: options.currentSessionId,
      shortId: meta.shortId,
      sessionDir: currInst.store.sessionDir,
      manifestPath: currInst.store.manifestPath,
      mtimeMs: now,
      origin: "current",
      workspaceLabel: meta.workspaceLabel,
      instances: currInst,
    });
  }

  const parallelCandidates: Array<{ sessionId: string; info: { sessionDir: string; manifestPath: string; mtimeMs: number } }> = [];
  const persistentCandidates: Array<{ sessionId: string; info: { sessionDir: string; manifestPath: string; mtimeMs: number } }> = [];

  for (const [sessionId, info] of candidateDirs.entries()) {
    if (sessionId === options.currentSessionId) continue;
    if (persistentSessionRefs.has(sessionId)) {
      persistentCandidates.push({ sessionId, info });
      continue;
    }
    if (options.includeAllAges || now - info.mtimeMs <= maxAgeMs) {
      parallelCandidates.push({ sessionId, info });
    }
  }

  parallelCandidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  for (const cand of parallelCandidates.slice(0, maxPeers)) {
    const entry = buildEntry(cand.sessionId, cand.info, "parallel");
    if (entry) results.push(entry);
  }

  persistentCandidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  for (const cand of persistentCandidates) {
    const entry = buildEntry(cand.sessionId, cand.info, "persistent-ref");
    if (entry) results.push(entry);
  }

  return results;
}

/**
 * Resolves a user-supplied `session` selector ("current", "parallel", "all", UUID prefix, or slot label like "slot-6").
 */
export function resolveTargetSessions(
  selector: string | undefined,
  options: DiscoverPeerSessionsOptions,
): DiscoveredSessionEntry[] {
  const cleanSelector = (selector || "").trim();
  const norm = cleanSelector.toLowerCase();

  if (!cleanSelector || norm === "current") {
    const all = discoverPeerSessions({ ...options, maxPeers: 0 });
    return all.filter((e) => e.origin === "current");
  }

  if (norm === "parallel") {
    const all = discoverPeerSessions(options);
    return all.filter((e) => e.origin === "parallel");
  }

  if (norm === "all") {
    return discoverPeerSessions(options);
  }

  // Specific session ID, prefix, or workspace/slot label: search across all cached sessions regardless of age
  const all = discoverPeerSessions({
    ...options,
    includeAllAges: true,
    maxPeers: 64,
  });

  const matched = all.filter((entry) => {
    const idLower = entry.sessionId.toLowerCase();
    const shortLower = entry.shortId.toLowerCase();
    const labelLower = (entry.workspaceLabel || "").toLowerCase();
    const cwdLower = (entry.instances.store.getMetadata().cwd || "").toLowerCase();
    if (idLower === norm || shortLower === norm || idLower.startsWith(norm)) {
      return true;
    }
    if (labelLower && labelLower === norm) {
      return true;
    }
    if (cwdLower && (cwdLower.endsWith(`/${norm}`) || cwdLower.includes(`/.pi/scratch/${norm}`))) {
      return true;
    }
    if (entry.sourceMemoryRef !== undefined && norm === `ref:${entry.sourceMemoryRef}`) {
      return true;
    }
    return false;
  });

  return matched;
}

export function closeSessionInstances(sessionId: string): void {
  const existing = activeSessions.get(sessionId);
  if (existing) {
    existing.store.clear();
    existing.tracker.clear();
    activeSessions.delete(sessionId);
    persistentSessionRefs.delete(sessionId);
    debugLog("session", "Closed session context instances", { sessionId });
  }
}

export function clearAllSessionInstances(): void {
  for (const [, inst] of activeSessions.entries()) {
    inst.store.clear();
    inst.tracker.clear();
  }
  activeSessions.clear();
  persistentSessionRefs.clear();
}
