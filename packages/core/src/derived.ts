import type { Database } from "bun:sqlite";
import { rebuildGraph } from "./graph/graph";
import type { GraphRebuildResult } from "./graph/graph";
import { rebuildSearch } from "./search/indexer";
import type { SearchRebuildResult } from "./search/indexer";

export interface DerivedRebuildResult {
  search: SearchRebuildResult;
  graph: GraphRebuildResult;
}

export function rebuildDerived(
  db: Database,
  vaultPath: string,
): DerivedRebuildResult {
  return {
    search: rebuildSearch(db, vaultPath),
    graph: rebuildGraph(db, vaultPath),
  };
}
