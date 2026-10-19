import { open, unlink, stat, readFile, mkdir, writeFile, link } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const inProcessLocks = new Map<string, Promise<void>>();

export interface LockOptions {
  timeoutMs?: number;
  staleThresholdMs?: number;
  /** Optional barrier hook for deterministic main lock testing */
  onAfterStaleInspection?: (info: LockInfo) => Promise<void> | void;
  /** Optional barrier hook for deterministic coordinator lock testing */
  onAfterCoordinatorInspection?: (info: CoordinatorLockInfo) => Promise<void> | void;
  /** Optional barrier hook for testing the critical interval between verification and removal */
  onBeforeCoordinatorRemoval?: (info: CoordinatorLockInfo) => Promise<void> | void;
  /** Optional barrier hook to simulate coordinator metadata write failure */
  onBeforeCoordinatorMetadataWrite?: () => Promise<void> | void;
  /** Optional barrier hook to simulate main lock metadata write failure or pause */
  onBeforeMainLockMetadataWrite?: () => Promise<void> | void;
  /** Optional barrier hook to simulate pause or failure immediately before atomic publish */
  onBeforePublish?: () => Promise<void> | void;
}

export interface LockInfo {
  pid: number;
  createdAt: number;
  token?: string;
}

export interface CoordinatorLockInfo {
  pid: number;
  token: string;
  createdAt: number;
}

export interface CoordinatorLease {
  token: string;
  filePath: string;
  fsFile?: {
    unlock(): Promise<void>;
    close(): void;
  };
  release?: () => Promise<void> | void;
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ESRCH") return false; // Confirmed: process does not exist
    return true; // Fail closed: EPERM or ambiguous system error treats process as alive
  }
}

function acquireNodeFlock(
  filePath: string,
  payload: string,
  token: string,
  opts: LockOptions,
): Promise<CoordinatorLease | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("flock", ["-x", "-n", filePath, "sh", "-c", "printf READY\\n; exec cat"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return resolve(null);
    }

    const cleanup = () => {
      try { child.stdin?.destroy(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    };

    child.stdout?.on("data", async (chunk) => {
      if (resolved) return;
      if (chunk.toString().includes("READY")) {
        resolved = true;
        try {
          if (opts.onBeforeCoordinatorMetadataWrite) {
            await opts.onBeforeCoordinatorMetadataWrite();
          }
          await writeFile(filePath, payload);
          resolve({ token, filePath, release: cleanup });
        } catch {
          cleanup();
          resolve(null);
        }
      }
    });

    child.on("exit", () => {
      if (!resolved) { resolved = true; resolve(null); }
    });
    child.on("error", () => {
      if (!resolved) { resolved = true; resolve(null); }
    });
  });
}

async function acquireRecoveryCoordinationLock(
  recoveryLockFile: string,
  opts: LockOptions = {},
): Promise<CoordinatorLease | null> {
  const myPid = typeof process !== "undefined" ? process.pid : 0;
  const myToken = crypto.randomUUID();
  const payload = JSON.stringify({ pid: myPid, token: myToken, createdAt: Date.now() });

  // 1. OS-enforced advisory lock (flock) via Deno.open and tryLock(true)
  if (typeof Deno !== "undefined" && typeof Deno.open === "function") {
    try {
      const f = await Deno.open(recoveryLockFile, { create: true, write: true, read: true });
      const acquired = await f.tryLock(true);
      if (acquired) {
        try {
          if (opts.onBeforeCoordinatorMetadataWrite) {
            await opts.onBeforeCoordinatorMetadataWrite();
          }
          await f.truncate(0);
          await f.write(new TextEncoder().encode(payload));
          return { token: myToken, filePath: recoveryLockFile, fsFile: f };
        } catch {
          try { await f.unlock(); } catch { /* ignore */ }
          try { f.close(); } catch { /* ignore */ }
          return null;
        }
      }
      f.close();

      // Coordinator is held by another process: run hooks then strictly fail closed
      const inspected: CoordinatorLockInfo = { pid: 0, token: "", createdAt: 0 };
      if (opts.onAfterCoordinatorInspection) {
        await opts.onAfterCoordinatorInspection(inspected);
      }
      if (opts.onBeforeCoordinatorRemoval) {
        await opts.onBeforeCoordinatorRemoval(inspected);
      }
      // Strictly fail closed: never attempt uncoordinated deletion of an existing coordinator lock
      return null;
    } catch {
      return null;
    }
  }

  // 2. Node.js OS advisory lock via flock (Linux / POSIX)
  const nodeLease = await acquireNodeFlock(recoveryLockFile, payload, myToken, opts);
  if (nodeLease) return nodeLease;

  // 3. Filesystem fallback: exclusive file creation open("wx")
  try {
    const handle = await open(recoveryLockFile, "wx");
    try {
      if (opts.onBeforeCoordinatorMetadataWrite) {
        await opts.onBeforeCoordinatorMetadataWrite();
      }
      await handle.write(new TextEncoder().encode(payload));
    } catch (writeErr) {
      try { await handle.close(); } catch { /* ignore */ }
      await unlink(recoveryLockFile).catch(() => {});
      throw writeErr;
    }
    await handle.close();
    return { token: myToken, filePath: recoveryLockFile };
  } catch {
    // Strictly fail closed: never unlink existing coordinator locks from competing processes
    return null;
  }
}

