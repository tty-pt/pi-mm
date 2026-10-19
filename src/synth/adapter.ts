import type { MmConfig } from "../config.ts";
import { synthConfigured } from "../config.ts";
import type {
  L2SynthesisInput,
  L2SynthesisOutcome,
  L3SynthesisInput,
  L3SynthesisOutcome,
} from "./types.ts";

export function normalizeChatCompletionUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export async function callChatCompletions(
  cfg: MmConfig,
  systemPrompt: string,
  userPrompt: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  if (!synthConfigured(cfg)) {
    return { ok: false, error: "synthesis capability not configured" };
  }

  const url = normalizeChatCompletionUrl(cfg.synthUrl!);
  const timeoutMs = cfg.synthTimeoutMs ?? 15000;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.synthKey && cfg.synthKey.trim() !== "") {
    headers["Authorization"] = `Bearer ${cfg.synthKey.trim()}`;
  }

  const payload = {
    model: cfg.synthModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  };

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText} ${errText.slice(0, 100)}` };
    }

    const data = await res.json();
    if (typeof data !== "object" || data === null) {
      return { ok: false, error: "Malformed response: not an object" };
    }
    const choices = (data as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return { ok: false, error: "Malformed response: choices array is empty" };
    }
    const msg = (choices[0] as Record<string, unknown>).message;
    if (typeof msg !== "object" || msg === null) {
      return { ok: false, error: "Malformed response: message is missing" };
    }
    const content = (msg as Record<string, unknown>).content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "Malformed response: content is empty" };
    }
    return { ok: true, content: content.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function synthesizeL2ScopeKnowledge(
  input: L2SynthesisInput,
  cfg: MmConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<L2SynthesisOutcome> {
  if (!synthConfigured(cfg)) {
    return { status: "unavailable", reason: "synthesis capability not configured" };
  }

  const validEvidenceRefs = new Set(input.evidence.map((e) => e.ref));
  if (input.priorAbstraction) {
    // Only inherit validated lower-level evidence references from predecessor, NEVER the predecessor ID itself
    for (const r of input.priorAbstraction.evidence) validEvidenceRefs.add(r);
  }

  const systemPrompt = `You are a precise knowledge synthesis engine for a hierarchical memory system.
