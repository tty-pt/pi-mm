import type { MmConfig, ReinforcementConfig } from "../config.ts";
import { DEFAULT_REINFORCEMENT_CONFIG, directiveEmbed, directiveFallback } from "../config.ts";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyDirectiveByEmbedding } from "../judge/adapter.ts";

export interface StandingDirectiveItem {
  ref: number;
  summary: string;
  subsystem?: string;
  project?: string;
}

export const STANDING_DIRECTIVE_PATTERN = /(?:always\s+remember(?:\s+to)?|never\s+(?:use|do|edit|commit|modify)|our\s+rule\s+is|standing\s+rule|invariant:)/i;

export function isStandingDirective(prompt?: string): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  return STANDING_DIRECTIVE_PATTERN.test(prompt);
}

export async function evaluateStandingDirective(
  prompt?: string,
  cfg?: MmConfig,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  if (!prompt || typeof prompt !== "string") return false;
  if (cfg && directiveEmbed(cfg) !== "off") {
    try {
      const verdict = await classifyDirectiveByEmbedding(prompt, cfg, fetchFn);
      if (verdict === "standing_directive") return true;
      if (verdict === "transient_task") return false;
    } catch {
      // Endpoint error or timeout
    }
    const fb = directiveFallback(cfg);
    if (fb === "skip") return false;
    return isStandingDirective(prompt);
  }
  return isStandingDirective(prompt);
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
  }

  public clearDirectives(): void {
    this.directives.clear();
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
  const maxDirectives = Math.min(5, Math.max(1, Math.floor(config.maxTokens / 35)));
  for (const dir of directives.slice(0, maxDirectives)) {
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
