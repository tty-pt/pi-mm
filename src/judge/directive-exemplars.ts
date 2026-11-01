// HIGH_LEVEL: bilingual exemplar set for standing directive classification
// (axil-auren `POST /v1/classify`). Detects whether a statement expresses a permanent
// invariant/rule/operational directive vs a transient, one-off task or conversational query.

export type DirectiveKind = "standing_directive" | "transient_task";

export const DIRECTIVE_KINDS: ReadonlySet<string> = new Set<DirectiveKind>([
  "standing_directive",
  "transient_task",
]);

export const DIRECTIVE_EXEMPLARS: Record<string, string[]> = {
  standing_directive: [
    // --- English ---
    "always remember to write unit tests for every new handler",
    "never use raw SQL queries in request handlers",
    "our rule is to keep all handlers pure C without external dependencies",
    "standing rule: no global mutable state across modules",
    "invariant: database writes must be atomic and routed through cormd",
    "from now on, make sure we never commit .env or secret files",
    "make sure all UX modules dual-compile cleanly to WASM",
    "always use axil_slugify instead of transliteration",
    "rule: never edit files in external directly",
    "standing policy: SSR is the single source of truth",
    "remember this rule: all test runs must be hermetic",
    "all future commits must include a changelog entry",
    // Negative constraints, mistake corrections, and anti-patterns
    "don't use raw pointers in request handlers",
    "never mock the filesystem in tests",
    "stop modifying the lockfile without running make",
    "you made a mistake, that function requires three arguments, never call it with two",
    "avoid global mutable variables in C modules",
    "make sure you never commit without running tests first",
    "don't ever edit package-lock.json manually",
    "stop using external libraries when libc provides the function",
    "that was a mistake, do not add temporary console logs or debug prints",
    "don't use mock data when real fixtures exist",
    "avoid modifying files in external/ directly",
    "never run tests in parallel on shared ports",
    "do not use regex heuristics for semantic matching",
    "never compliment yourself or use self-flattery when reporting metrics",
    "you made a mistake here, make sure to avoid doing that in the future",
    "stop doing that, we told you not to edit Makefile directly",
    "don't bypass the module boundary under any circumstances",
    "avoid hardcoded paths or port numbers in production code",

    // --- Portuguese ---
    "regra permanente: nunca use Rust ou Dioxus no caminho crítico",
    "a regra aqui é manter o SSR como contrato principal da aplicação",
    "em todo o código novo, certifique-se de seguir convenções C99",
    "nunca edite os arquivos em external diretamente",
    "diretriz permanente: todos os testes devem rodar hermeticamente",
    "lembre-se sempre de rodar o linter antes de submeter alterações",
    "nosso padrão é que toda mutação passe pelo daemon cormd",
    "regra: nunca adicione dependências pesadas de terceiros",
    "a partir de agora, use sempre codificação UTF-8 em todos os arquivos",
    // Restrições negativas, correções de erros e anti-padrões (PT)
    "não use variáveis globais em módulos C",
    "nunca use mocks nos testes unitários",
    "para de alterar o lockfile sem rodar make",
    "você cometeu um erro: essa função recebe três argumentos, nunca passe dois",
    "evite usar ponteiros soltos nos handlers",
    "não faça commit sem antes rodar make test",
    "para de usar dependências externas desnecessárias",
    "isso foi um erro, não use console.log em produção",
    "não burle a fronteira de módulos em hipótese alguma",
  ],

  transient_task: [
    // --- English ---
    "please fix the typo on line 42 of user.c",
    "edit parser.c and add a comment explaining the buffer size",
    "run the unit test suite and see if it passes",
    "can you check git status and tell me what files changed?",
    "what time is it right now?",
    "good morning, how are you doing today?",
    "write a small helper script to clean up temporary files",
    "why did the last build fail with a missing header?",
    "look up the implementation of route handling in mod_song.c",
    "search for all occurrences of corm_open across the repo",
    "show me the diff for the last commit",
    "restart the test daemon and check its log output",

    // --- Portuguese ---
    "onde fica o arquivo de configuração do servidor axil?",
    "compile o projeto com make e me mostre se houve algum erro",
    "por favor corrija o bug na função de parsing do json",
    "como eu faço para debugar a conexão do socket?",
    "olá, bom dia! vamos começar o trabalho de hoje",
    "verifique se os testes unitários passaram sem problemas",
    "adicione uma nova rota GET /health no módulo core",
    "qual foi a mensagem de erro que apareceu no terminal?",
  ],
};
