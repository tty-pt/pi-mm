import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import type { PiExecResult } from "./hooks/events.ts";
import type { Invocation, QmapRunner } from "./qmap.ts";
import { runtimeEnv } from "./config.ts";

/**
 * Extracts the target database filespec from an Invocation's argument list
 * based on positional command flag layout, rather than searching arbitrary
 * payload arguments for ".db".
 */
export function extractFilespec(inv: Invocation): string | null {
  const args = inv.args;
  if (!args || args.length === 0) return null;

  // 1. PUT: ["-p", "<ref>:<payload>", "<filespec>"]
  if (args[0] === "-p" && args.length >= 3) {
    return args[2];
  }

  // 2. GET: ["-r", "-g", "<ref>", "<filespec>"]
  if (args.length >= 4 && args[0] === "-r" && args[1] === "-g") {
    return args[3];
  }

  // 3. LIST: ["-g", ".", "<filespec>"]
  if (args.length >= 3 && args[0] === "-g" && args[1] === ".") {
    return args[2];
  }

  // 4. DEL: ["-d", "<ref>", "<filespec>"]
  if (args.length >= 3 && args[0] === "-d") {
    return args[2];
  }

  // 5. DEL_ALL: ["-D", "<target>", "<filespec>"]
  if (args.length >= 3 && args[0] === "-D") {
    return args[2];
  }

  // 6. QUERY: ["-X", "<expr>", "-g", ".", "<filespec>", ...]
  if (args[0] === "-X") {
    for (let i = 1; i < args.length - 1; i++) {
      if (args[i] === "-g" && args[i + 1] === "." && i + 2 < args.length) {
        return args[i + 2];
      }
    }
  }

  // 7. General positional fallback: scan from end for non-flag arguments
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    const prev = i > 0 ? args[i - 1] : "";
    if (prev === "-p" || prev === "-d" || prev === "-X" || prev === "-t" || prev === "-b") {
      continue;
    }
    if (!arg.startsWith("-") && arg.includes(".db")) {
      return arg;
    }
  }

  return null;
}

/**
 * Derives the database directory from an Invocation's argument list,
 * resolving relative paths against invocation.cwd.
 */
export function resolveDatabaseDir(inv: Invocation): string {
  let fspec = extractFilespec(inv);

  if (fspec) {
    const atIdx = fspec.indexOf("@");
    if (atIdx >= 0) fspec = fspec.slice(0, atIdx);
    const colonIdx = fspec.indexOf(":");
    if (colonIdx >= 0) fspec = fspec.slice(0, colonIdx);
    const dbDir = dirname(fspec);
    return isAbsolute(dbDir) ? dbDir : join(inv.cwd, dbDir);
  }

  return inv.cwd;
}

/**
 * Derives the canonical .cormd.lock path beside the target database file.
 */
export function resolveLockPath(inv: Invocation): string {
  return join(resolveDatabaseDir(inv), ".cormd.lock");
}

/**
 * Checks whether an exclusive advisory lock (flock) is currently held on lockPath
 * by another process (such as a resident cormd daemon).
 * Fails closed on unexpected filesystem or permission errors.
 */
export async function isDaemonLockHeld(lockPath: string): Promise<boolean> {
  // 1. Deno native advisory lock check
  if (typeof Deno !== "undefined" && typeof Deno.open === "function") {
    try {
      const f = await Deno.open(lockPath, { read: true, write: true });
      try {
        const acquired = await f.tryLock(true);
        if (acquired) {
          await f.unlock();
          f.close();
          return false;
        }
        f.close();
        return true;
      } catch {
        try { f.close(); } catch { /* ignore */ }
        return true; // Fail closed on unexpected lock error
      }
    } catch (err: unknown) {
      if (err instanceof Deno.errors.NotFound) {
        return false; // Confirmed: lock file does not exist
      }
      return true; // Fail closed on unexpected open error (e.g. EACCES)
    }
  }

  // 2. Node / POSIX spawnSync flock probe
  try {
    if (!existsSync(lockPath)) return false;
    const res = spawnSync("flock", ["-x", "-n", lockPath, "true"], { timeout: 200 });
    return res.status !== 0;
  } catch {
    return true; // Fail closed on unexpected spawn error
  }
}

export interface FormattedCommand {
  reqId: string;
  isMutation: boolean;
  header: string;
  body: string;
}

/**
 * Maps an Invocation produced by pi-mm invocation builders into the length-prefixed
 * cormd protocol frame.
 */
