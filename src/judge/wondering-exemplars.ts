// HIGH_LEVEL: #judge — shipped exemplars for assistant cognitive wondering detection.
// Evaluates assistant reasoning, thinking blocks, and turns via vector embeddings
// (axil-auren POST /v1/classify) to detect when the agent is wondering about how a
// subsystem or convention works ("wondering" vs "routine_action").
// When positive, the agent is steered with a memory hint without auto-triggering database queries.

export const WONDERING_KINDS: ReadonlySet<string> = new Set(["wondering", "routine_action"]);

export const WONDERING_EXEMPLARS: Record<string, string[]> = {
  wondering: [
    // Subsystem exploration & architecture curiosity
    "I wonder how the caching layer works in this project",
    "Not sure how the FTS engine handles accent folding here",
    "How does corm handle mutations and database locking?",
    "Where are session files stored in this architecture?",
    "How do we handle memory writes in this codebase?",
    "I need to understand how the review pipeline is wired",
    "Why are descriptors leaking in corm on reopen?",
    "Is there an established convention for module headers in this repo?",
    "Wondering if there is an existing helper for parsing headers",
    "Let me check if we decided on a standard way to structure this",
    "I'm curious what the convention is for error handling here",
    "How was the session journal designed originally?",
    // Portuguese wonderings
    "Como funciona a camada de cache neste projeto?",
    "Não tenho a certeza de como o motor trata a acentuação aqui",
    "Como é que o corm lida com as mutações e bloqueio de ficheiros?",
    "Onde é que os ficheiros de sessão ficam guardados nesta arquitetura?",
    "Será que já temos uma convenção definida para cabeçalhos de módulos?",
    "Preciso de perceber como é que o pipeline de revisão foi implementado",
    "Porque é que estamos a ter vazamento de descritores de ficheiro?",
    "Existe algum padrão já estabelecido para a persistência neste código?",
  ],
  routine_action: [
    // Direct code edits & file actions
    "I will now edit file src/main.c to add the missing return statement",
    "Let me run make test to inspect the compiler output",
    "Reading package.json to check dependency versions",
    "Successfully replaced 1 block in src/hooks/events.ts",
    "All 469 tests passed with zero errors",
    "Writing new implementation plan to draft file",
    "I am going to delete the temporary file now",
    "Executing git diff to review local changes",
    "Starting compilation via make watch",
    "Replacing old implementation with updated helper function",
    // Portuguese routine actions
    "Vou agora editar o ficheiro src/main.c para corrigir o retorno",
    "Deixa-me correr o make test para verificar os erros de compilação",
    "A ler o package.json para verificar as versões das dependências",
    "Substituído com sucesso o bloco no ficheiro",
    "Todos os testes passaram com zero erros",
    "A compilar o projeto com o make",
    "A executar git status para verificar alterações locais",
    "A escrever o novo plano de implementação no ficheiro de rascunho",
  ],
};
