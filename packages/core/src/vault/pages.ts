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

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
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

export function listCanonPages(vaultPath: string): CanonPage[] {
  return markdownFiles(vaultPath).map((path) => {
    const relPath = relative(vaultPath, path).split(sep).join("/");
    const page = parseFrontmatter(readFileSync(path, "utf8"));
    const id = page.data["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(`${relPath}: frontmatter.id must be a non-empty string`);
    }
    return { id, path, relPath, data: page.data, body: page.body };
  });
}

export function findPageById(vaultPath: string, id: string): CanonPage | null {
  return listCanonPages(vaultPath).find((page) => page.id === id) ?? null;
}
