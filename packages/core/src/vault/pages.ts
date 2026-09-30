import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { hashBytes } from "./write";
import { parseFrontmatter } from "./frontmatter";
import { validatePage } from "./schema";
import { canonLimitsFor, DEFAULT_LIVE_PAGE_CEILING, loadCanonLimits, type CanonLimits } from "./canon-limits";

export const MAX_CANON_PAGE_BYTES = 1_048_576;
export const MAX_CANON_DEPTH = 8;
/** Default resource budgets; each vault can configure its own scan limits. */
export const MAX_CANON_PAGES = canonLimitsFor(DEFAULT_LIVE_PAGE_CEILING).walk_files;
export const MAX_CANON_WALK_BYTES = canonLimitsFor(DEFAULT_LIVE_PAGE_CEILING).walk_bytes;

export const SCAN_FAILURE_CODES = [
  "parse",
  "invalid",
  "duplicate",
  "oversize",
  "too_deep",
  "too_many",
  "unreadable",
] as const;
export type ScanFailureCode = (typeof SCAN_FAILURE_CODES)[number];

export interface CanonPage {
  id: string;
  path: string;
  relPath: string;
  data: Record<string, unknown>;
  body: string;
  /** Hash of the exact bytes read for this snapshot; never frontmatter. */
  contentHash: string;
}

export interface SkippedPage {
  relPath: string;
  reason: string;
  code: ScanFailureCode;
}

/**
 * What a walk learned from one file's bytes, remembered against the file's
 * stat signature so an unchanged file is not read and parsed again.
 */
interface ParsedFile {
  signature: string;
  contentHash: string;
  data: Record<string, unknown>;
  body: string;
  /** First schema error, so an unchanged file is not validated again. */
  invalid: string | null;
}

/**
 * A caller-owned memo of parsed pages for one vault. It is a speed-up only:
 * a walk with and without it returns the same report.
 */
export interface CanonPageCache {
  files: Map<string, ParsedFile>;
}

export function createCanonPageCache(): CanonPageCache {
  return { files: new Map() };
}

/**
 * A file changed within this window of being read may change again in the
 * same filesystem timestamp tick and keep its size, which its stat signature
 * cannot show. Such a file is read again on the next walk.
 */
const RACY_WINDOW_MS = 2_000;

export interface CanonPageReport {
  pages: CanonPage[];
  skipped: SkippedPage[];
  truncated: boolean;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

/** Live canon only. Draft and archived pages are absent from derived layers. */
export function isLiveCanonPage(page: CanonPage): boolean {
  return page.data["status"] === "active";
}

function compareName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fsCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)) return code;
  }
  return "EIO";
}

function skip(relPath: string, code: ScanFailureCode, reason: string): SkippedPage {
  return { relPath, reason, code };
}

function isCanonPagePath(relPath: string): boolean {
  return relPath.endsWith(".md") && relPath !== "CANON.md" && relPath !== "SCHEMA.md";
}

interface WalkState {
  pages: CanonPage[];
  skipped: SkippedPage[];
  /** First path that claimed this frontmatter id, valid or not. */
  seen: Map<string, string>;
  files: number;
  bytes: number;
  limits: CanonLimits;
  truncated: boolean;
  cache: CanonPageCache | null;
  /** Files remembered by this walk; replaces the cache when the walk ends. */
  remembered: Map<string, ParsedFile>;
}

function withholdDuplicate(
  state: WalkState,
  id: string,
  firstPath: string,
  relPath: string,
): void {
  state.pages = state.pages.filter((entry) => entry.id !== id);
  state.skipped = state.skipped.filter(
    (entry) => !(entry.relPath === firstPath && entry.code === "invalid"),
  );
  if (!state.skipped.some((entry) => entry.relPath === firstPath && entry.code === "duplicate")) {
    state.skipped.push(
      skip(firstPath, "duplicate", `duplicate id "${id}"; also at ${relPath}`),
    );
  }
  state.skipped.push(
    skip(relPath, "duplicate", `duplicate id "${id}"; first seen at ${firstPath}`),
  );
}

