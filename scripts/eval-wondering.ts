import { DEFAULT_CONFIG, type MmConfig } from "../src/config.ts";
import { evaluateAssistantWondering } from "../src/hooks/wondering.ts";

interface Case {
  text: string;
  want: "wondering" | "routine_action";
  lang: "en" | "pt";
}

const CASES: Case[] = [
  // --- WONDERING (12 cases: 8 EN, 4 PT) ---
  { text: "I wonder how the caching layer works in this project", want: "wondering", lang: "en" },
  { text: "Not sure how the FTS engine handles accent folding here", want: "wondering", lang: "en" },
  { text: "How does corm handle mutations and database locking in production?", want: "wondering", lang: "en" },
  { text: "Where are session files stored in this architecture?", want: "wondering", lang: "en" },
  { text: "How do we handle memory writes in this codebase?", want: "wondering", lang: "en" },
  { text: "I need to understand how the review pipeline is wired", want: "wondering", lang: "en" },
  { text: "Why are descriptors leaking in corm on reopen?", want: "wondering", lang: "en" },
  { text: "Is there an established convention for module headers in this repo?", want: "wondering", lang: "en" },
  // Portuguese
  { text: "Como funciona a camada de cache neste projeto?", want: "wondering", lang: "pt" },
  { text: "Não tenho a certeza de como o motor trata a acentuação aqui", want: "wondering", lang: "pt" },
  { text: "Como é que o corm lida com as mutações e bloqueio de ficheiros?", want: "wondering", lang: "pt" },
  { text: "Onde é que os ficheiros de sessão ficam guardados nesta arquitetura?", want: "wondering", lang: "pt" },

  // --- ROUTINE ACTIONS (12 cases: 8 EN, 4 PT) ---
  { text: "I will now edit file src/main.c to add the missing return statement", want: "routine_action", lang: "en" },
  { text: "Let me run make test to inspect the compiler output", want: "routine_action", lang: "en" },
  { text: "Reading package.json to check dependency versions", want: "routine_action", lang: "en" },
  { text: "Successfully replaced 1 block in src/hooks/events.ts", want: "routine_action", lang: "en" },
  { text: "All 471 tests passed with zero errors", want: "routine_action", lang: "en" },
  { text: "Writing new implementation plan to draft file", want: "routine_action", lang: "en" },
  { text: "I am going to delete the temporary file now", want: "routine_action", lang: "en" },
  { text: "Executing git diff to review local changes", want: "routine_action", lang: "en" },
  // Portuguese
  { text: "Vou agora editar o ficheiro src/main.c para corrigir o retorno", want: "routine_action", lang: "pt" },
  { text: "Deixa-me correr o make test para verificar os erros de compilação", want: "routine_action", lang: "pt" },
  { text: "A ler o package.json para verificar as versões das dependências", want: "routine_action", lang: "pt" },
  { text: "Substituído com sucesso o bloco no ficheiro", want: "routine_action", lang: "pt" },
];

async function runBenchmark() {
  console.log("==================================================================");
  console.log(" ASSISTANT WONDERING CLASSIFICATION BENCHMARK");
  console.log(" Corpus: 24 cases (12 wondering, 12 routine_action; EN + PT)");
  console.log(" Backend: axil-auren on http://127.0.0.1:4242");
  console.log("==================================================================\n");

  const cfg: MmConfig = {
    ...DEFAULT_CONFIG,
    wonderingEmbed: "auto",
    captureEmbedUrl: "http://127.0.0.1:4242",
  };

  let correct = 0;
  let falseWonder = 0;
  let wonderCaught = 0;
  let totalWonder = 0;
  let totalAction = 0;
  const latencies: number[] = [];

  for (const c of CASES) {
    const t0 = performance.now();
    const isWondering = await evaluateAssistantWondering(c.text, cfg);
    const ms = performance.now() - t0;
    latencies.push(ms);

    const got = isWondering ? "wondering" : "routine_action";
    const isCorrect = got === c.want;
    if (isCorrect) correct++;

    if (c.want === "wondering") {
      totalWonder++;
      if (got === "wondering") wonderCaught++;
    } else {
      totalAction++;
      if (got === "wondering") falseWonder++;
    }

    const mark = isCorrect ? "✓ PASS" : "✗ FAIL";
    console.log(`[${mark}] [want: ${c.want}, got: ${got}] (${ms.toFixed(1)}ms): "${c.text.slice(0, 60)}"`);
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  console.log("\n------------------------------------------------------------------");
  console.log(`Total Cases:              ${CASES.length}`);
  console.log(`Overall Accuracy:         ${((correct / CASES.length) * 100).toFixed(1)}% (${correct}/${CASES.length})`);
  console.log(`Wondering Recall:         ${((wonderCaught / totalWonder) * 100).toFixed(1)}% (${wonderCaught}/${totalWonder})`);
  console.log(`Action Specificity:       ${(((totalAction - falseWonder) / totalAction) * 100).toFixed(1)}% (${totalAction - falseWonder}/${totalAction})`);
  console.log(`False Positives (Spam):   ${falseWonder}/${totalAction} (${((falseWonder / totalAction) * 100).toFixed(1)}%)`);
  console.log(`Latency p50:              ${p50.toFixed(1)} ms`);
  console.log(`Latency p95:              ${p95.toFixed(1)} ms`);
  console.log("------------------------------------------------------------------");
}

await runBenchmark();
