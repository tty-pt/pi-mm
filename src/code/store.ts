/**
 * Multi-Axis C Recall Kernel Code Store & Incremental Mtime Indexer (src/code/store.ts).
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { CodeFileManifestEntry, CodePersistedManifest, CodeSliceHit, CodeSymbolRecord } from "./types.ts";
import { scanSourceFile } from "./scanner.ts";
import {
  collectProjectSourceFiles, decodeCodeSymbolPayload, encodeCodeSymbolPayload,
  formatIsletCoord2D, hasSupportedExtension, normalizeRelPath, sliceSymbolLinesFromDisk,
} from "./payload_codec.ts";
import {
  buildForgetInvocation, buildGetInvocation, buildScanInvocation,
  buildStoreInvocation, type CormRunner, DaemonCormRunner, parseResultLines, type ResultLine,
} from "../corm.ts";
import { ensureDaemon } from "../daemon.ts";
import { type MmConfig, resolveAxisPath, resolveCormBin, resolveCormdBin, runtimeEnv } from "../config.ts";
import { createDefaultRunner, resolveRuntimeCwd } from "../session/store.ts";
import { debugLog } from "../debug.ts";

const MANIFEST_VERSION = 2;
const DEFAULT_MAX_FILES = 2500;
const DEFAULT_SWEEP_THROTTLE_MS = 2000;

function langFamily(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  if (ext === ".c" || ext === ".h" || ext === ".cc" || ext === ".cpp" || ext === ".hpp") return "c";
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "js";
  return ext || "other";
}

function modulePrefix(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length >= 2 && (parts[0] === "mods" || parts[0] === "external" || parts[0] === "packages")) {
    return `${parts[0]}/${parts[1]}/`;
  }
  return parts[0] ? `${parts[0]}/` : "";
}

export interface CodeStoreOptions {
  projectRoot?: string;
  indexDir?: string;
  cormBin?: string;
  cormdBin?: string;
  axisLibs?: string | null;
  embedUrl?: string;
  embedModel?: string;
  embedKey?: string;
  ephemeralSepal?: boolean;
  persistToCorm?: boolean;
  sweepThrottleMs?: number;
}

export class CodeStore {
  readonly projectRoot: string;
  readonly indexDir: string;
  readonly manifestPath: string;
  readonly socketPath: string;
  cormBin: string;
  cormdBin: string;
  axisPath: string;
  runner: CormRunner;
  private readonly shellRunner: CormRunner;
  private readonly hasCustomRunner: boolean;
  filespec: string;
  isletFilespec: string;
  extraEnv: Record<string, string>;
  private embedUrl?: string;
  private readonly persistToCorm: boolean;
  private readonly sweepThrottleMs: number;

  private nextRef = 1;
  private nextFileId = 1;
  private initialized = false;
  private indexedOnce = false;
  private lastSweepMs = 0;
  private daemonReadyPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  private readonly symbolsByRef = new Map<number, CodeSymbolRecord>();
  private readonly symbolsByName = new Map<string, CodeSymbolRecord[]>();
  private readonly symbolsByQualifiedName = new Map<string, CodeSymbolRecord>();
  private readonly filesByPath = new Map<string, CodeFileManifestEntry>();
  private readonly filePathById = new Map<number, string>();
  private readonly inFlightWrites = new Set<Promise<void>>();

  constructor(options: CodeStoreOptions = {}, customRunner?: CormRunner) {
    this.projectRoot = resolveRuntimeCwd(options.projectRoot);
    this.indexDir = options.indexDir ?? join(this.projectRoot, ".pi", "cache", "code-index");
    this.manifestPath = join(this.indexDir, "manifest.json");
    this.socketPath = join(this.indexDir, "cormd.sock");
    this.persistToCorm = options.persistToCorm !== false;
    this.sweepThrottleMs = options.sweepThrottleMs ?? DEFAULT_SWEEP_THROTTLE_MS;

    const envMap = runtimeEnv();
    const pathDirs = (envMap["PATH"] || "").split(":");
    const resolvedBin = options.cormBin || resolveCormBin({ cormBin: "" } as unknown as MmConfig, this.projectRoot, pathDirs, existsSync).path;
    this.cormBin = resolvedBin || "corm";
    const resolvedDaemon = options.cormdBin || resolveCormdBin({ cormBin: this.cormBin } as unknown as MmConfig, this.projectRoot, pathDirs, existsSync).path;
    this.cormdBin = resolvedDaemon || "";
    this.embedUrl = options.embedUrl || envMap["CORM_SEPAL_EMBED_URL"];

    const cfg = {
      cormBin: this.cormBin,
      axisLibs: options.axisLibs ?? null,
      memDir: this.indexDir,
      scanLimit: 10,
      embedUrl: this.embedUrl,
      semanticSearch: Boolean(this.embedUrl),
    };
    this.axisPath = resolveAxisPath(cfg as unknown as MmConfig, this.projectRoot);
    const embed = Boolean(this.embedUrl);
    this.filespec = `${this.indexDir}/code.db@joint,lemma${embed ? ",sepal" : ""}:a:b`;
    this.isletFilespec = `${this.indexDir}/code-islet.db@islet:a:s`;

    this.extraEnv = { CORM_AXIS_PATH: this.axisPath };
    if (this.embedUrl) {
      this.extraEnv["CORM_SEPAL_EMBED_URL"] = this.embedUrl;
      this.extraEnv["CORM_SEPAL_EMBED_MODEL"] = options.embedModel || envMap["CORM_SEPAL_EMBED_MODEL"] || "bge-base";
      if (options.embedKey) this.extraEnv["CORM_SEPAL_EMBED_KEY"] = options.embedKey;
    }
    if (options.ephemeralSepal !== false) {
      this.extraEnv["CORM_SEPAL_EPHEMERAL"] = "1";
    }
    this.shellRunner = createDefaultRunner();
    this.hasCustomRunner = Boolean(customRunner);
    this.runner = customRunner ?? (this.cormdBin ? new DaemonCormRunner(this.socketPath, this.shellRunner) : this.shellRunner);
  }

  configure(options: Partial<CodeStoreOptions>): void {
    if (options.cormBin && options.cormBin !== this.cormBin) {
      this.cormBin = options.cormBin;
    }
    if (options.embedUrl && !this.embedUrl) {
      this.embedUrl = options.embedUrl;
      this.filespec = `${this.indexDir}/code.db@joint,lemma,sepal:a:b`;
      this.extraEnv["CORM_SEPAL_EMBED_URL"] = this.embedUrl;
      if (options.embedModel) this.extraEnv["CORM_SEPAL_EMBED_MODEL"] = options.embedModel;
      if (options.embedKey) this.extraEnv["CORM_SEPAL_EMBED_KEY"] = options.embedKey;
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      if (!existsSync(this.indexDir)) {
        await mkdir(this.indexDir, { recursive: true });
      }
      this.loadManifestFromDisk();
      if (this.persistToCorm && !this.hasCustomRunner && this.cormdBin && !this.projectRoot.includes("fake")) {
        this.ensureCodeDaemon();
      }
      this.initialized = true;
    } catch (err) {
      debugLog("code", "Failed to initialize code index directory", { error: String(err) });
    }
  }

  private ensureCodeDaemon(): Promise<void> {
    if (this.daemonReadyPromise) return this.daemonReadyPromise;
    if (!this.cormdBin) return Promise.resolve();
    this.daemonReadyPromise = (async () => {
      try {
        await ensureDaemon({
          cormdBin: this.cormdBin,
          filespec: this.filespec,
          socketPath: this.socketPath,
          axisPath: this.axisPath,
          embedEnv: this.extraEnv,
          cwd: this.indexDir,
          timeoutMs: 1500,
        });
      } catch (err) {
        debugLog("code", "CodeStore cormd startup fallback to CLI", { error: String(err) });
      }
    })();
    return this.daemonReadyPromise;
  }

  private loadManifestFromDisk(): boolean {
    if (!existsSync(this.manifestPath)) return false;
    try {
      const raw = readFileSync(this.manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as CodePersistedManifest;
      if (!parsed || parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.files) || !Array.isArray(parsed.symbols)) {
        return false;
      }
      this.nextRef = Math.max(1, parsed.nextRef || 1);
      this.nextFileId = Math.max(1, parsed.nextFileId || 1);
      this.filesByPath.clear();
      this.filePathById.clear();
      this.symbolsByRef.clear();

      for (const f of parsed.files) {
        this.filesByPath.set(f.filePath, f);
        this.filePathById.set(f.fileId, f.filePath);
        if (f.fileId >= this.nextFileId) this.nextFileId = f.fileId + 1;
      }
      for (const s of parsed.symbols) {
        this.symbolsByRef.set(s.ref, s);
        if (s.ref >= this.nextRef) this.nextRef = s.ref + 1;
      }
      this.rebuildIndexesOnly();
      this.indexedOnce = this.filesByPath.size > 0;
      return true;
    } catch (err) {
      debugLog("code", "Failed to load code manifest", { error: String(err) });
      return false;
    }
  }

  saveManifestToDisk(): void {
    try {
      if (!existsSync(this.indexDir)) return;
      const manifest: CodePersistedManifest = {
        version: MANIFEST_VERSION,
        nextRef: this.nextRef,
        nextFileId: this.nextFileId,
        files: Array.from(this.filesByPath.values()),
        symbols: Array.from(this.symbolsByRef.values()),
      };
      const tmpPath = `${this.manifestPath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(manifest), "utf-8");
      renameSync(tmpPath, this.manifestPath);
    } catch (err) {
      debugLog("code", "Failed to save code manifest", { error: String(err) });
    }
  }

  async flush(timeoutMs = 250): Promise<void> {
    if (this.inFlightWrites.size === 0) return;
    const all = Promise.allSettled(Array.from(this.inFlightWrites));
    if (timeoutMs <= 0) {
      await all;
      return;
    }
    await Promise.race([
      all,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async ensureIndexed(maxFiles = DEFAULT_MAX_FILES, forceSweep = false): Promise<{ scannedFiles: number; totalSymbols: number }> {
    const now = Date.now();
    if (this.indexedOnce && this.filesByPath.size > 0 && !forceSweep && (now - this.lastSweepMs) < this.sweepThrottleMs) {
      return { scannedFiles: 0, totalSymbols: this.symbolsByRef.size };
    }
    return await this.indexProject(maxFiles);
  }

  async indexProject(maxFiles = DEFAULT_MAX_FILES): Promise<{ scannedFiles: number; totalSymbols: number }> {
    await this.init();
    const candidateFiles = collectProjectSourceFiles(this.projectRoot, maxFiles);
    const seenPaths = new Set<string>(candidateFiles);
    let scannedFiles = 0;
    let deletedFiles = 0;

    for (const relPath of candidateFiles) {
      const updated = await this.refreshFile(relPath, false);
      if (updated) scannedFiles++;
    }

    for (const [existingPath, entry] of Array.from(this.filesByPath.entries())) {
      if (!seenPaths.has(existingPath)) {
        this.removeFileSymbols(entry);
        this.filesByPath.delete(existingPath);
        this.filePathById.delete(entry.fileId);
        deletedFiles++;
      }
    }

    const mutated = scannedFiles > 0 || deletedFiles > 0;
    if (mutated || !this.indexedOnce) {
      this.rebuildCallGraph();
      if (mutated) this.saveManifestToDisk();
    }
    this.indexedOnce = true;
    this.lastSweepMs = Date.now();
    return { scannedFiles, totalSymbols: this.symbolsByRef.size };
  }

  async refreshFile(filePathInput: string, rebuildGraph = true): Promise<boolean> {
    await this.init();
    const absPath = isAbsolute(filePathInput) ? filePathInput : join(this.projectRoot, filePathInput);
    const relPath = normalizeRelPath(relative(this.projectRoot, absPath));
    if (relPath.startsWith("..") || !hasSupportedExtension(relPath)) return false;

    if (!existsSync(absPath)) {
      const prev = this.filesByPath.get(relPath);
      if (!prev) return false;
      this.removeFileSymbols(prev);
      this.filesByPath.delete(relPath);
      this.filePathById.delete(prev.fileId);
      if (rebuildGraph) {
        this.rebuildCallGraph();
        this.saveManifestToDisk();
      }
      return true;
    }

    let st;
    try {
      st = statSync(absPath);
    } catch {
      return false;
    }
    if (!st.isFile() || st.size > 512 * 1024) return false;

    const existing = this.filesByPath.get(relPath);
    if (existing && existing.mtimeMs === st.mtimeMs && existing.size === st.size) return false;

    let content = "";
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      return false;
    }

    if (existing) this.removeFileSymbols(existing);
    const fileId = existing ? existing.fileId : this.nextFileId++;
    this.filePathById.set(fileId, relPath);

    const scanned = scanSourceFile(relPath, content);
    const symbolRefs: number[] = [];

    for (const s of scanned.symbols) {
      const ref = this.nextRef++;
      const record: CodeSymbolRecord = {
        ...s, ref, fileId, mtimeMs: st.mtimeMs, callees: [], callers: [],
      };
      this.symbolsByRef.set(ref, record);
      symbolRefs.push(ref);
      if (this.persistToCorm) this.enqueueCormSymbolWrite(record);
    }

    this.filesByPath.set(relPath, {
      fileId, filePath: relPath, mtimeMs: st.mtimeMs, size: st.size,
      lineCount: scanned.lineCount, lineOffsets: scanned.lineOffsets,
      imports: scanned.imports, symbolRefs,
    });
    if (rebuildGraph) {
      this.rebuildCallGraph();
      this.saveManifestToDisk();
    }
    return true;
  }

  private enqueueWriteOp(op: () => Promise<void>): void {
    const next = this.writeChain.then(op, op);
    this.writeChain = next;
    this.inFlightWrites.add(next);
    next.finally(() => this.inFlightWrites.delete(next));
  }

  private removeFileSymbols(entry: CodeFileManifestEntry): void {
    for (const ref of entry.symbolRefs) {
      this.symbolsByRef.delete(ref);
      if (this.persistToCorm) {
        this.enqueueWriteOp(async () => {
          if (this.daemonReadyPromise) await this.daemonReadyPromise;
          await this.runner.run(
            buildForgetInvocation(this.cormBin, this.filespec, ref, this.axisPath, this.indexDir, this.extraEnv),
          ).catch(() => {});
        });
      }
    }
  }

  private async persistSymbolToCorm(record: CodeSymbolRecord): Promise<void> {
    if (this.daemonReadyPromise) await this.daemonReadyPromise;
    const date = new Date(record.mtimeMs || Date.now()).toISOString().slice(0, 10);
    const payload = encodeCodeSymbolPayload(date, record);
    try {
      await this.runner.run(
        buildStoreInvocation(this.cormBin, this.filespec, record.ref, payload, this.axisPath, this.indexDir, this.extraEnv),
      );
    } catch (err) {
      debugLog("code", "Corm symbol write error", { error: String(err) });
    }
  }

  private enqueueCormSymbolWrite(record: CodeSymbolRecord): void {
    this.enqueueWriteOp(() => this.persistSymbolToCorm(record));
  }

  private rebuildIndexesOnly(): void {
    this.symbolsByName.clear();
    this.symbolsByQualifiedName.clear();
    for (const sym of this.symbolsByRef.values()) {
      const list = this.symbolsByName.get(sym.name);
      if (list) list.push(sym);
      else this.symbolsByName.set(sym.name, [sym]);
      this.symbolsByQualifiedName.set(sym.qualifiedName, sym);
    }
  }

  rebuildCallGraph(): void {
    this.symbolsByName.clear();
    this.symbolsByQualifiedName.clear();
    for (const sym of this.symbolsByRef.values()) {
      sym.callees = [];
      sym.callers = [];
      const list = this.symbolsByName.get(sym.name);
      if (list) list.push(sym);
      else this.symbolsByName.set(sym.name, [sym]);
      this.symbolsByQualifiedName.set(sym.qualifiedName, sym);
    }

    for (const sym of this.symbolsByRef.values()) {
      const calleeRefs = new Set<number>();
      const symLang = langFamily(sym.filePath);
      const symMod = modulePrefix(sym.filePath);

      for (const rawName of sym.rawCallees) {
        const targets = this.symbolsByName.get(rawName);
        if (!targets || targets.length === 0) continue;

        const compat = targets.filter((t) =>
          t.ref !== sym.ref &&
          langFamily(t.filePath) === symLang &&
          (t.kind === "Function" || t.kind === "Method" || t.kind === "Macro")
        );
        if (compat.length === 0) continue;

        const nonMacro = compat.filter((t) => t.kind !== "Macro" && !t.signature.startsWith("XY_DECL"));
        let pool = nonMacro.length > 0 ? nonMacro : compat;
        const callerIsTest = sym.filePath.includes("/tests/") || sym.filePath.startsWith("tests/") || sym.filePath.includes("_test.");
        if (!callerIsTest) {
          const nonTest = pool.filter((t) => !t.filePath.includes("/tests/") && !t.filePath.startsWith("tests/") && !t.filePath.includes("_test."));
          if (nonTest.length > 0) pool = nonTest;
        }

        const sameFile = pool.find((t) => t.filePath === sym.filePath);
        let chosen: CodeSymbolRecord[];
        if (sameFile) {
          chosen = [sameFile];
        } else {
          const sameMod = symMod ? pool.filter((t) => modulePrefix(t.filePath) === symMod) : [];
          chosen = (sameMod.length > 0 ? sameMod : pool).slice(0, 3);
        }

        for (const target of chosen) {
          calleeRefs.add(target.ref);
          if (!target.callers.includes(sym.ref)) target.callers.push(sym.ref);
        }
      }
      sym.callees = Array.from(calleeRefs);
    }
  }

  async queryLexical(query: string, limit = 10): Promise<ResultLine[]> {
    try {
      if (this.daemonReadyPromise) await this.daemonReadyPromise;
      const inv = buildScanInvocation(
        this.cormBin, this.filespec, "(lemma)", limit, this.axisPath, this.indexDir, this.extraEnv,
        ["--field=text", "--query=" + query],
      );
      const res = await this.runner.run(inv);
      if (res.code === 0 && res.stdout) return parseResultLines(res.stdout);
    } catch { /* fallback to in-memory */ }
    return [];
  }

  async querySemantic(query: string, limit = 10): Promise<ResultLine[]> {
    if (!this.embedUrl) return [];
    try {
      if (this.daemonReadyPromise) await this.daemonReadyPromise;
      const inv = buildScanInvocation(
        this.cormBin, this.filespec, "(sepal)", limit, this.axisPath, this.indexDir, this.extraEnv,
        ["--field=text", "--query=" + query],
      );
      const res = await this.runner.run(inv);
      if (res.code === 0 && res.stdout) return parseResultLines(res.stdout);
    } catch { /* fallback to in-memory */ }
    return [];
  }

  async querySpatialSpan(filePath: string, startLine: number, endLine: number): Promise<CodeSymbolRecord[]> {
    const relPath = normalizeRelPath(filePath);
    const fileEntry = this.filesByPath.get(relPath);
    if (!fileEntry) return [];

    const matches: CodeSymbolRecord[] = [];
    for (const ref of fileEntry.symbolRefs) {
      const sym = this.symbolsByRef.get(ref);
      if (!sym) continue;
      if (sym.startLine <= endLine && sym.endLine >= startLine) {
        matches.push(sym);
      }
    }
    return matches;
  }

  getSymbolSync(ref: number): CodeSymbolRecord | undefined {
    return this.symbolsByRef.get(ref);
  }

  getSymbolsByName(name: string): CodeSymbolRecord[] {
    return this.symbolsByName.get(name) ?? [];
  }

  getSymbolByQualifiedName(qn: string): CodeSymbolRecord | undefined {
    return this.symbolsByQualifiedName.get(qn);
  }

  getFileEntry(filePath: string): CodeFileManifestEntry | undefined {
    return this.filesByPath.get(normalizeRelPath(filePath));
  }

  async getSymbol(ref: number): Promise<CodeSymbolRecord | null> {
    if (this.symbolsByRef.has(ref)) return this.symbolsByRef.get(ref)!;
    if (!this.persistToCorm) return null;
    try {
      if (this.daemonReadyPromise) await this.daemonReadyPromise;
      const inv = buildGetInvocation(this.cormBin, this.filespec, ref, this.axisPath, this.indexDir, this.extraEnv);
      const res = await this.runner.run(inv);
      if (res.code === 0 && res.stdout) {
        const decoded = decodeCodeSymbolPayload(res.stdout);
        if (decoded) {
          this.symbolsByRef.set(ref, decoded.symbol);
          return decoded.symbol;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  sliceSymbolSource(
    sym: CodeSymbolRecord,
    options?: { lineRange?: [number, number]; maxLines?: number; fullOutput?: boolean },
  ): CodeSliceHit | null {
    return sliceSymbolLinesFromDisk(this.projectRoot, sym, this.symbolsByRef, options);
  }

  getAllSymbols(): CodeSymbolRecord[] {
    return Array.from(this.symbolsByRef.values());
  }

  getAllFiles(): CodeFileManifestEntry[] {
    return Array.from(this.filesByPath.values());
  }

  getStats(): { files: number; symbols: number; callEdges: number } {
    let callEdges = 0;
    for (const sym of this.symbolsByRef.values()) callEdges += sym.callees.length;
    return { files: this.filesByPath.size, symbols: this.symbolsByRef.size, callEdges };
  }
}
