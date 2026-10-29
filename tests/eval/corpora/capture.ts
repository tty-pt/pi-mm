// Labelled corpora for pi-mm's conversational capture decision ("is this user turn worth
// remembering for future conversations?"), English and Portuguese, with the assistant
// reply as judge context. DESIGN DECISION FIXED BEFORE ANY HELD-OUT RESULT: embeddings
// classify the USER PROMPT only (the memory content is what the user said).
//   remember = new durable personal facts, experiences, preferences, technical discoveries, decisions
//   skip     = questions, recall probes, greetings, thanks, acknowledgements, transient chatter, task requests
// The state-changing error is a false "remember": it writes to the memory store.
import type { Case } from "../harness.ts";

export const rem = (text: string, response = "Got it."): Case => ({ text, response, want: "remember" });
export const skip = (text: string, response = "Sure."): Case => ({ text, response, want: "skip" });

export const CAPTURE_CORPUS: Case[] = [
  // ---- remember ---------------------------------------------------------------------------
  rem("I'm allergic to peanuts, so please never suggest recipes with them"),
  rem("We decided to use Postgres instead of MySQL for the billing service"),
  rem("My daughter's name is Clara and she starts school in September"),
  rem("I prefer tabs over spaces and a 100 column limit in all my projects"),
  rem("I just found out the build fails when the locale is set to pt_PT"),
  rem("I moved to Porto last month and work remotely from there now"),
  rem("The staging server is at 10.0.4.12 and only accepts SSH from the office VPN"),
  rem("I always deploy on Thursdays, never on Fridays"),
  rem("Our team agreed that all API errors must return RFC 7807 problem details"),
  rem("I'm vegetarian, and my partner is vegan"),
  rem("Turns out the memory leak was caused by the logger holding on to request objects"),
  rem("I'm learning Rust this year and want to rewrite the CLI tools in it eventually"),
  rem("Sou alérgico a frutos secos, por isso nunca sugiras receitas com eles"),
  rem("Decidimos usar Postgres em vez de MySQL no serviço de faturação"),
  rem("A minha filha chama-se Clara e começa a escola em setembro"),
  rem("Prefiro tabs a espaços e um limite de 100 colunas em todos os meus projetos"),
  rem("Descobri agora que o build falha quando o locale está em pt_PT"),
  rem("Mudei-me para o Porto no mês passado e trabalho daqui remotamente"),
  rem("O servidor de staging só aceita SSH a partir da VPN do escritório"),
  rem("Faço sempre deploy às quintas-feiras, nunca às sextas"),
  rem("Sou vegetariano e a minha companheira é vegan"),
  rem("Afinal a fuga de memória era causada pelo logger que guardava os objetos dos pedidos"),
  // ---- skip -------------------------------------------------------------------------------
  skip("Do you remember what my daughter's name is?"),
  skip("What did I tell you about my allergies?"),
  skip("Hello, how are you today?"),
  skip("Thanks, that was really helpful"),
  skip("Can you explain how a mutex works?"),
  skip("Ok, got it"),
  skip("Please run the tests again and tell me what fails"),
  skip("What is the difference between a process and a thread?"),
  skip("Good morning!"),
  skip("Show me the last ten lines of the log"),
  skip("Nice, that works now"),
  skip("Is it safe to eat peanuts if I'm allergic to tree nuts?"),
  skip("Lembras-te como se chama a minha filha?"),
  skip("O que te disse sobre as minhas alergias?"),
  skip("Olá, tudo bem?"),
  skip("Obrigado, ajudou bastante"),
  skip("Podes explicar-me como funciona um mutex?"),
  skip("Está bem, percebi"),
  skip("Corre os testes outra vez e diz-me o que falha"),
  skip("Qual é a diferença entre um processo e uma thread?"),
  skip("Bom dia!"),
  skip("Mostra-me as últimas dez linhas do log"),
];

/**
 * Corpus B: written AFTER corpus A's result and the pre-registered hypothesis (exemplar
 * set v2 at the default margin), BEFORE any run against v2. New topics throughout, with
 * hard negatives (questions and task requests that contain personal facts) and casual
 * positives.
 */
export const CAPTURE_CORPUS_B: Case[] = [
  // ---- remember ---------------------------------------------------------------------------
  rem("I have a cat called Pixel who sleeps on my keyboard every afternoon"),
  rem("For the record, we agreed to freeze the API until the audit is done"),
  rem("I only read documentation in English, even though I'm Portuguese"),
  rem("The Docker build is slow because the base image is pulled fresh every time"),
  rem("I'm training for a half marathon in October"),
  rem("Our monitoring alerts go to the #ops channel and the on-call phone"),
  rem("I prefer pull requests under 300 lines, anything bigger gets split"),
  rem("My birthday is on the 3rd of March, in case it matters for scheduling"),
  rem("We figured out the timeouts were caused by a misconfigured load balancer"),
  rem("I'm colour blind, so avoid red and green together in charts"),
  rem("We're going with Terraform for the infrastructure, not Pulumi"),
  rem("I work night shifts on Tuesdays and Wednesdays"),
  rem("Tenho um gato chamado Pixel que dorme em cima do teclado todas as tardes"),
  rem("Para constar, combinámos congelar a API até a auditoria terminar"),
  rem("Só leio documentação em inglês, apesar de ser português"),
  rem("O build do Docker é lento porque a imagem base é descarregada de novo de cada vez"),
  rem("Estou a treinar para uma meia maratona em outubro"),
  rem("Os alertas de monitorização vão para o canal #ops e para o telefone de prevenção"),
  rem("Prefiro pull requests com menos de 300 linhas, o que for maior é dividido"),
  rem("Faço anos a 3 de março, caso interesse para marcar reuniões"),
  rem("Percebemos que os timeouts eram causados por um balanceador mal configurado"),
  rem("Sou daltónico, por isso evita vermelho e verde juntos nos gráficos"),
  // ---- skip -------------------------------------------------------------------------------
  skip("What's my cat's name again?"),
  skip("Can you remember which day I said I do night shifts?"),
  skip("Hey there!"),
  skip("Awesome, thank you"),
  skip("How do I undo my last git commit?"),
  skip("Right, I see"),
  skip("Please restart the dev server and check the logs"),
  skip("Which is faster, quicksort or mergesort?"),
  skip("Good night"),
  skip("Delete the temporary files in the build folder"),
  skip("That fixed it, great"),
  skip("Given that I'm colour blind, which chart palette would you suggest?"),
  skip("Como é que o meu gato se chama mesmo?"),
  skip("Consegues lembrar-te em que dias disse que faço turnos da noite?"),
  skip("Boa tarde!"),
  skip("Fantástico, obrigado"),
  skip("Como desfaço o meu último commit no git?"),
  skip("Certo, estou a ver"),
  skip("Reinicia o servidor de desenvolvimento e verifica os logs"),
  skip("Qual é mais rápido, quicksort ou mergesort?"),
  skip("Boa noite"),
  skip("Apaga os ficheiros temporários da pasta de build"),
];

/** The shipped exemplars (single source of truth); the corpus tests assert disjointness from them. */
export { CAPTURE_EXEMPLARS } from "../../../src/judge/capture-exemplars.ts";
