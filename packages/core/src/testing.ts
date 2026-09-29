/** Test-only ledger opener. Production packages import `@kizuki/core/internal`. */
export { openLedger } from "./ledger/db";
/** Raw FTS helpers for tests. Adapters search through `serveSearch`. */
export { search, searchResult, toFtsQuery } from "./search";
/** Raw timeline helper for tests. Adapters query through `serveTimeline`. */
export { timeline } from "./query";
/** Raw graph neighbor helper for tests. Adapters query through `serveGraph`. */
export { neighbors } from "./graph";
/** Registers synthetic world table specs until the returned disposer runs. */
export { registerWorldTableSpecs } from "./world/tables/registry";
/** Registers synthetic world jobs until the returned disposer runs. */
export { registerWorldJobs } from "./serve/world-jobs";
/** Test seam for the world operation registry; production code never registers an operation this way. */
export { withWorldOps } from "./world/ops/registry";
