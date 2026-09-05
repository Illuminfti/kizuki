import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function writeAtomic(path: string, contents: string): void {
  const parent = dirname(path);
  ensureDir(parent);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, contents); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const directory = openSync(parent, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { rmSync(temporary, { force: true }); }
}

export function sha256Text(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function sha256Bytes(value: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
