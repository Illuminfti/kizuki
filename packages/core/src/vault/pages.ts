import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter";

export interface CanonPage {
  id: string;
  relPath: string;
  data: Record<string, unknown>;
  body: string;
}

function markdownFiles(path: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    if (entry.name === ".kizuki") continue;
    const target = join(path, entry.name);
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
  return markdownFiles(vaultPath).map((file) => {
    const relPath = relative(vaultPath, file).split(sep).join("/");
    const page = parseFrontmatter(readFileSync(file, "utf8"));
    const id = page.data["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(`${relPath}: frontmatter.id must be a non-empty string`);
    }
    return { id, relPath, data: page.data, body: page.body };
  });
}
