import type {
  MemoryEnvelope,
  MipmapLevel,
  LifecycleState,
  EpisodeRecord,
  EpisodeApproach,
  MemoryContext,
  SpatialGrid,
  UtilityFeedback,
  LifecycleTransition,
} from "./types.ts";

export function splitRawPayload(payload: string): { date: string; text: string } {
  const m = /^(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?):([\s\S]*)$/.exec(payload);
  if (m) return { date: m[1], text: m[2].trimStart() };
  const idx = payload.indexOf(":");
  if (idx < 0) return { date: "", text: payload };
  return { date: payload.slice(0, idx), text: payload.slice(idx + 1) };
}

export function sanitizeEpisode(ep?: EpisodeRecord): EpisodeRecord | undefined {
  if (!ep || typeof ep !== "object") return undefined;
  const sanitized: EpisodeRecord = {};
  if (typeof ep.request === "string" && ep.request.trim()) {
    sanitized.request = ep.request.length > 400 ? ep.request.slice(0, 397) + "..." : ep.request;
  }
  if (typeof ep.problem === "string" && ep.problem.trim()) {
    sanitized.problem = ep.problem.length > 400 ? ep.problem.slice(0, 397) + "..." : ep.problem;
  }
  if (Array.isArray(ep.findings) && ep.findings.length > 0) {
    sanitized.findings = ep.findings
      .slice(0, 20)
      .map((f) => (typeof f === "string" && f.length > 300 ? f.slice(0, 297) + "..." : f));
  }
  if (Array.isArray(ep.approaches) && ep.approaches.length > 0) {
    sanitized.approaches = ep.approaches.slice(0, 20).map((a) => ({
      approach: a.approach && a.approach.length > 200 ? a.approach.slice(0, 197) + "..." : (a.approach || ""),
      outcome: a.outcome,
      reason: a.reason && a.reason.length > 200 ? a.reason.slice(0, 197) + "..." : a.reason,
    }));
  }
  if (Array.isArray(ep.diffs) && ep.diffs.length > 0) {
    sanitized.diffs = ep.diffs.slice(0, 20).map((d) => (typeof d === "string" && d.length > 300 ? d.slice(0, 297) + "..." : d));
  }
  if (Array.isArray(ep.steps) && ep.steps.length > 0) sanitized.steps = ep.steps.slice(0, 10);
  if (Array.isArray(ep.observations) && ep.observations.length > 0) sanitized.observations = ep.observations.slice(0, 10);
  if (ep.outcome) sanitized.outcome = ep.outcome;
  if (ep.sessionId) sanitized.sessionId = ep.sessionId;
  if (ep.sessionFile) sanitized.sessionFile = ep.sessionFile;
  if (ep.leafId) sanitized.leafId = ep.leafId;
  if (ep.runId) sanitized.runId = ep.runId;
  if (ep.toolCallId) sanitized.toolCallId = ep.toolCallId;
  if (Array.isArray(ep.eventIds) && ep.eventIds.length > 0) sanitized.eventIds = ep.eventIds.slice(0, 10);
  if (ep.environment) sanitized.environment = ep.environment;
  if (ep.principle) sanitized.principle = ep.principle;
  if (ep.applicability) sanitized.applicability = ep.applicability;

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function encodePayload(date: string, envelope: MemoryEnvelope): string {
  const compact: Record<string, unknown> = { _v: 1 };
  if (envelope.level) compact.l = envelope.level;
  if (envelope.type) compact.t = envelope.type;
  if (envelope.lifecycle) compact.c = envelope.lifecycle;
  if (envelope.summary) compact.s = envelope.summary;
  if (Array.isArray(envelope.evidence) && envelope.evidence.length > 0) compact.e = envelope.evidence;
  if (envelope.supersedes !== undefined) compact.p = envelope.supersedes;
  if (envelope.supersededBy !== undefined) compact.b = envelope.supersededBy;
  if (Array.isArray(envelope.tags) && envelope.tags.length > 0) compact.g = envelope.tags;

  if (envelope.context && typeof envelope.context === "object") {
    const ctx: Record<string, unknown> = {};
    if (envelope.context.project) ctx.p = envelope.context.project;
    if (envelope.context.subsystem) ctx.s = envelope.context.subsystem;
    if (envelope.context.module) ctx.m = envelope.context.module;
    if (envelope.context.path) ctx.pt = envelope.context.path;
    if (envelope.context.subject) ctx.sub = envelope.context.subject;
    if (envelope.context.grid) ctx.gd = envelope.context.grid;
    if (Object.keys(ctx).length > 0) compact.x = ctx;
  }

  if (envelope.utility && typeof envelope.utility === "object") {
    compact.u = envelope.utility;
  }

  if (Array.isArray(envelope.history) && envelope.history.length > 0) {
    compact.h = envelope.history;
  }

  const cleanEp = sanitizeEpisode(envelope.episode);
  if (cleanEp) {
    const epObj: Record<string, unknown> = {};
    if (cleanEp.request) epObj.q = cleanEp.request;
    if (cleanEp.problem) epObj.p = cleanEp.problem;
    if (cleanEp.findings && cleanEp.findings.length > 0) epObj.f = cleanEp.findings;
    if (cleanEp.approaches && cleanEp.approaches.length > 0) epObj.a = cleanEp.approaches;
    if (cleanEp.steps && cleanEp.steps.length > 0) epObj.st = cleanEp.steps;
    if (cleanEp.observations && cleanEp.observations.length > 0) epObj.ob = cleanEp.observations;
    if (cleanEp.diffs && cleanEp.diffs.length > 0) epObj.d = cleanEp.diffs;
    if (cleanEp.outcome) epObj.o = cleanEp.outcome;
    if (cleanEp.sessionId) epObj.sid = cleanEp.sessionId;
    if (cleanEp.sessionFile) epObj.sfl = cleanEp.sessionFile;
    if (cleanEp.leafId) epObj.lid = cleanEp.leafId;
    if (cleanEp.runId) epObj.rid = cleanEp.runId;
    if (cleanEp.toolCallId) epObj.tid = cleanEp.toolCallId;
    if (cleanEp.eventIds && cleanEp.eventIds.length > 0) epObj.ev = cleanEp.eventIds;
    if (cleanEp.environment) epObj.env = cleanEp.environment;
    if (cleanEp.principle) epObj.pr = cleanEp.principle;
    if (cleanEp.applicability) epObj.ap = cleanEp.applicability;
    if (Object.keys(epObj).length > 0) compact.ep = epObj;
  }

  return `${date}:${JSON.stringify(compact)}`;
}

function isValidLevel(lvl: unknown): lvl is MipmapLevel {
  return typeof lvl === "string" && ["L0", "L1", "L2", "L3"].includes(lvl);
}

function isValidLifecycle(state: unknown): state is LifecycleState {
  return typeof state === "string" && [
    "observed",
    "hypothesized",
    "tested",
    "supported",
    "contradicted",
    "superseded",
  ].includes(state);
}

export function decodePayload(raw: string): { date: string; envelope: MemoryEnvelope } {
  const { date, text } = splitRawPayload(raw);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed === "object" && parsed !== null) {
        // Case A: Compact v1 format (_v === 1 or has short key 's' without verbose 'summary')
        if (parsed._v === 1 || (parsed.s !== undefined && parsed.summary === undefined)) {
          const level: MipmapLevel = isValidLevel(parsed.l) ? (parsed.l as MipmapLevel) : "L2";
          const defaultLc: LifecycleState = level === "L0" ? "observed" : "supported";
          const lifecycle: LifecycleState = isValidLifecycle(parsed.c) ? (parsed.c as LifecycleState) : defaultLc;
          const summary = typeof parsed.s === "string" ? parsed.s : "";
          const type = typeof parsed.t === "string" ? (parsed.t as MemoryEnvelope["type"]) : undefined;
          const evidence = Array.isArray(parsed.e) ? (parsed.e as number[]) : undefined;
          const supersedes = typeof parsed.p === "number" ? parsed.p : undefined;
          const supersededBy = typeof parsed.b === "number" ? parsed.b : undefined;
          const tags = Array.isArray(parsed.g) ? (parsed.g as string[]) : undefined;

          let context: MemoryContext | undefined;
          if (parsed.x && typeof parsed.x === "object") {
            const px = parsed.x as Record<string, unknown>;
            context = {
              project: typeof px.p === "string" ? px.p : undefined,
              subsystem: typeof px.s === "string" ? px.s : undefined,
              module: typeof px.m === "string" ? px.m : undefined,
              path: typeof px.pt === "string" ? px.pt : undefined,
              subject: typeof px.sub === "string" ? px.sub : undefined,
              grid: (px.gd as SpatialGrid) || undefined,
            };
          }

          let episode: EpisodeRecord | undefined;
          if (parsed.ep && typeof parsed.ep === "object") {
            const pep = parsed.ep as Record<string, unknown>;
            episode = {
              request: typeof pep.q === "string" ? pep.q : undefined,
              problem: typeof pep.p === "string" ? pep.p : undefined,
              findings: Array.isArray(pep.f) ? (pep.f as string[]) : undefined,
              approaches: Array.isArray(pep.a) ? (pep.a as EpisodeApproach[]) : undefined,
              steps: Array.isArray(pep.st) ? (pep.st as string[]) : undefined,
              observations: Array.isArray(pep.ob) ? (pep.ob as string[]) : undefined,
              diffs: Array.isArray(pep.d) ? (pep.d as string[]) : undefined,
              outcome: typeof pep.o === "string" ? pep.o : undefined,
              sessionId: typeof pep.sid === "string" ? pep.sid : undefined,
              sessionFile: typeof pep.sfl === "string" ? pep.sfl : undefined,
              leafId: typeof pep.lid === "string" ? pep.lid : undefined,
              runId: typeof pep.rid === "string" ? pep.rid : undefined,
              toolCallId: typeof pep.tid === "string" ? pep.tid : undefined,
              eventIds: Array.isArray(pep.ev) ? (pep.ev as string[]) : undefined,
              environment: (pep.env as Record<string, string>) || undefined,
              principle: typeof pep.pr === "string" ? pep.pr : undefined,
              applicability: typeof pep.ap === "string" ? pep.ap : undefined,
            };
          }

          return {
            date,
            envelope: {
              level,
              type,
              lifecycle,
              summary,
              evidence,
              supersedes,
              supersededBy,
              tags,
              context,
              episode,
              utility: (parsed.u as UtilityFeedback) || undefined,
              history: (parsed.h as LifecycleTransition[]) || undefined,
            },
          };
        }

        // Case B: Legacy verbose format
        const level: MipmapLevel = isValidLevel(parsed.level) ? parsed.level : "L2";
        const defaultLc: LifecycleState = level === "L0" ? "observed" : "supported";
        const lifecycle: LifecycleState = isValidLifecycle(parsed.lifecycle) ? parsed.lifecycle : defaultLc;
        const summary = typeof parsed.summary === "string"
          ? parsed.summary
          : (typeof parsed.text === "string"
            ? parsed.text
            : "");
        return {
          date,
          envelope: {
            ...(parsed as Partial<MemoryEnvelope>),
            level,
            lifecycle,
            summary,
          },
        };
      }
    } catch {
      // JSON parse failure falls through to legacy plain text
    }
  }

  // Case C: Legacy plain text
  return {
    date,
    envelope: {
      level: "L2",
      type: "note",
      lifecycle: "observed",
      summary: text,
    },
  };
}
