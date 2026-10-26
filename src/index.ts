import { installTools, defaultEnvSource, resolveMemDir, cormBin, memDir, axisPath } from "./tools/index.ts";
import { installSessionHooks } from "./hooks/events.ts";
import { checkMmHealth } from "./judge/adapter.ts";
import { readMmConfig, describeCapabilities, sepalConfigured } from "./config.ts";
import { buildMemoryOverview } from "./tools/overview.ts";
import { filespecFor, buildListInvocation, embedEnv } from "./corm.ts";
import { parseBareRefs } from "./resolve.ts";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MmReportData {
  title: string;
  lines: string[];
  timestamp?: number;
}

export function createMmReportComponent(
  data: MmReportData,
  theme?: {
    fg?: (name: string, text: string) => string;
    bg?: (name: string, text: string) => string;
    bold?: (text: string) => string;
  },
) {
  return {
    render(width: number): string[] {
      const w = Math.max(30, Math.min(width - 2, 76));
      const border = theme?.fg ? theme.fg("border", "─".repeat(w)) : "─".repeat(w);
      const titleText = theme?.bold && theme?.fg ? theme.bold(theme.fg("accent", ` ${data.title} `)) : ` ${data.title} `;
      const output: string[] = [border, titleText, border];
      for (const line of data.lines) {
        let styled = line;
        if (theme?.fg) {
          if (line.startsWith("[✓]")) styled = `${theme.fg("success", "[✓]")}${line.slice(3)}`;
          else if (line.startsWith("[✗]")) styled = `${theme.fg("error", "[✗]")}${line.slice(3)}`;
          else if (line.startsWith("[-]")) styled = `${theme.fg("dim", "[-]")}${line.slice(3)}`;
          else if (line.startsWith("[!]")) styled = `${theme.fg("warning", "[!]")}${line.slice(3)}`;
        }
        output.push(`  ${styled}`);
      }
      output.push(border);
      return output;
    },
    invalidate(): void {},
  };
}

async function runOverviewReport(
  envSource: (ctx: import("./hooks/events.ts").PiCtx) => Promise<import("./tools/index.ts").ToolEnv>,
  ctx: { cwd: string },
  extApi: { appendEntry?: (type: string, data: unknown) => void },
): Promise<void> {
  const env = await envSource(ctx as unknown as import("./hooks/events.ts").PiCtx);
  const overview = await buildMemoryOverview(env, { limit: 12 });
  const lines: string[] = [
    `[-] Total Records: ${overview.totalRecords} (${overview.scannedRecords} evaluated)`,
  ];
  if (overview.activeSpan.earliestDate && overview.activeSpan.latestDate) {
    lines.push(`[✓] Operational Timeline: ${overview.activeSpan.earliestDate} to ${overview.activeSpan.latestDate}`);
  }
  lines.push(`[-] Tiers: L3=${overview.levelCounts.L3} (Principles), L2=${overview.levelCounts.L2} (Invariants), L1=${overview.levelCounts.L1} (Tasks), L0=${overview.levelCounts.L0} (Raw)`);

  if (overview.principles.length > 0) {
    lines.push(`[✓] Universal Principles (L3):`);
    for (const pr of overview.principles.slice(0, 3)) {
      lines.push(`    • [Ref ${pr.ref}]: ${pr.summary}`);
    }
  }

  if (overview.invariantsAndDecisions.length > 0) {
    lines.push(`[✓] Invariants & Decisions (L2):`);
    for (const inv of overview.invariantsAndDecisions.slice(0, 4)) {
      const scope = [inv.project, inv.subsystem].filter(Boolean).join("/");
      lines.push(`    • [Ref ${inv.ref}]${scope ? ` (${scope})` : ""}: ${inv.summary}`);
    }
  }

  if (overview.timeline.length > 0) {
    lines.push(`[-] Timeline Epochs:`);
    for (const ep of overview.timeline.slice(-4)) {
      lines.push(`    • Epoch ${ep.epoch} (${ep.count} memories): ${ep.highlights.map((h) => `[Ref ${h.ref}]`).join(", ") || "various tasks"}`);
    }
  }

  lines.push(`[-] Zoom-In: Use memory_recall({ zoomRef: <ref> }) in agent turns to inspect full approaches & evidence.`);

  const reportData: MmReportData = {
    title: "Pi-MM Memory Overview & Timeline",
    lines,
    timestamp: Date.now(),
  };

  if (typeof extApi.appendEntry === "function") {
    extApi.appendEntry("mm-report", reportData);
  }
}

