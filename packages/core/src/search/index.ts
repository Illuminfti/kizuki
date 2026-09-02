export { indexEvent, indexPage, rebuildSearch, removeDoc } from "./indexer";
export type { DocScope, SearchRebuildResult } from "./indexer";
export { search, toFtsQuery } from "./query";
export type { SearchHit, SearchOptions } from "./query";
export { initSearch } from "./schema";
