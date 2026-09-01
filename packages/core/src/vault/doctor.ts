import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter";
import { validatePage } from "./schema";

export interface DoctorPageResult {
  page: string;
  errors: string[];
}

export interface DoctorVaultResult {
  pages: DoctorPageResult[];
  counts: {
    total: number;
    valid: number;
    invalid: number;
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function doctorVault(path: string): DoctorVaultResult {
  const pages: DoctorPageResult[] = markdownFiles(path)
    .map((file): DoctorPageResult => {
      let errors: string[];
      try {
        errors = validatePage(parseFrontmatter(readFileSync(file, "utf8")).data);
      } catch (error) {
        errors = [`frontmatter: ${errorMessage(error)}`];
      }
      return {
        page: relative(path, file).split(sep).join("/"),
        errors,
      };
    })
    .sort((a, b) => a.page.localeCompare(b.page));
  const valid = pages.filter(({ errors }) => errors.length === 0).length;

  return {
    pages,
    counts: {
      total: pages.length,
      valid,
      invalid: pages.length - valid,
    },
  };
}
