import { SessionStore } from "./store.ts";
import { SessionSink } from "./sink.ts";
import { SessionLineageTracker } from "./lineage.ts";
import { SessionRecallEngine } from "./recall.ts";
import type { SessionStoreOptions } from "./types.ts";
import { debugLog } from "../debug.ts";

interface SessionContextInstances {
  store: SessionStore;
  sink: SessionSink;
  tracker: SessionLineageTracker;
  engine: SessionRecallEngine;
}

const activeSessions = new Map<string, SessionContextInstances>();

export function getSessionInstances(
  sessionId: string = "default-session",
  options?: Omit<SessionStoreOptions, "sessionId">,
): SessionContextInstances {
  const existing = activeSessions.get(sessionId);
  if (existing) {
    if (options) {
      existing.store.configure(options);
    }
    return existing;
  }

  const store = new SessionStore({
    sessionId,
    cwd: options?.cwd,
    sessionDir: options?.sessionDir,
    cormBin: options?.cormBin,
    axisLibs: options?.axisLibs,
    embedUrl: options?.embedUrl,
    embedModel: options?.embedModel,
    embedKey: options?.embedKey,
    ephemeralSepal: options?.ephemeralSepal,
  });

  const tracker = new SessionLineageTracker();
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

  const instances: SessionContextInstances = { store, sink, tracker, engine };
  activeSessions.set(sessionId, instances);

  debugLog("session", "Created new session context instances", { sessionId });
  return instances;
}

export function closeSessionInstances(sessionId: string): void {
  const existing = activeSessions.get(sessionId);
  if (existing) {
    existing.store.clear();
    existing.tracker.clear();
    activeSessions.delete(sessionId);
    debugLog("session", "Closed session context instances", { sessionId });
  }
}

export function clearAllSessionInstances(): void {
  for (const [id, inst] of activeSessions.entries()) {
    inst.store.clear();
    inst.tracker.clear();
  }
  activeSessions.clear();
}
