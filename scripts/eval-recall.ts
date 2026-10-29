import { isMemoryRecallPrompt } from "../src/hooks/auto_recall.ts";
import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { RECALL_EXEMPLARS, RECALL_KINDS } from "../src/judge/recall-exemplars.ts";
import { mergeExemplars, gate, nearestExemplar } from "../src/judge/nearest.ts";
import { evaluateStrategy, formatReport, type Case, type Strategy } from "../tests/eval/harness.ts";

const RECALL_CORPUS: Case[] = [
  // --- RECALL_PAST (22 cases: 14 EN, 8 PT) ---
  { text: "Why did we choose static arrays instead of dynamic lists in the parser?", want: "recall_past" },
  { text: "What was the reason we didn't use epoll in the initial prototype?", want: "recall_past" },
  { text: "How did we resolve the file descriptor leak in the connection handler?", want: "recall_past" },
  { text: "We had a race condition in the buffer pool earlier, what was causing it?", want: "recall_past" },
  { text: "What caused the segfault in the tokenizer during last week's tests?", want: "recall_past" },
  { text: "What port did we configure for the metrics daemon?", want: "recall_past" },
  { text: "What are our project conventions for header file guards?", want: "recall_past" },
  { text: "Remind me what constraints we agreed on for maximum memory usage.", want: "recall_past" },
  { text: "Do you remember what indentation style I told you I prefer?", want: "recall_past" },
  { text: "What did I mention about my local development machine?", want: "recall_past" },
  { text: "Where did we leave off on the database migration plan?", want: "recall_past" },
  { text: "Did we finish the refactoring of the session manager or is it pending?", want: "recall_past" },
  { text: "What was that invariant we established regarding corm mutations?", want: "recall_past" },
  { text: "Have we previously discussed supporting WebSockets in this service?", want: "recall_past" },
  // Portuguese recall
  { text: "Por que razão não usámos alocação dinâmica no leitor de pacotes?", want: "recall_past" },
  { text: "Qual foi o motivo para termos evitado bibliotecas externas no motor?", want: "recall_past" },
  { text: "Como é que corrigimos aquele problema de deadlock no pipeline?", want: "recall_past" },
  { text: "Lembras-te de qual é a versão do compilador que combinámos usar?", want: "recall_past" },
  { text: "O que tínhamos decidido sobre o limite de conexões simultâneas?", want: "recall_past" },
  { text: "Onde é que tínhamos ficado no desenvolvimento do módulo de login?", want: "recall_past" },
  { text: "Lembras-te do que te contei sobre as restrições da rede da empresa?", want: "recall_past" },
  { text: "Já tínhamos implementado o tratamento deste código de erro?", want: "recall_past" },

  // --- STANDALONE (22 cases: 14 EN, 8 PT) ---
  { text: "Refactor parse_header to eliminate the duplicate error checks", want: "standalone" },
  { text: "Add a new helper function that formats timestamps as ISO 8601", want: "standalone" },
  { text: "Rename the parameter max_len to buffer_capacity across this file", want: "standalone" },
  { text: "Optimize the string copy loop using memcpy", want: "standalone" },
  { text: "Run make test and display the failed assertions", want: "standalone" },
  { text: "Check git diff to see what changes are currently unstaged", want: "standalone" },
  { text: "Print the first thirty lines of Makefile", want: "standalone" },
  { text: "Search for all occurrences of malloc in the src directory", want: "standalone" },
  { text: "How does a red-black tree maintain balance during insertion?", want: "standalone" },
  { text: "Explain the memory model semantics of atomic_thread_fence in C11", want: "standalone" },
  { text: "What is the difference between a process and a thread in Linux?", want: "standalone" },
  { text: "Hi there, good morning!", want: "standalone" },
  { text: "Thanks, that solved the problem completely.", want: "standalone" },
  { text: "Looks great, please proceed with the commit.", want: "standalone" },
  // Portuguese standalone
  { text: "Refatora esta função para usar um loop while simples", want: "standalone" },
  { text: "Adiciona um teste unitário para validar entradas vazias", want: "standalone" },
  { text: "Executa git status para ver os ficheiros modificados", want: "standalone" },
  { text: "Mostra o conteúdo das primeiras vinte linhas do ficheiro main.c", want: "standalone" },
  { text: "Como funciona o protocolo HTTP/2 sob o ponto de vista de multiplexagem?", want: "standalone" },
  { text: "Olá, como estás?", want: "standalone" },
  { text: "Muito obrigado pela ajuda", want: "standalone" },
  { text: "Perfeito, pode avançar com o próximo passo", want: "standalone" },
];

