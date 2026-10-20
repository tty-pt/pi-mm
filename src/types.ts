export type MipmapLevel = "L0" | "L1" | "L2" | "L3";

export type LifecycleState =
  | "observed"
  | "hypothesized"
  | "tested"
  | "supported"
  | "contradicted"
  | "superseded";

export interface EpisodeApproach {
  approach: string;
  outcome: "worked" | "failed" | "abandoned";
  reason?: string;
}

export interface EpisodeRecord {
  request?: string;
  problem?: string;
  approaches?: EpisodeApproach[];
  steps?: string[];
  observations?: string[];
  findings?: string[];
  unresolved?: string[];
  diffs?: string[];
  outcome?: "success" | "failure" | "aborted" | string;
  environment?: Record<string, string>;
  eventIds?: string[];
  sessionId?: string;
  sessionFile?: string;
  leafId?: string;
  runId?: string;
  toolCallId?: string;
  principle?: string;
  applicability?: string;
}

export interface SpatialGrid {
  x: number;
  y: number;
  z?: number;
}

export interface MemoryContext {
  project?: string;
  subsystem?: string;
  module?: string;
  path?: string;
  subject?: string;
  grid?: SpatialGrid;
}

export interface UtilityFeedback {
  usedCount: number;
  irrelevantCount: number;
  obsoleteCount: number;
  lastOutcome?: "useful" | "irrelevant" | "obsolete";
  lastNote?: string;
}

export interface LifecycleTransition {
  from: LifecycleState;
  to: LifecycleState;
  timestamp: string;
  reason?: string;
  evidenceRef?: number;
}

export interface MemoryEnvelope {
  level: MipmapLevel;
  type?: "episode" | "investigation" | "decision" | "invariant" | "pattern" | "note" | "concept";
  lifecycle: LifecycleState;
  summary: string;
  context?: MemoryContext;
  episode?: EpisodeRecord;
  evidence?: number[];
  supersededBy?: number;
  supersedes?: number;
  history?: LifecycleTransition[];
  utility?: UtilityFeedback;
  tags?: string[];
}
