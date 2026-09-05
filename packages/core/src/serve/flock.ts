import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { tryAdvisoryFileLock } from "../util/advisory-file-lock";
import { ulid } from "../util/ulid";
import { pidAlive } from "./leases";

export interface WriteFlock {
  /** Legacy PID diagnostic path. The ownership inode is write-pass.flock. */
  readonly path: string;
  release(): void;
}

/** Kernel ownership is independent of PID diagnostics and survives their removal. */
export function tryWriteFlock(vaultPath: string): WriteFlock | null {
  const directory = join(vaultPath, ".kizuki");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const native = tryAdvisoryFileLock(join(directory, "write-pass.flock"));
  if (native === null) return null;
  const path = join(directory, "write-pass.lock");
  try {
    if (existsSync(path)) {
      const legacy = lstatSync(path);
      if (!legacy.isFile()) { native.release(); return null; }
      const raw = readFileSync(path, "utf8").trim();
      const holder = /^\d+$/.test(raw) ? Number(raw) : NaN;
      // Unknown diagnostics fail closed; a live legacy writer does not yet
      // participate in the kernel protocol and must never be displaced.
      if (!Number.isSafeInteger(holder) || holder <= 0 || pidAlive(holder)) { native.release(); return null; }
      const current = lstatSync(path);
      if (legacy.ino !== current.ino || legacy.dev !== current.dev) { native.release(); return null; }
      unlinkSync(path);
    }
    // Publish complete diagnostics without replacing a legacy writer which
    // acquired its wx file after our check. A crash cannot expose an empty PID.
    const temporary = `${path}.${ulid()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    let identity;
    try {
      const line = `${process.pid}\n`;
      if (writeSync(fd, line) !== line.length) throw new Error("PID diagnostic write incomplete");
      fsyncSync(fd);
      linkSync(temporary, path);
      identity = fstatSync(fd);
    } finally {
      closeSync(fd);
      unlinkSync(temporary);
    }
    let released = false;
    return {
      path,
      release() {
        if (released) return;
        released = true;
        try {
          if (existsSync(path)) {
            const current = lstatSync(path);
            if (current.isFile() && current.ino === identity.ino && current.dev === identity.dev && readFileSync(path, "utf8") === `${process.pid}\n`) unlinkSync(path);
          }
        } finally { native.release(); }
      },
    };
  } catch {
    native.release();
    return null;
  }
}
