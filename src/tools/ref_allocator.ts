import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { QmapRunner } from "../qmap.ts";
import { buildListInvocation } from "../qmap.ts";
import { parseBareRefs, nextRef } from "../resolve.ts";

export function refSeqFilePath(memDir: string): string {
  return join(memDir, ".ref_seq");
}

/**
 * Reconciles the persistent reference counter against the actual database roster.
 * Called on first initialization or during collision recovery.
 * Caller must hold the memDir lock.
 */
export async function reconcileRefSeq(
  memDir: string,
  runner: QmapRunner,
  qmapBin: string,
  fspec: string,
  axes: string,
  eEnv?: Record<string, string>,
): Promise<number> {
  const listRes = await runner.run(buildListInvocation(qmapBin, fspec, axes, memDir, eEnv));
  const refs = parseBareRefs(listRes.stdout);
  const next = nextRef(refs);

  const targetPath = refSeqFilePath(memDir);
  const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await mkdir(memDir, { recursive: true });
    await writeFile(tmpPath, `${next}\n`, "utf8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  return next;
}

/**
 * Advances the persistent reference sequence to at least targetNext.
 * Ensures the sequence stays ahead of any manual stores or batch flushes.
 * Caller must hold the memDir lock.
 */
export async function advanceRefSeq(memDir: string, targetNext: number): Promise<void> {
  const seqPath = refSeqFilePath(memDir);
  let currentVal = 1;
  try {
    const raw = await readFile(seqPath, "utf8");
    const parsed = parseInt(raw.trim(), 10);
    if (!isNaN(parsed) && parsed >= 1) currentVal = parsed;
  } catch { /* ignore */ }
  const nextVal = Math.max(currentVal, targetNext);
  const tmpPath = `${seqPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await mkdir(memDir, { recursive: true });
    await writeFile(tmpPath, `${nextVal}\n`, "utf8");
    await rename(tmpPath, seqPath);
  } catch {
    try { await unlink(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Checks whether the persistent sequence file exists and contains a valid integer >= 1.
 * Allows the scheduler to account for one-time roster reconciliation in pre-flight budgeting.
 */
export async function isRefSeqInitialized(memDir: string): Promise<boolean> {
  const seqPath = refSeqFilePath(memDir);
  try {
    const raw = await readFile(seqPath, "utf8");
    const parsed = parseInt(raw.trim(), 10);
    return !isNaN(parsed) && parsed >= 1;
  } catch {
    return false;
  }
}

/**
 * Atomically allocates the next reference ID from the persistent sequence.
 * Avoids enumerating the entire database on ordinary operations.
 * Caller must hold the memDir lock.
 */
export async function allocateNextRef(
  memDir: string,
  runner: QmapRunner,
  qmapBin: string,
  fspec: string,
  axes: string,
  eEnv?: Record<string, string>,
  budget?: { charge: (type: "list" | "get" | "store" | "synth", count?: number) => void },
): Promise<number> {
  const seqPath = refSeqFilePath(memDir);

  let currentVal: number | null = null;
  try {
    const raw = await readFile(seqPath, "utf8");
    const parsed = parseInt(raw.trim(), 10);
    if (!isNaN(parsed) && parsed >= 1) {
      currentVal = parsed;
    }
  } catch {
    currentVal = null;
  }

  if (currentVal === null) {
    if (budget) budget.charge("list", 1);
    // Missing, empty, or unparseable: perform one-time roster reconciliation
    const reconciledStart = await reconcileRefSeq(memDir, runner, qmapBin, fspec, axes, eEnv);
    // Write reconciledStart + 1 for subsequent callers
    const targetPath = seqPath;
    const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      await writeFile(tmpPath, `${reconciledStart + 1}\n`, "utf8");
      await rename(tmpPath, targetPath);
    } catch {
      try { await unlink(tmpPath); } catch { /* ignore */ }
    }
    return reconciledStart;
  }

  const allocated = currentVal;
  const nextVal = currentVal + 1;

  const tmpPath = `${seqPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tmpPath, `${nextVal}\n`, "utf8");
    await rename(tmpPath, seqPath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  return allocated;
}
