import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { LedgerError } from "./connections";
import { isUlid, ULID_PATTERN } from "../util/ulid";

export const MAX_CONNECTION_STATE_BYTES = 1024 * 1024;
export const MAX_JOURNAL_BYTES = 16 * 1024;

type ChunkWriter = (
  fd: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
) => number;

const writeChunk: ChunkWriter = (fd, bytes, offset, length) =>
  writeSync(fd, bytes, offset, length);

const STAGING_NAME = new RegExp(
  `^${ULID_PATTERN}\\.state\\.${ULID_PATTERN}\\.tmp$`,
);
const JOURNAL_NAME = new RegExp(
  `^(${ULID_PATTERN})\\.state\\.${ULID_PATTERN}\\.journal$`,
);
/**
 * A staging file younger than this may belong to a writer another process is
 * running right now; only an older one is certainly the debris of a crash.
 * The bound is well past the five minutes a browser sign-in is given, because
 * sweeping a live writer's file costs the owner a grant they already made.
 */
const ABANDONED_STAGING_MS = 1_800_000;

export function isCoreUlid(value: string): boolean {
  return isUlid(value);
}

/** Source key a swap journal filename locks, or null when it cannot bind one. */
export function journalSourceKey(name: string): string | null {
  return JOURNAL_NAME.exec(name)?.[1] ?? null;
}

/** Journal witnesses for this source in the store or its quarantine. */
export function sourceJournalNames(directory: string, sourceKey: string): string[] {
  const prefix = `${sourceKey}.state.`;
  const match = (name: string): boolean =>
    name.startsWith(prefix) && name.endsWith(".journal");
  const found = readdirSync(directory).filter(match);
  const quarantine = join(directory, "quarantine");
  if (existsSync(quarantine)) {
    found.push(...readdirSync(quarantine).filter(match));
  }
  return found;
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

export function assertContainedPath(path: string, directory: string): void {
  const realDir = realpathSync(directory);
  let realFile: string;
  try {
    realFile = realpathSync(path);
  } catch {
    realFile = resolve(path);
  }
  if (realFile !== realDir && !realFile.startsWith(realDir + sep)) {
    throw new LedgerError("connection state ref escapes the store");
  }
}

export function assertRegularStateFile(path: string, directory: string): Stats {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new LedgerError("connection state is missing");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new LedgerError("connection state is not a regular file");
  }
  assertContainedPath(path, directory);
  return stats;
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
  // Cleanup belongs to this call only after exclusive creation succeeds.
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
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
  options: { abandonAfterMs?: number } = {},
): void {
  const now = Date.now();
  const abandonAfterMs = options.abandonAfterMs ?? ABANDONED_STAGING_MS;
  let removed = false;
  for (const name of readdirSync(directory)) {
    if (!STAGING_NAME.test(name) && !name.endsWith(".rollback")) continue;
    if (name === "quarantine") continue;
    const path = join(directory, name);
    if (owned.has(path)) continue;
    let age: number;
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
        rmSync(path, { force: true });
        removed = true;
        continue;
      }
      if (!stats.isFile()) continue;
      age = now - stats.mtimeMs;
    } catch {
      // Swapped or swept by another writer between the listing and this stat.
      continue;
    }
    if (age < abandonAfterMs) continue;
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
}

/**
 * The caller owns a durable journal before entering this swap. Flush its
 * directory entry before moving bytes so recovery can identify an interrupted
 * swap even when the first rename fails.
 */
export function swapStateFile(directory: string, swap: StagedSwap): void {
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

/**
 * Drops the rollback copy and the journal a committed swap no longer needs.
 * The row and the durable file are both committed by the time this runs, so
 * nothing here may throw: a file it cannot remove is debris the next
 * `recover()` clears from the journal, while raising would report failure for
 * a swap that landed and leave the caller holding a connection the store has
 * already moved past.
 */
export function clearSwapDebris(
  directory: string,
  paths: { backupPath: string | null; journalPath: string | null },
): void {
  let removed = false;
  for (const path of [paths.backupPath, paths.journalPath]) {
    if (path === null) continue;
    try {
      rmSync(path, { force: true });
      removed = true;
    } catch {
      // Left for recovery; the swap it belonged to is already durable.
    }
  }
  if (!removed) return;
  try {
    fsyncDirectory(directory);
  } catch {
    // Same: the removals are visible to this process either way, and the
    // journal is what makes an unflushed directory entry recoverable.
  }
}
