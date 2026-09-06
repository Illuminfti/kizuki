import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryWriteFlock } from "../../src/serve/flock";
import {
  assertVaultMutationScope,
  VaultMutationError,
  withVaultMutationAsync,
  withVaultMutationSync,
} from "../../src/vault/mutation-scope";
import type { VaultMutationScope, VaultMutationTarget } from "../../src/vault/mutation-scope";

const fixtures: { vault_path: string; db: Database }[] = [];

function fixture() {
  const target = { vault_path: mkdtempSync(join(tmpdir(), "kizuki-mutation-scope-")), db: new Database(":memory:") };
  fixtures.push(target);
  return target;
}

afterEach(() => {
  for (const target of fixtures.splice(0)) {
    target.db.close(true);
    rmSync(target.vault_path, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function expectBusy(target: VaultMutationTarget): void {
  expect(tryWriteFlock(target.vault_path)).toBeNull();
  expect(() => withVaultMutationSync(target, () => { throw new Error("busy callback must not run"); }))
    .toThrow(new VaultMutationError("writer_busy"));
}

function expectReleased(target: VaultMutationTarget): void {
  const lock = tryWriteFlock(target.vault_path);
  expect(lock).not.toBeNull();
  lock?.release();
}

describe("internal vault mutation ownership", () => {
  test("sync work carries a live nested scope and returns its original result", () => {
    const target = fixture();
    let completed!: VaultMutationScope;
    const result = { receipt: "ordinary-fixture" };
    const nested = (scope: VaultMutationScope) => {
      assertVaultMutationScope(scope, target);
      expectBusy(target);
      return result;
    };
    expect(withVaultMutationSync(target, scope => {
      completed = scope;
      return nested(scope);
    })).toBe(result);
    expect(() => assertVaultMutationScope(completed, target)).toThrow(new VaultMutationError("mutation_scope_invalid"));
    expectReleased(target);
  });

  test("the root and exact database are captured once and checked at nested use", () => {
    const target = fixture();
    const other = fixture();
    const supplied = { ...target };
    withVaultMutationSync(supplied, scope => {
      supplied.vault_path = other.vault_path;
      supplied.db = other.db;
      assertVaultMutationScope(scope, { ...target, vault_path: join(target.vault_path, ".") });
      expect(() => assertVaultMutationScope(scope, supplied)).toThrow(new VaultMutationError("mutation_scope_invalid"));
      expect(() => assertVaultMutationScope(scope, { ...target, db: other.db })).toThrow(new VaultMutationError("mutation_scope_invalid"));
      expect(() => assertVaultMutationScope({ ...scope }, target)).toThrow(new VaultMutationError("mutation_scope_invalid"));
      expectBusy({ ...target, db: other.db });
      expect(withVaultMutationSync(other, own => {
        assertVaultMutationScope(own, other);
        return "independent";
      })).toBe("independent");
    });
    expectReleased(target);
    expectReleased(other);
  });

  test("file-only ownership cannot stand in for a ledger-bound scope", () => {
    const target = fixture();
    const fileOnly = { vault_path: target.vault_path };
    withVaultMutationSync(fileOnly, scope => {
      assertVaultMutationScope(scope, fileOnly);
      expect(() => assertVaultMutationScope(scope, target)).toThrow(new VaultMutationError("mutation_scope_invalid"));
    });
    withVaultMutationSync(target, scope => {
      expect(() => assertVaultMutationScope(scope, fileOnly)).toThrow(new VaultMutationError("mutation_scope_invalid"));
    });
  });

  test("sync exceptions revoke ownership and preserve the callback error", () => {
    const target = fixture();
    const failure = new Error("ordinary callback failure");
    let failed!: VaultMutationScope;
    expect(() => withVaultMutationSync(target, scope => { failed = scope; throw failure; })).toThrow(failure);
    expect(() => assertVaultMutationScope(failed, target)).toThrow(new VaultMutationError("mutation_scope_invalid"));
    expectReleased(target);
  });

  test("async ownership remains until both work and awaited cleanup settle", async () => {
    const target = fixture();
    const work = deferred<string>();
    const cleaning = deferred<void>();
    const cleanup = deferred<void>();
    let completed!: VaultMutationScope;
    const operation = withVaultMutationAsync(target, async scope => {
      completed = scope;
      try { return await work.promise; }
      finally {
        cleaning.resolve();
        await cleanup.promise;
        assertVaultMutationScope(scope, target);
      }
    });
    expectBusy(target);
    work.resolve("finished");
    await cleaning.promise;
    expectBusy(target);
    cleanup.resolve();
    expect(await operation).toBe("finished");
    expect(() => assertVaultMutationScope(completed, target)).toThrow(new VaultMutationError("mutation_scope_invalid"));
    expectReleased(target);
  });

  test("an async rejection and a synchronous throw inside the async wrapper both release", async () => {
    const target = fixture();
    const work = deferred<void>();
    const failure = new Error("ordinary async failure");
    const operation = withVaultMutationAsync(target, () => work.promise);
    const rejected = operation.then(() => null, error => error);
    expectBusy(target);
    work.reject(failure);
    expect(await rejected).toBe(failure);
    expectReleased(target);
    await expect(withVaultMutationAsync(target, () => { throw failure; })).rejects.toThrow(failure);
    expectReleased(target);
  });

  test("caller deadline completion does not shorten an owned operation", async () => {
    const target = fixture();
    const work = deferred<string>();
    const deadline = deferred<string>();
    const operation = withVaultMutationAsync(target, () => work.promise);
    const caller = Promise.race([operation, deadline.promise]);
    deadline.resolve("deadline");
    expect(await caller).toBe("deadline");
    expectBusy(target);
    work.resolve("settled later");
    expect(await operation).toBe("settled later");
    expectReleased(target);
  });

  test("a returned promise on the sync path keeps ownership through settlement", async () => {
    const target = fixture();
    const work = deferred<string>();
    let completed!: VaultMutationScope;
    const operation = withVaultMutationSync(target, scope => { completed = scope; return work.promise; });
    expectBusy(target);
    assertVaultMutationScope(completed, target);
    work.resolve("settled");
    expect(await operation).toBe("settled");
    expect(() => assertVaultMutationScope(completed, target)).toThrow(new VaultMutationError("mutation_scope_invalid"));
    expectReleased(target);
  });

  test("promise rejection on the sync path still releases ownership", async () => {
    const target = fixture();
    const work = deferred<void>();
    const failure = new Error("returned promise failed");
    const operation = withVaultMutationSync(target, () => work.promise);
    const rejected = operation.then(() => null, error => error);
    expectBusy(target);
    work.reject(failure);
    expect(await rejected).toBe(failure);
    expectReleased(target);
  });

  test("both wrappers honor an existing native holder without invoking work", async () => {
    const target = fixture();
    const lock = tryWriteFlock(target.vault_path)!;
    expect(lock).not.toBeNull();
    let calls = 0;
    try {
      expect(() => withVaultMutationSync(target, () => ++calls)).toThrow(new VaultMutationError("writer_busy"));
      await expect(withVaultMutationAsync(target, () => ++calls)).rejects.toThrow(new VaultMutationError("writer_busy"));
      expect(calls).toBe(0);
    } finally { lock.release(); }
    expectReleased(target);
  });
});
