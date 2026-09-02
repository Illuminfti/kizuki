import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { KizukiError } from "../errors";
import { compareStrings, errorMessage } from "../util";
import { matchesGlob, sanitizeLine } from "../legacy/coerce";
import { LEGACY_WIKI_CONNECTOR_ID } from "./mapping";

/**
 * A wiki directory is hostile input: it can contain a symlink out of the tree,
 * a file that is not text at all, and more files than memory. Every dimension
 * is bounded and every refusal is reported rather than swallowed.
 */

export const MAX_FILES = 50_000;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_DEPTH = 16;
export const MAPPING_FILE_NAME = "kizuki-mapping.json";

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

export interface ScanResult {
  files: LegacyWikiFile[];
  skipped: { relpath: string; reason: SkipReason }[];
  /** MAX_FILES was reached; the import is a prefix of the wiki. */
  truncated: boolean;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

interface Walk {
  root: string;
  ignore: string[];
  files: LegacyWikiFile[];
  skipped: { relpath: string; reason: SkipReason }[];
  truncated: boolean;
}

function relative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function skip(walk: Walk, relpath: string, reason: SkipReason): void {
  // File names come from the source and are shown in a report and a terminal.
  walk.skipped.push({ relpath: sanitizeLine(relpath, 200), reason });
}

async function readEntry(
  walk: Walk,
  absolute: string,
  relpath: string,
): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch {
    skip(walk, relpath, "unreadable");
    return;
  }
  if (info.size > MAX_FILE_BYTES) {
    skip(walk, relpath, "too_large");
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    skip(walk, relpath, "unreadable");
    return;
  }
  let content: string;
  try {
    content = utf8.decode(bytes);
  } catch {
    // A page Kizuki cannot decode is not a page it can honestly import.
    skip(walk, relpath, "not_utf8");
    return;
  }
  walk.files.push({ relpath, content, mtimeMs: info.mtimeMs, size: info.size });
}

async function walkDirectory(
  walk: Walk,
  directory: string,
  depth: number,
): Promise<void> {
  if (walk.truncated) return;
  if (depth > MAX_DEPTH) {
    skip(walk, relative(walk.root, directory), "depth");
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => compareStrings(a.name, b.name));
  for (const entry of entries) {
    if (walk.truncated) return;
    // Dot entries hold tool state, not pages, and the mapping file is input.
    if (entry.name.startsWith(".") || entry.name === MAPPING_FILE_NAME)
      continue;
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
        skip(walk, relpath, "ignored");
        continue;
      }
      await walkDirectory(walk, absolute, depth + 1);
      continue;
    }
    if (!entry.isFile() || !MARKDOWN.test(entry.name)) continue;
    if (walk.ignore.some((pattern) => matchesGlob(relpath, pattern))) {
      skip(walk, relpath, "ignored");
      continue;
    }
    if (walk.files.length >= MAX_FILES) {
      walk.truncated = true;
      return;
    }
    await readEntry(walk, absolute, relpath);
  }
}

export async function scanLegacyWiki(
  root: string,
  ignore: string[],
): Promise<ScanResult> {
  const walk: Walk = { root, ignore, files: [], skipped: [], truncated: false };
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new KizukiError(
        "misconfigured",
        `${LEGACY_WIKI_CONNECTOR_ID}: path is not a directory: ${root}`,
      );
    }
    await walkDirectory(walk, root, 0);
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