export function formatProtocolCommand(inv: Invocation, reqId: string = "1"): FormattedCommand | null {
  const args = inv.args;
  if (!args || args.length === 0) return null;

  // 1. LIST: -g . <filespec>
  if (args.length >= 3 && args[0] === "-g" && args[1] === ".") {
    const filespec = args[2];
    return {
      reqId,
      isMutation: false,
      header: `LIST ${reqId} ${filespec} 0`,
      body: "",
    };
  }

  // 2. GET: -r -g <ref> <filespec>
  if (args.length >= 4 && args[0] === "-r" && args[1] === "-g") {
    const ref = args[2];
    const filespec = args[3];
    return {
      reqId,
      isMutation: false,
      header: `GET ${reqId} ${filespec} ${ref} 0`,
      body: "",
    };
  }

  // 3. PUT: -p <ref>:<payload> <filespec>
  if (args.length >= 3 && args[0] === "-p") {
    const colonIdx = args[1].indexOf(":");
    if (colonIdx <= 0) return null;
    const ref = args[1].slice(0, colonIdx);
    const payload = args[1].slice(colonIdx + 1);
    const filespec = args[2];
    const bodyBytes = new TextEncoder().encode(payload);
    return {
      reqId,
      isMutation: true,
      header: `PUT ${reqId} ${filespec} ${ref} ${bodyBytes.length}`,
      body: payload,
    };
  }

  // 4. DEL: -d <ref> <filespec>
  if (args.length >= 3 && args[0] === "-d") {
    const ref = args[1];
    const filespec = args[2];
    return {
      reqId,
      isMutation: true,
      header: `DEL ${reqId} ${filespec} ${ref} 0`,
      body: "",
    };
  }

  // 5. DEL_ALL: -D <target> <filespec>
  if (args.length >= 2 && args[0] === "-D") {
    const target = args[1] ?? "all";
    const filespec = args[2] ?? "mem.db";
    return {
      reqId,
      isMutation: true,
      header: `DEL_ALL ${reqId} ${filespec} ${target} 0`,
      body: "",
    };
  }

  // 6. QUERY: -X <expr> -g . <filespec> -t <limit> [...extraArgs]
  if (args.length >= 7 && args[0] === "-X" && args[2] === "-g" && args[3] === ".") {
    const expr = args[1];
    const filespec = args[4];
    const limit = args[6];
    const extraArgs = args.slice(7);
    const body = extraArgs.length > 0 ? `${expr}\n${extraArgs.join("\n")}` : expr;
    const bodyBytes = new TextEncoder().encode(body);
    return {
      reqId,
      isMutation: false,
      header: `QUERY ${reqId} ${filespec} ${limit} ${bodyBytes.length}`,
      body,
    };
  }

  return null;
}

/**
 * Communicates with the cormd daemon over a Unix Domain Socket with strict timeout,
 * distinguishing pre-send connection failures from in-flight/mutation drops.
 */
export class DaemonQmapRunner implements QmapRunner {
  private reqCounter = 0;

  constructor(
    readonly socketPath: string,
    readonly fallback: QmapRunner,
    readonly timeoutMs: number = 1000,
  ) {}