async function main() {
  const url = Deno.env.get("PI_MM_EVAL_URL") ?? "http://127.0.0.1:4242";
  const cfg: MmConfig = {
    ...DEFAULT_CONFIG,
    captureEmbedUrl: url,
    recallMinSimilarity: 0.60,
    recallMinMargin: 0.08,
  };

  const examples = mergeExemplars(RECALL_EXEMPLARS, {}, RECALL_KINDS);

  console.log("==================================================================");
  console.log(" RECALL INTENT CLASSIFICATION EMPIRICAL BENCHMARK");
  console.log(` Corpus: ${RECALL_CORPUS.length} cases (22 recall_past, 22 standalone; bilingual EN/PT)`);
  console.log(` Backend: axil-auren on ${url}`);
  console.log("==================================================================\n");

  // Strategy 1: Previous Regex Heuristic (isMemoryRecallPrompt)
  const regexStrategy: Strategy = {
    name: "Regex Heuristic (previous gate)",
    classify: (c) => Promise.resolve(isMemoryRecallPrompt(c.text) ? "recall_past" : "standalone"),
  };

  // Strategy 2: In-Memory Embeddings (bge-base via POST /v1/classify)
  const embedStrategy: Strategy = {
    name: "Embeddings (bge-base via /v1/classify)",
    classify: async (c) => {
      const verdict = await nearestExemplar(cfg, examples, c.text);
      if (verdict === null) return null;
      return gate(verdict, {
        minSimilarity: 0.60,
        minMargin: 0.08,
        harmless: "standalone",
        actionable: new Set(["recall_past"]),
      });
    },
  };

  const stateChanging = new Set(["recall_past"]);

  console.log("1. Running Regex Heuristic Strategy...");
  const regexReport = await evaluateStrategy(regexStrategy, RECALL_CORPUS, { stateChanging });

  console.log("2. Running Embeddings Strategy via axil-auren...");
  const embedReport = await evaluateStrategy(embedStrategy, RECALL_CORPUS, { stateChanging });

  console.log("\n" + formatReport("REGEX", regexReport));
  console.log("\n" + formatReport("EMBED", embedReport));

  // Margin sweep to inspect precision/recall frontier
  console.log("\n------------------------------------------------------------------");
  console.log(" MARGIN SWEEP ON EMBEDDINGS (floor = 0.60):");
  console.log(" Margin | Overall Acc | Recall (recall_past) | Specificity (standalone) | False Positives");
  console.log("------------------------------------------------------------------");

  const rawVerdicts = [];
  for (const c of RECALL_CORPUS) {
    const v = await nearestExemplar(cfg, examples, c.text);
    rawVerdicts.push({ c, v });
  }

  const nPast = RECALL_CORPUS.filter((x) => x.want === "recall_past").length;
  const nStand = RECALL_CORPUS.filter((x) => x.want === "standalone").length;

  for (const m of [0.00, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15]) {
    let correct = 0;
    let truePast = 0;
    let trueStand = 0;
    let falsePast = 0;

    for (const { c, v } of rawVerdicts) {
      const got = v === null ? null : gate(v, {
        minSimilarity: 0.60,
        minMargin: m,
        harmless: "standalone",
        actionable: new Set(["recall_past"]),
      });

      if (got === c.want) {
        correct++;
        if (c.want === "recall_past") truePast++;
        if (c.want === "standalone") trueStand++;
      } else if (got === "recall_past" && c.want === "standalone") {
        falsePast++;
      }
    }

    const accPct = ((correct / RECALL_CORPUS.length) * 100).toFixed(1);
    const recPct = ((truePast / nPast) * 100).toFixed(1);
    const specPct = ((trueStand / nStand) * 100).toFixed(1);

    console.log(
      `  ${m.toFixed(2)}  |    ${accPct}% (${correct}/${RECALL_CORPUS.length})   |     ${recPct}% (${truePast}/${nPast})     |        ${specPct}% (${trueStand}/${nStand})       |        ${falsePast}`
    );
  }
}

if (import.meta.main) {
  await main();
}
