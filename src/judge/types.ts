export type JudgeAction = "remember" | "update" | "skip";

export interface JudgeDecision {
  action: JudgeAction;
  summary?: string;
  type?: "note" | "decision" | "episode";
  targetRef?: string | number;
  reason?: string;
  findings?: string[];
}

export type JudgeDecisionSource = "llm" | "fallback" | "explicit" | "disabled" | "heuristic";

export interface JudgeResult {
  decision: JudgeDecision;
  source: JudgeDecisionSource;
  degraded?: boolean;
  error?: string;
}
