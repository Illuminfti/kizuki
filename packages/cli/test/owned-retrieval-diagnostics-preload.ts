/** TEMPORARY fixture-only instrumentation; remove once the native CI failure is repaired.
 * Observe original calls/results without changing runtime or maintenance policy.
 * Provider text, paths, raw messages, stacks and arbitrary error properties never leave here.
 */
import { EmbeddedRetrievalPort } from "@kizuki/retrieval-pg";
import { Fts5RetrievalPort } from "@kizuki/core";
import { OwnedDirectory } from "../../core/src/util/owned-directory";
import { SqlStore } from "../../retrieval-pg/src/sql-store";

const CODES = new Set(["EACCES", "EPERM", "EBADF", "ENOENT", "ENOTEMPTY", "EINVAL", "EIO", "ENOSPC", "ELOOP", "ENOTDIR", "EMFILE", "ENFILE", "unavailable", "lease_required"]);
const INTERNAL = new Set(["owned_directory_unsafe", "owned_directory_identity_changed", "owned_directory_closed", "owned_directory_bounds", "owned_directory_abi_invalid", "owned_directory_absence_unproven", "owned_directory_lock_missing", "owned_directory_unsupported", "owned_generation_changed_restart_required", "owned_generation_changed_restart_required: active_sql_uncontained"]);
type Phase = "pg-erase" | "pg-close" | "sql-close" | "sql-callback" | "fts-erase" | "fd-remove-tree";
export function failureDiagnostic(phase: Phase, error: unknown): string {
  let code = "unclassified";
  if (error instanceof Error) {
    const native = (error as NodeJS.ErrnoException).code;
    if (typeof native === "string" && CODES.has(native)) code = native;
    else if (INTERNAL.has(error.message)) code = error.message;
  }
  return JSON.stringify({ schema: "kizuki.synthetic-erasure-diagnostic/v1", phase, code });
}
function report(phase: Phase, error: unknown): void {
  // Diagnostic failure must not replace the operation's original exception.
  try { process.stderr.write(failureDiagnostic(phase, error) + "\n"); } catch {}
}
const pgErase = EmbeddedRetrievalPort.prototype.eraseOwnedGeneration;
EmbeddedRetrievalPort.prototype.eraseOwnedGeneration = async function () {
  try { return await pgErase.call(this); } catch (error) { report("pg-erase", error); throw error; }
};
const pgClose = EmbeddedRetrievalPort.prototype.close;
EmbeddedRetrievalPort.prototype.close = async function () {
  try { return await pgClose.call(this); } catch (error) { report("pg-close", error); throw error; }
};
const sqlClose = SqlStore.prototype.close;
SqlStore.prototype.close = async function (disposeAssets = true) {
  try { return await sqlClose.call(this, disposeAssets); } catch (error) { report("sql-close", error); throw error; }
};
const sqlRun = SqlStore.prototype.run;
SqlStore.prototype.run = function <T>(fn: () => Promise<T>): Promise<T> {
  return sqlRun.call(this, async () => {
    try { return await fn(); } catch (error) { report("sql-callback", error); throw error; }
  }) as Promise<T>;
};
const ftsErase = Fts5RetrievalPort.prototype.eraseOwnedGeneration;
Fts5RetrievalPort.prototype.eraseOwnedGeneration = async function () {
  try { return await ftsErase.call(this); } catch (error) { report("fts-erase", error); throw error; }
};
const remove = OwnedDirectory.prototype.removeTree;
OwnedDirectory.prototype.removeTree = function (...args: Parameters<typeof remove>) {
  try { return remove.apply(this, args); } catch (error) { report("fd-remove-tree", error); throw error; }
};
