import type { PiExecResult } from "./hooks/events.ts";
import { levelWindow, type JointWindow } from "./window.ts";
import type { MmConfig } from "./config.ts";
import { isDaemonLockHeld, resolveLockPath } from "./daemon.ts";

export { DaemonCormRunner, DaemonCormRunner as DaemonQmapRunner, isDaemonLockHeld, resolveLockPath } from "./daemon.ts";

export const FILESPEC = "mem.db@joint,lemma:a:b";
export const SEPAL_MIN_SIM = 0.2;
export const SEPAL_VEC_MAX = 2048;

export function filespecFor(memDir: string, embed?: boolean): string {
  return `${memDir}/mem.db@joint,lemma${embed ? ",sepal" : ""}:a:b`;
}

export function embedEnv(cfg: MmConfig): Record<string, string> {
  if (typeof cfg.embedUrl !== "string" || typeof cfg.embedModel !== "string") return {};
  const env: Record<string, string> = {
    CORM_SEPAL_EMBED_URL: cfg.embedUrl,
    CORM_SEPAL_EMBED_MODEL: cfg.embedModel,
  };
  if (typeof cfg.embedKey === "string" && cfg.embedKey.trim() !== "") {
    env["CORM_SEPAL_EMBED_KEY"] = cfg.embedKey;
  }
  if (cfg.ephemeralSepal) {
    env["CORM_SEPAL_EPHEMERAL"] = "1";
  }
  return env;
}

export interface Invocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  payloadBytes?: Uint8Array;
  ref?: number;
  filespec?: string;
}

export interface CormRunner {
  run(invocation: Invocation): Promise<PiExecResult>;
}

export class ShellCormRunner implements CormRunner {
  constructor(
    private readonly exec: (
      command: string,
      args: string[],
      options?: { cwd?: string; env?: Record<string, string>; stdin?: Uint8Array },
    ) => Promise<PiExecResult>,
  ) {}

  async run(invocation: Invocation): Promise<PiExecResult> {
    const isMutation = invocation.args.includes("-p") || invocation.args.includes("-d") || invocation.args.includes("-D");
    if (isMutation) {
      const lockPath = resolveLockPath(invocation);
      if (await isDaemonLockHeld(lockPath)) {
        return {
          stdout: "",
          stderr: "corm: database is leased by resident cormd; direct mutation forbidden",
          code: 1,
        };
      }
    }
    let execArgs = invocation.args;
    if (invocation.payloadBytes && execArgs.length >= 2 && execArgs[0] === "-p") {
      const colonIdx = execArgs[1].indexOf(":");
      if (colonIdx > 0) {
        const ref = execArgs[1].slice(0, colonIdx);
        execArgs = ["-p", `${ref}:-`, ...execArgs.slice(2)];
      }
    }
    return this.exec(invocation.command, execArgs, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdin: invocation.payloadBytes,
    });
  }
}

export { ShellCormRunner as ShellQmapRunner };

function base(bin: string, axisLibPath: string, memDir: string, extraEnv?: Record<string, string>): Invocation {
  return {
    command: bin,
    args: [],
    env: {
      CORM_AXIS_PATH: axisLibPath,
      ...extraEnv,
    },
    cwd: memDir,
  };
}

export function buildStoreInvocation(
  bin: string,
  filespec: string,
  ref: number,
  payload: string | Uint8Array,
  axisLibPath: string,
  memDir: string,
  extraEnv?: Record<string, string>,
): Invocation {
  const inv = base(bin, axisLibPath, memDir, extraEnv);
  inv.ref = ref;
  inv.filespec = filespec;
  if (payload instanceof Uint8Array) {
    inv.payloadBytes = payload;
    inv.args = ["-p", `${ref}:-`, filespec];
  } else {
    inv.args = ["-p", `${ref}:${payload}`, filespec];
  }
  return inv;
}

export function buildScanInvocation(
  bin: string,
  filespec: string,
  expr: string,
  limit: number,
  axisLibPath: string,
  memDir: string,
  extraEnv?: Record<string, string>,
  extraArgs?: string[],
): Invocation {
  const inv = base(bin, axisLibPath, memDir, extraEnv);
  inv.args = ["-X", expr, "-g", ".", filespec, "-t", String(limit), ...(extraArgs ?? [])];
  return inv;
}

export function buildListInvocation(
  bin: string,
  filespec: string,
  axisLibPath: string,
  memDir: string,
  extraEnv?: Record<string, string>,
): Invocation {
  const inv = base(bin, axisLibPath, memDir, extraEnv);
  inv.args = ["-g", ".", filespec];
  return inv;
}

export function buildGetInvocation(
  bin: string,
  filespec: string,
  ref: number,
  axisLibPath: string,
  memDir: string,
  extraEnv?: Record<string, string>,
): Invocation {
  const inv = base(bin, axisLibPath, memDir, extraEnv);
  inv.args = ["-r", "-g", String(ref), filespec];
  return inv;
}

export function buildForgetInvocation(
  bin: string,
  filespec: string,
  ref: number,
  axisLibPath: string,
  memDir: string,
  extraEnv?: Record<string, string>,
): Invocation {
  const inv = base(bin, axisLibPath, memDir, extraEnv);
  inv.args = ["-d", String(ref), filespec];
  return inv;
}

export function scanWindow(level: number, now: Date, until?: string): JointWindow | null {
  const w = levelWindow(level, now);
  if (w === null) {
    if (until) return { a: "0", b: until };
    return null;
  }
  return { a: w.a, b: until && until < w.b ? until : w.b };
}

export function scanWindowArgs(level: number, now: Date, until?: string): string[] {
  const w = scanWindow(level, now, until);
  return w ? ["--since=" + w.a, "--until=" + w.b] : [];
}

export function scanExpr(_topic: string, level: number, now: Date, until?: string, withEmbed?: boolean): string {
  const parts: string[] = [];
  const window = scanWindow(level, now, until);
  if (window) parts.push("joint");
  parts.push("lemma");
  if (withEmbed) parts.push("sepal");
  return parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;
}

export function scanLexicalExpr(level: number, now: Date, until?: string): string {
  const parts: string[] = [];
  const window = scanWindow(level, now, until);
  if (window) parts.push("joint");
  parts.push("lemma");
  return parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;
}

export function scanSemanticExpr(level: number, now: Date, until?: string): string {
  const parts: string[] = [];
  const window = scanWindow(level, now, until);
  if (window) parts.push("joint");
  parts.push("sepal");
  return parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;
}

export interface ResultLine {
  ref: number;
  score?: string;
  record: string;
}

export function parseResultLines(stdout: string): ResultLine[] {
  const lines: ResultLine[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const scored = /^(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s+([\s\S]*)$/.exec(line);
    if (scored) {
      lines.push({ ref: Number(scored[1]), score: scored[2], record: scored[3] });
      continue;
    }
    const plain = /^(\d+)\s+([\s\S]*)$/.exec(line);
    if (plain) {
      lines.push({ ref: Number(plain[1]), record: plain[2] });
      continue;
    }
    if (lines.length > 0 && line !== "") {
      lines[lines.length - 1].record += "\n" + line;
    }
  }
  return lines;
}

export function payloadDate(timestamp: string | undefined, now: Date): string {
  if (typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2}/.test(timestamp)) return timestamp.slice(0, 10);
  return toISODateLocal(now);
}

function toISODateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
