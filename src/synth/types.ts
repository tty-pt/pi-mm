import type { LifecycleState, MemoryEnvelope } from "../types.ts";

export interface EvidenceItemSummary {
  ref: number;
  level: string;
  summary: string;
  lifecycle?: LifecycleState;
  problem?: string;
  findings?: string[];
  outcome?: string;
  approaches?: Array<{ approach: string; outcome: string }>;
  diffs?: string[];
  context?: MemoryEnvelope["context"];
  evidence?: number[];
}

export interface L2SynthesisInput {
  scope: string;
  isConversational: boolean;
  priorAbstraction?: {
    ref: number;
    summary: string;
    evidence: number[];
  };
  evidence: EvidenceItemSummary[];
}

export interface L2SynthesisOutcome {
  status: "ok" | "unavailable" | "failed" | "validation_error";
  summary?: string;
  explanation?: string;
  citedRefs?: number[];
  reason?: string;
}

export interface L2ScopeItemSummary {
  ref: number;
  scope: string;
  summary: string;
  evidence: number[];
}

export interface L3SynthesisInput {
  priorAbstraction?: {
    ref: number;
    summary: string;
    evidence: number[];
  };
  l2Items: L2ScopeItemSummary[];
}

export interface L3SynthesisOutcome {
  status: "ok" | "unavailable" | "failed" | "validation_error";
  summary?: string;
  principle?: string;
  applicability?: string;
  citedRefs?: number[];
  reason?: string;
}
