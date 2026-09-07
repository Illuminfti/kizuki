import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

// Inspect the environment independently; never skip because implementation fails.
export const credentialCustodyQualified = process.platform === "linux" && process.arch === "x64" && (() => {
  const uid = process.geteuid?.();
  if (uid === undefined) return false;
  for (let path = tmpdir();; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) ||
      ((stat.mode & 0o022) !== 0 && (stat.uid !== 0 || (stat.mode & 0o1000) === 0))) return false;
    if (path === dirname(path)) return true;
  }
})();
