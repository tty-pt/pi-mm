import type { MmConfig, ReinforcementConfig } from "../config.ts";
import { DEFAULT_REINFORCEMENT_CONFIG, directiveEmbed, directiveFallback } from "../config.ts";
import { existsSync, readdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyDirectiveByEmbedding } from "../judge/adapter.ts";

export interface StandingDirectiveItem {
  ref: number;
  summary: string;
  subsystem?: string;
  project?: string;
}

export const STANDING_DIRECTIVE_PATTERN =
  /(?:always\s+remember(?:\s+to)?|remember\s+(?:this\s+)?(?:forever|permanently|always)\s+(?:to\b|never\b|always\b|do\s+not\b|don't\b)|never\s+forget\s+to\b|remember\s+this\s+rule|from\s+now\s+on[\s,]+(?:always|never|do\s+not|don't)|never\s+(?:use|do|edit|commit|modify|mock|skip)|our\s+rule\s+is|standing\s+rule|invariant:|regra\s+permanente:|diretriz\s+permanente:|lembre-se\s+sempre\s+de\b)/i;

export const NATURAL_ANCHOR_PATTERN =
  /(?:@remember\b|^\s*remember:|^\s*note:|\bremember\s+(?:this\s+)?(?:forever|permanently|always)\b|\balways\s+remember\b|\bnever\s+forget\b|\bdon't\s+forget\b|\bkeep\s+in\s+mind\s+(?:that|forever|always)\b|\blembre-se\s+sempre\b|\bnunca\s+esque[cç]a\b)/i;

export function isStandingDirective(prompt?: string): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  return STANDING_DIRECTIVE_PATTERN.test(prompt);
}

export function isNaturalAnchor(prompt?: string): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  return NATURAL_ANCHOR_PATTERN.test(prompt);
}

export function stripNaturalRememberPrefix(prompt: string): string {
  const cleaned = prompt
    .trim()
    .replace(/^(?:please\s+)?(?:remember\s+(?:this\s+)?(?:forever|permanently|always)(?:\s+that|\s+to)?|always\s+remember(?:\s+that|\s+to)?|never\s+forget(?:\s+that|\s+to)?|don't\s+forget(?:\s+that|\s+to)?|keep\s+in\s+mind(?:\s+forever|\s+always)?(?:\s+that)?|remember\s+this\s+rule|lembre-se\s+sempre(?:\s+que|\s+de)?|nunca\s+esque[cç]a(?:\s+que|\s+de)?)[\s:,-]*/i, "")
    .trim();
  return cleaned.length >= 4 ? cleaned : prompt.trim();
}

export function extractDirectiveClause(prompt: string): string {
  if (!prompt || typeof prompt !== "string") return "";
  const trimmed = prompt.trim();
  const clauses = trimmed
    .split(/(?<=[.!?])\s+|\n+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (clauses.length <= 1) return trimmed;
  const matching = clauses.filter(
    (c) =>
      isStandingDirective(c) ||
      isNaturalAnchor(c) ||
      /^(?:also[\s,]+)?(?:always|never|do\s+not|don't|from\s+now\s+on|in\s+all\s+future)/i.test(c),
  );
  if (matching.length > 0) {
    return matching
      .join(" ")
      .replace(/^(?:also|and|by\s+the\s+way|btw)[\s,:-]+/i, "")
      .trim();
  }
  return trimmed;
}

export async function evaluateStandingDirective(
  prompt?: string,
  cfg?: MmConfig,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  if (!prompt || typeof prompt !== "string") return false;
  const candidateClause = extractDirectiveClause(prompt);
  const probes = candidateClause !== prompt.trim() ? [candidateClause, prompt] : [prompt];
  if (cfg && directiveEmbed(cfg) !== "off") {
    for (const probe of probes) {
      try {
        const verdict = await classifyDirectiveByEmbedding(probe, cfg, fetchFn);
        if (verdict === "standing_directive") return true;
        if (verdict === "transient_task" && probes.length === 1) return false;
      } catch {
        // Endpoint error or timeout
      }
    }
    const fb = directiveFallback(cfg);
    if (fb === "skip") return false;
    return probes.some((p) => isStandingDirective(p));
  }
  return probes.some((p) => isStandingDirective(p));
}

export async function syncDirectivesFile(
  cwd: string,
  scheduler: ReinforcementScheduler,
  removedRefs: number[] = [],
): Promise<void> {
  const filePath = join(cwd, "standing_directives.json");
  const merged = new Map<number, StandingDirectiveItem>();
  const removedSet = new Set<number>(removedRefs);

  try {
    if (existsSync(filePath)) {
      const raw = JSON.parse(await readFile(filePath, "utf8"));
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (
            item &&
            typeof item.ref === "number" &&
            typeof item.summary === "string" &&
            !removedSet.has(item.ref)
          ) {
            merged.set(item.ref, item);
            scheduler.registerDirective(item);
          }
        }
      }
    }
  } catch {
    // Ignore malformed or missing file
  }

  for (const r of removedSet) {
    scheduler.unregisterDirective(r);
    merged.delete(r);
  }

  for (const item of scheduler.getDirectives()) {
    if (!removedSet.has(item.ref)) {
      merged.set(item.ref, item);
    }
  }

  const out = Array.from(merged.values()).sort((a, b) => a.ref - b.ref);
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tmpPath, JSON.stringify(out, null, 2), "utf8");
    await rename(tmpPath, filePath);
  } catch {
    await writeFile(filePath, JSON.stringify(out, null, 2), "utf8").catch(() => {});
  }
}

