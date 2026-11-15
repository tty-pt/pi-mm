import type { SessionTurnEvent } from "./types.ts";

export interface SessionBranchEntry {
  id?: string;
  parentId?: string;
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
  };
}

export interface LineageSessionManagerLike {
  getBranch?: () => SessionBranchEntry[];
  getEntries?: () => SessionBranchEntry[];
  getLeafId?: () => string;
}

export class SessionLineageTracker {
  private readonly parents = new Map<string, string>();
  private readonly children = new Map<string, Set<string>>();
  private latestEntryId?: string;

  /**
   * Registers a node and its parent edge in the session DAG.
   */
  addEntry(entryId: string, parentId?: string): void {
    if (!entryId) return;
    this.latestEntryId = entryId;

    if (parentId) {
      this.parents.set(entryId, parentId);
      if (!this.children.has(parentId)) {
        this.children.set(parentId, new Set());
      }
      this.children.get(parentId)!.add(entryId);
    }
  }

  /**
   * Traces the active ancestry chain from the given leaf up to the root.
   */
  getActiveLineage(leafId?: string): Set<string> {
    const active = new Set<string>();
    let curr = leafId || this.latestEntryId;
    if (!curr) return active;

    const visited = new Set<string>();
    while (curr && !visited.has(curr)) {
      visited.add(curr);
      active.add(curr);
      curr = this.parents.get(curr);
    }

    return active;
  }

  /**
   * Resolves active lineage using sessionManager if available, otherwise DAG tree.
   */
  resolveActiveLineage(
    sessionManager?: LineageSessionManagerLike,
    fallbackLeafId?: string,
  ): Set<string> {
    if (sessionManager?.getBranch) {
      try {
        const branch = sessionManager.getBranch();
        if (Array.isArray(branch) && branch.length > 0) {
          const ids = new Set<string>();
          for (const item of branch) {
            if (item?.id) ids.add(item.id);
          }
          if (ids.size > 0) return ids;
        }
      } catch {
        // Fall back to DAG ancestry
      }
    }

    const leaf = sessionManager?.getLeafId?.() || fallbackLeafId || this.latestEntryId;
    return this.getActiveLineage(leaf);
  }

  /**
   * Filters a list of session events based on lineage scope ('active' vs 'all').
   */
  filterEvents(
    events: SessionTurnEvent[],
    scope: "active" | "all" = "active",
    sessionManager?: LineageSessionManagerLike,
    leafId?: string,
  ): SessionTurnEvent[] {
    if (scope === "all") {
      return [...events];
    }

    const activeSet = this.resolveActiveLineage(sessionManager, leafId);
    if (activeSet.size === 0) {
      return [...events]; // Fallback to all if lineage cannot be established
    }

    const matched = events.filter((ev) => activeSet.has(ev.entryId));
    if (matched.length === 0 && sessionManager?.getBranch) {
      // If events were recorded with synthetic entryIds (e.g. entry-1-user) that don't match
      // sessionManager's internal UUIDs, fall back to returning all events rather than an empty set.
      return [...events];
    }
    return matched;
  }

  getParent(entryId: string): string | undefined {
    return this.parents.get(entryId);
  }

  getChildren(entryId: string): string[] {
    return Array.from(this.children.get(entryId) ?? []);
  }

  clear(): void {
    this.parents.clear();
    this.children.clear();
    this.latestEntryId = undefined;
  }
}
