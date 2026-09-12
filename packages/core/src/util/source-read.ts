import { ptr } from "bun:ffi";
import { loadOwnedDirectoryNative } from "./owned-directory-native";

/** Readonly source open via native openat. Not a vault/private-directory helper. */
export type SourceReadFailure = "unsupported" | "native_unavailable" | "invalid_name" | "symlink" | "io";
export class SourceReadError extends Error {
  constructor(readonly reason: SourceReadFailure, readonly code?: string) {
    super(`source_read_${reason}`);
    this.name = "SourceReadError";
  }
}
function fail(reason: SourceReadFailure, code?: string): never {
  throw new SourceReadError(reason, code);
}

let native: ReturnType<typeof loadOwnedDirectoryNative> | undefined;
function api() {
  if (!((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64"))) {
    fail("unsupported");
  }
  try { return native ??= loadOwnedDirectoryNative(); }
  catch (error) {
    if (error instanceof Error && error.message === "owned_directory_unsupported") fail("unsupported");
    fail("native_unavailable");
  }
}
function nameBytes(name: string): Buffer {
  const bytes = Buffer.from(name);
  if (!bytes.length || bytes.length > 255 || bytes.includes(0) || name.includes("/") || name.includes("\\") ||
      name === "." || name === ".." || bytes.toString("utf8") !== name) fail("invalid_name");
  return Buffer.concat([bytes, Buffer.from([0])]);
}

/**
 * Open a readable child relative to a held directory descriptor.
 * Uses the shared openat primitive (O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC).
 * Does not inspect owner, mode, nlink, or vault ancestry. No pathname fallback.
 */
export function openSourceChild(parentFd: number, name: string): number {
  if (!Number.isInteger(parentFd) || parentFd < 0 || parentFd > 0x7fffffff) fail("io");
  const bytes = nameBytes(name);
  const fd = api().symbols.openChild(parentFd, ptr(bytes), 0);
  if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd > 0x7fffffff) fail("io");
  if (fd >= 0) return fd;
  if (fd === -40 || fd === -20) fail("symlink", fd === -40 ? "ELOOP" : "ENOTDIR");
  fail("io");
}
