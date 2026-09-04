import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** Creates a release-owned directory only when no untrusted path is present. */
export function ensureReleaseDirectory(path: string): void {
  if (absent(path)) {
    mkdirSync(path, { mode: 0o700 });
    return;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`unsafe release directory: ${path}`);
  }
}

/** Refuse to overwrite an artifact or follow a symlink while hashing it. */
export function requireRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`unsafe release artifact: ${path}`);
  }
}

export function checksumManifest(directory: string, names: readonly string[]): string {
  return names.map((name) => {
    const path = join(directory, name);
    requireRegularFile(path);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    return `${digest}  ${name}`;
  }).join("\n") + "\n";
}

export function verifyChecksumManifest(directory: string, names: readonly string[]): void {
  const manifestPath = join(directory, "SHA256SUMS");
  requireRegularFile(manifestPath);
  const expected = checksumManifest(directory, names).trim();
  const actual = readFileSync(manifestPath, "utf8").trim();
  if (actual !== expected) throw new Error("release checksum verification failed");
}

export function requireAbsent(path: string): void {
  if (!absent(path)) throw new Error(`refusing to overwrite release artifact: ${basename(path)}`);
}
