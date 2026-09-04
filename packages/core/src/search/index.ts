export { indexEvent, indexPage, rebuildSearch, removeDoc } from "./indexer";
export type { DocScope, SearchRebuildResult } from "./indexer";
export { search, searchResult, toFtsQuery } from "./query";
export type { SearchHit, SearchOptions, SearchResult } from "./query";
export { initSearch } from "./schema";