  async run(inv: Invocation): Promise<PiExecResult> {
    const lockPath = resolveLockPath(inv);

    // 1. If socket does not exist on disk, fall back promptly
    if (!existsSync(this.socketPath)) {
      if (this.isMutation(inv) && (await isDaemonLockHeld(lockPath))) {
        return {
          stdout: "",
          stderr: "corm: database is leased by resident cormd, but daemon is unreachable; direct mutation refused",
          code: 1,
        };
      }
      return this.fallback.run(inv);
    }

    // 2. Format protocol command
    this.reqCounter = (this.reqCounter + 1) % 1000000;
    const reqId = String(this.reqCounter);
    const cmd = formatProtocolCommand(inv, reqId);
    if (!cmd) {
      // Unrecognized CLI invocation pattern: fall back
      return this.fallback.run(inv);
    }

    let sent = false;
    try {
      const response = await this.sendUdsRequest(cmd, () => {
        sent = true;
      });

      if (response.status === "OK") {
        return { stdout: response.body, stderr: "", code: 0 };
      } else {
        if (response.body.includes("reconciliation required") && !cmd.header.startsWith("RECONCILE")) {
          const rawFspec = extractFilespec(inv);
          if (rawFspec) {
            const recCmd: FormattedCommand = {
              reqId: `${reqId}_rec`,
              header: `RECONCILE ${reqId}_rec ${rawFspec} 0 0`,
              body: "",
              isMutation: true,
            };
            try {
              const recRes = await this.sendUdsRequest(recCmd, () => {});
              if (recRes.status === "OK") {
                const retryRes = await this.sendUdsRequest(cmd, () => {});
                if (retryRes.status === "OK") {
                  return { stdout: retryRes.body, stderr: "", code: 0 };
                }
              }
            } catch {
              // fall through to return error
            }
          }
        }
        return { stdout: "", stderr: response.body, code: 1 };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // If a mutation was sent to cormd, do NOT replay blindly via CLI!
      if (sent && cmd.isMutation) {
        return {
          stdout: "",
          stderr: `corm: mutation outcome ambiguous: ambiguous outcome (${errMsg}); replay refused`,
          code: 1,
        };
      }

      // Pre-send failure or read-only failure: safe to fall back to CLI runner
      if (cmd.isMutation && (await isDaemonLockHeld(lockPath))) {
        return {
          stdout: "",
          stderr: "corm: database is leased by resident cormd, but daemon is unreachable; direct mutation refused",
          code: 1,
        };
      }

      return this.fallback.run(inv);
    }
  }

  private isMutation(inv: Invocation): boolean {
    const args = inv.args;
    return args.includes("-p") || args.includes("-d") || args.includes("-D");
  }

  private sendUdsRequest(
    cmd: FormattedCommand,
    onSent: () => void,
  ): Promise<{ status: string; reqId: string; body: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const client = net.createConnection({ path: this.socketPath });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { client.destroy(); } catch { /* ignore */ }
        reject(new Error(`timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        try { client.destroy(); } catch { /* ignore */ }
      };

      client.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      client.on("connect", () => {
        const payloadBytes = new TextEncoder().encode(cmd.body);
        const header = `${cmd.header}\n`;
        const headerBytes = new TextEncoder().encode(header);
        const full = new Uint8Array(headerBytes.length + payloadBytes.length);
        full.set(headerBytes, 0);
        full.set(payloadBytes, headerBytes.length);

        client.write(full, (err) => {
          if (err) {
            if (settled) return;
            settled = true;
            cleanup();
            return reject(err);
          }
          onSent();
        });
      });

      let inBuffer = new Uint8Array(0);

      client.on("data", (chunk: Uint8Array) => {
        if (settled) return;
        const next = new Uint8Array(inBuffer.length + chunk.length);
        next.set(inBuffer, 0);
        next.set(chunk, inBuffer.length);
        inBuffer = next;

        // Check if header line received
        const text = new TextDecoder().decode(inBuffer);
        const nlIdx = text.indexOf("\n");
        if (nlIdx < 0) return;

        const headerLine = text.slice(0, nlIdx);
        const parts = headerLine.trim().split(" ");
        if (parts.length < 3) return;

        const status = parts[0];
        const reqId = parts[1];
        const bodyLen = parseInt(parts[2], 10);
        if (isNaN(bodyLen)) {
          settled = true;
          cleanup();
          return reject(new Error(`malformed daemon response header: ${headerLine}`));
        }

        const headerByteLen = new TextEncoder().encode(headerLine + "\n").length;
        if (inBuffer.length >= headerByteLen + bodyLen) {
          settled = true;
          const bodyBytes = inBuffer.slice(headerByteLen, headerByteLen + bodyLen);
          const body = new TextDecoder().decode(bodyBytes);
          cleanup();
          resolve({ status, reqId, body });
        }
      });

      client.on("close", () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("connection closed prematurely by cormd"));
        }
      });
    });
  }
}

export interface ProbeDaemonIdentityResult {
  live: boolean;
  matches: boolean;
  error?: string;
}

/**
 * Probes a daemon socket and verifies both active responsiveness and database identity.
 */
export function probeDaemonIdentity(
  socketPath: string,
  expectedFilespec: string,
  timeoutMs: number = 200,
): Promise<ProbeDaemonIdentityResult> {
  return new Promise((resolve) => {
    let done = false;
    const client = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        client.destroy();
        resolve({ live: false, matches: false });
      }
    }, timeoutMs);

    client.on("connect", () => {
      // Send a LIST probe with the expected database filespec
      client.write(`LIST 0 ${expectedFilespec} 0\n`);
    });

    client.on("data", (data) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        client.destroy();
        const text = data.toString();
        if (text.startsWith("OK")) {
          resolve({ live: true, matches: true });
        } else if (text.startsWith("ERR")) {
          resolve({ live: true, matches: false, error: text.slice(text.indexOf("\n") + 1).trim() });
        } else {
          resolve({ live: true, matches: false, error: "malformed response" });
        }
      }
    });

    client.on("error", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        client.destroy();
        resolve({ live: false, matches: false });
      }
    });
  });
}

/**
 * Pings a unix socket to check if a live cormd daemon is actively responding.
 * Backward compatible: accepts optional expectedFilespec or timeoutMs directly.
 */
export async function probeDaemonSocket(
  socketPath: string,
  expectedFilespecOrTimeout?: string | number,
  timeoutMs: number = 200,
): Promise<boolean> {
  let targetFspec = "ping";
  let timeout = timeoutMs;
  if (typeof expectedFilespecOrTimeout === "number") {
    timeout = expectedFilespecOrTimeout;
  } else if (typeof expectedFilespecOrTimeout === "string") {
    targetFspec = expectedFilespecOrTimeout;
  }

  const res = await probeDaemonIdentity(socketPath, targetFspec, timeout);
  return targetFspec === "ping" ? res.live : (res.live && res.matches);
}

export interface DaemonStartupOptions {
  cormdBin: string;
  filespec: string;
  socketPath: string;
  axisPath?: string;
  embedEnv?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Ensures exactly one resident cormd daemon is running and confirmed ready.
 * Handles existing daemons, stale dead sockets, concurrent startup races via withLock,
 * database identity verification, and axis/embedding environment configuration.
 */
export async function ensureDaemon(options: DaemonStartupOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const rawDb = options.filespec.includes("@")
    ? options.filespec.slice(0, options.filespec.indexOf("@"))
    : options.filespec.includes(":")
    ? options.filespec.slice(0, options.filespec.indexOf(":"))
    : options.filespec;
  const dbDir = isAbsolute(rawDb) ? dirname(rawDb) : join(options.cwd ?? process.cwd(), dirname(rawDb));
  const lockPath = join(dbDir, ".cormd.lock");

  // 1. If socket exists, probe if it is responsive and serving the expected database
  if (existsSync(options.socketPath)) {
    const probe = await probeDaemonIdentity(options.socketPath, options.filespec, 150);
    if (probe.live) {
      if (probe.matches) {
        return options.socketPath;
      } else {
        // Responsive but incompatible database: fail closed, never reuse silently!
        throw new Error(
          `cormd daemon on ${options.socketPath} is serving an incompatible database: ${probe.error ?? "database mismatch"}`,
        );
      }
    }

    // Socket exists but is unresponsive: check if a daemon holds the lock
    const locked = await isDaemonLockHeld(lockPath);
    if (!locked) {
      // Safe recovery: dead daemon left a stale socket
      try {
        rmSync(options.socketPath, { force: true });
      } catch {
        // Best effort removal
      }
    }
  }

  // 2. Spawn cormd daemon if socket is not present
  if (!existsSync(options.socketPath)) {
    try {
      mkdirSync(dirname(options.socketPath), { recursive: true });
    } catch {
      // Best effort directory creation
    }

    const env: Record<string, string> = {
      ...(runtimeEnv() as Record<string, string>),
      CORM_AXIS_PATH: options.axisPath ?? "",
      CORM_AXIS_LIBS: options.axisPath ?? "",
      QMAP_AXIS_PATH: options.axisPath ?? "",
      ...(options.embedEnv ?? {}),
    };

    const child = spawn(
      options.cormdBin,
      ["-d", options.filespec, "-s", options.socketPath, "-f"],
      {
        cwd: options.cwd,
        env,
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
  }

  // 3. Poll for confirmed socket readiness and identity match
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(options.socketPath)) {
      const probe = await probeDaemonIdentity(options.socketPath, options.filespec, 100);
      if (probe.live && probe.matches) {
        return options.socketPath;
      }
      if (probe.live && !probe.matches) {
        throw new Error(
          `cormd daemon on ${options.socketPath} is serving an incompatible database: ${probe.error ?? "database mismatch"}`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  // Final check at deadline
  if (existsSync(options.socketPath)) {
    const probe = await probeDaemonIdentity(options.socketPath, options.filespec, 150);
    if (probe.live && probe.matches) return options.socketPath;
    if (probe.live && !probe.matches) {
      throw new Error(
        `cormd daemon on ${options.socketPath} is serving an incompatible database: ${probe.error ?? "database mismatch"}`,
      );
    }
  }

  throw new Error(`cormd failed to confirm readiness on ${options.socketPath} within ${timeoutMs}ms`);
}