Your task is to synthesize lower-level (L1) episodic observations into a durable, coherent higher-level (L2) scoped knowledge abstraction.
RULES:
1. Identify what the evidence establishes as durable knowledge within the scope "${input.scope}".
2. Do NOT merely concatenate or join strings from the input summaries. Do NOT use template prefixes like "Scoped Knowledge:" or "Project Knowledge:".
3. If a prior abstraction is provided, reconcile the prior abstraction with the new evidence to produce an updated, comprehensive successor knowledge statement.
4. CODE CONTROLS PROVENANCE: cite ONLY the numeric evidence references provided. Do NOT invent references.
5. Return strictly valid JSON with this exact schema:
{
  "summary": "Coherent, synthesized scope knowledge statement (1-3 sentences)",
  "explanation": "Brief reasoning explaining how the evidence supports this synthesis",
  "citedRefs": [1, 2]
}`;

  let userPrompt = `Scope: ${input.scope} (${input.isConversational ? "conversational / personal" : "technical / project"})\n\n`;
  if (input.priorAbstraction) {
    userPrompt += `Existing Prior Abstraction (Ref ${input.priorAbstraction.ref}):\n`;
    userPrompt += `Summary: ${input.priorAbstraction.summary}\n`;
    userPrompt += `Cited Evidence: [${input.priorAbstraction.evidence.join(", ")}]\n\n`;
    userPrompt += `New Evidence to Reconcile:\n`;
  } else {
    userPrompt += `Evidence to Synthesize:\n`;
  }

  for (const item of input.evidence) {
    userPrompt += `- [Ref ${item.ref}]: ${item.summary}\n`;
    if (item.problem) userPrompt += `  Problem: ${item.problem}\n`;
    if (item.findings && item.findings.length > 0) userPrompt += `  Findings: ${item.findings.join("; ")}\n`;
    if (item.outcome) userPrompt += `  Outcome: ${item.outcome}\n`;
  }

  const resp = await callChatCompletions(cfg, systemPrompt, userPrompt, fetchFn);
  if (!resp.ok || !resp.content) {
    return { status: "failed", reason: resp.error || "Synthesis request failed" };
  }

  try {
    const jsonStr = extractJsonText(resp.content);
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== "object" || parsed === null) {
      return { status: "validation_error", reason: "Model output is not a JSON object" };
    }
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) {
      return { status: "validation_error", reason: "Model output missing non-empty summary" };
    }
    const rawRefs = Array.isArray(parsed.citedRefs) ? parsed.citedRefs : [];
    const validRefs = rawRefs.filter((r: unknown): r is number => typeof r === "number" && validEvidenceRefs.has(r));

    if (validRefs.length === 0) {
      return { status: "validation_error", reason: "Model returned zero valid cited references from the provided evidence set" };
    }

    return {
      status: "ok",
      summary,
      explanation: typeof parsed.explanation === "string" ? parsed.explanation.trim() : undefined,
      citedRefs: validRefs,
    };
  } catch (err) {
    return { status: "validation_error", reason: `Failed to parse model JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function synthesizeL3GeneralPrinciple(
  input: L3SynthesisInput,
  cfg: MmConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<L3SynthesisOutcome> {
  if (!synthConfigured(cfg)) {
    return { status: "unavailable", reason: "synthesis capability not configured" };
  }

  const scopes = new Set(input.l2Items.map((item) => item.scope));
  if (scopes.size < 2) {
    return { status: "validation_error", reason: "L3 generalization requires evidence across at least 2 distinct scopes" };
  }

  const validL2Refs = new Set(input.l2Items.map((item) => item.ref));
  if (input.priorAbstraction) {
    // Only inherit validated L2 evidence references from predecessor, NEVER the predecessor L3 ID itself
    for (const r of input.priorAbstraction.evidence) validL2Refs.add(r);
  }

  const systemPrompt = `You are a cross-domain generalization engine for a hierarchical memory system.
Your task is to derive a genuine, overarching general principle or invariant (L3) from multiple distinct domain scopes (L2).
RULES:
1. Derive a meaningful shared principle that genuinely applies across the distinct scopes.
2. Explain its applicability and boundary conditions. Do NOT make sweeping assertions beyond what the evidence supports.
3. Do NOT merely join or concatenate summaries from different scopes. Do NOT use template prefixes like "General Knowledge across:".
4. CODE CONTROLS PROVENANCE: cite ONLY the numeric L2 references provided. Must cite evidence from at least 2 distinct scopes.
5. Return strictly valid JSON with this exact schema:
{
  "summary": "Concise statement of the general principle or invariant (1-2 sentences)",
  "principle": "Detailed formulation of the underlying mechanism or invariant rule",
  "applicability": "Boundary conditions and contexts where this principle holds",
  "citedRefs": [10, 20]
}`;

  let userPrompt = `Input L2 Scope Knowledge to Generalize:\n\n`;
  if (input.priorAbstraction) {
    userPrompt += `Existing Prior L3 Generalization (Ref ${input.priorAbstraction.ref}):\n`;
    userPrompt += `Summary: ${input.priorAbstraction.summary}\n`;
    userPrompt += `Cited Evidence: [${input.priorAbstraction.evidence.join(", ")}]\n\n`;
    userPrompt += `New L2 Knowledge to Reconcile:\n`;
  }

  for (const item of input.l2Items) {
    userPrompt += `- [L2 Ref ${item.ref}] Scope: ${item.scope}\n`;
    userPrompt += `  Summary: ${item.summary}\n`;
  }

  const resp = await callChatCompletions(cfg, systemPrompt, userPrompt, fetchFn);
  if (!resp.ok || !resp.content) {
    return { status: "failed", reason: resp.error || "Synthesis request failed" };
  }

  try {
    const jsonStr = extractJsonText(resp.content);
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== "object" || parsed === null) {
      return { status: "validation_error", reason: "Model output is not a JSON object" };
    }
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const principle = typeof parsed.principle === "string" ? parsed.principle.trim() : "";
    if (!summary || !principle) {
      return { status: "validation_error", reason: "Model output missing non-empty summary or principle" };
    }
    const rawRefs = Array.isArray(parsed.citedRefs) ? parsed.citedRefs : [];
    const validRefs = rawRefs.filter((r: unknown): r is number => typeof r === "number" && validL2Refs.has(r));

    // Verify cited refs cover at least 2 distinct scopes
    const citedScopes = new Set<string>();
    for (const item of input.l2Items) {
      if (validRefs.includes(item.ref)) citedScopes.add(item.scope);
    }
    if (citedScopes.size < 2 && input.l2Items.length >= 2) {
      return { status: "validation_error", reason: "Model cited references do not span at least 2 distinct scopes" };
    }

    return {
      status: "ok",
      summary,
      principle,
      applicability: typeof parsed.applicability === "string" ? parsed.applicability.trim() : undefined,
      citedRefs: validRefs,
    };
  } catch (err) {
    return { status: "validation_error", reason: `Failed to parse model JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}
