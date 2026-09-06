import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { tryWriteFlock } from "../serve/flock";

/** Internal operation target; file-only maintenance has no ledger binding. */
export interface VaultMutationTarget {
  readonly vault_path: string;
  readonly db?: Database;
}

declare const mutationScope: unique symbol;
export interface VaultMutationScope {
  readonly [mutationScope]: true;
}

export class VaultMutationError extends Error {
  override readonly name = "VaultMutationError";

  constructor(readonly code: "writer_busy" | "mutation_target_invalid" | "mutation_scope_invalid") {
    super(code === "writer_busy" ? "canon writer is busy; retry the operation" : "vault mutation ownership is invalid");
  }
}

const active = new WeakMap<VaultMutationScope, VaultMutationTarget>();

function captureTarget(target: VaultMutationTarget): VaultMutationTarget {
  if (typeof target !== "object" || target === null) throw new VaultMutationError("mutation_target_invalid");
  const { vault_path, db } = target;
  if (typeof vault_path !== "string" || vault_path.length === 0 || vault_path.includes("\0") ||
      (db !== undefined && !(db instanceof Database))) {
    throw new VaultMutationError("mutation_target_invalid");
  }
  return Object.freeze({ vault_path: resolve(vault_path), ...(db === undefined ? {} : { db }) });
}

function acquire(target: VaultMutationTarget): { scope: VaultMutationScope; release(): void } {
  const captured = captureTarget(target);
  const lock = tryWriteFlock(captured.vault_path);
  if (lock === null) throw new VaultMutationError("writer_busy");
  const scope = Object.freeze({}) as VaultMutationScope;
  active.set(scope, captured);
  return {
    scope,
    release() {
      if (!active.delete(scope)) return;
      lock.release();
    },
  };
}

/** Nested internal work must carry the live owner for this exact root/ledger pair. */
export function assertVaultMutationScope(scope: VaultMutationScope, target: VaultMutationTarget): void {
  const owned = active.get(scope);
  if (owned === undefined) throw new VaultMutationError("mutation_scope_invalid");
  const captured = captureTarget(target);
  if (owned.vault_path !== captured.vault_path || owned.db !== captured.db) {
    throw new VaultMutationError("mutation_scope_invalid");
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<T>).then === "function";
}

/**
 * A synchronous result releases before return. If a callback returns asynchronous
 * work, ownership follows that work instead of escaping through a sync finally.
 * No caller receives the release handle or gains ambient reentrancy.
 */
export function withVaultMutationSync<T>(target: VaultMutationTarget, work: (scope: VaultMutationScope) => PromiseLike<T>): Promise<T>;
export function withVaultMutationSync<T>(target: VaultMutationTarget, work: (scope: VaultMutationScope) => T): T;
export function withVaultMutationSync<T>(
  target: VaultMutationTarget,
  work: (scope: VaultMutationScope) => T | PromiseLike<T>,
): T | Promise<T> {
  const owner = acquire(target);
  let deferred = false;
  try {
    const result = work(owner.scope);
    if (isPromiseLike(result)) {
      const operation = Promise.resolve(result).finally(() => owner.release());
      deferred = true;
      return operation;
    }
    return result;
  } finally {
    if (!deferred) owner.release();
  }
}

/** Caller deadlines must race this promise, never shorten the owned callback. */
export async function withVaultMutationAsync<T>(
  target: VaultMutationTarget,
  work: (scope: VaultMutationScope) => T | PromiseLike<T>,
): Promise<T> {
  const owner = acquire(target);
  try {
    return await work(owner.scope);
  } finally {
    owner.release();
  }
}
