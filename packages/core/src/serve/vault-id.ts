import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "../util/ulid";
import { VAULT_ID_PATH } from "./types";

export function vaultIdPath(vaultPath: string): string {
  return join(vaultPath, VAULT_ID_PATH);
}

export function readVaultId(vaultPath: string): string | null {
  const path = vaultIdPath(vaultPath);
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return value.length === 0 ? null : value;
}

export function ensureVaultId(vaultPath: string): string {
  const existing = readVaultId(vaultPath);
  if (existing !== null) return existing;
  const id = ulid().toLowerCase();
  const path = vaultIdPath(vaultPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${id}\n`, { flag: "wx", mode: 0o600 });
  return readVaultId(vaultPath) ?? id;
}
