import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";

let native: ReturnType<typeof load> | undefined;
function load() {
  const library = process.platform === "linux" ? "libc.so.6" : process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null;
  if (library === null) throw new Error("native advisory locking is unsupported on this platform");
  return dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
}

export interface AdvisoryFileLock {
  release(): void;
}

/** Stable inode, never unlinked. Closing this fd or process death releases ownership. */
export function tryAdvisoryFileLock(path: string): AdvisoryFileLock | null {
  native ??= load();
  let fd: number;
  try { fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error("advisory file lock cannot be opened"); }
  try {
    if (native.symbols.flock(fd, 2 | 4) !== 0) { closeSync(fd); return null; }
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || !current.isFile() || opened.ino !== current.ino || opened.dev !== current.dev) {
      throw new Error("advisory file lock identity changed");
    }
    let released = false;
    return { release() { if (!released) { released = true; closeSync(fd); } } };
  } catch {
    closeSync(fd);
    throw new Error("advisory file lock acquisition failed");
  }
}
