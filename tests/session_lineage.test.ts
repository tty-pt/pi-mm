import { strict as assert } from "node:assert";
import { SessionLineageTracker } from "../src/session/lineage.ts";
import type { SessionTurnEvent } from "../src/session/types.ts";

Deno.test("SessionLineageTracker: linear session traces all ancestors to root", () => {
  const tracker = new SessionLineageTracker();
  tracker.addEntry("e1");
  tracker.addEntry("e2", "e1");
  tracker.addEntry("e3", "e2");
  tracker.addEntry("e4", "e3");

  const active = tracker.getActiveLineage("e4");
  assert.equal(active.size, 4);
  assert.ok(active.has("e1"));
  assert.ok(active.has("e2"));
  assert.ok(active.has("e3"));
  assert.ok(active.has("e4"));

  // Default without explicit leaf uses latest entry
  const defaultActive = tracker.getActiveLineage();
  assert.equal(defaultActive.size, 4);
  assert.ok(defaultActive.has("e4"));
});

Deno.test("SessionLineageTracker: branches isolate alternative explorations", () => {
  const tracker = new SessionLineageTracker();
  // Main branch: e1 -> e2
  tracker.addEntry("e1");
  tracker.addEntry("e2", "e1");

  // Branch A (abandoned): e2 -> e3a -> e4a
  tracker.addEntry("e3a", "e2");
  tracker.addEntry("e4a", "e3a");

  // Branch B (active fork): e2 -> e3b -> e4b
  tracker.addEntry("e3b", "e2");
  tracker.addEntry("e4b", "e3b");

  // When leaf is e4b, branch A must NOT be in active lineage
  const activeB = tracker.getActiveLineage("e4b");
  assert.equal(activeB.size, 4);
  assert.ok(activeB.has("e1"));
  assert.ok(activeB.has("e2"));
  assert.ok(activeB.has("e3b"));
  assert.ok(activeB.has("e4b"));
  assert.ok(!activeB.has("e3a"));
  assert.ok(!activeB.has("e4a"));

  // When leaf is e4a, branch B must NOT be in active lineage
  const activeA = tracker.getActiveLineage("e4a");
  assert.equal(activeA.size, 4);
  assert.ok(activeA.has("e1"));
  assert.ok(activeA.has("e2"));
  assert.ok(activeA.has("e3a"));
  assert.ok(activeA.has("e4a"));
  assert.ok(!activeA.has("e3b"));
  assert.ok(!activeA.has("e4b"));
});

Deno.test("SessionLineageTracker: filters events by active lineage vs all scope", () => {
  const tracker = new SessionLineageTracker();
  tracker.addEntry("e1");
  tracker.addEntry("e2", "e1");
  tracker.addEntry("e_abandoned", "e2");
  tracker.addEntry("e3", "e2");

  const events: SessionTurnEvent[] = [
    { id: "1", turnIndex: 1, entryId: "e1", timestamp: "", role: "user", speaker: "User", summary: "Start", text: "" },
    { id: "2", turnIndex: 2, entryId: "e2", timestamp: "", role: "assistant", speaker: "Assistant", summary: "Plan", text: "" },
    { id: "3", turnIndex: 3, entryId: "e_abandoned", timestamp: "", role: "tool", speaker: "bash", summary: "Failed approach", text: "" },
    { id: "4", turnIndex: 4, entryId: "e3", timestamp: "", role: "tool", speaker: "bash", summary: "Working approach", text: "" },
  ];

  // Active filter (leaf is e3)
  const activeEvents = tracker.filterEvents(events, "active", undefined, "e3");
  assert.equal(activeEvents.length, 3);
  assert.ok(activeEvents.some((e) => e.entryId === "e1"));
  assert.ok(activeEvents.some((e) => e.entryId === "e2"));
  assert.ok(activeEvents.some((e) => e.entryId === "e3"));
  assert.ok(!activeEvents.some((e) => e.entryId === "e_abandoned"));

  // All scope includes abandoned event
  const allEvents = tracker.filterEvents(events, "all");
  assert.equal(allEvents.length, 4);
  assert.ok(allEvents.some((e) => e.entryId === "e_abandoned"));
});

Deno.test("SessionLineageTracker: integrates with Pi sessionManager.getBranch", () => {
  const tracker = new SessionLineageTracker();
  const mockSessionManager = {
    getBranch: () => [{ id: "branch-root" }, { id: "branch-step1" }, { id: "branch-leaf" }],
  };

  const resolved = tracker.resolveActiveLineage(mockSessionManager);
  assert.equal(resolved.size, 3);
  assert.ok(resolved.has("branch-root"));
  assert.ok(resolved.has("branch-step1"));
  assert.ok(resolved.has("branch-leaf"));
});

Deno.test("SessionLineageTracker: safely terminates on circular parent references", () => {
  const tracker = new SessionLineageTracker();
  tracker.addEntry("c1", "c2");
  tracker.addEntry("c2", "c1"); // cycle!

  const active = tracker.getActiveLineage("c1");
  assert.equal(active.size, 2);
  assert.ok(active.has("c1"));
  assert.ok(active.has("c2"));
});
