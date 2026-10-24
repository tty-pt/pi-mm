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
import { encodeTokens, decodeTokens, packTokens, unpackTokens } from "./tok.ts";

export const HTOK_MAGIC = 0x48544f4b;
export const HTOK_VERSION = 4;

export const HTOK_TYPE_TOKENS = 1;
export const HTOK_TYPE_UTF8 = 2;
export const HTOK_TYPE_UUID = 3;
export const HTOK_TYPE_HISTORY = 4;

export const FLAG_HAS_SUPERSEDES = 0x01;
export const FLAG_HAS_SUPERSEDED_BY = 0x02;
export const FLAG_HAS_EVIDENCE = 0x04;
export const FLAG_IS_ANCHOR = 0x08;

export function writeVarint(val: number): Uint8Array {
  let v = Math.max(0, Math.floor(val));
  const bytes: number[] = [];
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

export function readVarint(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < bytes.length) {
    const byte = bytes[offset + bytesRead];
    bytesRead++;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  return { value, bytesRead };
}

export const FIELD_NAME_TO_ID = new Map<string, number>([
  ["text", 0],
  ["tags", 1],
  ["ctx_proj", 2],
  ["ctx_sub", 3],
  ["ctx_mod", 4],
  ["ctx_path", 5],
  ["ctx_subj", 6],
  ["ctx_grid", 7],
  ["ep_req", 8],
  ["ep_prob", 9],
  ["ep_out", 10],
  ["ep_find", 11],
  ["ep_unres", 12],
  ["ep_diff", 13],
  ["ep_step", 14],
  ["ep_obs", 15],
  ["ep_eid", 16],
  ["ep_app", 17],
  ["ep_sid", 18],
  ["ep_sfl", 19],
  ["ep_lid", 20],
  ["ep_rid", 21],
  ["ep_tid", 22],
  ["ep_env", 23],
  ["util", 24],
  ["hist", 25],
  ["ep_pr", 26],
  ["ep_ap", 27],
]);

export const FIELD_ID_TO_NAME = new Map<number, string>(
  Array.from(FIELD_NAME_TO_ID.entries()).map(([k, v]) => [v, k])
);

export function packVarTag(fieldName: string, typeTag: number): { varTag: number; customName?: string } {
  const id = FIELD_NAME_TO_ID.get(fieldName);
  if (id !== undefined && id < 31) {
    return { varTag: ((id & 0x1f) << 3) | (typeTag & 0x07) };
  }
  return { varTag: (31 << 3) | (typeTag & 0x07), customName: fieldName };
}

export function unpackVarTag(varTag: number): { fieldId: number; typeTag: number; isEscape: boolean; fieldName?: string } {
  const fieldId = (varTag >> 3) & 0x1f;
  const typeTag = varTag & 0x07;
  if (fieldId === 31) {
    return { fieldId, typeTag, isEscape: true };
  }
  return { fieldId, typeTag, isEscape: false, fieldName: FIELD_ID_TO_NAME.get(fieldId) };
}

export function packTriad(
  level: MipmapLevel = "L2",
  lifecycle: LifecycleState = "supported",
  type: MemoryEnvelope["type"] = "note"
): number {
  const l = LEVEL_TO_U8[level] ?? 2;
  const lc = LIFECYCLE_TO_U8[lifecycle] ?? 3;
  const t = type ? (TYPE_TO_U8[type] ?? 5) : 5;
  return ((l & 0x03) << 6) | ((lc & 0x07) << 3) | (t & 0x07);
}

export function unpackTriad(triad: number): {
  level: MipmapLevel;
  lifecycle: LifecycleState;
  type: MemoryEnvelope["type"];
} {
  const l = (triad >> 6) & 0x03;
  const lc = (triad >> 3) & 0x07;
  const t = triad & 0x07;
  return {
    level: U8_TO_LEVEL[l] ?? "L2",
    lifecycle: U8_TO_LIFECYCLE[lc] ?? "supported",
    type: U8_TO_TYPE[t] ?? "note",
  };
}

export function uuidToBytes(uuid: string): Uint8Array | null {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length < 16) return "";
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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
  if (Array.isArray(ep.unresolved) && ep.unresolved.length > 0) {
    sanitized.unresolved = ep.unresolved
      .slice(0, 20)
      .map((u) => (typeof u === "string" && u.length > 300 ? u.slice(0, 297) + "..." : u));
  }
  if (ep.environment) sanitized.environment = ep.environment;
  if (ep.principle) sanitized.principle = ep.principle;
  if (ep.applicability) sanitized.applicability = ep.applicability;

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function encodeLegacyJsonPayload(date: string, envelope: MemoryEnvelope): string {
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

export function encodePayload(date: string, envelope: MemoryEnvelope): Uint8Array {
  return encodeHtokPayload(date, envelope);
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

const LEVEL_TO_U8: Record<MipmapLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };
const U8_TO_LEVEL: Record<number, MipmapLevel> = { 0: "L0", 1: "L1", 2: "L2", 3: "L3" };

const LIFECYCLE_TO_U8: Record<LifecycleState, number> = {
  observed: 0,
  hypothesized: 1,
  tested: 2,
  supported: 3,
  contradicted: 4,
  superseded: 5,
};
const U8_TO_LIFECYCLE: Record<number, LifecycleState> = {
  0: "observed",
  1: "hypothesized",
  2: "tested",
  3: "supported",
  4: "contradicted",
  5: "superseded",
};

const TYPE_TO_U8: Record<string, number> = {
  episode: 0,
  investigation: 1,
  decision: 2,
  invariant: 3,
  pattern: 4,
  note: 5,
  concept: 6,
};
const U8_TO_TYPE: Record<number, MemoryEnvelope["type"]> = {
  0: "episode",
  1: "investigation",
  2: "decision",
  3: "invariant",
  4: "pattern",
  5: "note",
  6: "concept",
};

export function isHtokPayload(raw: string | Uint8Array): boolean {
  if (raw instanceof Uint8Array) {
    if (raw.length < 8) return false;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    return view.getUint32(0, true) === HTOK_MAGIC;
  }
  if (typeof raw === "string") {
    if (raw.length < 4) return false;
    const b0 = raw.charCodeAt(0) & 0xff;
    const b1 = raw.charCodeAt(1) & 0xff;
    const b2 = raw.charCodeAt(2) & 0xff;
    const b3 = raw.charCodeAt(3) & 0xff;
    const u32 = (((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0);
    return u32 === HTOK_MAGIC || raw.startsWith("HTOK");
  }
  return false;
}

export function encodeHtokPayload(date: string, envelope: MemoryEnvelope, version = HTOK_VERSION): Uint8Array {
  // Parse date into native unix timestamp (uint32)
  let ts = 0;
  if (date) {
    const parsed = Date.parse(date.includes("T") ? date : `${date}T12:00:00Z`);
    if (!isNaN(parsed) && parsed > 0) {
      ts = Math.floor(parsed / 1000);
    }
  }

  const evidence = Array.isArray(envelope.evidence) ? envelope.evidence.filter((e) => typeof e === "number") : [];
  
  interface HtokField {
    name: string;
    type: number;
    data: Uint8Array;
  }

  const fields: HtokField[] = [];
  const enc = new TextEncoder();

  function tokField(name: string, str: string): HtokField {
    return {
      name,
      type: HTOK_TYPE_TOKENS,
      data: packTokens(encodeTokens(str)),
    };
  }

  // Searchable text (summary / primary searchable text) - stored as packed token stream
  const searchableText = envelope.summary || envelope.episode?.problem || envelope.episode?.request || "";
  fields.push(tokField("text", searchableText));

  // Tags
  if (envelope.tags && envelope.tags.length > 0) {
    fields.push(tokField("tags", envelope.tags.join("\n")));
  }

  // Context fields
  if (envelope.context) {
    if (envelope.context.project) fields.push(tokField("ctx_proj", envelope.context.project));
    if (envelope.context.subsystem) fields.push(tokField("ctx_sub", envelope.context.subsystem));
    if (envelope.context.module) fields.push(tokField("ctx_mod", envelope.context.module));
    if (envelope.context.path) fields.push(tokField("ctx_path", envelope.context.path));
    if (envelope.context.subject) fields.push(tokField("ctx_subj", envelope.context.subject));
    if (envelope.context.grid) {
      const zStr = envelope.context.grid.z !== undefined ? `,${envelope.context.grid.z}` : "";
      fields.push(tokField("ctx_grid", `${envelope.context.grid.x},${envelope.context.grid.y}${zStr}`));
    }
  }

  // Episode fields
  const cleanEp = sanitizeEpisode(envelope.episode);
  if (cleanEp) {
    if (cleanEp.request) fields.push(tokField("ep_req", cleanEp.request));
    if (cleanEp.problem) fields.push(tokField("ep_prob", cleanEp.problem));
    if (cleanEp.outcome) fields.push(tokField("ep_out", cleanEp.outcome));
    if (cleanEp.findings && cleanEp.findings.length > 0) {
      fields.push(tokField("ep_find", cleanEp.findings.join("\n")));
    }
    if (cleanEp.unresolved && cleanEp.unresolved.length > 0) {
      fields.push(tokField("ep_unres", cleanEp.unresolved.join("\n")));
    }
    if (cleanEp.diffs && cleanEp.diffs.length > 0) {
      fields.push(tokField("ep_diff", cleanEp.diffs.join("\n")));
    }
    if (cleanEp.steps && cleanEp.steps.length > 0) {
      fields.push(tokField("ep_step", cleanEp.steps.join("\n")));
    }
    if (cleanEp.observations && cleanEp.observations.length > 0) {
      fields.push(tokField("ep_obs", cleanEp.observations.join("\n")));
    }
    if (cleanEp.eventIds && cleanEp.eventIds.length > 0) {
      fields.push(tokField("ep_eid", cleanEp.eventIds.join("\n")));
    }
    if (cleanEp.approaches && cleanEp.approaches.length > 0) {
      const appLines = cleanEp.approaches.map((a) => `${a.outcome}\t${a.approach}\t${a.reason || ""}`);
      fields.push(tokField("ep_app", appLines.join("\n")));
    }
    if (cleanEp.sessionId) {
      const uuidBytes = uuidToBytes(cleanEp.sessionId);
      if (uuidBytes) {
        fields.push({
          name: "ep_sid",
          type: HTOK_TYPE_UUID,
          data: uuidBytes,
        });
      } else {
        fields.push(tokField("ep_sid", cleanEp.sessionId));
      }
    }
    if (cleanEp.sessionFile) {
      // Check if sessionFile is an authentic Pi agent session path (resolving via .pi/agent/sessions/)
      // Accommodate resolved absolute paths (/.pi/agent/sessions/), tilde-prefixed paths (~/.pi/agent/sessions/),
      // and Windows backslashes (\.pi\agent\sessions\).
      const isAuthenticPiSession = Boolean(
        cleanEp.sessionId &&
        (cleanEp.sessionFile.includes("/.pi/agent/sessions/") ||
         cleanEp.sessionFile.includes("~/.pi/agent/sessions/") ||
         cleanEp.sessionFile.includes(".pi/agent/sessions/") ||
         cleanEp.sessionFile.includes("\\.pi\\agent\\sessions\\"))
      );
      if (!isAuthenticPiSession) {
        fields.push(tokField("ep_sfl", cleanEp.sessionFile));
      }
    }
    if (cleanEp.leafId) fields.push(tokField("ep_lid", cleanEp.leafId));
    if (cleanEp.runId) fields.push(tokField("ep_rid", cleanEp.runId));
    if (cleanEp.toolCallId) fields.push(tokField("ep_tid", cleanEp.toolCallId));
    if (cleanEp.principle) fields.push(tokField("ep_pr", cleanEp.principle));
    if (cleanEp.applicability) fields.push(tokField("ep_ap", cleanEp.applicability));
    if (cleanEp.environment && Object.keys(cleanEp.environment).length > 0) {
      const envLines = Object.entries(cleanEp.environment).map(([k, v]) => `${k}=${v}`);
      fields.push(tokField("ep_env", envLines.join("\n")));
    }
  }

  // Utility feedback
  if (envelope.utility) {
    fields.push(
      tokField(
        "util",
        `${envelope.utility.usedCount},${envelope.utility.irrelevantCount},${envelope.utility.obsoleteCount},${envelope.utility.lastOutcome || ""},${envelope.utility.lastNote || ""}`
      )
    );
  }

  // History transitions: serialized with native 32-bit binary timestamps and packed token reasons
  if (envelope.history && envelope.history.length > 0) {
    let histSize = 2; // 2 bytes transition count
    const encodedReasons: Uint8Array[] = [];
    for (const h of envelope.history) {
      const rBytes = packTokens(encodeTokens(h.reason || ""));
      encodedReasons.push(rBytes);
      histSize += 1 + 1 + 4 + 4 + 2 + rBytes.length; // from(1), to(1), ts(4), evRef(4), rLen(2), reason
    }
    const hBytes = new Uint8Array(histSize);
    const hView = new DataView(hBytes.buffer);
    let hOff = 0;
    hView.setUint16(hOff, envelope.history.length, true); hOff += 2;
    for (let i = 0; i < envelope.history.length; i++) {
      const h = envelope.history[i];
      hBytes[hOff++] = LIFECYCLE_TO_U8[h.from] ?? 0;
      hBytes[hOff++] = LIFECYCLE_TO_U8[h.to] ?? 0;
      const hTs = Math.floor(Date.parse(h.timestamp) / 1000) || 0;
      hView.setUint32(hOff, hTs, true); hOff += 4;
      hView.setUint32(hOff, h.evidenceRef ?? 0, true); hOff += 4;
      const rBytes = encodedReasons[i];
      hView.setUint16(hOff, rBytes.length, true); hOff += 2;
      hBytes.set(rBytes, hOff); hOff += rBytes.length;
    }
    fields.push({ name: "hist", type: HTOK_TYPE_HISTORY, data: hBytes });
  }

  let flags = 0;
  if (envelope.supersedes !== undefined && envelope.supersedes > 0) flags |= FLAG_HAS_SUPERSEDES;
  if (envelope.supersededBy !== undefined && envelope.supersededBy > 0) flags |= FLAG_HAS_SUPERSEDED_BY;
  if (evidence.length > 0) flags |= FLAG_HAS_EVIDENCE;
  if (envelope.isAnchor) flags |= FLAG_IS_ANCHOR;

  if (version === 4) {
    const bytesList: number[] = [];
    // Magic: 4B
    bytesList.push(0x4b, 0x4f, 0x54, 0x48); // "HTOK" (0x48544f4b in LE)
    // Version: 2B (4 in LE)
    bytesList.push(4, 0);
    // Timestamp: 4B in LE
    bytesList.push(ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >>> 24) & 0xff);
    // Triad: 1B
    const triad = packTriad(envelope.level, envelope.lifecycle, envelope.type);
    bytesList.push(triad);
    // Flags: 1B
    bytesList.push(flags);

    // If supersedes
    if (flags & FLAG_HAS_SUPERSEDES) {
      const sBytes = writeVarint(envelope.supersedes!);
      for (let i = 0; i < sBytes.length; i++) bytesList.push(sBytes[i]);
    }
    // If supersededBy
    if (flags & FLAG_HAS_SUPERSEDED_BY) {
      const sbBytes = writeVarint(envelope.supersededBy!);
      for (let i = 0; i < sbBytes.length; i++) bytesList.push(sbBytes[i]);
    }
    // If evidence: sorted ascending, count + base + deltas
    if (flags & FLAG_HAS_EVIDENCE) {
      const sorted = [...evidence].sort((a, b) => a - b);
      const cBytes = writeVarint(sorted.length);
      for (let i = 0; i < cBytes.length; i++) bytesList.push(cBytes[i]);
      if (sorted.length > 0) {
        const bBytes = writeVarint(sorted[0]);
        for (let i = 0; i < bBytes.length; i++) bytesList.push(bBytes[i]);
        for (let i = 1; i < sorted.length; i++) {
          const delta = sorted[i] - sorted[i - 1];
          const dBytes = writeVarint(delta);
          for (let j = 0; j < dBytes.length; j++) bytesList.push(dBytes[j]);
        }
      }
    }

    // Field count varint
    const fcBytes = writeVarint(fields.length);
    for (let i = 0; i < fcBytes.length; i++) bytesList.push(fcBytes[i]);

    // Fields
    for (const f of fields) {
      const { varTag, customName } = packVarTag(f.name, f.type);
      bytesList.push(varTag);
      if (customName !== undefined) {
        const nameBytes = enc.encode(customName);
        bytesList.push(nameBytes.length);
        for (let i = 0; i < nameBytes.length; i++) bytesList.push(nameBytes[i]);
      }
      const lenBytes = writeVarint(f.data.length);
      for (let i = 0; i < lenBytes.length; i++) bytesList.push(lenBytes[i]);
      for (let i = 0; i < f.data.length; i++) bytesList.push(f.data[i]);
    }

    // Trailer byte
    bytesList.push(0xaa);
    return new Uint8Array(bytesList);
  }

  let totalSize = 14; // magic(4) + version(2) + ts(4) + level(1) + lifecycle(1) + type(1) + flags(1)
  if (flags & FLAG_HAS_SUPERSEDES) totalSize += 4;
  if (flags & FLAG_HAS_SUPERSEDED_BY) totalSize += 4;
  if (flags & FLAG_HAS_EVIDENCE) totalSize += 2 + evidence.length * 4;
  totalSize += 2; // field_count (uint16)

  for (const f of fields) {
    const nameBytes = enc.encode(f.name);
    totalSize += 1 + nameBytes.length + 1 + 2 + f.data.length; // nameLen(1) + name + typeTag(1) + dataLen(2) + data
  }

  const out = new Uint8Array(totalSize + 1);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  let offset = 0;
  view.setUint32(offset, HTOK_MAGIC, true); offset += 4;
  view.setUint16(offset, 3, true); offset += 2; // version 3: packed binary fields and native timestamps
  view.setUint32(offset, ts, true); offset += 4;
  view.setUint8(offset++, LEVEL_TO_U8[envelope.level || "L2"] ?? 2);
  view.setUint8(offset++, LIFECYCLE_TO_U8[envelope.lifecycle || "supported"] ?? 3);
  view.setUint8(offset++, envelope.type ? (TYPE_TO_U8[envelope.type] ?? 5) : 5);
  view.setUint8(offset++, flags);

  if (flags & FLAG_HAS_SUPERSEDES) {
    view.setUint32(offset, envelope.supersedes!, true); offset += 4;
  }
  if (flags & FLAG_HAS_SUPERSEDED_BY) {
    view.setUint32(offset, envelope.supersededBy!, true); offset += 4;
  }
  if (flags & FLAG_HAS_EVIDENCE) {
    view.setUint16(offset, evidence.length, true); offset += 2;
    for (const evRef of evidence) {
      view.setUint32(offset, evRef, true); offset += 4;
    }
  }

  view.setUint16(offset, fields.length, true); offset += 2;

  for (const f of fields) {
    const nameBytes = enc.encode(f.name);
    out[offset++] = nameBytes.length;
    out.set(nameBytes, offset); offset += nameBytes.length;

    out[offset++] = f.type;
    view.setUint16(offset, f.data.length, true); offset += 2;
    out.set(f.data, offset); offset += f.data.length;
  }

  out[offset++] = 0xaa; // Trailer byte to protect binary string against String.prototype.trim()
  return out;
}

export function bytesToBinaryString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

export function binaryStringToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i) & 0xff;
  }
  return bytes;
}

