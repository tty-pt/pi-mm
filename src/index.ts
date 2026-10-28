import { installTools, defaultEnvSource, resolveMemDir, cormBin, memDir, axisPath } from "./tools/index.ts";
import { installSessionHooks, persistConversationalMemory } from "./hooks/events.ts";
import { checkMmHealth } from "./judge/adapter.ts";
import { readMmConfig, describeCapabilities, sepalConfigured } from "./config.ts";
import { buildMemoryOverview } from "./tools/overview.ts";
import { filespecFor, buildListInvocation, embedEnv } from "./corm.ts";
import { parseBareRefs } from "./resolve.ts";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findSepalLib, ensureAuren, getBootstrapState, findUserConfig, serverLogPath, MODEL_CATALOG, DOCS_SEPAL, DOCS_PIMM_PREREQUISITES } from "./auren.ts";

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
  const targetCwd = typeof (ctx as { cwd?: string })?.cwd === "string" ? (ctx as { cwd: string }).cwd : ".";

  // Zero-config axil-auren: inspect/provision models & launcher
  let bootState = getBootstrapState();
  if (!cfg.captureEmbedUrl || cfg.captureEmbedUrl.includes("4242") || (cfg.judgeUrl && cfg.judgeUrl.includes("4242"))) {
    try {
      bootState = await ensureAuren({
        cwd: targetCwd,
        settings: { autoStart: cfg.autoStartAuren, autoDownloadModels: cfg.autoDownloadModels },
      });
    } catch { /* best effort */ }
  }

  const health = await checkMmHealth(cfg);
  const lines: string[] = [
    health.judgeOk
      ? `[✓] Embedding Classifier: ${health.judgeEndpoint} (200 OK, latency: ${health.judgeLatencyMs}ms)`
      : `[✗] Embedding Classifier: ${health.judgeEndpoint} (OFFLINE - ${health.judgeError})`,
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
  // Core C Engine Versions & Requirements
  const { checkAllEngineVersions } = await import("./versions.ts");
  const engineReports = checkAllEngineVersions({ cwd: targetCwd });
  lines.push("[-] Core C Engines & Versions:");
  for (const rep of engineReports) {
    const symbol = rep.status === "satisfied" ? "[✓]" : rep.status === "outdated" ? "[!]" : "[✗]";
    const ver = rep.version ? `${rep.version} (${rep.source})` : "not installed";
    lines.push(`  ${symbol} ${rep.name.padEnd(11)}: ${ver} (requires >= ${rep.minRequired})`);
  }

  lines.push(`[-] Pipeline: ${describeCapabilities(cfg)}`);
  const keywords = cfg.captureKeywords && cfg.captureKeywords.length > 0
    ? cfg.captureKeywords
    : (cfg.captureKeyword ? [cfg.captureKeyword] : ["@remember", "@memory", "remember:", "note:"]);
  lines.push(`[-] Trigger Word Families: ${keywords.map((k) => `'${k}'`).join(", ")}`);

  // Primary Storage & HTOK Density diagnostics
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
    ? "In-Memory (Ephemeral index)"
    : (existsSync(sepalPath) ? `Persistent Disk (${(statSync(sepalPath).size / 1024).toFixed(1)} KB)` : "Persistent Disk (uncreated)");
  lines.push(`[-] Axis Sepal (Vectors): ${sepalMode}`);

  const embedCachePath = join(memDirPath, "sepal-embed-cache.bin");
  if (existsSync(embedCachePath)) {
    lines.push(`[✓] Sepal Embeddings Cache: ${(statSync(embedCachePath).size / 1024).toFixed(1)} KB (L2 disk cache)`);
  }

  const rosterPath = join(memDirPath, "mem.db.roster");
  if (existsSync(rosterPath)) {
    try {
      const rosterBytes = readFileSync(rosterPath);
      let ascii = "";
      for (let i = 0; i < rosterBytes.length; i++) {
        const b = rosterBytes[i];
        ascii += (b >= 32 && b <= 126) ? String.fromCharCode(b) : " ";
      }
      const idx = ascii.indexOf("axes");
      let axesList = "joint, lemma, sepal";
      if (idx !== -1) {
        const sub = ascii.slice(idx + 4).trim();
        const m = sub.match(/^[a-zA-Z0-9_,]+/);
        if (m) axesList = m[0].replace(/,/g, ", ");
      }
      lines.push(`[✓] Bound Axes (mem.db.roster): ${axesList}`);
    } catch {
      lines.push(`[✓] Bound Axes (mem.db.roster): joint, lemma, sepal`);
    }
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

  // Zero-config diagnostics: config, models, daemon log, actionable notices
  const uCfg = findUserConfig({ cwd: targetCwd });
  lines.push(`[-] Auren Config: ${uCfg ?? "None (auto-managed at ~/.config/auren/config.json)"}`);
  const home = typeof process !== "undefined" && process.env?.HOME ? process.env.HOME : "/tmp";
  const { presentModels } = await import("./auren-bootstrap.ts");
  const present = presentModels(MODEL_CATALOG, home);
  if (present.length > 0) {
    lines.push(`[✓] Local GGUF Models (~/.models): ${present.map((m) => m.id).join(", ")}`);
  } else {
    lines.push("[-] Local GGUF Models (~/.models): None found");
  }
  if (bootState.downloads.length > 0) {
    for (const dl of bootState.downloads) {
      const pct = dl.total > 0 ? Math.floor((dl.done / dl.total) * 100) : 0;
      lines.push(`[-] Downloading: ${dl.id} (${pct}%)`);
    }
  }
  lines.push(`[-] Daemon Log: ${serverLogPath(home)}`);

  // Actionable notices for uninstalled services
  const sepalLib = findSepalLib(targetCwd);
  if (!sepalLib && cfg.semanticSearch !== false) {
    lines.push("");
    lines.push("[!] Axis Sepal (libsepal.so) is not installed.");
    lines.push("    Vector embeddings and semantic hybrid search require libsepal.");
    lines.push(`    -> Installation guide: ${DOCS_SEPAL}`);
    lines.push(`    -> Prerequisites guide: ${DOCS_PIMM_PREREQUISITES}`);
  }

  for (const n of bootState.notices) {
    if (n.code === "downloading") continue;
    lines.push("");
    lines.push(`[!] ${n.message}`);
    lines.push(`    -> Guide: ${n.link}`);
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
      description: "Memory status, health diagnostics, all-time timeline overview, and standing rules (/mm doctor, /mm overview, /mm rule <directive>).",
      handler: async (args: string, ctx: { cwd: string }) => {
        const sub = args.trim();
        const cfg = await readMmConfig(ctx.cwd);

        if (sub.startsWith("rule ") || sub.startsWith("rule:") || sub === "rule") {
          const ruleText = sub.replace(/^rule[:\s]*/i, "").trim();
          if (!ruleText) {
            if (typeof extApi.appendEntry === "function") {
              extApi.appendEntry("mm-report", {
                title: "Pi-MM Standing Directive",
                lines: ["[!] Usage: /mm rule <standing operational rule>"],
                timestamp: Date.now(),
              });
            }
            return;
          }
          const ref = await persistConversationalMemory(
            {
              meaningful: true,
              level: "L2",
              type: "invariant",
              standing: true,
              summary: ruleText,
              problem: ruleText,
              findings: [ruleText],
            },
            envSource,
            ctx as unknown as import("./hooks/events.ts").PiCtx,
          );
          if (typeof extApi.appendEntry === "function") {
            extApi.appendEntry("mm-report", {
              title: "Pi-MM Standing Directive Registered",
              lines: [
                `[✓] Registered Standing Invariant [Ref ${ref ?? "saved"}]:`,
                `    • ${ruleText}`,
                `[-] This directive will be reinforced at context milestones and session start.`,
              ],
              timestamp: Date.now(),
            });
          }
          return;
        }

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