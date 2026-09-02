import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function writeAtomic(path: string, contents: string): void {
  ensureDir(dirname(path));
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function sha256Text(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function sha256Bytes(value: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
