import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface MmRawAddon {
  adaptiveRrfK: (candidateCount: number) => number;
  isTechnicalInquiry: (query: string) => boolean;
  isCleanSummaryText: (summary: string) => boolean;
  isCodeOrDocArtifact: (record: string, envelopeJson: string) => boolean;
  isQuestionMemory: (envelopeJson: string) => boolean;
  isAssistantEcho: (envelopeJson: string) => boolean;
  fuseRankingsRRF: (
    lexical: Array<{ ref: number; record: string; score?: string; tier?: string }>,
    semantic: Array<{ ref: number; record: string; score?: string; tier?: string }>,
    kOverride?: number,
  ) => Array<{
    ref: number;
    tier: string;
    record: string;
    origin: "lemma" | "sepal" | "both";
    rrfScore: number;
    lexicalRank?: number;
    semanticRank?: number;
    lexicalScore?: string;
    semanticScore?: string;
  }>;
  computeRankingScore: (cand: Record<string, unknown>, crit: Record<string, unknown>) => number;
  filterAndEnrich: (
    candidates: Array<Record<string, unknown>>,
    crit: Record<string, unknown>,
  ) => Array<Record<string, unknown>>;
  payloadEncode: (envelopeJson: string) => { bytes: Uint8Array; json: string };
  payloadDecode: (bytesOrStr: Uint8Array | string) => string;
  windowForLevel: (level: string, nowEpochSec: number) => {
    bounded: boolean;
    since: string;
    until: string;
  };
  classifyPrompt: (prompt: string) => "standalone" | "recall" | "directive" | "overview" | "wondering";
  scanSource: (
    filePath: string,
    content: string,
    fileId?: number,
  ) => Array<{
    name: string;
    qualifiedName: string;
    parentSymbol: string;
    kind: string;
    filePath: string;
    startLine: number;
    endLine: number;
    signature: string;
    docComment: string;
    rawCallees: string[];
  }>;
  openContext: (opts?: Record<string, unknown>) => unknown;
  closeContext: (ctx: unknown) => void;
  getContextInfo: (ctx: unknown) => {
    globalDir: string;
    projectDir: string;
    projectRoot: string;
    projectName: string;
    hasProjectTier: boolean;
  };
  record: (ctx: unknown, req: Record<string, unknown>) => { tier: "global" | "project"; ref: number };
  recall: (ctx: unknown, req: Record<string, unknown>) => string;
  review: (ctx: unknown, req: Record<string, unknown>) => string;
  overview: (ctx: unknown, tier?: string, maxPerBucket?: number) => string;
  evaluateGuardrail: (ctx: unknown, intent: string, filePath?: string, symbolName?: string) => string;
  observeVerification: (ctx: unknown, command: string, exitCode: number, outputSnippet?: string) => number;
  recordFileMutation: (ctx: unknown, filePath: string) => boolean;
  prime: (ctx: unknown, prompt: string) => string;
  consolidate: (ctx: unknown, tier?: string) => { l2Created: number; l3Created: number };
  openCodeIndex: (rootDir?: string) => { fileCount: number; symbolCount: number };
  codeSearch: (idx: unknown, query: string, fileFilter?: string, kindFilter?: string, limit?: number) => string;
  codeReadSymbols: (
    idx: unknown,
    symbols: string | string[],
    parentSymbol?: string,
    fileFilter?: string,
    neighbors?: string,
    lineStart?: number,
    lineEnd?: number,
  ) => string;
  codeTrace: (idx: unknown, symbolName: string, direction?: string, depth?: number) => string;
  codeOverview: (idx: unknown) => string;
  codeDiffImpact: (idx: unknown, depth?: number) => string;
  codeDiagnose: (idx: unknown, traceText: string, depth?: number) => string;
  codeDetectXyMismatches: (idx: unknown) => string;
  codeResolveCrossBoundary: (idx: unknown, symbolName?: string, filePath?: string) => string;
  codeFirstTouchDossier: (idx: unknown, fileOrSymbol: string) => string;
  projectCodeSearch?: (project: string | null, query: string, fileFilter?: string, kindFilter?: string, limit?: number) => string;
  projectCodeSymbol?: (project: string | null, symbol: string, fileFilter?: string) => string;
  projectCodeTrace?: (project: string | null, symbol: string, direction?: string, depth?: number) => string;
}

let cachedMmAddon: MmRawAddon | null | undefined = undefined;

function resolveMmPkgRootFromRequire(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve("@tty-pt/mm/package.json"));
  } catch {
    return null;
  }
}

function tryDlopenMmAddon(): MmRawAddon | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const cwd = typeof process !== "undefined" ? process.cwd() : ".";
    const home = os.homedir();
    const platform = process.platform;
    const arch = process.arch;
    const baseKey = `${platform}-${arch}`;
    const keys = platform === "linux" ? [`${baseKey}-musl`, baseKey] : [baseKey];

    const pkgRoots = [
      resolve(here, "../../../../external/libmm/npm"),
      resolve(here, "../../mm"),
      resolve(here, "../node_modules/@tty-pt/mm"),
      resolve(here, "../../node_modules/@tty-pt/mm"),
      resolve(here, "../../../node_modules/@tty-pt/mm"),
      resolve(here, "../../../../node_modules/@tty-pt/mm"),
      resolve(cwd, "external/libmm/npm"),
      resolve(cwd, "node_modules/@tty-pt/mm"),
      resolve(cwd, ".pi/agent/npm/node_modules/@tty-pt/mm"),
      resolve(cwd, ".pi/npm/node_modules/@tty-pt/mm"),
      resolve(cwd, ".pi/extensions/pi-mm/node_modules/@tty-pt/mm"),
      resolve(home, ".pi/agent/npm/node_modules/@tty-pt/mm"),
      resolve(home, ".pi/npm/node_modules/@tty-pt/mm"),
      resolve(home, "node_modules/@tty-pt/mm"),
    ];
    const reqRoot = resolveMmPkgRootFromRequire();
    if (reqRoot) pkgRoots.push(reqRoot);

    const candidates: string[] = [];
    for (const root of pkgRoots) {
      candidates.push(
        join(root, "dist", "mm_node.node"),
        join(root, "dist", "mm.node"),
        join(root, "build", "Release", "mm_node.node"),
      );
      for (const key of keys) {
        candidates.push(
          join(root, "prebuilds", key, "mm.node"),
          join(root, "prebuilds", key, "mm_node.node"),
        );
      }
    }

    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const mod: { exports: Record<string, unknown> } = { exports: {} };
        process.dlopen(mod, candidate);
        const raw = mod.exports as unknown as MmRawAddon;
        if (typeof raw.adaptiveRrfK === "function" && raw.adaptiveRrfK(1) === 10) {
          return raw;
        }
      } catch {
        // try next candidate
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function getMmAddon(): MmRawAddon | null {
  if (cachedMmAddon !== undefined) return cachedMmAddon;
  cachedMmAddon = tryDlopenMmAddon();
  return cachedMmAddon;
}

export function isMmNativeAvailable(): boolean {
  return getMmAddon() !== null;
}
