import type { MipmapLevel } from "../types.ts";
import type { OverviewItem, MemoryOverviewEpoch } from "./overview.ts";

export interface RenderOverviewData {
  totalRecords: number;
  scannedRecords: number;
  activeSpan: { earliestDate?: string; latestDate?: string };
  levelCounts: Record<MipmapLevel, number>;
  scopeCounts: Record<string, number>;
  personaTenets: OverviewItem[];
  principles: OverviewItem[];
  invariantsAndDecisions: OverviewItem[];
  recentMilestones: OverviewItem[];
  timeline: MemoryOverviewEpoch[];
}

export function renderOverviewMarkdown(data: RenderOverviewData): string {
  const lines: string[] = [];
  lines.push("# Memory System Overview (All-Time High-Level Recall)");

  const dateSpan = data.activeSpan.earliestDate && data.activeSpan.latestDate
    ? `${data.activeSpan.earliestDate} to ${data.activeSpan.latestDate}`
    : "all recorded sessions";

  lines.push(`- Total Records: ${data.totalRecords} (${data.scannedRecords} evaluated across ${dateSpan})`);
  lines.push(`- Mipmap Distribution: L3: ${data.levelCounts.L3}, L2: ${data.levelCounts.L2}, L1: ${data.levelCounts.L1}, L0: ${data.levelCounts.L0}`);

  const topScopes = Object.entries(data.scopeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s, c]) => `${s} (${c})`)
    .join(", ");
  if (topScopes) {
    lines.push(`- Active Domains & Scopes: ${topScopes}`);
  }
  lines.push("");

  renderPersonaTenets(lines, data.personaTenets);
  renderPrinciples(lines, data.principles);
  renderInvariants(lines, data.invariantsAndDecisions);
  renderRecentMilestones(lines, data.recentMilestones);
  renderTimeline(lines, data.timeline);

  lines.push("---");
  lines.push("💡 **Zoom-In & Navigation:**");
  lines.push("- To zoom into any memory and inspect its full approaches, diffs, and evidence tree, call: `memory_recall({ zoomRef: <ref> })`");
  lines.push("- To search semantically for related knowledge, call: `memory_recall({ query: \"<question or concept>\" })`");

  return lines.join("\n");
}

function renderPersonaTenets(lines: string[], personaTenets: OverviewItem[]): void {
  if (personaTenets.length === 0) return;
  lines.push("## User Persona & Core Tenets");
  for (const p of personaTenets) {
    lines.push(`- [Ref ${p.ref}] (${p.level}, ${p.lifecycle}): ${p.summary}`);
  }
  lines.push("");
}

function renderPrinciples(lines: string[], principles: OverviewItem[]): void {
  if (principles.length === 0) return;
  lines.push("## Universal Principles (L3)");
  for (const pr of principles) {
    const scope = [pr.project, pr.subsystem].filter(Boolean).join("/");
    const scopeLabel = scope ? ` [${scope}]` : "";
    lines.push(`- [Ref ${pr.ref}] (L3, ${pr.lifecycle}${scopeLabel}): ${pr.summary}`);
    if (pr.evidenceRefs && pr.evidenceRefs.length > 0) {
      lines.push(`  Underlying Evidence: cited refs [${pr.evidenceRefs.join(", ")}]`);
    }
  }
  lines.push("");
}

function renderInvariants(lines: string[], invariants: OverviewItem[]): void {
  if (invariants.length === 0) return;
  lines.push("## Architectural Invariants & Decisions (L2)");
  for (const inv of invariants) {
    const scope = [inv.project, inv.subsystem].filter(Boolean).join("/");
    const scopeLabel = scope ? ` [${scope}]` : "";
    lines.push(`- [Ref ${inv.ref}] (L2, ${inv.lifecycle}${scopeLabel}): ${inv.summary}`);
    if (inv.evidenceRefs && inv.evidenceRefs.length > 0) {
      lines.push(`  Evidence: cited refs [${inv.evidenceRefs.join(", ")}]`);
    }
  }
  lines.push("");
}

function renderRecentMilestones(lines: string[], milestones: OverviewItem[]): void {
  if (milestones.length === 0) return;
  lines.push("## Key Task Investigations & Milestones (L1)");
  for (const m of milestones.slice(-8)) {
    const scope = [m.project, m.subsystem].filter(Boolean).join("/");
    const scopeLabel = scope ? ` [${scope}]` : "";
    const dateLabel = m.date ? ` (${m.date})` : "";
    lines.push(`- [Ref ${m.ref}] (L1, ${m.lifecycle}${scopeLabel}${dateLabel}): ${m.summary}`);
    if (m.approachOutcomes) {
      lines.push(`  Approaches: ${m.approachOutcomes.worked} worked, ${m.approachOutcomes.failed} failed`);
    }
  }
  lines.push("");
}

function renderTimeline(lines: string[], timeline: MemoryOverviewEpoch[]): void {
  if (timeline.length === 0) return;
  lines.push("## Chronological Timeline");
  for (const ep of timeline) {
    const scopeList = ep.scopes.length > 0 ? ` [${ep.scopes.join(", ")}]` : "";
    lines.push(`- **Epoch ${ep.epoch}** (${ep.count} memories${scopeList}):`);
    for (const h of ep.highlights.slice(0, 3)) {
      lines.push(`  • [Ref ${h.ref}] (${h.level}): ${h.summary}`);
    }
  }
  lines.push("");
}
