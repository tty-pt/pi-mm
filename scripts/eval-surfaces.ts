import { DIRECTIVE_EXEMPLARS } from "../src/judge/directive-exemplars.ts";
import { OVERVIEW_EXEMPLARS } from "../src/judge/overview-exemplars.ts";
import { KIND_EXEMPLARS } from "../../pi-quest/src/drafting/kind-exemplars.ts";

const AUREN_URL = process.env.PI_MM_EVAL_URL || "http://127.0.0.1:4242";

// ============================================================================
// 1. STANDING DIRECTIVES BENCHMARK CORPUS (Held-out from training exemplars)
// ============================================================================
const STANDING_DIRECTIVE_PATTERN = /(?:always\s+remember(?:\s+to)?|never\s+(?:use|do|edit|commit|modify)|our\s+rule\s+is|standing\s+rule|invariant:)/i;

const DIRECTIVE_CORPUS = [
  // 10 Real Directives (EN + PT)
  { text: "Make sure we never write raw SQL queries in request handlers", kind: "standing_directive" },
  { text: "From now on, ensure all memory operations go through cormd", kind: "standing_directive" },
  { text: "Standing rule: all UX modules must dual-compile to native and WASM", kind: "standing_directive" },
  { text: "Our rule is: keep the memory footprint strictly bounded", kind: "standing_directive" },
  { text: "Always remember to run make test before committing", kind: "standing_directive" },
  { text: "Regra permanente: nunca use Rust ou Dioxus no caminho crítico", kind: "standing_directive" },
  { text: "Em todo o código novo, certifique-se de seguir convenções C99", kind: "standing_directive" },
  { text: "A regra aqui é manter o SSR como contrato principal da aplicação", kind: "standing_directive" },
  { text: "Invariant: every memory record must cite an active evidence ref", kind: "standing_directive" },
  { text: "All tests must execute hermetically without live network calls", kind: "standing_directive" },

  // 10 Transient Tasks / Questions (EN + PT)
  { text: "Please fix the typo in user.c on line 42", kind: "transient_task" },
  { text: "Can you check git status and see what files were modified?", kind: "transient_task" },
  { text: "Run the unit test suite and tell me if it passes", kind: "transient_task" },
  { text: "What time is the next train to Boston?", kind: "transient_task" },
  { text: "Good morning! Let's get started on the next feature", kind: "transient_task" },
  { text: "Onde fica o arquivo de configuração do axil?", kind: "transient_task" },
  { text: "Compile o projeto com make e me mostre os warnings", kind: "transient_task" },
  { text: "Como eu faço para debugar a conexão do socket?", kind: "transient_task" },
  { text: "Write a helper function to format timestamps in ISO-8601", kind: "transient_task" },
  { text: "Why did the last build fail?", kind: "transient_task" },
];

// ============================================================================
// 2. OVERVIEW ROUTING BENCHMARK CORPUS (Held-out from training exemplars)
// ============================================================================
const DIRECT_MEMORY_PATTERN = /^(?:what\s+do\s+you\s+(?:remember|recall)|tell\s+me\s+what\s+you\s+(?:remember|recall)|what\s+did\s+i\s+say(?:\s+earlier|\s+before)?|what\s+were\s+we\s+talking\s+about|do\s+you\s+remember\s+anything|do\s+you\s+recall\s+anything|what\s+do\s+you\s+(?:remember|recall)\s+(?:across\s+all\s+time|from\s+all\s+time|from\s+past\s+sessions)?|give\s+me\s+(?:an?\s+)?(?:overview|summary)\s+of\s+(?:all\s+)?(?:your\s+)?memories|what\s+memories\s+do\s+you\s+have|what\s+have\s+we\s+worked\s+on(?:\s+across\s+all\s+time)?)[?.!\s]*$/i;

