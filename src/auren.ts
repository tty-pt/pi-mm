/**
 * Thin façade over the self-contained bootstrap module (also vendored into pi-quest).
 * Existing imports of "./auren.ts" keep working.
 */
export {
  DEFAULT_AUREN_URL,
  DEFAULT_AUREN_PORT,
  DEFAULT_AUREN_JUDGE_MODEL,
  DEFAULT_AUREN_EMBED_MODEL,
  DOCS_PIMM_PREREQUISITES,
  DOCS_AUREN,
  DOCS_SEPAL,
  DOCS_CORM,
  DOCS_LEMMA,
  DOCS_JOINT,
  findAurenServer,
  findSepalLib,
  isAurenRunning,
  ensureAuren,
  getBootstrapState,
  describeProgress,
  diagnoseAuren,
  serverLogPath,
  findUserConfig,
  MODEL_CATALOG,
} from "./auren-bootstrap.ts";
export type { BootstrapState, Notice, BootstrapSettings, DownloadPolicy } from "./auren-bootstrap.ts";
export { ensureAurenDaemon } from "./auren-bootstrap.ts";
