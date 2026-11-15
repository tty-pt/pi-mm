/**
 * Verification-Attested Epistemic Promotion Ledger (src/hooks/verification_ledger.ts).
 * Tracks failing test/build commands, edited files/symbols, and FAIL -> PASS transitions
 * within a session to automatically synthesize attested L2 causal fix memories and bind them to AST anchors.
 */

import type { PiCtx, ToolResultEvent } from "./events.ts";
import type { EnvSource } from "../tools/index.ts";
import { executeStore } from "../tools/store.ts";
import { extractReliableProjectContext } from "./events.ts";
import { debugLog } from "../debug.ts";
import { normalizeRelPath } from "../code/payload_codec.ts";

import { deriveModuleKey, inferTier0VerificationGate } from "../code/dossier.ts";

export interface FailedVerificationEntry {
  commandKey: string;
  rawCommand: string;
  errorSnippet: string;
  failedAtMs: number;
  mutatedFilesSinceFail: Set<string>;
}

export interface ModuleVerificationReport {
  moduleKey: string;
  changedFiles: string[];
  requiredCommand: string;
  status: "verified" | "unverified_since_edit" | "unverified";
  lastMutatedAtMs?: number;
  lastVerifiedAtMs?: number;
}

const sessionFailedLedger = new Map<string, Map<string, FailedVerificationEntry>>();
const sessionPassedLedger = new Map<string, Set<string>>();
const sessionFileMutationTime = new Map<string, Map<string, number>>();
const sessionCommandPassTime = new Map<string, Map<string, number>>();

export function clearVerificationLedger(): void {
  sessionFailedLedger.clear();
  sessionPassedLedger.clear();
  sessionFileMutationTime.clear();
  sessionCommandPassTime.clear();
}

export function hasAttestedPassingVerification(sessionId: string, reportedTests?: string[]): boolean {
  if (!sessionId || !reportedTests || reportedTests.length === 0) return false;
  const passed = sessionPassedLedger.get(sessionId);
  if (!passed || passed.size === 0) return false;
  return reportedTests.some((t) => {
    const norm = normalizeVerificationCommandKey(t);
    const low = t.trim().toLowerCase();
    if (!low) return false;
    for (const p of passed) {
      if (p === norm || p === low || p.includes(low) || low.includes(p)) return true;
    }
    return false;
  });
}

const VERIFICATION_COMMAND_MARKERS = [
  "make test", "make site-wasm", "make mods", "make -c mods/", "deno test",
  "npm test", "node --test", "./test.sh", "check-module-boundaries.sh",
  "check-wasm-imports.sh", "check-no-site-specific-js.sh", "check-complexity.ts",
  "cargo test", "pytest", "go test",
];

export function isVerificationCommand(cmd: string): boolean {
  const lower = cmd.toLowerCase().trim();
  if (!lower) return false;
  return VERIFICATION_COMMAND_MARKERS.some((m) => lower.includes(m));
}

export function normalizeVerificationCommandKey(cmd: string): string {
  const trimmed = cmd.trim();
  const parts = trimmed.split(" ").filter(Boolean);
  return parts.slice(0, 6).join(" ").toLowerCase();
}

export function recordFileMutationInLedger(sessionId: string, filePath: string, timestampMs = Date.now()): void {
  const norm = normalizeRelPath(filePath);
  if (sessionId && norm) {
    let mutMap = sessionFileMutationTime.get(sessionId);
    if (!mutMap) {
      mutMap = new Map<string, number>();
      sessionFileMutationTime.set(sessionId, mutMap);
    }
    mutMap.set(norm, timestampMs);
  }
  const map = sessionFailedLedger.get(sessionId);
  if (!map || map.size === 0) return;
  for (const entry of map.values()) {
    entry.mutatedFilesSinceFail.add(norm);
  }
}

function findLatestPassTimestampForGate(
  passMap: Map<string, number> | undefined,
  modKey: string,
  requiredCommand: string,
): number | undefined {
  if (!passMap || passMap.size === 0) return undefined;
  const reqLower = requiredCommand.toLowerCase();
  const modLeaf = modKey.includes("/") ? modKey.slice(modKey.lastIndexOf("/") + 1).toLowerCase() : modKey.toLowerCase();
  let best: number | undefined;
  for (const [cmd, ts] of passMap.entries()) {
    const matchesGate = cmd.includes(reqLower) || reqLower.includes(cmd) ||
      (modLeaf.length >= 2 && cmd.includes(modLeaf) && isVerificationCommand(cmd));
    if (matchesGate && (best === undefined || ts > best)) best = ts;
  }
  return best;
}

