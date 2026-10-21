import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { KizukiError } from "./errors";

/**
 * A Kizuki vault is derived output: its pages, archives and control data were
 * written by the loop, so a connector that read them back would launder machine
 * text into external evidence. Every folder-reading connector shares this check.
 */
const VAULT_MARKER = ".kizuki";
const MAX_ANCESTORS = 256;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

export function refuseVaultSource(): never {
  throw new KizukiError("misconfigured", "source_contains_kizuki_vault: choose an independent source folder outside Kizuki canon, archives and control data");
}

/** lstat also recognizes a dangling or hostile marker symlink; exclude patterns cannot suppress it. */
async function hasVaultMarker(directory: string): Promise<boolean> {
  try {
    await lstat(path.join(directory, VAULT_MARKER));
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

/** Refuses a directory that is, or sits inside, a Kizuki vault. The caller passes a resolved path. */
export async function assertOutsideVault(directory: string): Promise<void> {
  let current = directory;
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    if (await hasVaultMarker(current)) refuseVaultSource();
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
  throw new KizukiError("misconfigured", "source_path_depth: source ancestry exceeds the verification bound");
}

/** The same refusal for a single-file source, decided from the file's resolved location. */
export async function assertFileOutsideVault(file: string): Promise<void> {
  let resolved: string;
  try {
    resolved = await realpath(file);
  } catch {
    // An unreadable source is reported by the reader with its own error.
    return;
  }
  await assertOutsideVault(path.dirname(resolved));
}