async function safeReleaseCoordinatorLock(lease: CoordinatorLease): Promise<void> {
  if (lease.fsFile) {
    try { await lease.fsFile.unlock(); } catch { /* ignore */ }
    try { lease.fsFile.close(); } catch { /* ignore */ }
    return;
  }
  if (lease.release) {
    try { await lease.release(); } catch { /* ignore */ }
    return;
  }
  try {
    const content = await readFile(lease.filePath, "utf-8");
    const info = JSON.parse(content) as CoordinatorLockInfo;
    const myPid = typeof process !== "undefined" ? process.pid : 0;
    if (info?.token === lease.token && info?.pid === myPid) {
      await unlink(lease.filePath).catch(() => {});
    }
  } catch { /* ignore */ }
}

async function safeReleaseFileLock(lockFile: string, myToken: string): Promise<void> {
  try {
    const content = await readFile(lockFile, "utf-8");
    const info = JSON.parse(content) as LockInfo;
    const myPid = typeof process !== "undefined" ? process.pid : 0;
    if (info?.token === myToken && info?.pid === myPid) {
      await unlink(lockFile).catch(() => {});
    }
  } catch { /* ignore */ }
}

async function tryRecoverStaleLock(
  lockFile: string,
  staleThresholdMs: number,
  opts: LockOptions,
): Promise<void> {
  let inspectedInfo: LockInfo | null = null;
  try {
    const st = await stat(lockFile);
    if (Date.now() - st.mtimeMs < staleThresholdMs) return;
    const content = await readFile(lockFile, "utf-8");
    if (content.trim() === "") return; // Fail closed on legacy empty lock (unknown creator)
    inspectedInfo = JSON.parse(content);
  } catch {
    return; // Malformed or absent: fail closed
  }

  if (!inspectedInfo || typeof inspectedInfo.pid !== "number" || inspectedInfo.pid <= 0 || isPidAlive(inspectedInfo.pid)) {
    return;
  }

  if (opts.onAfterStaleInspection) {
    await opts.onAfterStaleInspection(inspectedInfo);
  }

  // Coordinate recovery across all processes to eliminate TOCTOU replacement races
  const recoveryLockFile = `${lockFile}.recovery.lock`;
  const coordinatorLease = await acquireRecoveryCoordinationLock(recoveryLockFile, opts);
  if (!coordinatorLease) return;

  try {
    // Under coordination lock, safely recheck ownership of lockFile
    let currentContent: string;
    try {
      currentContent = await readFile(lockFile, "utf-8");
    } catch {
      return; // Lock already cleaned up or released
    }

    const st = await stat(lockFile);
    if (Date.now() - st.mtimeMs < staleThresholdMs) return; // Fresh lock replaced the old one

    if (currentContent.trim() === "") return; // Legacy empty lock: fail closed

    let currentInfo: LockInfo;
    try {
      currentInfo = JSON.parse(currentContent);
    } catch {
      return; // Fail closed on malformed
    }

    if (!currentInfo || typeof currentInfo.pid !== "number" || currentInfo.pid <= 0 || isPidAlive(currentInfo.pid)) {
      return; // Lock owner is alive or unknown: do not touch!
    }

    if (inspectedInfo.token && currentInfo.token !== inspectedInfo.token) return; // Replaced
    if (inspectedInfo.pid !== currentInfo.pid) return; // Replaced

    await unlink(lockFile).catch(() => {});
  } finally {
    await safeReleaseCoordinatorLock(coordinatorLease);
  }
}

async function acquireFileLock(
  lockFile: string,
  start: number,
  timeoutMs: number,
  staleThresholdMs: number,
  opts: LockOptions,
): Promise<string> {
  const myPid = typeof process !== "undefined" ? process.pid : 0;
  while (true) {
    const token = crypto.randomUUID();
    const tmpFile = `${lockFile}.tmp.${myPid}.${token}`;
    try {
      if (opts.onBeforeMainLockMetadataWrite) {
        await opts.onBeforeMainLockMetadataWrite();
      }
      const payload = JSON.stringify({ pid: myPid, token, createdAt: Date.now() });
      await writeFile(tmpFile, payload);
      if (opts.onBeforePublish) {
        await opts.onBeforePublish();
      }
      await link(tmpFile, lockFile);
      return token;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "EEXIST") {
        await tryRecoverStaleLock(lockFile, staleThresholdMs, opts);
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Failed to acquire memory lock on ${lockFile} after ${timeoutMs}ms (lock contention)`);
      }
      const backoff = 20 + Math.floor(Math.random() * 20);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  }
}

export async function withLock<T>(
  dir: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const staleThresholdMs = opts.staleThresholdMs ?? 5000;

  // 1. In-process queue: ensures serialized execution within the same process
  let releaseInProcess: () => void = () => {};
  const currentLock = inProcessLocks.get(dir) ?? Promise.resolve();
  const lockAcquiredPromise = new Promise<void>((resolve) => {
    releaseInProcess = resolve;
  });
  inProcessLocks.set(dir, currentLock.then(() => lockAcquiredPromise, () => lockAcquiredPromise));
  await currentLock;

  // 2. Cross-process filesystem lock: unconditionally enforced inside try/finally
  const lockFile = join(dir, ".mm.lock");
  let acquiredToken: string | null = null;

  try {
    await mkdir(dir, { recursive: true });
    acquiredToken = await acquireFileLock(lockFile, Date.now(), timeoutMs, staleThresholdMs, opts);
    return await fn();
  } finally {
    if (acquiredToken) {
      await safeReleaseFileLock(lockFile, acquiredToken);
    }
    releaseInProcess();
  }
}