async function runDoctorReport(
  envSource: (ctx: import("./hooks/events.ts").PiCtx) => Promise<import("./tools/index.ts").ToolEnv>,
  ctx: { cwd: string },
  cfg: import("./config.ts").MmConfig,
  extApi: { appendEntry?: (type: string, data: unknown) => void },
): Promise<void> {
  const health = await checkMmHealth(cfg);
  const lines: string[] = [
    health.judgeOk
      ? `[✓] Decision Judge: ${health.judgeEndpoint} (200 OK, latency: ${health.judgeLatencyMs}ms)`
      : `[✗] Decision Judge: ${health.judgeEndpoint} (OFFLINE - ${health.judgeError})`,
  ];
  if (health.judgeModels && health.judgeModels.length > 0) {
    lines.push(`[✓] Models Detected: ${health.judgeModels.join(", ")}`);
  }
  if (cfg.embedUrl) {
    lines.push(
      health.embedOk
        ? `[✓] Embeddings Endpoint: ${health.embedEndpoint} (200 OK, latency: ${health.embedLatencyMs}ms)`
        : `[✗] Embeddings Endpoint: ${health.embedEndpoint} (OFFLINE - ${health.embedError})`,
    );
  } else {
    lines.push("[-] Embeddings Endpoint: Unconfigured (semantic search disabled)");
  }
  lines.push(`[-] Pipeline: ${describeCapabilities(cfg)}`);
  const keywords = cfg.captureKeywords && cfg.captureKeywords.length > 0
    ? cfg.captureKeywords
    : (cfg.captureKeyword ? [cfg.captureKeyword] : ["@remember", "@memory", "remember:", "note:"]);
  lines.push(`[-] Trigger Word Families: ${keywords.map((k) => `'${k}'`).join(", ")}`);

  // Primary Storage & HTOK Density diagnostics
  const targetCwd = typeof (ctx as { cwd?: string })?.cwd === "string" ? (ctx as { cwd: string }).cwd : ".";
  const memDirPath = resolveMemDir(targetCwd, cfg.memDir);
  const dbPath = join(memDirPath, "mem.db");
  if (existsSync(dbPath)) {
    const stat = statSync(dbPath);
    lines.push(`[✓] Primary Storage (mem.db): ${(stat.size / 1024).toFixed(1)} KB (${stat.size} bytes)`);
    try {
      const buf = readFileSync(dbPath);
      let nullBytes = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0) nullBytes++;
      }
      const nullDensity = buf.length > 0 ? ((nullBytes / buf.length) * 100).toFixed(2) : "0.00";
      lines.push(`[-] HTOK Null Density: ${nullBytes} null bytes (${nullDensity}%)`);
    } catch { /* ignore read errors */ }
  } else {
    lines.push(`[-] Primary Storage (mem.db): Not yet created (starts fresh on first store)`);
  }

  // Secondary Axis diagnostics
  const jointPath = join(memDirPath, "mem.db-joint");
  const jointMode = cfg.ephemeralJoint || (typeof process !== "undefined" && process?.env?.["CORM_JOINT_EPHEMERAL"] === "1")
    ? "In-Memory (Ephemeral)"
    : (existsSync(jointPath) ? `Persistent Disk (${(statSync(jointPath).size / 1024).toFixed(1)} KB)` : "Persistent Disk (uncreated)");
  lines.push(`[-] Axis Joint (Time): ${jointMode}`);

  const sepalPath = join(memDirPath, "mem.db-sepal");
  const sepalMode = cfg.ephemeralSepal || (typeof process !== "undefined" && process?.env?.["CORM_SEPAL_EPHEMERAL"] === "1")
    ? "In-Memory (Ephemeral, zero disk bytes)"
    : (existsSync(sepalPath) ? `Persistent Disk (${(statSync(sepalPath).size / 1024).toFixed(1)} KB)` : "Persistent Disk (uncreated)");
  lines.push(`[-] Axis Sepal (Vectors): ${sepalMode}`);

  const embedCachePath = join(memDirPath, "sepal-embed-cache.bin");
  if (existsSync(embedCachePath)) {
    lines.push(`[✓] Sepal Embed Cache: ${(statSync(embedCachePath).size / 1024).toFixed(1)} KB`);
  }

  const rosterPath = join(memDirPath, "mem.db.roster");
  if (existsSync(rosterPath)) {
    lines.push(`[-] Axis Roster: Persistent Disk (${(statSync(rosterPath).size / 1024).toFixed(1)} KB)`);
  }

  // Total Indexed Records count
  if (existsSync(dbPath)) {
    let recordCount = 0;
    let queried = false;
    try {
      const env = await envSource(ctx as unknown as import("./hooks/events.ts").PiCtx);
      const bin = cormBin(env);
      if (bin) {
        const axes = axisPath(env);
        const embed = sepalConfigured(env.cfg);
        const mDir = memDir(env);
        const fspec = filespecFor(mDir, embed);
        const eEnv = embedEnv(env.cfg);
        const listRes = await env.runner.run(buildListInvocation(bin, fspec, axes, mDir, eEnv));
        const allRefs = parseBareRefs(listRes.stdout);
        recordCount = allRefs.length;
        queried = true;
      }
    } catch { /* ignore runner errors */ }

    if (queried) {
      lines.push(`[-] Total Indexed Records: ${recordCount}`);
    } else {
      lines.push(`[-] Total Indexed Records: Unknown (corm query unavailable)`);
    }
  } else {
    lines.push(`[-] Total Indexed Records: 0 (starts fresh on first store)`);
  }

  const reportData: MmReportData = {
    title: "Pi-MM Memory System & Judge Doctor",
    lines,
    timestamp: Date.now(),
  };

  if (typeof extApi.appendEntry === "function") {
    extApi.appendEntry("mm-report", reportData);
  }
}

