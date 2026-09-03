import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { KizukiError } from "../errors";
import { compareStrings, errorMessage } from "../util";
import { matchesGlob } from "../legacy/coerce";
import { MAPPING_FILE_NAME } from "../legacy/mapping-file";
import { LEGACY_WIKI_CONNECTOR_ID } from "./mapping";

/**
 * A wiki directory is hostile input: it can contain a symlink out of the tree,
 * a file that is not text at all, and more files than memory. Every dimension
 * is bounded and every refusal is reported rather than swallowed.
 */

/** Entries the walk will consider at all, not only the ones it keeps. */
const MAX_FILES = 50_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 16;

const MARKDOWN = /\.(?:md|markdown)$/i;

export type SkipReason =
  "symlink" | "not_utf8" | "too_large" | "unreadable" | "ignored" | "depth";

export interface LegacyWikiFile {
  /** Forward slashes, relative to the root. */
  relpath: string;
  content: string;
  mtimeMs: number;
  size: number;
}

export interface Skipped {
  relpath: string;
  reason: SkipReason;
  /** A directory the walk did not enter hides every page beneath it, so a
   * caller comparing against a snapshot cannot call any of them deleted. */
  kind: "file" | "directory";
}

export interface ScanResult {
  files: LegacyWikiFile[];
  skipped: Skipped[];
  /** MAX_FILES was reached; the import is a prefix of the wiki. */
  truncated: boolean;
}

/**
 * Never follow: the directory listing said this was a regular file, but the
 * entry can be replaced between the listing and the open, and a link out of
 * the wiki is a traversal. Non-blocking so a pipe left in the tree cannot hold
 * the walk open waiting for a writer.
 */
const OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type FileRead =
  { file: Omit<LegacyWikiFile, "relpath"> } | { reason: SkipReason };

const utf8 = new TextDecoder("utf-8", { fatal: true });

interface Walk {
  root: string;
  ignore: string[];
  files: LegacyWikiFile[];
  skipped: Skipped[];
  /** Every directory entry looked at, so a flood of skips is bounded too. */
  considered: number;
  truncated: boolean;
}

function relative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function skip(
  walk: Walk,
  relpath: string,
  reason: SkipReason,
  kind: "file" | "directory" = "file",
): void {
  // The raw relpath: a caller has to be able to match a skip against a cursor
  // snapshot exactly. The report layer is what makes a hostile name safe to
  // print.
  walk.skipped.push({ relpath, reason, kind });
}

/**
 * One page, read from a descriptor the walk opened itself. Every bound is
 * checked against that descriptor rather than against an earlier `stat`, so a
 * file swapped for a link, replaced by a directory, or grown mid-read cannot
 * get past the limits the walk promises.
 */
export async function readWikiFile(absolute: string): Promise<FileRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, OPEN_FLAGS);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { reason: code === "ELOOP" ? "symlink" : "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { reason: "unreadable" };
    if (info.size > MAX_FILE_BYTES) return { reason: "too_large" };
    // One byte past what the descriptor just reported: enough to notice that
    // the file grew, never enough to read an unbounded one.
    const buffer = Buffer.alloc(info.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      // A single read may stop short of what was asked for; a page cut off
      // there would import as a silent prefix of itself.
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > MAX_FILE_BYTES) return { reason: "too_large" };
    if (filled > info.size) return { reason: "unreadable" };
    let content: string;
    try {
      content = utf8.decode(buffer.subarray(0, filled));
    } catch {
      // A page Kizuki cannot decode is not a page it can honestly import.
      return { reason: "not_utf8" };
    }
    return { file: { content, mtimeMs: info.mtimeMs, size: filled } };
  } catch {
    return { reason: "unreadable" };
  } finally {
    await handle.close();
  }
}

async function readEntry(
  walk: Walk,
  absolute: string,
  relpath: string,
): Promise<void> {
  const result = await readWikiFile(absolute);
  if ("reason" in result) {
    skip(walk, relpath, result.reason);
    return;
  }
  walk.files.push({ relpath, ...result.file });
}

/**
 * Where a directory entry really is, or null when that is outside the wiki.
 * The listing's entry type is a snapshot: between `readdir` and the call that
 * enters a subdirectory, the entry can be replaced by a link, and every open
 * below it would then be relative to a tree the walk never agreed to read.
 * Descending the resolved path means each level was checked as it was taken.
 */
export async function confinedDirectory(
  root: string,
  absolute: string,
): Promise<string | null> {
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch {
    return null;
  }
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
    ? resolved
    : null;
}

async function walkDirectory(
  walk: Walk,
  directory: string,
  depth: number,
): Promise<void> {
  if (walk.truncated) return;
  if (depth > MAX_DEPTH) {
    skip(walk, relative(walk.root, directory), "depth", "directory");
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // One directory the owner cannot read is a reported gap, not a reason to
    // abandon the rest of the estate. The root is different: a wiki that
    // cannot be listed at all is a misconfiguration, and the caller is told.
    if (depth === 0) throw error;
    skip(walk, relative(walk.root, directory), "unreadable", "directory");
    return;
  }
  entries.sort((a, b) => compareStrings(a.name, b.name));
  for (const entry of entries) {
    if (walk.truncated) return;
    // Dot entries hold tool state, not pages, and the mapping file is input.
    if (entry.name.startsWith(".") || entry.name === MAPPING_FILE_NAME)
      continue;
    if (walk.considered >= MAX_FILES) {
      walk.truncated = true;
      return;
    }
    walk.considered += 1;
    const absolute = path.join(directory, entry.name);
    const relpath = relative(walk.root, absolute);
    if (entry.isSymbolicLink()) {
      // Never followed: a link out of the wiki is a traversal, and a link
      // inside it is a second copy of a page already being imported.
      skip(walk, relpath, "symlink");
      continue;
    }
    if (entry.isDirectory()) {
      if (walk.ignore.some((pattern) => matchesGlob(relpath, pattern))) {
        skip(walk, relpath, "ignored", "directory");
        continue;
      }
      const inside = await confinedDirectory(walk.root, absolute);
      if (inside === null) {
        skip(walk, relpath, "symlink", "directory");
        continue;
      }
      await walkDirectory(walk, inside, depth + 1);
      continue;
    }
    if (!entry.isFile() || !MARKDOWN.test(entry.name)) continue;
    if (walk.ignore.some((pattern) => matchesGlob(relpath, pattern))) {
      skip(walk, relpath, "ignored");
      continue;
    }
    await readEntry(walk, absolute, relpath);
  }
}

export async function scanLegacyWiki(
  root: string,
  ignore: string[],
): Promise<ScanResult> {
  const walk: Walk = {
    // Canonical, so containment below is decided against where the wiki
    // really is rather than against the name the owner typed.
    root,
    ignore,
    files: [],
    skipped: [],
    considered: 0,
    truncated: false,
  };
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new KizukiError(
        "misconfigured",
        `${LEGACY_WIKI_CONNECTOR_ID}: path is not a directory: ${root}`,
      );
    }
    walk.root = await realpath(root);
    await walkDirectory(walk, walk.root, 0);
  } catch (error) {
    if (error instanceof KizukiError) throw error;
    throw new KizukiError(
      "misconfigured",
      `${LEGACY_WIKI_CONNECTOR_ID}: cannot read ${root}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  walk.files.sort((a, b) => compareStrings(a.relpath, b.relpath));
  walk.skipped.sort((a, b) => compareStrings(a.relpath, b.relpath));
  return {
    files: walk.files,
    skipped: walk.skipped,
    truncated: walk.truncated,
  };
}
