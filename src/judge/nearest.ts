// HIGH_LEVEL: #judge — generic nearest-exemplar classification over the classification
// embeddings seam. A decision is a table `kind -> example sentences`; a probe is
// classified as the kind of its most similar example, with the margin over the best other
// kind reported alongside. `gate` turns a raw verdict into a final kind: anything below
// the similarity floor, or an actionable kind that does not beat the runner-up by the
// margin, becomes the decision's harmless kind. Mirrors pi-quest's engine by design
// (copied, not imported: pi-mm stays independent).
import type { MmConfig } from "../config.ts";
import { captureEmbedBase, captureEmbedModel, cosine, embedTexts } from "./embed.ts";

export type ExemplarTable = Readonly<Record<string, readonly string[]>>;
export interface Exemplar {
  kind: string;
  text: string;
}

export interface NearestVerdict {
  kind: string;
  /** Cosine of the probe to its closest example of `kind`. */
  similarity: number;
  /** `similarity` minus the best similarity of any other kind (1 + sim when alone). */
  margin: number;
}

export interface GateOptions {
  minSimilarity: number;
  minMargin: number;
  /** Kind returned for anything that does not clear the gate; it must never change state. */
  harmless: string;
  /** Kinds that need the margin too (state-changing ones). The floor binds every kind. */
  actionable: ReadonlySet<string>;
}

interface Index {
  kinds: string[];
  vectors: number[][];
}

const indexes = new Map<string, Promise<Index | null>>();

export function clearNearestIndexes(): void {
  indexes.clear();
}

/** Shipped examples plus the operator's, de-duplicated, restricted to `allowedKinds` when given. */
export function mergeExemplars(defaults: ExemplarTable, extra: ExemplarTable, allowedKinds?: ReadonlySet<string>): Exemplar[] {
  const out: Exemplar[] = [];
  const seen = new Set<string>();
  const add = (kind: string, texts: readonly string[]): void => {
    if (allowedKinds !== undefined && !allowedKinds.has(kind)) return;
    for (const text of texts) {
      const key = `${kind}\u0000${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, text });
    }
  };
  for (const [kind, texts] of Object.entries(defaults)) add(kind, texts);
  for (const [kind, texts] of Object.entries(extra)) add(kind, texts);
  return out;
}

function exemplarIndex(cfg: MmConfig, base: string, examples: readonly Exemplar[], fetchFn?: typeof fetch): Promise<Index | null> {
  const key = [base, captureEmbedModel(cfg), examples.map((e) => `${e.kind}:${e.text}`).join("\u0001")].join("\u0000");
  let hit = indexes.get(key);
  if (hit === undefined) {
    // First use embeds every example in one batch; a slow cold start must not abort it.
    hit = embedTexts(cfg, examples.map((e) => e.text), { timeoutMs: 12_000, fetchFn }).then((vectors) =>
      vectors === null ? null : { kinds: examples.map((e) => e.kind), vectors }
    );
    indexes.set(key, hit);
    void hit.then((v) => { if (v === null) indexes.delete(key); });
  }
  return hit;
}

async function classifyViaEndpoint(
  base: string,
  model: string,
  examples: readonly Exemplar[],
  text: string,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<NearestVerdict | null> {
  const labels: Record<string, string[]> = {};
  for (const ex of examples) {
    if (!labels[ex.kind]) labels[ex.kind] = [];
    labels[ex.kind]?.push(ex.text);
  }

  const url = `${base.replace(/\/+$/, "")}/v1/classify`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, text, labels }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as {
      choice?: string;
      similarity?: number;
      margin?: number;
    };
    if (typeof body.choice === "string" && typeof body.similarity === "number" && typeof body.margin === "number") {
      return {
        kind: body.choice,
        similarity: body.similarity,
        margin: body.margin,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Nearest-example verdict for `text`, or null when embeddings are unavailable. */
export async function nearestExemplar(
  cfg: MmConfig,
  examples: readonly Exemplar[],
  text: string,
  fetchFn?: typeof fetch,
): Promise<NearestVerdict | null> {
  const base = captureEmbedBase(cfg);
  if (base === null || examples.length === 0) return null;

  // Try fast in-memory server-side classification endpoint first
  const serverChoice = await classifyViaEndpoint(
    base,
    captureEmbedModel(cfg),
    examples,
    text,
    Math.max(cfg.judgeTimeoutMs || 2000, 2000),
    fetchFn,
  );
  if (serverChoice !== null) {
    return serverChoice;
  }

  // Graceful fallback to client-side vector batching if endpoint is unsupported/down
  const index = await exemplarIndex(cfg, base, examples, fetchFn);
  if (index === null) return null;
  const vec = await embedTexts(cfg, [text], { fetchFn });
  const probe = vec?.[0];
  if (probe === undefined) return null;
  const best = new Map<string, number>();
  index.vectors.forEach((v, i) => {
    const kind = index.kinds[i] ?? "";
    const sim = cosine(probe, v);
    if (sim > (best.get(kind) ?? -Infinity)) best.set(kind, sim);
  });
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (top === undefined) return null;
  return { kind: top[0], similarity: top[1], margin: top[1] - (ranked[1]?.[1] ?? -1) };
}

/** Final kind for a raw verdict: the verdict's own kind only when it clears the gate. */
export function gate(v: NearestVerdict, o: GateOptions): string {
  if (v.similarity < o.minSimilarity) return o.harmless;
  if (o.actionable.has(v.kind) && v.margin < o.minMargin) return o.harmless;
  return v.kind;
}
