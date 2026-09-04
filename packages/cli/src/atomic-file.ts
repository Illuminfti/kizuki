import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

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

type LockHolder = "live" | "dead" | "pending";

function inspectLockHolder(lockPath: string): LockHolder {
  if (!existsSync(lockPath)) return "dead";
  let raw = "";
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch {
    return "pending";
  }
  if (raw.length === 0) return "pending";
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) return "pending";
  try {
    process.kill(pid, 0);
    return "live";
  } catch {
    return "dead";
  }
}

export function withExclusiveLock(lockPath: string, fn: () => void): void {
  const parent = dirname(lockPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const mine = join(parent, `.${basename(lockPath)}.${process.pid}`);
  writeFileSync(mine, `${process.pid}\n`, { mode: 0o600 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try {
        linkSync(mine, lockPath);
        break;
      } catch (error) {
        if (!isBusy(error)) {
          throw new Error(`could not lock ${lockPath}`);
        }
        const holder = inspectLockHolder(lockPath);
        const expired = Date.now() >= deadline;
        if (holder === "dead" || (holder === "pending" && expired)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Another waiter may have already stolen the stale file.
          }
          continue;
        }
        if (expired) {
          throw new Error(`could not lock ${lockPath}`);
        }
        Bun.sleepSync(LOCK_POLL_MS);
      }
    }
    try {
      fn();
    } finally {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }
  } finally {
    if (existsSync(mine)) unlinkSync(mine);
  }
}
