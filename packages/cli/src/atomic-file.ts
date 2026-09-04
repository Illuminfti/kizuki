import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 20;

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

export function writeAtomicFile(
  path: string,
  contents: string,
  mode = 0o600,
): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const temporary = join(parent, `.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(temporary, "wx", mode);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    chmodSync(path, mode);
    try {
      const dirFd = openSync(parent, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync is best-effort on filesystems that refuse it.
    }
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function withExclusiveLock(lockPath: string, fn: () => void): void {
  const parent = dirname(lockPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        fn();
      } finally {
        closeSync(fd);
        if (existsSync(lockPath)) unlinkSync(lockPath);
      }
      return;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) {
        throw new Error(`could not lock ${lockPath}`);
      }
      Bun.sleepSync(LOCK_POLL_MS);
    }
  }
}
