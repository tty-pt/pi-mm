import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PiExecResult } from "./hooks/events.ts";
import type { CormRunner, Invocation } from "./corm.ts";
import { formatProtocolCommand, isDaemonLockHeld, resolveDatabaseDir, resolveLockPath } from "./daemon.ts";
import { withLock } from "./lock.ts";

export interface CormAddonModule {
  execCormCommand: (
    op: string,
    filespec: string,
    arg2?: string,
    payload?: string | Uint8Array,
    env?: Record<string, string>,
  ) => {
    code: number;
    stdout: string;
    stderr: string;
    stdoutBytes?: Uint8Array;
  };
  closeCormEngine?: (filespec?: string) => boolean;
}

let cachedModulePromise: Promise<CormAddonModule | null> | null = null;

function resolveCormPkgRootFromRequire(): string | null {
  try {
    const req = createRequire(import.meta.url);
    try { return dirname(req.resolve("@tty-pt/corm/package.json")); } catch {
      for (let d = dirname(req.resolve("@tty-pt/corm")), i = 0; i < 4; i++, d = dirname(d)) {
        if (existsSync(join(d, "package.json"))) return d;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function resolveLocalCormEntry(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const cwd = typeof process !== "undefined" ? process.cwd() : ".";
    const home = os.homedir();
    const candidates = [
      resolve(here, "../../../../external/libcorm/npm/dist/index.js"),
      resolve(here, "../../corm/dist/index.js"),
      resolve(here, "../node_modules/@tty-pt/corm/dist/index.js"),
      resolve(here, "../../node_modules/@tty-pt/corm/dist/index.js"),
      resolve(here, "../../../node_modules/@tty-pt/corm/dist/index.js"),
      resolve(here, "../../../../node_modules/@tty-pt/corm/dist/index.js"),
      resolve(here, "../../../../../node_modules/@tty-pt/corm/dist/index.js"),
      resolve(cwd, "node_modules/@tty-pt/corm/dist/index.js"),
      resolve(cwd, ".pi/agent/npm/node_modules/@tty-pt/corm/dist/index.js"),
      resolve(cwd, ".pi/npm/node_modules/@tty-pt/corm/dist/index.js"),
      resolve(cwd, ".pi/extensions/pi-mm/node_modules/@tty-pt/corm/dist/index.js"),
      resolve(home, ".pi/agent/npm/node_modules/@tty-pt/corm/dist/index.js"),
      resolve(home, ".pi/npm/node_modules/@tty-pt/corm/dist/index.js"),
      resolve(home, "node_modules/@tty-pt/corm/dist/index.js"),
    ];
    const reqRoot = resolveCormPkgRootFromRequire();
    if (reqRoot) candidates.push(join(reqRoot, "dist", "index.js"));
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return pathToFileURL(candidate).href;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function tryDlopenCormAddon(): CormAddonModule | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const cwd = typeof process !== "undefined" ? process.cwd() : ".";
    const home = os.homedir();
    const platform = process.platform;
    const arch = process.arch;
    const baseKey = `${platform}-${arch}`;
    const keys = platform === "linux" ? [`${baseKey}-musl`, baseKey] : [baseKey];
    const pkgRoots = [
      resolve(here, "../../../../external/libcorm/npm"),
      resolve(here, "../../corm"),
      resolve(here, "../node_modules/@tty-pt/corm"),
      resolve(here, "../../node_modules/@tty-pt/corm"),
      resolve(here, "../../../node_modules/@tty-pt/corm"),
      resolve(here, "../../../../node_modules/@tty-pt/corm"),
      resolve(here, "../../../../../node_modules/@tty-pt/corm"),
      resolve(cwd, "node_modules/@tty-pt/corm"),
      resolve(cwd, ".pi/agent/npm/node_modules/@tty-pt/corm"),
      resolve(cwd, ".pi/npm/node_modules/@tty-pt/corm"),
      resolve(cwd, ".pi/extensions/pi-mm/node_modules/@tty-pt/corm"),
      resolve(home, ".pi/agent/npm/node_modules/@tty-pt/corm"),
      resolve(home, ".pi/npm/node_modules/@tty-pt/corm"),
      resolve(home, "node_modules/@tty-pt/corm"),
    ];
    const reqRoot = resolveCormPkgRootFromRequire();
    if (reqRoot) pkgRoots.push(reqRoot);
    const candidates: string[] = [];
    for (const root of pkgRoots) {
      candidates.push(join(root, "build", "Release", "corm_node.node"));
      for (const key of keys) {
        candidates.push(
          join(root, "prebuilds", key, "corm.node"),
          join(root, "prebuilds", key, "corm_node.node"),
        );
      }
    }
    const dlopenFlags =
      os.constants?.dlopen &&
      typeof os.constants.dlopen.RTLD_NOW === "number" &&
      typeof os.constants.dlopen.RTLD_GLOBAL === "number"
        ? os.constants.dlopen.RTLD_NOW | os.constants.dlopen.RTLD_GLOBAL
        : undefined;

    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const mod: { exports: Record<string, unknown> } = { exports: {} };
        if (dlopenFlags !== undefined) {
          process.dlopen(mod, candidate, dlopenFlags);
        } else {
          process.dlopen(mod, candidate);
        }
        const raw = mod.exports as {
          execCommand?: (
            op: string,
            filespec: string,
            arg2: string,
            payload: string | Uint8Array,
            env?: Record<string, string>,
          ) => { code: number; stdout: string; stderr: string; stdoutBytes?: Uint8Array };
          closeEngine?: (filespec?: string) => boolean;
        };
        if (typeof raw.execCommand === "function") {
          const probe = raw.execCommand("PING", "mem.db", "", "");
          if (probe && probe.code === 0 && probe.stdout.trim() === "PONG") {
            return {
              execCormCommand(op, filespec, arg2 = "", payload = "", env = undefined) {
                const body =
                  payload instanceof Uint8Array
                    ? payload
                    : payload !== undefined && payload !== null
                    ? String(payload)
                    : "";
                return raw.execCommand!(
                  String(op),
                  String(filespec),
                  arg2 !== undefined && arg2 !== null ? String(arg2) : "",
                  body,
                  env,
                );
              },
              closeCormEngine(filespec) {
                if (typeof raw.closeEngine !== "function") return false;
                return filespec !== undefined
                  ? Boolean(raw.closeEngine(String(filespec)))
                  : Boolean(raw.closeEngine());
              },
            };
          }
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

export async function loadCormAddonModule(): Promise<CormAddonModule | null> {
  if (cachedModulePromise) return cachedModulePromise;
  cachedModulePromise = (async () => {
    const dlopened = tryDlopenCormAddon();
    if (dlopened) return dlopened;

    const specifiers: string[] = [];
    const localUrl = resolveLocalCormEntry();
    if (localUrl) specifiers.push(localUrl);
    specifiers.push("@tty-pt/corm");

    for (const spec of specifiers) {
      try {
        const mod = (await import(spec)) as Partial<CormAddonModule>;
        if (mod && typeof mod.execCormCommand === "function") {
          const res = mod.execCormCommand("PING", "mem.db", "", "");
          if (res && res.code === 0 && res.stdout.trim() === "PONG") {
            return mod as CormAddonModule;
          }
        }
      } catch {
        // try next specifier
      }
    }

    return null;
  })();
  return cachedModulePromise;
}

function parseHeaderFields(header: string): { op: string; filespec: string; arg2: string } | null {
  const parts = header.trim().split(/\s+/);
  if (parts.length < 4) return null;
  const op = parts[0];
  const filespec = parts[2];
  const arg2 = parts[3];
  return { op, filespec, arg2 };
}

/**
 * In-process Node-API CormRunner that executes Corm commands directly via `@tty-pt/corm`
 * when no resident `cormd` socket is active, with full `.cormd.lock` lease respect and
 * `.mm.lock` mutation serialization. Falls back to `ShellCormRunner` if the native addon
 * is unavailable or an unrecognized CLI invocation is passed.
 */
export class NativeAddonCormRunner implements CormRunner {
  constructor(
    readonly fallback: CormRunner,
    private readonly moduleLoader: () => Promise<CormAddonModule | null> = loadCormAddonModule,
  ) {}

  async run(inv: Invocation): Promise<PiExecResult> {
    const isMutation = inv.args.includes("-p") || inv.args.includes("-d") || inv.args.includes("-D");
    if (isMutation) {
      const lockPath = resolveLockPath(inv);
      if (await isDaemonLockHeld(lockPath)) {
        return {
          stdout: "",
          stderr: "corm: database is leased by resident cormd; direct mutation forbidden",
          code: 1,
        };
      }
    }

    const mod = await this.moduleLoader();
    if (!mod) {
      return this.fallback.run(inv);
    }

    const cmd = formatProtocolCommand(inv, "1");
    if (!cmd) {
      return this.fallback.run(inv);
    }

    const parsed = parseHeaderFields(cmd.header);
    if (!parsed) {
      return this.fallback.run(inv);
    }

    let resolvedFilespec = parsed.filespec;
    if (resolvedFilespec && !resolvedFilespec.startsWith("/") && inv.cwd) {
      resolvedFilespec = join(inv.cwd, resolvedFilespec);
    }

    if (resolvedFilespec.includes("sepal")) {
      return this.fallback.run(inv);
    }

    const payload =
      parsed.op === "PUT" && cmd.bodyBytes !== undefined
        ? cmd.bodyBytes
        : cmd.body;

    const executeInProcess = async (): Promise<PiExecResult> => {
      try {
        const res = mod.execCormCommand(
          parsed.op,
          resolvedFilespec,
          parsed.arg2,
          payload,
          { CORM_QUIET: "1", ...(inv.env ?? {}) },
        );
        return {
          code: res.code,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
          ...(res.stdoutBytes ? { stdoutBytes: res.stdoutBytes } : {}),
        };
      } catch (err: unknown) {
        return {
          code: 1,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
        };
      }
    };

    if (cmd.isMutation) {
      const dbDir = resolveDatabaseDir(inv);
      return await withLock(dbDir, async () => {
        const lockPath = resolveLockPath(inv);
        if (await isDaemonLockHeld(lockPath)) {
          return {
            stdout: "",
            stderr: "corm: database is leased by resident cormd; direct mutation forbidden",
            code: 1,
          };
        }
        return await executeInProcess();
      });
    }

    return await executeInProcess();
  }
}
