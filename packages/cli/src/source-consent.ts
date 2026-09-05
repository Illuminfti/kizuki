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


interface CustodyStat { uid: number; mode: number; isDirectory(): boolean; }
/** POSIX custody checks, independent of namespace translations or caller flags. */
export function policyDirectoryCustody(stat: CustodyStat, uid: number): boolean {
  const rootSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  return stat.isDirectory() && (stat.uid === 0 || stat.uid === uid) &&
    ((stat.mode & 0o022) === 0 || rootSticky);
}
export function policyFileCustody(stat: Pick<CustodyStat, "uid" | "mode">, uid: number): boolean {
  return stat.uid === uid && (stat.mode & 0o022) === 0;
}

/** Read owner policy only; never include file contents or OS paths in errors. */
export function readSourcePolicy(path: string): unknown {
  let fd: number | undefined;
  try {
    if (process.platform === "win32" || typeof process.geteuid !== "function") throw new Error();
    const uid = process.geteuid();
    const absolute = resolve(path);
    const parents: string[] = [];
    for (let parent = dirname(absolute); ; parent = dirname(parent)) {
      if (parents.length >= 256) throw new Error();
      parents.push(parent);
      if (parent === dirname(parent)) break;
    }
    parents.reverse();
    const parentIdentity = () => parents.map(parent => {
      const stat = lstatSync(parent);
      if (!policyDirectoryCustody(stat, uid)) throw new Error();
      return `${stat.dev}:${stat.ino}`;
    }).join("/");
    const ancestors = parentIdentity();
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || !policyFileCustody(before, uid) || before.nlink !== 1 || before.size > 16_384) throw new Error();
    const bytes = Buffer.alloc(16_385);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(fd);
    if (parentIdentity() !== ancestors || !policyFileCustody(after, uid) || after.nlink !== 1 || used !== before.size || used > 16_384 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used))) as unknown;
  } catch { throw new UsageError("source_policy_file_unsafe: POSIX custody could not be verified; use an owner-controlled JSON file (0600 preferred, 0644 allowed), at most 16384 bytes, with trusted directories and no symlinks"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function consentHint(db: Database, source: string): string {
  const grant = inspectSourceGrant(db, source);
  if (grant?.status === "denied") return `source consent denied; inspect purge: ${INVOCATION} connect status --source ${source}`;
  return `consent-required: ${INVOCATION} connect grant --source ${source} --policy POLICY.json --expected-revision ${grant?.revision ?? 0} --operation-id UNIQUE_ID`;
}
