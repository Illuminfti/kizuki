import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIRECTORIES = [
  "entities",
  "facts",
  "events",
  "sources",
  "dashboards",
  "archive",
  ".kizuki",
] as const;

const CANON_DOCTRINE = `# Canon

Canon is Markdown you own. A loop writes it for you from evidence it can
name, and records a receipt for every write. Nothing here is a secret from
you: \`kizuki audit\` shows every write with its evidence and its diff, and
\`kizuki undo <receipt>\` reverses any of them. If a page is wrong, say so —
\`kizuki tell "..."\` — and the page changes in the same breath. Edit these
files by hand whenever you like; the loop treats your edits as your word
and will not overwrite them.
`;

const SCHEMA_DOCTRINE = `# Page schema

Every page requires \`id\`, \`title\`, \`type\`, \`status\`, and \`sensitivity\` frontmatter.
Canon is reviewed Markdown; staging belongs in the database.
Every page carries \`sensitivity\` and \`taint\`; a page missing
either is never served to anyone, including you.
Unknown frontmatter keys must use the \`x-*\` extension namespace.
`;

const FILES = [
  ["CANON.md", CANON_DOCTRINE],
  ["SCHEMA.md", SCHEMA_DOCTRINE],
  [".gitignore", ".kizuki/\n"],
  [join(".kizuki", ".gitignore"), "*\n!.gitignore\n"],
] as const;

export interface InitVaultResult {
  created: string[];
}

export function initVault(path: string): InitVaultResult {
  const created: string[] = [];
  mkdirSync(path, { recursive: true });

  for (const directory of DIRECTORIES) {
    const target = join(path, directory);
    const existed = existsSync(target);
    mkdirSync(target, { recursive: true });
    if (!existed) created.push(`${directory}/`);
  }

  for (const [relativePath, content] of FILES) {
    const target = join(path, relativePath);
    if (existsSync(target)) continue;
    writeFileSync(target, content, { flag: "wx" });
    created.push(relativePath);
  }

  return { created };
}
