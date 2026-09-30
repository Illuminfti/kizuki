import type { RunContext, SyncBatch } from "@kizuki/core";

/**
 * Plays the host for a connector call made without one: a store to lend, and
 * the commit that follows a batch whose checkpoint advanced.
 */
export function hostStore(): { store: Map<string, string>; context: RunContext; commit(batch: SyncBatch): SyncBatch } {
  const store = new Map<string, string>();
  return {
    store,
    context: { cursor_store: store },
    commit(batch) {
      for (const [key, value] of Object.entries(batch.cursor_store ?? {})) {
        if (value === null) store.delete(key);
        else store.set(key, value);
      }
      return batch;
    },
  };
}