export function decodeHtokPayload(raw: string | Uint8Array): { date: string; envelope: MemoryEnvelope } {
  const bytes = typeof raw === "string" ? binaryStringToBytes(raw) : raw;

  if (bytes.length < 8) {
    return { date: "", envelope: { level: "L2", lifecycle: "observed", summary: "" } };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);

  let date = "";
  let level: MipmapLevel = "L2";
  let lifecycle: LifecycleState = "supported";
  let type: MemoryEnvelope["type"] | undefined;
  let supersedes: number | undefined;
  let supersededBy: number | undefined;
  let evidence: number[] | undefined;
  let history: LifecycleTransition[] | undefined;
  let isAnchor = false;

  const fieldTokens = new Map<string, Uint16Array>();
  const fieldStrings = new Map<string, string>();

  let offset = 8;
  if (version >= 4 && bytes.length >= 12) {
    const ts = view.getUint32(6, true);
    if (ts > 0) {
      date = new Date(ts * 1000).toISOString().slice(0, 10);
    }
    const triad = view.getUint8(10);
    const flags = view.getUint8(11);
    if (flags & FLAG_IS_ANCHOR) isAnchor = true;
    const unpacked = unpackTriad(triad);
    level = unpacked.level;
    lifecycle = unpacked.lifecycle;
    type = unpacked.type;
    offset = 12;

    if (flags & FLAG_HAS_SUPERSEDES) {
      const v = readVarint(bytes, offset);
      supersedes = v.value;
      offset += v.bytesRead;
    }
    if (flags & FLAG_HAS_SUPERSEDED_BY) {
      const v = readVarint(bytes, offset);
      supersededBy = v.value;
      offset += v.bytesRead;
    }
    if (flags & FLAG_HAS_EVIDENCE) {
      const c = readVarint(bytes, offset);
      const evidCount = c.value;
      offset += c.bytesRead;
      if (evidCount > 0) {
        evidence = [];
        const base = readVarint(bytes, offset);
        let curr = base.value;
        offset += base.bytesRead;
        evidence.push(curr);
        for (let i = 1; i < evidCount && offset < bytes.length; i++) {
          const d = readVarint(bytes, offset);
          curr += d.value;
          offset += d.bytesRead;
          evidence.push(curr);
        }
      }
    }

    if (offset < bytes.length) {
      const fc = readVarint(bytes, offset);
      const fieldCount = fc.value;
      offset += fc.bytesRead;

      for (let f = 0; f < fieldCount && offset < bytes.length; f++) {
        const varTag = bytes[offset++];
        const tagInfo = unpackVarTag(varTag);
        let name = tagInfo.fieldName || "";
        if (tagInfo.isEscape) {
          if (offset >= bytes.length) break;
          const nameLen = bytes[offset++];
          if (offset + nameLen > bytes.length) break;
          name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLen));
          offset += nameLen;
        }
        const dl = readVarint(bytes, offset);
        const dataLen = dl.value;
        offset += dl.bytesRead;

        if (offset + dataLen > bytes.length) break;
        const fieldData = bytes.subarray(offset, offset + dataLen);
        offset += dataLen;

        const typeTag = tagInfo.typeTag;
        if (typeTag === HTOK_TYPE_TOKENS) {
          const toks = unpackTokens(fieldData);
          fieldTokens.set(name, toks);
          fieldStrings.set(name, decodeTokens(toks));
        } else if (typeTag === HTOK_TYPE_UTF8) {
          fieldStrings.set(name, new TextDecoder().decode(fieldData));
        } else if (typeTag === HTOK_TYPE_UUID) {
          fieldStrings.set(name, bytesToUuid(fieldData));
        } else if (typeTag === HTOK_TYPE_HISTORY) {
          const hView = new DataView(fieldData.buffer, fieldData.byteOffset, fieldData.byteLength);
          let hOff = 0;
          if (fieldData.length >= 2) {
            const hCount = hView.getUint16(hOff, true); hOff += 2;
            history = [];
            for (let i = 0; i < hCount && hOff < fieldData.length; i++) {
              const from = U8_TO_LIFECYCLE[fieldData[hOff++]] ?? "observed";
              const to = U8_TO_LIFECYCLE[fieldData[hOff++]] ?? "supported";
              const hTs = hView.getUint32(hOff, true); hOff += 4;
              const evRef = hView.getUint32(hOff, true); hOff += 4;
              const rLen = hView.getUint16(hOff, true); hOff += 2;
              const rBytes = fieldData.subarray(hOff, hOff + rLen);
              const reasonToks = unpackTokens(rBytes);
              const reason = decodeTokens(reasonToks);
              hOff += rLen;
              history.push({
                from,
                to,
                timestamp: hTs > 0 ? new Date(hTs * 1000).toISOString() : "",
                reason: reason || undefined,
                evidenceRef: evRef > 0 ? evRef : undefined,
              });
            }
          }
        }
      }
    }
  } else if (version >= 3 && bytes.length >= 16) {
    const ts = view.getUint32(6, true);
    if (ts > 0) {
      date = new Date(ts * 1000).toISOString().slice(0, 10);
    }
    level = U8_TO_LEVEL[view.getUint8(10)] ?? "L2";
    lifecycle = U8_TO_LIFECYCLE[view.getUint8(11)] ?? "supported";
    type = U8_TO_TYPE[view.getUint8(12)] ?? "note";
    const flags = view.getUint8(13);
    if (flags & FLAG_IS_ANCHOR) isAnchor = true;
    offset = 14;

    if (flags & FLAG_HAS_SUPERSEDES) {
      supersedes = view.getUint32(offset, true); offset += 4;
    }
    if (flags & FLAG_HAS_SUPERSEDED_BY) {
      supersededBy = view.getUint32(offset, true); offset += 4;
    }
    if (flags & FLAG_HAS_EVIDENCE) {
      const evidCount = view.getUint16(offset, true); offset += 2;
      if (evidCount > 0 && offset + evidCount * 4 <= bytes.length) {
        evidence = [];
        for (let i = 0; i < evidCount; i++) {
          evidence.push(view.getUint32(offset, true));
          offset += 4;
        }
      }
    }

    if (offset + 2 <= bytes.length) {
      const fieldCount = view.getUint16(offset, true);
      offset += 2;

      for (let f = 0; f < fieldCount && offset < bytes.length; f++) {
        const nameLen = bytes[offset++];
        if (offset + nameLen > bytes.length) break;
        const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLen));
        offset += nameLen;

        if (offset + 3 > bytes.length) break;
        const typeTag = bytes[offset++];
        const dataLen = view.getUint16(offset, true);
        offset += 2;

        if (offset + dataLen > bytes.length) break;
        const fieldData = bytes.subarray(offset, offset + dataLen);
        offset += dataLen;

        if (typeTag === HTOK_TYPE_TOKENS) {
          const toks = unpackTokens(fieldData);
          fieldTokens.set(name, toks);
          fieldStrings.set(name, decodeTokens(toks));
        } else if (typeTag === HTOK_TYPE_UTF8) {
          fieldStrings.set(name, new TextDecoder().decode(fieldData));
        } else if (typeTag === HTOK_TYPE_UUID) {
          fieldStrings.set(name, bytesToUuid(fieldData));
        } else if (typeTag === HTOK_TYPE_HISTORY) {
          const hView = new DataView(fieldData.buffer, fieldData.byteOffset, fieldData.byteLength);
          let hOff = 0;
          if (fieldData.length >= 2) {
            const hCount = hView.getUint16(hOff, true); hOff += 2;
            history = [];
            for (let i = 0; i < hCount && hOff < fieldData.length; i++) {
              const from = U8_TO_LIFECYCLE[fieldData[hOff++]] ?? "observed";
              const to = U8_TO_LIFECYCLE[fieldData[hOff++]] ?? "supported";
              const hTs = hView.getUint32(hOff, true); hOff += 4;
              const evRef = hView.getUint32(hOff, true); hOff += 4;
              const rLen = hView.getUint16(hOff, true); hOff += 2;
              const rBytes = fieldData.subarray(hOff, hOff + rLen);
              const reasonToks = unpackTokens(rBytes);
              const reason = decodeTokens(reasonToks);
              hOff += rLen;
              history.push({
                from,
                to,
                timestamp: hTs > 0 ? new Date(hTs * 1000).toISOString() : "",
                reason: reason || undefined,
                evidenceRef: evRef > 0 ? evRef : undefined,
              });
            }
          }
        }
      }
    }
  } else if (version >= 2 && bytes.length >= 26) {
    const ts = view.getUint32(6, true);
    if (ts > 0) {
      date = new Date(ts * 1000).toISOString().slice(0, 10);
    }
    level = U8_TO_LEVEL[view.getUint8(10)] ?? "L2";
    lifecycle = U8_TO_LIFECYCLE[view.getUint8(11)] ?? "supported";
    type = U8_TO_TYPE[view.getUint8(12)] ?? "note";
    const pVal = view.getUint32(14, true);
    if (pVal > 0) supersedes = pVal;
    const bVal = view.getUint32(18, true);
    if (bVal > 0) supersededBy = bVal;
    const evidCount = view.getUint16(22, true);
    offset = 24;
    if (evidCount > 0 && offset + evidCount * 4 <= bytes.length) {
      evidence = [];
      for (let i = 0; i < evidCount; i++) {
        evidence.push(view.getUint32(offset, true));
        offset += 4;
      }
    }
    if (offset + 2 <= bytes.length) {
      const fieldCount = view.getUint16(offset, true);
      offset += 2;
      for (let f = 0; f < fieldCount && offset < bytes.length; f++) {
        const nameLen = bytes[offset++];
        if (offset + nameLen > bytes.length) break;
        const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLen));
        offset += nameLen;
        if (offset + 2 > bytes.length) break;
        const tokCount = view.getUint16(offset, true);
        offset += 2;
        if (offset + tokCount * 2 > bytes.length) break;
        const toks = new Uint16Array(tokCount);
        for (let i = 0; i < tokCount; i++) {
          toks[i] = view.getUint16(offset, true);
          offset += 2;
        }
        fieldTokens.set(name, toks);
        fieldStrings.set(name, decodeTokens(toks));
      }
    }
  } else {
    // Version 1
    if (offset + 2 <= bytes.length) {
      const fieldCount = view.getUint16(offset, true);
      offset += 2;
      for (let f = 0; f < fieldCount && offset < bytes.length; f++) {
        const nameLen = bytes[offset++];
        if (offset + nameLen > bytes.length) break;
        const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLen));
        offset += nameLen;
        if (offset + 2 > bytes.length) break;
        const tokCount = view.getUint16(offset, true);
        offset += 2;
        if (offset + tokCount * 2 > bytes.length) break;
        const toks = new Uint16Array(tokCount);
        for (let i = 0; i < tokCount; i++) {
          toks[i] = view.getUint16(offset, true);
          offset += 2;
        }
        fieldTokens.set(name, toks);
        fieldStrings.set(name, decodeTokens(toks));
      }
    }
  }

  const getStr = (name: string): string => {
    const s = fieldStrings.get(name);
    if (s !== undefined) return s;
    const toks = fieldTokens.get(name);
    return toks ? decodeTokens(toks) : "";
  };

  const has = (name: string): boolean => fieldStrings.has(name) || fieldTokens.has(name);

  if (!date && has("date")) {
    date = getStr("date");
  }
  const summary = getStr("text");

  // Version 1 fallback if version was 1
  if (version < 2) {
    if (has("lvl")) level = isValidLevel(getStr("lvl")) ? (getStr("lvl") as MipmapLevel) : "L2";
    if (has("life")) lifecycle = isValidLifecycle(getStr("life")) ? (getStr("life") as LifecycleState) : "supported";
    if (has("type")) type = getStr("type") ? (getStr("type") as MemoryEnvelope["type"]) : undefined;
    if (has("evid")) evidence = getStr("evid").split(" ").map(Number).filter((n) => !isNaN(n));
    if (has("p")) supersedes = Number(getStr("p"));
    if (has("b")) supersededBy = Number(getStr("b"));
  }

  let tags: string[] | undefined = has("tags") ? getStr("tags").split("\n").filter(Boolean) : undefined;

  let context: MemoryContext | undefined;
  if (has("ctx_proj") || has("ctx_sub") || has("ctx_mod") || has("ctx_path") || has("ctx_subj") || has("ctx_grid")) {
    context = {};
    if (has("ctx_proj")) context.project = getStr("ctx_proj");
    if (has("ctx_sub")) context.subsystem = getStr("ctx_sub");
    if (has("ctx_mod")) context.module = getStr("ctx_mod");
    if (has("ctx_path")) context.path = getStr("ctx_path");
    if (has("ctx_subj")) context.subject = getStr("ctx_subj");
    if (has("ctx_grid")) {
      const parts = getStr("ctx_grid").split(",");
      if (parts.length >= 2) {
        context.grid = {
          x: Number(parts[0]),
          y: Number(parts[1]),
          ...(parts.length >= 3 && parts[2] !== "" ? { z: Number(parts[2]) } : {}),
        };
      }
    }
  }

  let episode: EpisodeRecord | undefined;
  if (
    has("ep_req") || has("ep_prob") || has("ep_out") || has("ep_find") ||
    has("ep_diff") || has("ep_step") || has("ep_obs") || has("ep_app") ||
    has("ep_sid") || has("ep_sfl") || has("ep_lid") || has("ep_rid") ||
    has("ep_tid") || has("ep_pr") || has("ep_ap") || has("ep_env")
  ) {
    episode = {};
    if (has("ep_req")) episode.request = getStr("ep_req");
    if (has("ep_prob")) episode.problem = getStr("ep_prob");
    if (has("ep_out")) episode.outcome = getStr("ep_out");
    if (has("ep_find")) episode.findings = getStr("ep_find").split("\n").filter(Boolean);
    if (has("ep_unres")) episode.unresolved = getStr("ep_unres").split("\n").filter(Boolean);
    if (has("ep_diff")) episode.diffs = getStr("ep_diff").split("\n");
    if (has("ep_step")) episode.steps = getStr("ep_step").split("\n").filter(Boolean);
    if (has("ep_obs")) episode.observations = getStr("ep_obs").split("\n").filter(Boolean);
    if (has("ep_eid")) episode.eventIds = getStr("ep_eid").split("\n").filter(Boolean);
    if (has("ep_sid")) episode.sessionId = getStr("ep_sid");
    if (has("ep_sfl")) episode.sessionFile = getStr("ep_sfl");
    if (has("ep_lid")) episode.leafId = getStr("ep_lid");
    if (has("ep_rid")) episode.runId = getStr("ep_rid");
    if (has("ep_tid")) episode.toolCallId = getStr("ep_tid");
    if (has("ep_pr")) episode.principle = getStr("ep_pr");
    if (has("ep_ap")) episode.applicability = getStr("ep_ap");
    if (has("ep_env")) {
      episode.environment = {};
      for (const line of getStr("ep_env").split("\n").filter(Boolean)) {
        const idx = line.indexOf("=");
        if (idx > 0) {
          episode.environment[line.slice(0, idx)] = line.slice(idx + 1);
        }
      }
    }
    if (has("ep_app")) {
      episode.approaches = getStr("ep_app").split("\n").filter(Boolean).map((line) => {
        const [outcome, approach, reason] = line.split("\t");
        return {
          outcome: outcome as "worked" | "failed" | "abandoned",
          approach: approach || "",
          reason: reason || undefined,
        };
      });
    }
  }

  let utility: UtilityFeedback | undefined;
  if (has("util")) {
    const parts = getStr("util").split(",");
    utility = {
      usedCount: Number(parts[0]) || 0,
      irrelevantCount: Number(parts[1]) || 0,
      obsoleteCount: Number(parts[2]) || 0,
      lastOutcome: parts[3] ? (parts[3] as "useful" | "irrelevant" | "obsolete") : undefined,
      lastNote: parts[4] || undefined,
    };
  }

  if (!history && has("hist")) {
    history = getStr("hist").split("\n").filter(Boolean).map((line) => {
      const [from, to, timestamp, reason, evid] = line.split("\t");
      return {
        from: from as LifecycleState,
        to: to as LifecycleState,
        timestamp,
        reason: reason || undefined,
        evidenceRef: evid ? Number(evid) : undefined,
      };
    });
  }

  // Backwards compatibility fallback for legacy JSON-in-HTOK payloads
  const metaTokens = fieldTokens.get("meta");
  if (metaTokens) {
    const metaStr = decodeTokens(metaTokens);
    if (metaStr.startsWith("{")) {
      try {
        const meta = JSON.parse(metaStr);
        if (isValidLevel(meta.l)) level = meta.l;
        if (isValidLifecycle(meta.c)) lifecycle = meta.c;
        if (typeof meta.t === "string") type = meta.t as MemoryEnvelope["type"];
        if (Array.isArray(meta.e)) evidence = meta.e;
        if (typeof meta.p === "number") supersedes = meta.p;
        if (typeof meta.b === "number") supersededBy = meta.b;
        if (Array.isArray(meta.g)) tags = meta.g;
        if (meta.x && typeof meta.x === "object") context = meta.x as MemoryContext;
        if (meta.u && typeof meta.u === "object") utility = meta.u as UtilityFeedback;
      } catch {
        // best effort
      }
    }
  }

  const bodyTokens = fieldTokens.get("body");
  if (bodyTokens) {
    const bodyStr = decodeTokens(bodyTokens);
    if (bodyStr.startsWith("{")) {
      try {
        const body = JSON.parse(bodyStr);
        if (body.ep && typeof body.ep === "object") episode = body.ep as EpisodeRecord;
        if (Array.isArray(body.h)) history = body.h as LifecycleTransition[];
      } catch {
        // best effort
      }
    }
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
      utility,
      history,
      isAnchor: isAnchor || undefined,
    },
  };
}