export function install(pi: import("./hooks/events.ts").Pi): void {
  const envSource = defaultEnvSource(pi);
  installSessionHooks(pi, envSource);
  installTools(pi, envSource);

  const extApi = pi as unknown as {
    registerEntryRenderer?: (type: string, renderer: unknown) => void;
    appendEntry?: (type: string, data: unknown) => void;
    registerCommand?: (name: string, spec: unknown) => void;
  };

  if (typeof extApi.registerEntryRenderer === "function") {
    extApi.registerEntryRenderer(
      "mm-report",
      (entry: { data?: MmReportData }, _options: unknown, theme: unknown) => {
        const data = entry?.data ?? { title: "Pi-MM Status", lines: [] };
        return createMmReportComponent(data, theme as Parameters<typeof createMmReportComponent>[1]);
      },
    );
  }

  if (typeof extApi.registerCommand === "function") {
    extApi.registerCommand("mm", {
      description: "Memory status, health diagnostics, and all-time timeline overview (/mm doctor, /mm overview, /mm timeline).",
      handler: async (args: string, ctx: { cwd: string }) => {
        const sub = args.trim();
        const cfg = await readMmConfig(ctx.cwd);

        if (sub === "overview" || sub === "timeline" || sub.startsWith("overview") || sub.startsWith("timeline")) {
          await runOverviewReport(envSource, ctx, extApi);
          return;
        }

        if (sub === "doctor" || sub === "status" || sub === "") {
          await runDoctorReport(envSource, ctx, cfg, extApi);
        }
      },
    });
  }
}

export default install;