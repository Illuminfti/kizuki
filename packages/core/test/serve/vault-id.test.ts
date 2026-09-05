import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVaultId, readVaultId, vaultIdPath } from "../../src/serve/vault-id";

const dirs: string[] = [];

function vault(): string {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-vault-id-"));
  dirs.push(directory);
  return directory;
}

function cloneIdentity(from: string, to: string): void {
  mkdirSync(join(to, ".kizuki"), { recursive: true });
  for (const name of ["vault-id", "vault-machine"]) {
    const source = join(from, ".kizuki", name);
    try {
      writeFileSync(join(to, ".kizuki", name), readFileSync(source));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("vault identity", () => {
  test("mints once and keeps the id across restart on the same machine", () => {
    const path = vault();
    const first = ensureVaultId(path, "machine-a");
    expect(first).toMatch(/^[0-7][0-9a-hjkmnpqrstvwxyz]{25}$/);
    expect(ensureVaultId(path, "machine-a")).toBe(first);
    expect(readVaultId(path)).toBe(first);
    expect(readFileSync(vaultIdPath(path), "utf8").trim()).toBe(first);
  });

  test("a copied vault on the same machine keeps the id", () => {
    const origin = vault();
    const originId = ensureVaultId(origin, "machine-a");
    const copy = vault();
    cloneIdentity(origin, copy);
    expect(ensureVaultId(copy, "machine-a")).toBe(originId);
  });

  test("a cloned vault on a new machine remints once", () => {
    const origin = vault();
    const originId = ensureVaultId(origin, "machine-origin");
    const fork = vault();
    cloneIdentity(origin, fork);
    expect(readVaultId(fork)).toBe(originId);

    const forkId = ensureVaultId(fork, "machine-fork");
    expect(forkId).not.toBe(originId);
    expect(readVaultId(fork)).toBe(forkId);
    expect(ensureVaultId(fork, "machine-fork")).toBe(forkId);
    expect(readVaultId(origin)).toBe(originId);
  });

  test("an existing unbound id is adopted rather than rotated", () => {
    const path = vault();
    mkdirSync(join(path, ".kizuki"), { recursive: true, mode: 0o700 });
    writeFileSync(vaultIdPath(path), "01adoptedvaultid000000000001\n", { mode: 0o600 });
    expect(ensureVaultId(path, "machine-a")).toBe("01adoptedvaultid000000000001");
    expect(ensureVaultId(path, "machine-a")).toBe("01adoptedvaultid000000000001");
    const fork = vault();
    cloneIdentity(path, fork);
    expect(ensureVaultId(fork, "machine-b")).not.toBe("01adoptedvaultid000000000001");
  });

  test("a missing machine identity never rotates an existing id", () => {
    const path = vault();
    const id = ensureVaultId(path, "machine-a");
    expect(ensureVaultId(path, null)).toBe(id);
    expect(ensureVaultId(path, "")).toBe(id);
  });
});
