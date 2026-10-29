// Test helper: deterministic judge + embeddings endpoints so no test ever talks to a live
// auren server. Mirrors pi-quest/tests/judge-stub.ts for pi-mm's closed yes/no judge.

/** Fake embedder: text -> vector. `null` => HTTP failure. */
export type EmbedAnswer = (text: string) => number[] | null;
/** Fake judge: the memory_action answer ("yes" | "no" | "update"), or null => HTTP failure. */
export type JudgeAnswer = (state: string) => string | null;

export interface StubFetch {
  fetch: typeof fetch;
  embedCalls: () => number;
  judgeCalls: () => number;
}

export function makeStubFetch(judge: JudgeAnswer, embed?: EmbedAnswer): StubFetch {
  let embeds = 0;
  let judges = 0;
  const stub = ((url: unknown, init?: { body?: string }) => {
    const urlStr = String(url);
    if (urlStr.includes("/v1/classify")) {
      return Promise.resolve(new Response("classify stub down", { status: 404 }));
    }
    if (urlStr.includes("/v1/embeddings")) {
      embeds += 1;
      if (embed === undefined) return Promise.resolve(new Response("down", { status: 503 }));
      const input = (JSON.parse(init?.body ?? "{}") as { input?: string | string[] }).input ?? [];
      const texts = Array.isArray(input) ? input : [input];
      const vecs = texts.map((t) => embed(t));
      if (vecs.some((v) => v === null)) return Promise.resolve(new Response("down", { status: 503 }));
      const data = vecs.map((embedding, index) => ({ object: "embedding", index, embedding }));
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
    }
    judges += 1;
    const body = JSON.parse(init?.body ?? "{}") as { state?: string };
    const choice = judge(body.state ?? "");
    if (choice === null) return Promise.resolve(new Response("down", { status: 503 }));
    return Promise.resolve(new Response(JSON.stringify({ answers: { memory_action: { choice } } }), { status: 200 }));
  }) as typeof fetch;
  return { fetch: stub, embedCalls: () => embeds, judgeCalls: () => judges };
}

/** Install the stub as globalThis.fetch (for code paths that do not take a fetchFn); returns restore(). */
export function stubGlobalFetch(judge: JudgeAnswer, embed?: EmbedAnswer): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = makeStubFetch(judge, embed).fetch;
  return () => { globalThis.fetch = real; };
}
