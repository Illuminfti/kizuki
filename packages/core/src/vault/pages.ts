import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { compareCodePoints } from "../util/text";
import { parseFrontmatter } from "./frontmatter";

export interface CanonPage {
  id: string;
  path: string;
  relPath: string;
  data: Record<string, unknown>;
  body: string;
}

/**
 * `unreadable` means the frontmatter is not available at all: it did not
 * parse, or the file did not open and the caller tolerates that. The other
 * two parsed, so their frontmatter can still be read by a caller that needs
 * it (`ledger/purge.ts` computes its cascade from `sources`).
 */
export type SkipKind = "unreadable" | "no-id" | "duplicate-id";

export interface SkippedPage {
  relPath: string;
  kind: SkipKind;
  reason: string;
}

export interface CanonPageReadOptions {
  /**
   * Report a file the OS refuses (permissions, I/O) as `unreadable` instead
   * of throwing. Only `doctor` asks for it: describing a broken vault is that
   * verb's whole job, so one unreadable note must not take the report
   * offline. Every other reader keeps the fail-loud default, because a
   * rebuild that silently omits canon, or a writer that reads an unreadable
   * page as absent, is worse than an error.
   */
  tolerateUnreadable?: boolean;
}

export interface CanonPageReport {
  pages: CanonPage[];
  /**
   * Pages that parsed and named an id another file claimed first. They are
   * not served — every reader keys on the id — but they are real notes with
   * real provenance, so a caller that reasons about `sources` rather than
   * about ids reads them too. Each also appears in `skipped`.
   */
  duplicates: CanonPage[];
  skipped: SkippedPage[];
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    compareCodePoints(a.name, b.name),
  );
  for (const entry of entries) {
    if (entry.name === ".kizuki" || entry.name === "archive") continue;
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(target));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      entry.name !== "CANON.md" &&
      entry.name !== "SCHEMA.md"
    ) {
      files.push(target);
    }
  }
  return files;
}

export function listCanonPagesReport(
  vaultPath: string,
  opts: CanonPageReadOptions = {},
): CanonPageReport {
  const pages: CanonPage[] = [];
  const duplicates: CanonPage[] = [];
  const skipped: SkippedPage[] = [];
  const seen = new Map<string, string>();

  for (const path of markdownFiles(vaultPath)) {
    const relPath = relative(vaultPath, path).split(sep).join("/");
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(readFileSync(path, "utf8"));
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (opts.tolerateUnreadable === true && error instanceof Error)
      ) {
        skipped.push({ relPath, kind: "unreadable", reason: error.message });
        continue;
      }
      throw error;
    }
    const id = parsed.data["id"];
    if (typeof id !== "string" || id.length === 0) {
      skipped.push({
        relPath,
        kind: "no-id",
        reason: "id: must be a non-empty string",
      });
      continue;
    }
    const first = seen.get(id);
    if (first !== undefined) {
      skipped.push({
        relPath,
        kind: "duplicate-id",
        reason: `duplicate id "${id}"; first seen at ${first}`,
      });
      duplicates.push({
        id,
        path,
        relPath,
        data: parsed.data,
        body: parsed.body,
      });
      continue;
    }
    seen.set(id, relPath);
    pages.push({ id, path, relPath, data: parsed.data, body: parsed.body });
  }

  return { pages, duplicates, skipped };
}

export function listCanonPages(vaultPath: string): CanonPage[] {
  return listCanonPagesReport(vaultPath).pages;
}

export function findPageById(vaultPath: string, id: string): CanonPage | null {
  return listCanonPages(vaultPath).find((page) => page.id === id) ?? null;
}
