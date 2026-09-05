import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inspectSourceGrant } from "@kizuki/core";
import type { Database } from "bun:sqlite";
import { UsageError } from "./args";
import { INVOCATION } from "./runtime";

export const CONSENT_OPTIONS = ["--policy", "--expected-revision", "--operation-id"];

export function expectedRevision(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError("--expected-revision requires an exact nonnegative integer");
  }
  return Number(value);
}

/** Read owner policy only; never include file contents or OS paths in errors. */
export function readSourcePolicy(path: string): unknown {
  let fd: number | undefined;
  try {
    const absolute = resolve(path);
    for (let parent = dirname(absolute); ; parent = dirname(parent)) {
      if (lstatSync(parent).isSymbolicLink()) throw new Error();
      if (parent === dirname(parent)) break;
    }
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 16_384) throw new Error();
    const bytes = Buffer.alloc(16_385);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(fd);
    if (used !== before.size || used > 16_384 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used))) as unknown;
  } catch { throw new UsageError("source_policy_file_unsafe: use a regular JSON file of at most 16384 bytes without symlinks"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function consentHint(db: Database, source: string): string {
  const grant = inspectSourceGrant(db, source);
  if (grant?.status === "denied") return `source consent denied; inspect purge: ${INVOCATION} connect status --source ${source}`;
  return `consent-required: ${INVOCATION} connect grant --source ${source} --policy POLICY.json --expected-revision ${grant?.revision ?? 0} --operation-id UNIQUE_ID`;
}
