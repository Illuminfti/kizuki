import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { KizukiError } from "@kizuki/core";
import { MAX_CURSOR_STORE_BYTES, MAX_CURSOR_STORE_ENTRIES } from "@kizuki/core/contracts";
import type { SessionFile } from "./files";

const CHECK_BYTES = 4096;
const HEX = /^[0-9a-f]{64}$/;
/** Hashes and counters only: never persist transcript text or working directories. */
export type FileOffset = [identity: string, prefix: string, tail: string, offset: number, line: number, size: number, mtime: number, headless: boolean];
export const fileKey = (relpath: string): string => createHash("sha256").update(relpath).digest("hex");
const identity = (info: Stats): string => fileKey(`${info.dev}:${info.ino}:${info.birthtimeMs}`);

export function parseOffset(raw: string | undefined): FileOffset | null {
  if (raw === undefined) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new KizukiError("corrupted", "agent-sessions file offset is not valid"); }
  if (!Array.isArray(value) || value.length !== 8 ||
      !value.slice(0, 3).every((s) => typeof s === "string" && HEX.test(s)) ||
      !value.slice(3, 6).every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) ||
      typeof value[6] !== "number" || !Number.isFinite(value[6]) || value[6] < 0 ||
      typeof value[7] !== "boolean" || value[4] > value[3] || value[3] > value[5]) {
    throw new KizukiError("corrupted", "agent-sessions file offset is not valid");
  }
  return value as FileOffset;
}

async function hashRange(handle: FileHandle, start: number, length: number): Promise<string> {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(bytes, read, length - read, start + read);
    if (result.bytesRead === 0) break;
    read += result.bytesRead;
  }
  return createHash("sha256").update(bytes.subarray(0, read)).digest("hex");
}

async function hashes(handle: FileHandle, offset: number): Promise<[string, string]> {
  const length = Math.min(offset, CHECK_BYTES);
  return [await hashRange(handle, 0, length), await hashRange(handle, offset - length, length)];
}

export async function matchesOffset(handle: FileHandle, info: Stats, saved: FileOffset): Promise<boolean> {
  if (identity(info) !== saved[0] || info.size < saved[5] ||
      (info.size === saved[5] && info.mtimeMs !== saved[6])) return false;
  const [prefix, tail] = await hashes(handle, saved[3]);
  return prefix === saved[1] && tail === saved[2];
}

export async function encodeOffset(handle: FileHandle, info: Stats, offset: number, line: number, headless: boolean): Promise<string> {
  const [prefix, tail] = await hashes(handle, offset);
  return JSON.stringify([identity(info), prefix, tail, offset, line, info.size, info.mtimeMs, headless] satisfies FileOffset);
}

/** Prefer the newest files; losing an offset is safe because the ledger deduplicates a reread. */
export function boundOffsets(store: Map<string, string>, files: readonly SessionFile[], keep: string | null): void {
  const preferred = [...files].reverse().map((file) => fileKey(file.relpath));
  if (keep !== null) preferred.unshift(keep);
  const retained = new Set<string>();
  let bytes = 0;
  for (const key of preferred) {
    const value = store.get(key);
    if (value === undefined || retained.has(key)) continue;
    const size = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (retained.size >= MAX_CURSOR_STORE_ENTRIES || bytes + size > MAX_CURSOR_STORE_BYTES) continue;
    retained.add(key);
    bytes += size;
  }
  for (const key of store.keys()) if (!retained.has(key)) store.delete(key);
}

export function offsetDigest(store: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  for (const [key, value] of [...store].sort(([a], [b]) => a.localeCompare(b))) hash.update(key).update("\0").update(value).update("\0");
  return hash.digest("hex");
}