const OVERVIEW_CORPUS = [
  // 10 Overview Queries (EN + PT)
  { text: "What's our project status and architectural history across all time?", kind: "overview_query" },
  { text: "Synthesize everything we've investigated and learned so far", kind: "overview_query" },
  { text: "Can you give me an all-time overview of the principles discovered?", kind: "overview_query" },
  { text: "Give me an overview of all memories", kind: "overview_query" },
  { text: "What have we worked on across all sessions?", kind: "overview_query" },
  { text: "Dá um apanhado geral das coisas que investigamos até agora", kind: "overview_query" },
  { text: "O que você lembra de tudo o que foi feito neste projeto?", kind: "overview_query" },
  { text: "Faça um resumo de alto nível da nossa memória persistente", kind: "overview_query" },
  { text: "Qual é o panorama histórico das investigações que realizamos?", kind: "overview_query" },
  { text: "Resuma as principais decisões e princípios aprendidos no repositório", kind: "overview_query" },

  // 10 Specific Queries (EN + PT)
  { text: "What did we decide about audio sampling rate in FLAC files?", kind: "specific_query" },
  { text: "How did we fix the socket leak on WSL?", kind: "specific_query" },
  { text: "Where is the cormd daemon runner implemented?", kind: "specific_query" },
  { text: "Why did we choose static buffers instead of malloc in the parser?", kind: "specific_query" },
  { text: "What was the name of the grandfather I mentioned earlier?", kind: "specific_query" },
  { text: "Qual foi a taxa de amostragem definida para arquivos de áudio?", kind: "specific_query" },
  { text: "Como corrigimos o vazamento de memória no parser?", kind: "specific_query" },
  { text: "Qual porta o axil-auren utiliza para o servidor de inferência?", kind: "specific_query" },
  { text: "Onde fica o arquivo de configuração do linter?", kind: "specific_query" },
  { text: "Did we test the SIMD benchmark on bge-base?", kind: "specific_query" },
];

// ============================================================================
// 3. FINE-GRAINED QUEST KINDS BENCHMARK CORPUS
// ============================================================================
const KIND_CORPUS = [
  // 5 bugfixes
  { text: "Fix segmentation fault when parsing empty string in config", kind: "bugfix" },
  { text: "Repair buffer overflow in HTTP header parser", kind: "bugfix" },
  { text: "Resolve deadlock between worker threads on shutdown", kind: "bugfix" },
  { text: "Corrigir o crash ao processar arquivo corrompido", kind: "bugfix" },
  { text: "Consertar erro de permissão ao criar socket unix", kind: "bugfix" },

  // 5 features
  { text: "Add support for JWT token authentication in API routes", kind: "feature" },
  { text: "Implement automatic rate limiting middleware for axil", kind: "feature" },
  { text: "Build user profile avatar upload and resizing pipeline", kind: "feature" },
  { text: "Criar endpoint para busca semântica de candidatos", kind: "feature" },
  { text: "Implementar tela de login com suporte a OAuth", kind: "feature" },

  // 5 refactors
  { text: "Refactor database client to use connection pooling", kind: "refactor" },
  { text: "Decouple state machine from UI view rendering", kind: "refactor" },
  { text: "Extract common string utilities into a shared helper module", kind: "refactor" },
  { text: "Refatorar o módulo de cache para usar estrutura LRU", kind: "refactor" },
  { text: "Reorganizar as rotas da API em controladores separados", kind: "refactor" },

  // 5 docs
  { text: "Update README with installation steps and curl examples", kind: "docs" },
  { text: "Document all configuration environment variables in CONFIG.md", kind: "docs" },
  { text: "Write architecture overview and module dependency diagram", kind: "docs" },
  { text: "Atualizar a documentação da API no README", kind: "docs" },
  { text: "Escrever o changelog da versão 0.5.0", kind: "docs" },

  // 5 analysis
  { text: "Investigate database query latency spikes under high concurrency", kind: "analysis" },
  { text: "Audit security risks and attack vectors in session cookies", kind: "analysis" },
  { text: "Analyze performance tradeoffs between SQLite and DuckDB", kind: "analysis" },
  { text: "Investigar a viabilidade de compilar o motor para WebAssembly", kind: "analysis" },
  { text: "Comparar o tempo de resposta entre bge-base e bge-small", kind: "analysis" },
];

