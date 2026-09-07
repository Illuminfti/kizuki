import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { CanonFilesError, openCanonFiles, type CanonFiles } from "../vault/canon-files";
import { openOwnedDirectory, type OwnedDirectory } from "../util/owned-directory";
import type { AdvisoryFileLock } from "../util/advisory-file-lock";
import { LedgerError } from "./connections";

const LOCK_NAME = "connection-state.lock";
export interface ConnectionStateLease {
  assertCurrent(): void;
  release(): void;
}

/** The empty private lock inode is permanent. Only its kernel lease expires. */
export function acquireConnectionStateLease(controlDirectory: string): ConnectionStateLease {
  const control = resolve(controlDirectory);
  let files: CanonFiles | undefined, directory: OwnedDirectory | undefined, lock: AdvisoryFileLock | null = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { lock?.release(); }
    finally { try { directory?.close(); } finally { files?.close(); } }
  };
  try {
    files = openCanonFiles(control);
    files.assertPrivateDirectory("connections");
    directory = openOwnedDirectory(control);
    const root = lstatSync(control);
    if (!root.isDirectory() || root.uid !== process.geteuid?.() || (root.mode & 0o777) !== 0o700) throw Error("unsafe control");
    let snapshot = files.readPrivate(LOCK_NAME);
    if (snapshot === null) {
      try { snapshot = files.create(LOCK_NAME, new Uint8Array()); }
      catch (error) {
        // Another creator may win the empty inode. It must pass the same
        // private-file checks; no existing entry is repaired or replaced.
        if (!(error instanceof CanonFilesError) || error.reason !== "conflict") throw error;
        snapshot = files.readPrivate(LOCK_NAME);
      }
    }
    if (snapshot === null) throw Error("missing lock");
    try { if (snapshot.bytes.byteLength !== 0) throw Error("nonempty lock"); }
    finally { snapshot.close(); }
    const identity = directory.inspect([LOCK_NAME]), connections = directory.childIdentity("connections");
    if (identity === null || connections === null) throw Error("missing identity");
    lock = directory.tryLock([LOCK_NAME]);
    if (lock === null) throw new LedgerError("connection state is locked by another writer");
    const assertCurrent = () => {
      if (released) throw new LedgerError("connection state lease is no longer active");
      try {
        directory!.assertCurrent();
        files!.assertPrivateDirectory("connections");
        const currentRoot = lstatSync(control), current = directory!.inspect([LOCK_NAME]), child = directory!.childIdentity("connections");
        if (currentRoot.dev !== root.dev || currentRoot.ino !== root.ino || !currentRoot.isDirectory() ||
            currentRoot.uid !== root.uid || (currentRoot.mode & 0o777) !== 0o700 ||
            current === null || !current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino ||
            current.uid !== root.uid || current.nlink !== 1 || current.size !== 0 || (current.mode & 0o777) !== 0o600 ||
            child?.dev !== connections.dev || child.ino !== connections.ino) throw Error("changed identity");
      } catch { throw new LedgerError("connection state lock custody changed"); }
    };
    assertCurrent();
    return Object.freeze({ assertCurrent, release });
  } catch (error) {
    release();
    if (error instanceof LedgerError) throw error;
    throw new LedgerError("connection state lock custody is unavailable");
  }
}
