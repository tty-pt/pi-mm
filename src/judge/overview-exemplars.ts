// HIGH_LEVEL: bilingual exemplar set for memory overview classification
// (axil-auren `POST /v1/classify`). Detects whether a memory question is requesting an
// all-time high-level retrospective overview vs a specific targeted query.

export type OverviewKind = "overview_query" | "specific_query";

export const OVERVIEW_KINDS: ReadonlySet<string> = new Set<OverviewKind>([
  "overview_query",
  "specific_query",
]);

export const OVERVIEW_EXEMPLARS: Record<string, string[]> = {
  overview_query: [
    // --- English ---
    "what do you remember across all time?",
    "give me a high-level overview of everything we have worked on",
    "what are all the memories and principles you have learned so far?",
    "tell me what you recall from past sessions and projects",
    "can you summarize the overall timeline of our investigations?",
    "what is the general state of our project knowledge and lore?",
    "synthesize all the key architectural decisions made across time",
    "what have we accomplished and discovered so far in this codebase?",

    // --- Portuguese ---
    "o que você lembra de tudo que já fizemos até hoje?",
    "me dá um panorama geral de todas as memórias e aprendizados",
    "faça um resumo histórico de todas as investigações passadas",
    "qual é o apanhado geral das decisões arquiteturais tomadas?",
    "sintetize o que você tem guardado na sua memória de longo prazo",
  ],

  specific_query: [
    // --- English ---
    "what did we decide about audio sampling rate in FLAC files?",
    "why did we choose static arrays instead of linked lists in the parser?",
    "how did we resolve the file descriptor leak in the connection handler?",
    "what was the bug with the cormd daemon socket on WSL?",
    "where did we store the session UUID compression algorithm?",
    "what was the name of my grandfather that I mentioned earlier?",
    "what is the token packing format used by HTOK v4?",
    "did we test the SIMD dot product benchmark on bge-base?",

    // --- Portuguese ---
    "qual foi a taxa de amostragem definida para os arquivos FLAC?",
    "como nós corrigimos o vazamento de memória no parser de json?",
    "o que combinamos sobre o uso de threads no servidor axil?",
    "qual foi a regra de lint estabelecida para imports em C?",
  ],
};
