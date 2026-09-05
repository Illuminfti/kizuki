import { registerPort } from "@kizuki/core";
import type { PortRegistry, RetrievalPort } from "@kizuki/core";
import { EMBEDDED_RETRIEVAL_DESCRIPTOR } from "./descriptor";
import { createEmbeddedRetrievalPort } from "./port";

export {
  EMBEDDED_RETRIEVAL_DESCRIPTOR,
  EMBEDDED_RETRIEVAL_ID,
} from "./descriptor";
export {
  DEFAULT_HEARTBEAT_MS,
  STALE_HEARTBEAT_MULTIPLIER,
  WriterLease,
  isProcessAlive,
  writeSyntheticHolder,
} from "./lease";
export type { LeaseHolder, LeaseReceipt, LeaseSnapshot } from "./lease";
export {
  EmbeddedRetrievalPort,
  createEmbeddedRetrievalPort,
  openEmbeddedRetrievalPort,
} from "./port";
export type { EmbeddedRetrievalOptions } from "./port";
export { McpEngineSurface } from "./session";
export { RefreshWatcher } from "./watcher";
export type { WatchEvent, WatchEventType } from "./watcher";
export {
  AUTHORITY_WEIGHT,
  NEAR_DUPLICATE_JACCARD,
  RRF_K,
} from "./rank";
export { assertNoStoreTransaction, runStoreTransaction } from "./txn";

export function registerEmbeddedRetrieval(registry?: PortRegistry): void {
  if (registry === undefined) {
    registerPort<RetrievalPort>(
      EMBEDDED_RETRIEVAL_DESCRIPTOR,
      (ctx) => createEmbeddedRetrievalPort(ctx),
    );
    return;
  }
  registry.registerPort<RetrievalPort>(
    EMBEDDED_RETRIEVAL_DESCRIPTOR,
    (ctx) => createEmbeddedRetrievalPort(ctx),
  );
}

export { eraseOwnedEmbeddedGeneration } from "./port";
