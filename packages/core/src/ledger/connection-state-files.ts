import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { LedgerError } from "./connections";

type ChunkWriter = (
  fd: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
) => number;

const writeChunk: ChunkWriter = (fd, bytes, offset, length) =>
  writeSync(fd, bytes, offset, length);

const CORE_ULID_PATTERN = "[0-9A-HJKMNPQRSTVWXYZ]{26}";
const STAGING_NAME = new RegExp(
  `^${CORE_ULID_PATTERN}\\.state\\.${CORE_ULID_PATTERN}\\.tmp$`,
);
/**
 * A staging file younger than this may belong to a writer another process is
 * running right now; only an older one is certainly the debris of a crash.
 * The bound is well past the five minutes a browser sign-in is given, because
 * sweeping a live writer's file costs the owner a grant they already made.
 */
const ABANDONED_STAGING_MS = 1_800_000;

const CORE_ULID = new RegExp(`^${CORE_ULID_PATTERN}$`);

export function isCoreUlid(value: string): boolean {
  return CORE_ULID.test(value);
}

export function stateRefFor(sourceKey: string): string {
  return `file:connections/${sourceKey}.state`;
}

export function connectionStatePath(directory: string, ref: string): string {
  if (!ref.startsWith("file:connections/") || !ref.endsWith(".state")) {
    throw new LedgerError("connection state ref is invalid");
  }
  const path = resolve(dirname(directory), ref.slice("file:".length));
  if (dirname(path) !== resolve(directory) || relative(directory, path).startsWith("..")) {
    throw new LedgerError("connection state ref escapes the store");
  }
  return path;
}

/** Internal test seam; this module is not re-exported from the public package. */
export function writeAll(
  fd: number,
  bytes: Uint8Array,
  writer: ChunkWriter = writeChunk,
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writer(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) {
      throw new LedgerError("connection state write made no progress");
    }
    offset += written;
  }
}

export function writeDurableFile(path: string, bytes: Uint8Array): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd);
      fd = undefined;
    }
    rmSync(path, { force: true });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Staging files hold the same plaintext the durable file does. A writer that
 * was killed between its write and its swap leaves one behind, and nothing
 * else in the tree ever removes it. `owned` is the set the calling store is
 * still writing, so recovery never takes a file out from under itself.
 */
export function sweepAbandonedStaging(
  directory: string,
  owned: ReadonlySet<string>,
): void {
  const now = Date.now();
  let removed = false;
  for (const name of readdirSync(directory)) {
    if (!STAGING_NAME.test(name)) continue;
    const path = join(directory, name);
    if (owned.has(path)) continue;
    let age: number;
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      // Swapped or swept by another writer between the listing and this stat.
      continue;
    }
    if (age < ABANDONED_STAGING_MS) continue;
    rmSync(path, { force: true });
    removed = true;
  }
  if (removed) fsyncDirectory(directory);
}

export interface StagedSwap {
  /** Where the durable bytes must end up. */
  finalPath: string;
  /** The 0600 sibling holding the bytes that are replacing them. */
  stagingPath: string;
  /** Where the bytes being replaced wait until the row commits. */
  backupPath: string | null;
  journalPath: string;
  journalBytes: Uint8Array;
}

/**
 * Journal first, then keep the old bytes, then move the new ones in. The order
 * is what lets recovery tell a finished swap from an interrupted one.
 */
export function swapStateFile(directory: string, swap: StagedSwap): void {
  writeDurableFile(swap.journalPath, swap.journalBytes);
  fsyncDirectory(directory);
  if (swap.backupPath !== null) renameSync(swap.finalPath, swap.backupPath);
  try {
    renameSync(swap.stagingPath, swap.finalPath);
  } catch (error) {
    // A recovery sweep in another process can remove a staging file this one
    // still owns. The raw failure names the control directory, and a caller of
    // this store never receives a filesystem path.
    throw new LedgerError("connection state staging is missing", {
      cause: error,
    });
  }
  fsyncDirectory(directory);
}

/** Puts back whatever a swap moved, however far through it got. */
export function restoreStateFile(
  directory: string,
  paths: {
    finalPath: string;
    stagingPath: string | null;
    backupPath: string | null;
    journalPath: string | null;
    swapped: boolean;
  },
): void {
  if (paths.swapped) rmSync(paths.finalPath, { force: true });
  if (paths.backupPath !== null && existsSync(paths.backupPath)) {
    renameSync(paths.backupPath, paths.finalPath);
  }
  if (paths.stagingPath !== null) rmSync(paths.stagingPath, { force: true });
  if (paths.journalPath !== null) rmSync(paths.journalPath, { force: true });
  fsyncDirectory(directory);
}

/** Drops the rollback copy and the journal a committed swap no longer needs. */
export function clearSwapDebris(
  directory: string,
  paths: { backupPath: string | null; journalPath: string | null },
): void {
  if (paths.backupPath === null && paths.journalPath === null) return;
  if (paths.backupPath !== null) rmSync(paths.backupPath, { force: true });
  if (paths.journalPath !== null) rmSync(paths.journalPath, { force: true });
  fsyncDirectory(directory);
}
