import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pidAlive } from "./leases";

const LOCK_NAME = "write-pass.lock";

export interface WriteFlock {
  readonly path: string;
  release(): void;
}

function lockPath(vaultPath: string): string {
  return join(vaultPath, ".kizuki", LOCK_NAME);
}

/**
 * Exclusive triage lock (LifeOS flock). A dead holder's file is reclaimed.
 * Two live holders: the second call returns null and writes nothing.
 */
export function tryWriteFlock(vaultPath: string): WriteFlock | null {
  const path = lockPath(vaultPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
      return null;
    }
    try {
      unlinkSync(path);
    } catch {
      return null;
    }
  }
  try {
    const fd = openSync(path, "wx", 0o600);
    writeSync(fd, `${process.pid}\n`);
    return {
      path,
      release(): void {
        closeSync(fd);
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      },
    };
  } catch {
    return null;
  }
}
