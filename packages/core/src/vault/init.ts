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

Canon is reviewed Markdown on the owner's disk.
Staging lives only in the database under \`.kizuki/\`.
Only an owner-invoked promotion may write canon.
Every canon page requires a \`sensitivity\` label.
`;

const SCHEMA_DOCTRINE = `# Page schema

Every page requires \`id\`, \`title\`, \`type\`, \`status\`, and \`sensitivity\` frontmatter.
Canon is reviewed Markdown; staging belongs in the database.
Only owner promotion writes canon.
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