export interface ReinforcementTriggerResult {
  trigger: boolean;
  reason?: "session_start" | "compaction" | "milestone";
  milestone?: number;
}

export interface ReinforcementCtx {
  cwd?: string;
  hasUI?: boolean;
  mode?: string;
}

export class ReinforcementScheduler {
  private lastMilestoneIndex = -1;
  private sessionStartTriggered = false;
  private compactionResetPending = false;
  private directives: Map<number, StandingDirectiveItem> = new Map();

  public onSessionStart(): void {
    this.lastMilestoneIndex = -1;
    this.sessionStartTriggered = false;
    this.compactionResetPending = false;
  }

  public onCompaction(): void {
    this.lastMilestoneIndex = -1;
    this.compactionResetPending = true;
  }

  public registerDirective(item: StandingDirectiveItem): void {
    this.directives.set(item.ref, item);
    this.syncGlobal();
  }

  public unregisterDirective(ref: number): boolean {
    const deleted = this.directives.delete(ref);
    if (deleted) this.syncGlobal();
    return deleted;
  }

  public clearDirectives(): void {
    this.directives.clear();
    this.syncGlobal();
  }

  private syncGlobal(): void {
    try {
      const g = globalThis as Record<string, unknown>;
      g["__pi_mm_directives"] = Array.from(this.directives.values());
      g["__pi_mm_scheduler"] = this;
    } catch {
      // Best-effort global synchronization
    }
  }

  public getDirectives(activeSubsystems?: string[]): StandingDirectiveItem[] {
    const list = Array.from(this.directives.values());
    if (!activeSubsystems || activeSubsystems.length === 0) {
      return list;
    }
    return list.filter((item) => {
      if (!item.subsystem) return true;
      const normSub = item.subsystem.startsWith("lib") ? item.subsystem.slice(3) : item.subsystem;
      return activeSubsystems.some(
        (act) => act === normSub || act === `lib${normSub}` || normSub === act,
      );
    });
  }

  public checkTrigger(
    contextPercent: number,
    config: Required<ReinforcementConfig> = DEFAULT_REINFORCEMENT_CONFIG,
  ): ReinforcementTriggerResult {
    if (!config.enabled) {
      return { trigger: false };
    }

    if (!this.sessionStartTriggered && config.onSessionStart) {
      this.sessionStartTriggered = true;
      return { trigger: true, reason: "session_start" };
    }

    if (this.compactionResetPending && config.onCompaction) {
      this.compactionResetPending = false;
      return { trigger: true, reason: "compaction" };
    }

    const milestones = config.milestones;
    for (let i = milestones.length - 1; i >= 0; i--) {
      const thresholdPercent = milestones[i] * 100;
      if (contextPercent >= thresholdPercent) {
        if (this.lastMilestoneIndex < i) {
          this.lastMilestoneIndex = i;
          return { trigger: true, reason: "milestone", milestone: milestones[i] };
        }
        break;
      }
    }

    return { trigger: false };
  }
}

export function discoverAvailableSkills(cwd?: string): string[] {
  const skills: string[] = [];
  const candidateDirs: string[] = [];

  if (cwd) {
    candidateDirs.push(join(cwd, ".pi", "skills"));
  }
  const home = typeof process !== "undefined" ? process.env?.HOME : undefined;
  if (home) {
    candidateDirs.push(join(home, ".pi", "agent", "skills"));
  }

  for (const dir of candidateDirs) {
    try {
      if (existsSync(dir)) {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith(".")) {
            if (!skills.includes(e.name)) {
              skills.push(e.name);
            }
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  return skills.slice(0, 6);
}

export function synthesizeReinforcementBlockFromDirectives(
  directives: StandingDirectiveItem[],
  ctx: ReinforcementCtx,
  trigger: ReinforcementTriggerResult,
  config: Required<ReinforcementConfig> = DEFAULT_REINFORCEMENT_CONFIG,
): string {
  const skills = config.includeEnvironmentBaseline ? discoverAvailableSkills(ctx.cwd) : [];

  if (directives.length === 0 && skills.length === 0) {
    return "";
  }

  let reasonLabel = "Periodic Context Reinforcement";
  if (trigger.reason === "session_start") {
    reasonLabel = "Session Initialization";
  } else if (trigger.reason === "compaction") {
    reasonLabel = "Post-Compaction Context Re-anchor";
  } else if (trigger.reason === "milestone" && trigger.milestone) {
    reasonLabel = `Context Milestone (${Math.round(trigger.milestone * 100)}% capacity)`;
  }

  const lines: string[] = [
    `[Standing Operational Directives & Environment Baseline — ${reasonLabel}]`,
  ];

  // Hard clamp: maximum 5 directives, respecting token budget
  // Sort directives newest-first so recently learned rules take precedence
  const maxDirectives = Math.min(5, Math.max(1, Math.floor(config.maxTokens / 35)));
  const sorted = directives.slice().reverse();
  for (const dir of sorted.slice(0, maxDirectives)) {
    const scope = [dir.project, dir.subsystem].filter(Boolean).join("/");
    const scopeTag = scope ? ` (${scope})` : "";
    lines.push(`• Directive${scopeTag}: ${dir.summary}`);
  }

  if (skills.length > 0 && config.includeEnvironmentBaseline) {
    lines.push(`• Active Skills Available: ${skills.join(", ")}`);
    lines.push(`• Primary Exploration Tools: Prefer search_code/read_symbol over raw grep/cat.`);
  }

  lines.push(`(Observe these standing operational constraints across all tool operations.)`);

  let text = lines.join("\n");
  const maxChars = config.maxTokens * 4;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 3) + "...";
  }

  return text;
}
