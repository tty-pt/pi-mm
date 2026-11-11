/**
 * Data structures and contracts for the Multi-Axis Codebase Mipmap Space (src/code/).
 */

export type CodeSymbolKind =
  | "Function"
  | "Method"
  | "Class"
  | "Struct"
  | "Interface"
  | "Type"
  | "Enum"
  | "Macro"
  | "Route"
  | "Variable";

export interface ScannedSymbol {
  /** Short identifier name (e.g. "createDefaultRunner" or "song_handler") */
  name: string;
  /** Qualified name including file/module and optional parent class (e.g. "src/session/store.ts:SessionStore.appendEvent") */
  qualifiedName: string;
  /** Structural kind */
  kind: CodeSymbolKind;
  /** Relative file path from project root */
  filePath: string;
  /** 1-based start line */
  startLine: number;
  /** 1-based inclusive end line */
  endLine: number;
  /** Compact declaration signature */
  signature: string;
  /** Enclosing class/struct/interface name if method */
  parentSymbol?: string;
  /** Leading doc comment summary if present */
  docComment?: string;
  /** HTTP route path if kind === "Route" */
  routePath?: string;
  /** HTTP route method (GET, POST, etc.) if kind === "Route" */
  routeMethod?: string;
  /** Outbound function/method names called inside this symbol's body */
  rawCallees: string[];
}

export interface ScannedFileResult {
  filePath: string;
  lineCount: number;
  byteLength: number;
  lineOffsets: number[];
  imports: string[];
  symbols: ScannedSymbol[];
}

export interface CodeSymbolRecord extends ScannedSymbol {
  /** Assigned 32-bit corm reference ID */
  ref: number;
  /** Assigned numeric file ID for libislet spatial indexing */
  fileId: number;
  /** Last modified epoch ms of the containing file */
  mtimeMs: number;
  /** Resolved outbound callee symbol refs */
  callees: number[];
  /** Resolved inbound caller symbol refs */
  callers: number[];
}

export interface CodeFileManifestEntry {
  fileId: number;
  filePath: string;
  mtimeMs: number;
  size: number;
  lineCount: number;
  lineOffsets: number[];
  imports: string[];
  symbolRefs: number[];
}

export interface CodePersistedManifest {
  version: number;
  nextRef: number;
  nextFileId: number;
  files: CodeFileManifestEntry[];
  symbols: CodeSymbolRecord[];
}

export interface CodeArchitectureOverview {
  projectRoot: string;
  totalFiles: number;
  totalSymbols: number;
  totalCallEdges: number;
  modules: Array<{
    moduleName: string;
    fileCount: number;
    symbolCount: number;
    dependsOn: string[];
  }>;
  entryPointsAndRoutes: Array<{
    ref: number;
    qualifiedName: string;
    kind: CodeSymbolKind;
    filePath: string;
    startLine: number;
    routePath?: string;
    routeMethod?: string;
  }>;
  hotspots: Array<{
    ref: number;
    name: string;
    qualifiedName: string;
    kind: CodeSymbolKind;
    filePath: string;
    startLine: number;
    endLine: number;
    inboundCount: number;
    outboundCount: number;
    totalDegree: number;
  }>;
}

export interface CodeTraceNode {
  ref: number;
  name: string;
  qualifiedName: string;
  kind: CodeSymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  depth: number;
  direction: "root" | "inbound" | "outbound";
  children: CodeTraceNode[];
}

export interface CodeTraceResult {
  status: "ok" | "not_found" | "ambiguous";
  targetQuery: string;
  root?: CodeSymbolRecord;
  inboundTree?: CodeTraceNode;
  outboundTree?: CodeTraceNode;
  candidates?: CodeSymbolRecord[];
}

export interface CodeDiffHunk {
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface CodeDiffImpactResult {
  changedFiles: string[];
  hunks: CodeDiffHunk[];
  modifiedSymbols: CodeSymbolRecord[];
  impactedCallers: Array<{
    symbol: CodeSymbolRecord;
    calledModifiedSymbol: string;
    depth: number;
  }>;
}

export interface CodeSliceHit {
  ref: number;
  symbol: CodeSymbolRecord;
  totalLines: number;
  startLine: number;
  endLine: number;
  compacted: boolean;
  lines: Array<{ lineNum: number; text: string }>;
  directCallers: CodeSymbolRecord[];
  directCallees: CodeSymbolRecord[];
}

export interface CodeQueryOptions {
  query?: string;
  symbol?: string;
  symbols?: string[];
  file?: string;
  kind?: string;
  parentSymbol?: string;
  neighbors?: "none" | "callers" | "callees" | "both";
  neighborLimit?: number;
  trace?: string;
  direction?: "inbound" | "outbound" | "both";
  depth?: number;
  diff?: boolean;
  overview?: boolean;
  lineRange?: [number, number];
  maxLines?: number;
  fullOutput?: boolean;
  limit?: number;
}
