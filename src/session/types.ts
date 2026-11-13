/**
 * Data structures and contracts for Ephemeral Semantic Session Memory.
 */

export type SessionRole = "user" | "assistant" | "tool";

export type SessionOriginKind = "current" | "parallel" | "persistent-ref";

export interface SessionMetadata {
  /** Full session identifier */
  sessionId: string;
  /** First 8 characters of sessionId for compact badges */
  shortId: string;
  /** Working directory associated with the session */
  cwd?: string;
  /** Short workspace or slot label (e.g. "slot-6" or "site") */
  workspaceLabel?: string;
  /** Path to native .jsonl transcript if known */
  sessionFile?: string;
  /** ISO timestamp of earliest event */
  startedAt: string;
  /** ISO timestamp of latest event */
  updatedAt: string;
  /** Maximum 1-based turn index in session */
  turnCount: number;
  /** Total number of recorded events */
  eventCount: number;
  /** Preview of Turn 1 user prompt (up to 120 chars) */
  firstUserPrompt?: string;
}

export interface SessionTurnEvent {
  /** Unique ID of this session event */
  id: string;
  /** Turn sequence number (1-based) */
  turnIndex: number;
  /** Pi DAG entry ID */
  entryId: string;
  /** Pi DAG parent entry ID for lineage resolution */
  parentId?: string;
  /** ISO timestamp */
  timestamp: string;
  /** Role: user | assistant | tool */
  role: SessionRole;
  /** Speaker label, e.g. "User", "Assistant", "bash", "edit" */
  speaker: string;
  /** Compact structured summary for vector embedding & high-signal display */
  summary: string;
  /** Primary text content (user prompt, assistant reply, or tool output) */
  text: string;
  /** Assistant reasoning/thoughts if present */
  thinking?: string;
  /** Tool name if tool execution */
  toolName?: string;
  /** Tool invocation arguments */
  toolArgs?: Record<string, unknown>;
  /** Exit status code for shell/process executions */
  exitCode?: number;
  /** Files modified or read during this event */
  filesTouched?: string[];
  /** Concise error snippet if execution failed */
  errorSnippet?: string;
  /** Total number of lines in raw payload */
  lineCount?: number;
  /** Raw payload byte length */
  byteLength?: number;
}

export interface SessionStoreOptions {
  /** Session identifier */
  sessionId: string;
  /** Working directory for resolving corm and axis libraries */
  cwd?: string;
  /** Base directory for session cache; defaults to .pi/cache/sessions/<id> */
  sessionDir?: string;
  /** Optional workspace or slot label */
  workspaceLabel?: string;
  /** Optional native .jsonl transcript file path */
  sessionFile?: string;
  /** Path to corm binary */
  cormBin?: string;
  /** Path to external axis shared libraries */
  axisLibs?: string | null;
  /** Embedding service endpoint URL */
  embedUrl?: string;
  /** Embedding model identifier (e.g. "bge-base") */
  embedModel?: string;
  /** Embedding authorization key */
  embedKey?: string;
  /** Whether to run sepal in ephemeral in-memory mode (CORM_SEPAL_EPHEMERAL=1) */
  ephemeralSepal?: boolean;
}

export interface SessionLineRange {
  start: number;
  end: number;
}

export interface SessionQueryOptions {
  /** Natural language or keyword query */
  query: string;
  /** Lineage scope: active branch only (default) or all branches */
  lineage?: "active" | "all";
  /** Current leaf ID for active lineage resolution */
  leafId?: string;
  /** Maximum number of matches to return (default 5) */
  limit?: number;
  /** Minimum similarity score floor (0..1) */
  minScore?: number;
  /** Specific turn to drill into */
  zoomTurn?: number;
  /** Specific tool index to drill into */
  toolIndex?: number;
  /** Specific 1-based line range to slice [start, end] */
  lineRange?: [number, number];
}

export interface SessionCardHit {
  ref: number;
  turnIndex: number;
  toolIndex?: number;
  entryId: string;
  parentId?: string;
  timestamp: string;
  role: SessionRole;
  speaker: string;
  summary: string;
  score: number;
  toolName?: string;
  exitCode?: number;
  filesTouched?: string[];
  errorSnippet?: string;
  inspectRef: string;
  lineCount: number;
  sessionId?: string;
  sessionShortId?: string;
  sessionOrigin?: SessionOriginKind;
  workspaceLabel?: string;
  sourceMemoryRef?: number;
}

export interface SessionZoomHit {
  ref: number;
  turnIndex: number;
  toolIndex?: number;
  toolName?: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  lines: Array<{ lineNum: number; text: string }>;
  rawContent: string;
  sessionId?: string;
  sessionShortId?: string;
  sessionOrigin?: SessionOriginKind;
  workspaceLabel?: string;
  sourceMemoryRef?: number;
}

export interface SessionQueryResult {
  /** Default progressive summary cards */
  cards: SessionCardHit[];
  /** Detailed line-level zoom if zoomTurn/lineRange requested */
  zoom?: SessionZoomHit;
  /** Active lineage chain entry IDs */
  activeLineage?: string[];
  /** Total matching events evaluated */
  totalMatches: number;
}
