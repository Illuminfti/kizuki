import { resolve } from "node:path";
import type { CanonIo } from "./store";

/** Capture the selected database/root and optional services once per operation. */
export function snapshotCanonIo(io: CanonIo): CanonIo {
  const { db, vault_path, now, ids, retrieval, retrieval_store } = io;
  return Object.freeze({
    db, vault_path: resolve(vault_path),
    ...(now === undefined ? {} : { now }),
    ...(ids === undefined ? {} : { ids }),
    ...(retrieval === undefined ? {} : { retrieval }),
    ...(retrieval_store === undefined ? {} : { retrieval_store }),
  });
}