function considerFile(state: WalkState, path: string, relPath: string): void {
  if (state.truncated) return;
  if (state.files >= state.limits.walk_files) {
    state.truncated = true;
    state.skipped.push(
      skip(".", "too_many", `vault exceeds ${state.limits.walk_files} markdown files; raise max_scan_files under [canon] in .kizuki/serve.toml`),
    );
    return;
  }
  state.files += 1;

  let size: number;
  let signature: string;
  let changedMs: number;
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      state.skipped.push(skip(relPath, "unreadable", "unreadable: not a regular file"));
      return;
    }
    size = Number(stat.size);
    changedMs = Number((stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs) / 1_000_000n);
    signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    state.skipped.push(skip(relPath, "unreadable", `unreadable: ${fsCode(error)}`));
    return;
  }

  if (size > MAX_CANON_PAGE_BYTES) {
    state.skipped.push(
      skip(relPath, "oversize", `exceeds ${MAX_CANON_PAGE_BYTES} bytes`),
    );
    return;
  }
  if (state.bytes + size > state.limits.walk_bytes) {
    state.truncated = true;
    state.skipped.push(
      skip(relPath, "too_many", `vault exceeds ${state.limits.walk_bytes} scanned bytes; raise max_scan_bytes under [canon] in .kizuki/serve.toml`),
    );
    return;
  }

  const remembered = state.cache?.files.get(path);
  let file: ParsedFile;
  if (remembered?.signature === signature) {
    file = remembered;
    state.bytes += size;
  } else {
    const readAtMs = Date.now();
    try {
      const bytes = readFileSync(path);
      state.bytes += bytes.byteLength;
      const parsed = parseFrontmatter(bytes.toString("utf8"));
      file = {
        // An empty signature never matches: see RACY_WINDOW_MS.
        signature: changedMs + RACY_WINDOW_MS > readAtMs ? "" : signature,
        contentHash: hashBytes(bytes),
        data: parsed.data,
        body: parsed.body,
        invalid: validatePage(parsed.data)[0] ?? null,
      };
    } catch (error) {
      if (error instanceof SyntaxError) {
        state.skipped.push(skip(relPath, "parse", error.message));
        return;
      }
      state.skipped.push(skip(relPath, "unreadable", `unreadable: ${fsCode(error)}`));
      return;
    }
  }
  // A remembered file hands out a copy: no caller can change what the next
  // walk is given.
  const parsed = state.cache === null
    ? file
    : { data: structuredClone(file.data), body: file.body };
  if (state.cache !== null && file.signature !== "") state.remembered.set(path, file);
  const { contentHash } = file;

  const rawId = parsed.data["id"];
  const id = typeof rawId === "string" && rawId.length > 0 ? rawId : null;
  if (id !== null) {
    const firstPath = state.seen.get(id);
    if (firstPath !== undefined) {
      withholdDuplicate(state, id, firstPath, relPath);
      return;
    }
    state.seen.set(id, relPath);
  }

  if (file.invalid !== null) {
    state.skipped.push(skip(relPath, "invalid", file.invalid));
    return;
  }
  if (id === null) {
    state.skipped.push(skip(relPath, "invalid", "id: must be a non-empty string"));
    return;
  }

  state.pages.push({
    id,
    path,
    relPath,
    data: parsed.data,
    body: parsed.body,
    contentHash,
  });
}

function walk(state: WalkState, directory: string, vaultPath: string, depth: number): void {
  if (state.truncated) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      compareName(a.name, b.name),
    );
  } catch (error) {
    const relPath = relative(vaultPath, directory).split(sep).join("/") || ".";
    state.skipped.push(skip(relPath, "unreadable", `unreadable: ${fsCode(error)}`));
    return;
  }

  for (const entry of entries) {
    if (state.truncated) return;
    if (depth === 0 && (entry.name === ".kizuki" || entry.name === "archive")) continue;
    const target = join(directory, entry.name);
    const relPath = relative(vaultPath, target).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      if (isCanonPagePath(relPath)) {
        if (depth + 1 > MAX_CANON_DEPTH) {
          state.skipped.push(
            skip(relPath, "too_deep", `exceeds ${MAX_CANON_DEPTH} path segments`),
          );
        } else {
          considerFile(state, target, relPath);
        }
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (depth >= MAX_CANON_DEPTH) {
        state.skipped.push(
          skip(relPath, "too_deep", `exceeds ${MAX_CANON_DEPTH} path segments`),
        );
        continue;
      }
      walk(state, target, vaultPath, depth + 1);
      continue;
    }
    if (!entry.isFile() || !isCanonPagePath(relPath)) {
      continue;
    }
    if (depth + 1 > MAX_CANON_DEPTH) {
      state.skipped.push(
        skip(relPath, "too_deep", `exceeds ${MAX_CANON_DEPTH} path segments`),
      );
      continue;
    }
    considerFile(state, target, relPath);
  }
}

export function listCanonPagesReport(
  vaultPath: string,
  cache?: CanonPageCache,
  options: { readonly include_archived?: boolean } = {},
): CanonPageReport {
  const state: WalkState = {
    pages: [],
    skipped: [],
    seen: new Map(),
    files: 0,
    bytes: 0,
    limits: loadCanonLimits(vaultPath),
    truncated: false,
    cache: cache ?? null,
    remembered: new Map(),
  };
  walk(state, vaultPath, vaultPath, 0);
  if (cache !== undefined) cache.files = state.remembered;
  state.skipped.sort((left, right) => compareName(left.relPath, right.relPath));
  return { pages: options.include_archived === false ? state.pages.filter((page) => page.data["status"] !== "archived") : state.pages, skipped: state.skipped, truncated: state.truncated };
}

export function listCanonPages(vaultPath: string): CanonPage[] {
  return listCanonPagesReport(vaultPath).pages;
}

/**
 * Parse, identity, and I/O failures make a vault walk incomplete.
 * Schema-invalid and oversized files are withheld; they do not abort rebuild.
 */
export function fatalCanonSkips(
  skipped: readonly SkippedPage[],
): SkippedPage[] {
  return skipped.filter(
    (entry) => entry.code !== "invalid" && entry.code !== "oversize",
  );
}

/** Stable hash of live page identity and path. Shared by search and graph stamps. */
export function canonPagesHash(pages: readonly CanonPage[]): string {
  const material = pages
    .map((page) => `${page.id}\t${page.relPath}`)
    .sort()
    .join("\n");
  return new Bun.CryptoHasher("sha256").update(material).digest("hex");
}

export function findPageById(vaultPath: string, id: string): CanonPage | null {
  return listCanonPages(vaultPath).find((page) => page.id === id) ?? null;
}
