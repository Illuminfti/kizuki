import { join } from "node:path";

export const ENGINE_REL = "engine.json";
export const STORE_REL = "store";
export const LEASE_REL = "lease";
export const DOCS_REL = "store/docs.json";
export const GRAPH_REL = "store/graph.json";
export const CHECKPOINT_REL = "store/embed-checkpoint.json";
export const SELF_WRITES_REL = "store/self-writes.json";
export const LEASE_HELD_REL = "lease/held";
export const LEASE_HOLDER_REL = "lease/held/holder.json";
export const LEASE_QUEUE_REL = "lease/queue.json";
export const LEASE_RECEIPTS_REL = "lease/receipts.jsonl";

export function dataPath(dataDir: string, rel: string): string {
  return join(dataDir, rel);
}