async function runClassify(text: string, labels: Record<string, string[]>): Promise<{ choice: string; similarity: number; margin: number; latencyMs: number }> {
  const t0 = performance.now();
  const res = await fetch(`${AUREN_URL}/v1/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "bge-base", text, labels }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json() as { choice: string; similarity: number; margin: number };
  const latencyMs = performance.now() - t0;
  return { choice: data.choice, similarity: data.similarity, margin: data.margin, latencyMs };
}

async function benchmarkDirectives() {
  console.log("\n==================================================================");
  console.log("1. BENCHMARK: STANDING DIRECTIVES CLASSIFICATION (isStandingDirective)");
  console.log("==================================================================");

  let regexCorrect = 0;
  let embedCorrect = 0;
  let regexDirectivesCaught = 0;
  let embedDirectivesCaught = 0;
  let regexFalseDirectives = 0;
  let embedFalseDirectives = 0;
  const latencies: number[] = [];

  for (const item of DIRECTIVE_CORPUS) {
    const isRegex = STANDING_DIRECTIVE_PATTERN.test(item.text);
    const regexChoice = isRegex ? "standing_directive" : "transient_task";

    if (regexChoice === item.kind) regexCorrect++;
    if (item.kind === "standing_directive" && isRegex) regexDirectivesCaught++;
    if (item.kind === "transient_task" && isRegex) regexFalseDirectives++;

    const res = await runClassify(item.text, DIRECTIVE_EXEMPLARS);
    latencies.push(res.latencyMs);

    const embedChoice = res.choice;
    if (embedChoice === item.kind) embedCorrect++;
    if (item.kind === "standing_directive" && embedChoice === "standing_directive") embedDirectivesCaught++;
    if (item.kind === "transient_task" && embedChoice === "standing_directive") embedFalseDirectives++;
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)].toFixed(1);
  const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(1);

  console.log(`Corpus Size:               ${DIRECTIVE_CORPUS.length} (10 standing directives, 10 transient tasks; EN + PT)`);
  console.log(`Legacy Regex Accuracy:     ${regexCorrect}/${DIRECTIVE_CORPUS.length} (${(regexCorrect / DIRECTIVE_CORPUS.length * 100).toFixed(1)}%)`);
  console.log(`Embeddings Accuracy:       ${embedCorrect}/${DIRECTIVE_CORPUS.length} (${(embedCorrect / DIRECTIVE_CORPUS.length * 100).toFixed(1)}%)  [+${((embedCorrect - regexCorrect) / DIRECTIVE_CORPUS.length * 100).toFixed(1)}% gain]`);
  console.log(`Directives Caught (Recall): Regex ${regexDirectivesCaught}/10 (${regexDirectivesCaught * 10}%) vs Embeddings ${embedDirectivesCaught}/10 (${embedDirectivesCaught * 10}%)`);
  console.log(`False Directives (Spam):   Regex ${regexFalseDirectives} vs Embeddings ${embedFalseDirectives}`);
  console.log(`Embeddings Latency:        p50 = ${p50} ms, p95 = ${p95} ms`);
}

async function benchmarkOverview() {
  console.log("\n==================================================================");
  console.log("2. BENCHMARK: OVERVIEW ROUTING (isDirectMemoryQuestion)");
  console.log("==================================================================");

  let regexCorrect = 0;
  let embedCorrect = 0;
  let regexOverviewsCaught = 0;
  let embedOverviewsCaught = 0;
  let regexFalseOverviews = 0;
  let embedFalseOverviews = 0;
  const latencies: number[] = [];

  for (const item of OVERVIEW_CORPUS) {
    const isRegex = DIRECT_MEMORY_PATTERN.test(item.text);
    const regexChoice = isRegex ? "overview_query" : "specific_query";

    if (regexChoice === item.kind) regexCorrect++;
    if (item.kind === "overview_query" && isRegex) regexOverviewsCaught++;
    if (item.kind === "specific_query" && isRegex) regexFalseOverviews++;

    const res = await runClassify(item.text, OVERVIEW_EXEMPLARS);
    latencies.push(res.latencyMs);

    const embedChoice = res.choice;
    if (embedChoice === item.kind) embedCorrect++;
    if (item.kind === "overview_query" && embedChoice === "overview_query") embedOverviewsCaught++;
    if (item.kind === "specific_query" && embedChoice === "overview_query") embedFalseOverviews++;
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)].toFixed(1);
  const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(1);

  console.log(`Corpus Size:               ${OVERVIEW_CORPUS.length} (10 overview queries, 10 specific queries; EN + PT)`);
  console.log(`Legacy Regex Accuracy:     ${regexCorrect}/${OVERVIEW_CORPUS.length} (${(regexCorrect / OVERVIEW_CORPUS.length * 100).toFixed(1)}%)`);
  console.log(`Embeddings Accuracy:       ${embedCorrect}/${OVERVIEW_CORPUS.length} (${(embedCorrect / OVERVIEW_CORPUS.length * 100).toFixed(1)}%)  [+${((embedCorrect - regexCorrect) / OVERVIEW_CORPUS.length * 100).toFixed(1)}% gain]`);
  console.log(`Overviews Caught (Recall): Regex ${regexOverviewsCaught}/10 (${regexOverviewsCaught * 10}%) vs Embeddings ${embedOverviewsCaught}/10 (${embedOverviewsCaught * 10}%)`);
  console.log(`False Overviews (Spam):    Regex ${regexFalseOverviews} vs Embeddings ${embedFalseOverviews}`);
  console.log(`Embeddings Latency:        p50 = ${p50} ms, p95 = ${p95} ms`);
}

async function benchmarkQuestKinds() {
  console.log("\n==================================================================");
  console.log("3. BENCHMARK: FINE-GRAINED QUEST KINDS (classifyQuestKind)");
  console.log("==================================================================");

  let correct = 0;
  const latencies: number[] = [];
  const perKind: Record<string, { total: number; correct: number }> = {};

  for (const kind of Object.keys(KIND_EXEMPLARS)) {
    perKind[kind] = { total: 0, correct: 0 };
  }

  for (const item of KIND_CORPUS) {
    perKind[item.kind].total++;
    const res = await runClassify(item.text, KIND_EXEMPLARS);
    latencies.push(res.latencyMs);

    if (res.choice === item.kind) {
      correct++;
      perKind[item.kind].correct++;
    } else {
      console.log(`   [MISS] "${item.text}" expected: ${item.kind}, got: ${res.choice} (sim: ${res.similarity.toFixed(2)}, margin: ${res.margin.toFixed(2)})`);
    }
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)].toFixed(1);
  const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(1);

  console.log(`Corpus Size:               ${KIND_CORPUS.length} (5 kinds: bugfix, feature, refactor, docs, analysis; EN + PT)`);
  console.log(`Classification Accuracy:   ${correct}/${KIND_CORPUS.length} (${(correct / KIND_CORPUS.length * 100).toFixed(1)}%)`);
  for (const [kind, stats] of Object.entries(perKind)) {
    if (stats.total > 0) {
      console.log(`  - ${kind.padEnd(12)}: ${stats.correct}/${stats.total} (${(stats.correct / stats.total * 100).toFixed(0)}%)`);
    }
  }
  console.log(`Embeddings Latency:        p50 = ${p50} ms, p95 = ${p95} ms`);
}

async function main() {
  await benchmarkDirectives();
  await benchmarkOverview();
  await benchmarkQuestKinds();
  console.log("\n==================================================================");
  console.log("ALL BENCHMARKS COMPLETED AGAINST LIVE AXIL-AUREN.");
  console.log("==================================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
