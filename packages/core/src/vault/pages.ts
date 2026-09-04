import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter";

export interface CanonPage {
  id: string;
  path: string;
  relPath: string;
  data: Record<string, unknown>;
  body: string;
}

export interface SkippedPage {
  relPath: string;
  reason: string;
}

export interface CanonPageReport {
  pages: CanonPage[];
  skipped: SkippedPage[];
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

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    compareName(a.name, b.name),
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

export function listCanonPagesReport(vaultPath: string): CanonPageReport {
  const pages: CanonPage[] = [];
  const skipped: SkippedPage[] = [];
  const seen = new Map<string, string>();

  for (const path of markdownFiles(vaultPath)) {
    const relPath = relative(vaultPath, path).split(sep).join("/");
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(readFileSync(path, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        skipped.push({ relPath, reason: error.message });
        continue;
      }
      throw error;
    }
    const id = parsed.data["id"];
    if (typeof id !== "string" || id.length === 0) {
      skipped.push({ relPath, reason: "id: must be a non-empty string" });
      continue;
    }
    const first = seen.get(id);
    if (first !== undefined) {
      skipped.push({
        relPath,
        reason: `duplicate id "${id}"; first seen at ${first}`,
      });
      continue;
    }
    seen.set(id, relPath);
    pages.push({ id, path, relPath, data: parsed.data, body: parsed.body });
  }

  return { pages, skipped };
}

export function listCanonPages(vaultPath: string): CanonPage[] {
  return listCanonPagesReport(vaultPath).pages;
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
