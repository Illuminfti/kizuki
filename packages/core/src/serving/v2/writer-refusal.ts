import { assertPositiveAuthorityMutationAllowed, ErasurePendingError } from "../../canon/positive-authority";
import type { Database } from "bun:sqlite";
import { withCanonMutationAsync } from "../../canon/io";
import type { CanonIo } from "../../canon";
import { VaultMutationError, withVaultMutationAsync, type VaultMutationScope } from "../../vault/mutation-scope";
import { WRITER_REFUSAL_V2 } from "../../contracts/scoped-tools";
import { ServeError } from "../types";

/** Only raised before mutation. Adapters must not infer this from a generic
 * busy error after a committed correction or a failed refresh. */
export class ScopedWriterUnavailable extends ServeError {
  constructor() { super("busy", "writer unavailable"); }
}
export function scopedWriterRefusal(error: unknown): typeof WRITER_REFUSAL_V2 | null {
  return error instanceof ScopedWriterUnavailable ? WRITER_REFUSAL_V2 : null;
}
export function assertScopedWriterAvailable(db: Database): void {
  try { assertPositiveAuthorityMutationAllowed(db); }
  catch (error) { if (error instanceof ErasurePendingError) throw new ScopedWriterUnavailable(); throw error; }
}
/** The boolean distinguishes acquisition from errors in completed work. */
export async function withScopedCanonMutation<T extends CanonIo, R>(io: T, work: (scope: VaultMutationScope, owned: T) => R | PromiseLike<R>): Promise<R> {
  let entered = false;
  try {
    return await withCanonMutationAsync(io, (scope, owned) => {
      entered = true;
      return work(scope, owned);
    });
  } catch (error) {
    if (!entered && error instanceof VaultMutationError && error.code === "writer_busy") throw new ScopedWriterUnavailable();
    throw error;
  }
}
export async function withScopedClaimMutation<R>(db: Database, vaultPath: string, work: () => Promise<R>): Promise<R> {
  let entered = false;
  try {
    return await withVaultMutationAsync({ db, vault_path: vaultPath }, () => {
      entered = true;
      return work();
    });
  } catch (error) {
    if (!entered && error instanceof VaultMutationError && error.code === "writer_busy") throw new ScopedWriterUnavailable();
    throw error;
  }
}