export function evaluateModuleVerificationStatus(
  sessionId: string,
  changedFiles: string[],
): ModuleVerificationReport[] {
  if (changedFiles.length === 0) return [];
  const byMod = new Map<string, { files: string[]; sampleFile: string }>();
  for (const raw of changedFiles) {
    const norm = normalizeRelPath(raw);
    const modKey = deriveModuleKey(norm);
    if (!modKey) continue;
    const cur = byMod.get(modKey);
    if (cur) cur.files.push(norm);
    else byMod.set(modKey, { files: [norm], sampleFile: norm });
  }
  const mutMap = sessionFileMutationTime.get(sessionId);
  const passMap = sessionCommandPassTime.get(sessionId);
  const reports: ModuleVerificationReport[] = [];

  for (const [modKey, group] of byMod.entries()) {
    const gate = inferTier0VerificationGate(modKey, group.sampleFile);
    if (!gate) continue;
    let lastMutatedAtMs: number | undefined;
    for (const f of group.files) {
      const m = mutMap?.get(f);
      if (m !== undefined && (lastMutatedAtMs === undefined || m > lastMutatedAtMs)) lastMutatedAtMs = m;
    }
    const lastVerifiedAtMs = findLatestPassTimestampForGate(passMap, modKey, gate.command);
    let status: ModuleVerificationReport["status"] = "unverified";
    if (lastVerifiedAtMs !== undefined) {
      status = (lastMutatedAtMs !== undefined && lastMutatedAtMs > lastVerifiedAtMs) ? "unverified_since_edit" : "verified";
    } else if (lastMutatedAtMs !== undefined) {
      status = "unverified_since_edit";
    }
    reports.push({
      moduleKey: modKey,
      changedFiles: group.files,
      requiredCommand: gate.command,
      status,
      lastMutatedAtMs,
      lastVerifiedAtMs,
    });
  }
  return reports;
}

async function persistVerifiedFix(
  priorFail: FailedVerificationEntry,
  mutatedFiles: string[],
  envSource: EnvSource,
  ctx: PiCtx,
): Promise<number | null> {
  try {
    const fileSummary = mutatedFiles.slice(0, 4).join(", ");
    const summary = `Verified Fix (${priorFail.rawCommand}): Resolved "${priorFail.errorSnippet.slice(0, 100)}" by updating ${fileSummary}`;
    const projectCtx = extractReliableProjectContext(ctx);
    const res = await executeStore(
      envSource,
      {
        level: "L2",
        type: "episode",
        lifecycle: "tested",
        summary: summary.slice(0, 250),
        context: { ...projectCtx, path: mutatedFiles[0] },
        episode: {
          problem: priorFail.errorSnippet,
          approaches: [{
            approach: `Modified ${fileSummary} and verified with \`${priorFail.rawCommand}\``,
            outcome: "worked",
            reason: `Transitioned \`${priorFail.rawCommand}\` from FAIL to PASS (exit 0)`,
          }],
          findings: [`Failing symptom: ${priorFail.errorSnippet}`, `Verified fix in: ${fileSummary}`],
          diffs: mutatedFiles,
          outcome: "success",
        },
        tags: ["attested-fix", "fail-to-pass"],
      },
      ctx,
    );
    const ref = (res.details as { ref?: number } | undefined)?.ref ?? null;
    if (ref) {
      debugLog("capture", "Synthesized attested FAIL->PASS L2 causal fix memory", { ref, cmd: priorFail.rawCommand, files: mutatedFiles });
    }
    return ref;
  } catch {
    return null;
  }
}

export async function observeBashVerificationOutcome(
  sessionId: string,
  event: ToolResultEvent,
  envSource?: EnvSource,
  ctx?: PiCtx,
): Promise<number | null> {
  if (event.toolName !== "bash") return null;
  const rawCmd = String(
    (event.input as Record<string, unknown> | undefined)?.["command"]
    ?? (event.args as Record<string, unknown> | undefined)?.["command"]
    ?? "",
  ).trim();
  if (!isVerificationCommand(rawCmd)) return null;

  const cmdKey = normalizeVerificationCommandKey(rawCmd);
  const outText = Array.isArray(event.content) ? event.content.map((p) => p.text ?? "").join("\n").trim() : "";

  let map = sessionFailedLedger.get(sessionId);
  if (!map) {
    map = new Map<string, FailedVerificationEntry>();
    sessionFailedLedger.set(sessionId, map);
  }

  if (event.isError) {
    const firstErrLine = outText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.toLowerCase().includes("error") || l.toLowerCase().includes("fail"))
      ?? outText.slice(0, 180);
    const existing = map.get(cmdKey);
    map.set(cmdKey, {
      commandKey: cmdKey,
      rawCommand: rawCmd.slice(0, 160),
      errorSnippet: firstErrLine.slice(0, 220),
      failedAtMs: Date.now(),
      mutatedFilesSinceFail: existing ? existing.mutatedFilesSinceFail : new Set<string>(),
    });
    return null;
  }

  let passed = sessionPassedLedger.get(sessionId);
  if (!passed) {
    passed = new Set<string>();
    sessionPassedLedger.set(sessionId, passed);
  }
  const nowMs = Date.now();
  passed.add(cmdKey);
  passed.add(rawCmd.toLowerCase());
  let passTimes = sessionCommandPassTime.get(sessionId);
  if (!passTimes) {
    passTimes = new Map<string, number>();
    sessionCommandPassTime.set(sessionId, passTimes);
  }
  passTimes.set(cmdKey, nowMs);
  passTimes.set(rawCmd.toLowerCase(), nowMs);

  const priorFail = map.get(cmdKey);
  if (!priorFail) return null;
  map.delete(cmdKey);

  const mutatedFiles = Array.from(priorFail.mutatedFilesSinceFail);
  if (mutatedFiles.length === 0 || !envSource || !ctx) return null;
  return await persistVerifiedFix(priorFail, mutatedFiles, envSource, ctx);
}