export function isCleanSummaryText(text?: string): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("\uFFFD")) return false; // Replacement character from invalid UTF-8
  if (trimmed.startsWith("[Corrupted payload")) return false;

  let controlCount = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    // Disallow null bytes and control characters < 32 except tab (9), newline (10), carriage return (13)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
    // Disallow DEL (127) and C1 control characters (128-159)
    if (code >= 127 && code <= 159) return false;
    // Count suspicious Latin-1 high bytes often seen in mojibake
    if (code >= 160 && code <= 255) {
      controlCount++;
    }
  }
  // If more than 15% of characters in non-trivial text are non-ASCII Latin-1 symbols (classic mojibake), reject
  if (trimmed.length > 5 && controlCount / trimmed.length > 0.15) {
    return false;
  }
  return true;
}

export function decodePayload(raw: string | Uint8Array): { date: string; envelope: MemoryEnvelope } {
  if (isHtokPayload(raw)) {
    return decodeHtokPayload(raw);
  }
  const rawStr = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const { date, text } = splitRawPayload(rawStr);
  if (isHtokPayload(text)) {
    return decodeHtokPayload(text);
  }
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
  if (!isCleanSummaryText(text)) {
    return {
      date,
      envelope: {
        level: "L0",
        type: "episode",
        lifecycle: "contradicted",
        summary: "[Corrupted payload: unprintable binary data]",
      },
    };
  }

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
