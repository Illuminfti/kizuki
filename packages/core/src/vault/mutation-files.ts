import { openCanonFiles, type CanonFiles } from "./canon-files";
import { assertVaultMutationScope, type VaultMutationScope, type VaultMutationTarget } from "./mutation-scope";

function promiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<T>).then === "function";
}

/** Descriptors are borrowed only while the exact enclosing mutation owner lives. */
export function withMutationFilesSync<T>(scope: VaultMutationScope, target: VaultMutationTarget, work: (files: CanonFiles) => PromiseLike<T>): Promise<T>;
export function withMutationFilesSync<T>(scope: VaultMutationScope, target: VaultMutationTarget, work: (files: CanonFiles) => T): T;
export function withMutationFilesSync<T>(
  scope: VaultMutationScope,
  target: VaultMutationTarget,
  work: (files: CanonFiles) => T | PromiseLike<T>,
): T | Promise<T> {
  assertVaultMutationScope(scope, target);
  const files = openCanonFiles(target.vault_path);
  let deferred = false;
  try {
    const result = work(files);
    if (promiseLike(result)) {
      const operation = Promise.resolve(result).finally(() => files.close());
      deferred = true;
      return operation;
    }
    return result;
  } finally {
    if (!deferred) files.close();
  }
}

export async function withMutationFilesAsync<T>(
  scope: VaultMutationScope,
  target: VaultMutationTarget,
  work: (files: CanonFiles) => T | PromiseLike<T>,
): Promise<T> {
  assertVaultMutationScope(scope, target);
  const files = openCanonFiles(target.vault_path);
  try {
    return await work(files);
  } finally {
    files.close();
  }
}
