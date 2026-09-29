import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { MAX_RELPATH_CHARS } from "./cursor";

/**
 * The transcript tree is hostile input: it can hold a link out of the root, a
 * pipe, a file of any size and a line of any length. Every dimension is bounded
 * and every refusal is counted rather than swallowed.
 */

const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 4;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const SUBAGENT_DIRECTORY = "subagents";

/** Never follow a link, and never block on a pipe left in the tree. */
const OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface SessionFile {
  absolute: string;
  /** Forward slashes, relative to the root. */
  relpath: string;
  mtime_ms: number;
}

export type Counters = Record<string, number>;

export function count(counters: Counters, key: string, n = 1): void {
  counters[key] = (counters[key] ?? 0) + n;
}

export interface Listing {
  files: SessionFile[];
  skipped: Counters;
}

/** The canonical root, or null when it is not a readable directory. */
export async function resolveRoot(configured: string): Promise<string | null> {
  try {
    const root = await realpath(configured);
    return (await stat(root)).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/** Every `.jsonl` file below `root`, ordered by (mtime, relpath). */
export async function listSessionFiles(
  root: string,
  includeSubagents: boolean,
): Promise<Listing> {
  const files: SessionFile[] = [];
  const skipped: Counters = {};
  let considered = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      count(skipped, "unreadable");
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (considered >= MAX_ENTRIES) {
        count(skipped, "too_many_entries");
        return;
      }
      considered += 1;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        count(skipped, "symlink");
      } else if (entry.isDirectory()) {
        if (entry.name === SUBAGENT_DIRECTORY && !includeSubagents) continue;
        if (depth >= MAX_DEPTH) count(skipped, "depth");
        else {
          // The listing is a snapshot: descend where the entry really is, and
          // only if that is still inside the root.
          const inside = await realpath(absolute).catch(() => null);
          if (inside !== null && inside.startsWith(`${root}${path.sep}`)) await walk(inside, depth + 1);
          else count(skipped, "symlink");
        }
      } else if (entry.name.endsWith(".jsonl")) {
        if (!entry.isFile()) {
          count(skipped, "not_regular");
          continue;
        }
        const relpath = path.relative(root, absolute).split(path.sep).join("/");
        if (relpath.length > MAX_RELPATH_CHARS) {
          count(skipped, "name_too_long");
          continue;
        }
        try {
          files.push({
            absolute,
            relpath,
            mtime_ms: Math.floor((await stat(absolute)).mtimeMs),
          });
        } catch {
          count(skipped, "unreadable");
        }
      }
    }
  };

  await walk(root, 0);
  files.sort((a, b) =>
    a.mtime_ms !== b.mtime_ms
      ? a.mtime_ms - b.mtime_ms
      : a.relpath < b.relpath
        ? -1
        : a.relpath > b.relpath
          ? 1
          : 0,
  );
  return { files, skipped };
}

/** Opens a regular file inside the size cap, or names why it was refused. */
export async function openSessionFile(
  absolute: string,
): Promise<{ handle: FileHandle } | { reason: string }> {
  let handle: FileHandle;
  try {
    handle = await open(absolute, OPEN_FLAGS);
  } catch (error) {
    return {
      reason:
        (error as { code?: unknown }).code === "ELOOP"
          ? "symlink"
          : "unreadable",
    };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > MAX_FILE_BYTES) {
      await handle.close();
      return { reason: "too_large" };
    }
    return { handle };
  } catch {
    await handle.close();
    return { reason: "not_regular" };
  }
}

export interface FileLine {
  /** 1-based. */
  line: number;
  /** Bytes of the line including its terminator. */
  bytes: number;
  /** Null when the line exceeded MAX_LINE_BYTES and was discarded. */
  text: string | null;
}

/**
 * Newline-terminated lines of an open file. Line 1 and every line after
 * `skipLines` are yielded; the lines between are counted and never decoded.
 * An unterminated final line is a write in progress and is left for the next
 * pass.
 */
export async function* readLines(
  handle: FileHandle,
  skipLines: number,
): AsyncGenerator<FileLine> {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let parts: Buffer[] = [];
  let lineBytes = 0;
  let oversized = false;
  let line = 0;
  let position = 0;
  while (position < MAX_FILE_BYTES) {
    const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    const view = chunk.subarray(0, bytesRead);
    let start = 0;
    while (start < bytesRead) {
      const newline = view.indexOf(0x0a, start);
      const end = newline === -1 ? bytesRead : newline;
      const wanted = line === 0 || line + 1 > skipLines;
      lineBytes += end - start;
      if (wanted && !oversized) {
        if (lineBytes > MAX_LINE_BYTES) {
          oversized = true;
          parts = [];
        } else parts.push(Buffer.from(view.subarray(start, end)));
      }
      if (newline === -1) break;
      line += 1;
      if (line === 1 || line > skipLines) {
        yield {
          line,
          bytes: lineBytes + 1,
          text: oversized ? null : Buffer.concat(parts).toString("utf8"),
        };
      }
      parts = [];
      lineBytes = 0;
      oversized = false;
      start = newline + 1;
    }
  }
}
