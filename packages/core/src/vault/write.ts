import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { serializePage } from "./frontmatter";
import type { VaultPage } from "./frontmatter";
import { validatePage } from "./schema";

export interface WritePageOptions {
  revision?: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findVaultRoot(file: string): string {
  let current = dirname(resolve(file));
  while (true) {
    if (isDirectory(join(current, "archive")) && isDirectory(join(current, ".kizuki"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`cannot find vault root for ${file}`);
}

function nextArchivePath(vault: string, file: string): string {
  const stem = basename(file, extname(file));
  let timestamp = Date.now();
  let candidate = join(vault, "archive", `${stem}.prev-${timestamp}.md`);
  while (existsSync(candidate)) {
    timestamp += 1;
    candidate = join(vault, "archive", `${stem}.prev-${timestamp}.md`);
  }
  return candidate;
}

export function writePage(path: string, page: VaultPage, opts: WritePageOptions = {}): void {
  const errors = validatePage(page.data);
  if (errors.length > 0) {
    throw new TypeError(`Invalid page:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
  const content = serializePage(page);
  const exists = existsSync(path);

  if (exists && opts.revision !== true) {
    throw new Error(`Refusing to overwrite existing page: ${path}`);
  }
  if (!exists) {
    writeFileSync(path, content, { flag: "wx" });
    return;
  }

  const vault = findVaultRoot(path);
  mkdirSync(join(vault, "archive"), { recursive: true });
  copyFileSync(path, nextArchivePath(vault, path));
  writeFileSync(path, content);
}
