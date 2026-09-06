import { resolve } from "node:path";
import { readPage, type CanonIo } from "./store";
import { assertCanonFiles, type CanonFiles } from "../vault/canon-files";
import { withMutationFilesAsync, withMutationFilesSync } from "../vault/mutation-files";
import {
  assertVaultMutationScope, VaultMutationError, withVaultMutationAsync, withVaultMutationSync,
  type VaultMutationScope,
} from "../vault/mutation-scope";

const owners = new WeakMap<CanonIo, { scope: VaultMutationScope; files: CanonFiles }>();

/** Internal registration; the public CanonIo shape carries no capability fields. */
export function bindCanonFiles<T extends CanonIo>(scope: VaultMutationScope, io: T, files: CanonFiles): T {
  assertVaultMutationScope(scope, io);
  assertCanonFiles(files, io.vault_path);
  if (!Object.isFrozen(io)) throw new VaultMutationError("mutation_target_invalid");
  owners.set(io, { scope, files });
  return io;
}

/** Read helpers retain their standalone behavior; owned calls use their captured descriptors. */
export function canonFilesFor(io: CanonIo): CanonFiles | undefined {
  const owner = owners.get(io);
  if (owner === undefined) return undefined;
  assertVaultMutationScope(owner.scope, io);
  assertCanonFiles(owner.files, io.vault_path);
  return owner.files;
}

/** Source-only read facade for domain work already bound to a mutation owner. */
export function readOwnedCanonPage(io: CanonIo, relPath: string) {
  if (canonFilesFor(io) === undefined) throw new VaultMutationError("mutation_scope_invalid");
  return readPage(io, relPath);
}

export function requireCanonFiles(scope: VaultMutationScope, io: CanonIo): CanonFiles {
  assertVaultMutationScope(scope, io);
  const owner = owners.get(io);
  if (owner === undefined || owner.scope !== scope) throw new VaultMutationError("mutation_scope_invalid");
  assertCanonFiles(owner.files, io.vault_path);
  return owner.files;
}

/** Capture the selected database/root and optional services once per operation. */
export function snapshotCanonIo(io: CanonIo): CanonIo {
  const { db, vault_path, now, ids, retrieval, retrieval_store } = io;
  const captured = Object.freeze({
    db, vault_path: resolve(vault_path),
    ...(now === undefined ? {} : { now }),
    ...(ids === undefined ? {} : { ids }),
    ...(retrieval === undefined ? {} : { retrieval }),
    ...(retrieval_store === undefined ? {} : { retrieval_store }),
  });
  const owner = owners.get(io);
  return owner === undefined ? captured : bindCanonFiles(owner.scope, captured, owner.files);
}

/** Callers snapshot their full operation input before acquiring the writer. */
export function withCanonMutationSync<T extends CanonIo, R>(io: T, work: (scope: VaultMutationScope, io: T) => PromiseLike<R>): Promise<R>;
export function withCanonMutationSync<T extends CanonIo, R>(io: T, work: (scope: VaultMutationScope, io: T) => R): R;
export function withCanonMutationSync<T extends CanonIo, R>(io: T, work: (scope: VaultMutationScope, io: T) => R | PromiseLike<R>): R | PromiseLike<R> {
  return withVaultMutationSync(io, scope => withMutationFilesSync(scope, io, files => work(scope, bindCanonFiles(scope, io, files))));
}

export function withCanonMutationAsync<T extends CanonIo, R>(
  io: T,
  work: (scope: VaultMutationScope, io: T) => R | PromiseLike<R>,
): Promise<R> {
  return withVaultMutationAsync(io, scope => withMutationFilesAsync(scope, io, files => work(scope, bindCanonFiles(scope, io, files))));
}
