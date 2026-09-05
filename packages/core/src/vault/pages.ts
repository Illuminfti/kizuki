import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { hashBytes } from "./write";
import { parseFrontmatter } from "./frontmatter";
import { validatePage } from "./schema";

export const MAX_CANON_PAGE_BYTES = 1_048_576;
export const MAX_CANON_PAGES = 10_000;
export const MAX_CANON_DEPTH = 8;
export const MAX_CANON_WALK_BYTES = 64 * 1_048_576;

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

interface WalkState {
  pages: CanonPage[];
  skipped: SkippedPage[];
  seen: Map<string, CanonPage>;
  duplicates: Set<string>;
  files: number;
  bytes: number;
  truncated: boolean;
}

function considerFile(state: WalkState, path: string, relPath: string): void {
  if (state.truncated) return;
  if (state.files >= MAX_CANON_PAGES) {
    state.truncated = true;
    state.skipped.push(
      skip(".", "too_many", `vault exceeds ${MAX_CANON_PAGES} markdown files`),
    );
    return;
  }
  state.files += 1;

  let size: number;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      state.skipped.push(skip(relPath, "unreadable", "unreadable: not a regular file"));
      return;
    }
    size = stat.size;
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
  if (state.bytes + size > MAX_CANON_WALK_BYTES) {
    state.truncated = true;
    state.skipped.push(
      skip(relPath, "too_many", `vault exceeds ${MAX_CANON_WALK_BYTES} scanned bytes`),
    );
    return;
  }

  let parsed: ReturnType<typeof parseFrontmatter>;
  let contentHash: string;
  try {
    const bytes = readFileSync(path);
    state.bytes += bytes.byteLength;
    contentHash = hashBytes(bytes);
    parsed = parseFrontmatter(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      state.skipped.push(skip(relPath, "parse", error.message));
      return;
    }
    state.skipped.push(skip(relPath, "unreadable", `unreadable: ${fsCode(error)}`));
    return;
  }

  const errors = validatePage(parsed.data);
  if (errors.length > 0) {
    state.skipped.push(skip(relPath, "invalid", errors[0] ?? "invalid page"));
    return;
  }

  const id = parsed.data["id"];
  if (typeof id !== "string" || id.length === 0) {
    state.skipped.push(skip(relPath, "invalid", "id: must be a non-empty string"));
    return;
  }

  const page: CanonPage = {
    id,
    path,
    relPath,
    data: parsed.data,
    body: parsed.body,
    contentHash,
  };
  const first = state.seen.get(id);
  if (first !== undefined) {
    state.duplicates.add(id);
    if (!state.skipped.some((entry) => entry.relPath === first.relPath && entry.code === "duplicate")) {
      state.skipped.push(
        skip(first.relPath, "duplicate", `duplicate id "${id}"; also at ${relPath}`),
      );
    }
    state.skipped.push(
      skip(relPath, "duplicate", `duplicate id "${id}"; first seen at ${first.relPath}`),
    );
    state.pages = state.pages.filter((entry) => entry.id !== id);
    return;
  }
  state.seen.set(id, page);
  state.pages.push(page);
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
    if (entry.name === ".kizuki" || entry.name === "archive") continue;
    const target = join(directory, entry.name);
    const relPath = relative(vaultPath, target).split(sep).join("/");
    if (entry.isSymbolicLink()) continue;
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
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".md") ||
      entry.name === "CANON.md" ||
      entry.name === "SCHEMA.md"
    ) {
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

export function listCanonPagesReport(vaultPath: string): CanonPageReport {
  const state: WalkState = {
    pages: [],
    skipped: [],
    seen: new Map(),
    duplicates: new Set(),
    files: 0,
    bytes: 0,
    truncated: false,
  };
  walk(state, vaultPath, vaultPath, 0);
  state.skipped.sort((left, right) => compareName(left.relPath, right.relPath));
  return { pages: state.pages, skipped: state.skipped, truncated: state.truncated };
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
