// Consolidation pipeline health lines for `/mm doctor`.
//
// The mipmap hierarchy (L0 -> L1 -> L2 -> L3) can stall silently: a wedged L0 queue or unconfigured
// synthesis leaves recall searching raw tool echoes. These lines make queue depth, staleness, and
// synthesis availability visible.
import { synthStatus, type MmConfig } from "../config.ts";
import type { ConsolidationJournal } from "./consolidation_journal.ts";

const STALE_L2_DAYS = 3;
const L0_BACKLOG_WARN = 500;

export function describeConsolidationPipeline(cfg: MmConfig, journal: ConsolidationJournal, now: Date): string[] {
  const lines: string[] = [];
  const synth = synthStatus(cfg);
  lines.push(`${synth.on ? "[✓]" : "[✗]"} Synthesis (L2/L3): ${synth.on ? "on" : "off"} (${synth.detail})`);

  const pendingL0 = journal.pendingL0Refs?.length ?? 0;
  const dirtyL1 = Object.values(journal.dirtyScopes ?? {}).reduce((n, s) => n + (s.l1Refs?.length ?? s.count ?? 0), 0);
  const scopes = Object.keys(journal.dirtyScopes ?? {}).length;
  const lastL2 = journal.dirtyL2?.lastUpdated;
  const lastL2Day = lastL2 ? lastL2.slice(0, 10) : "never";
  lines.push(`${pendingL0 > L0_BACKLOG_WARN ? "[!]" : "[-]"} Queue: pendingL0=${pendingL0} dirtyL1=${dirtyL1} (${scopes} scope(s)) lastL2=${lastL2Day} drain=${cfg.consolidateDrainMs ?? 0}ms/turn`);

  if (pendingL0 > L0_BACKLOG_WARN) {
    lines.push(`[!] L0 backlog is large; it drains newest-first in ${cfg.consolidateBatchLimit ?? 20}-ref batches (raise PI_MM_CONSOLIDATE_DRAIN_MS to drain faster).`);
  }
  if (dirtyL1 > 0 && lastL2) {
    const ageDays = (now.getTime() - new Date(lastL2).getTime()) / 86_400_000;
    if (ageDays > STALE_L2_DAYS) {
      lines.push(`[!] L2 consolidation stale for ${Math.floor(ageDays)} day(s) with ${dirtyL1} L1 waiting${synth.on ? "" : " (synthesis is off)"}.`);
    }
  } else if (dirtyL1 > 0 && !synth.on) {
    lines.push(`[!] ${dirtyL1} L1 record(s) waiting for L2, but synthesis is off.`);
  }
  return lines;
}
