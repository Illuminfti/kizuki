import { ptr } from "bun:ffi";
import type { BigIntStats } from "node:fs";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { loadOwnedDirectoryNative } from "../util/owned-directory-native";
import { assertCanonFiles } from "../vault/canon-files";
import { assertVaultMutationScope, type VaultMutationScope } from "../vault/mutation-scope";
import { requireCanonFiles } from "./io";
import { RECEIPTS_PATH } from "./receipts";
import type { CanonIo } from "./store";

const SOURCE_STREAM_LIMIT = 32n * 1024n * 1024n;
const [CONTROL, DIRECTORY, FILE] = RECEIPTS_PATH.split("/") as [string, string, string];
type Failure = "unsupported" | "native_unavailable" | "unsafe" | "missing" | "conflict" | "changed" | "bounds" | "closed" | "failed" | "io" | "durability";
export class ReceiptStreamError extends Error {
  constructor(readonly reason: Failure) { super(`canon_receipt_stream_${reason}`); this.name = "ReceiptStreamError"; }
}
function fail(reason: Failure): never { throw new ReceiptStreamError(reason); }
function mapped(error: unknown): ReceiptStreamError { return error instanceof ReceiptStreamError ? error : new ReceiptStreamError("io"); }
let native: ReturnType<typeof loadOwnedDirectoryNative> | undefined;
function api() {
  if (process.platform !== "linux" || process.arch !== "x64" || process.geteuid === undefined) fail("unsupported");
  try { return native ??= loadOwnedDirectoryNative(); } catch { fail("native_unavailable"); }
}
function nameBytes(name: string): Buffer {
  const bytes = Buffer.from(name);
  if (!bytes.length || bytes.length > 255 || bytes.includes(0) || name.includes("/") || name.includes("\\") ||
      name === "." || name === ".." || bytes.toString("utf8") !== name) fail("bounds");
  return Buffer.concat([bytes, Buffer.from([0])]);
}
function result(value: number | bigint): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value > 0x7fffffff || value < -4095) fail("io");
  if (value === -38 || value === -95) fail("unsupported");
  if (value === -17) fail("conflict");
  if (value < 0 && value !== -2) fail("unsafe");
  return value;
}
function openDirectory(parent: number, name: string): number | null {
  const bytes = nameBytes(name), fd = result(api().symbols.openChild(parent, ptr(bytes), 1));
  return fd === -2 ? null : fd;
}
function openFile(parent: number, readable: boolean, exclusive = false): number | null {
  const bytes = nameBytes(FILE);
  const open = readable ? api().symbols.openReceiptReadAppendChild : api().symbols.openReceiptAppendChild;
  const fd = result(open(parent, ptr(bytes), exclusive ? 1 : 0));
  return fd === -2 ? null : fd;
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function directoryStat(fd: number, ancestor = false): BigIntStats {
  const stat = fstatSync(fd, { bigint: true }), uid = BigInt(process.geteuid!());
  const sticky = ancestor && stat.uid === 0n && (stat.mode & 0o1000n) !== 0n;
  if (!stat.isDirectory() || stat.nlink < 1n || (stat.uid !== uid && (!ancestor || stat.uid !== 0n)) ||
      ((stat.mode & 0o022n) !== 0n && !sticky)) fail("unsafe");
  return stat;
}
function openRoot(path: string): number {
  if (path === "/" || path.split("/").length > 257) fail("bounds");
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000);
  try {
    directoryStat(fd, true);
    const parts = path.split("/").filter(Boolean);
    for (const [index, part] of parts.entries()) {
      const next = openDirectory(fd, part); if (next === null) fail("missing");
      closeSync(fd); fd = next;
      directoryStat(fd, index < parts.length - 1);
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function fileStat(fd: number, readable: boolean): BigIntStats {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.geteuid!()) || stat.size < 0n || (stat.mode & 0o200n) === 0n) fail("unsafe");
  if (readable && stat.size > SOURCE_STREAM_LIMIT) fail("bounds");
  return stat;
}
function sync(fd: number): void { try { fsyncSync(fd); } catch { fail("durability"); } }
function closeAll(fds: readonly number[]): void {
  let failed = false;
  for (const fd of [...fds].reverse()) { try { closeSync(fd); } catch { failed = true; } }
  if (failed) fail("io");
}
function verifyDirectories(path: string, fds: readonly number[], expected: readonly BigIntStats[], assertOwner: () => void): void {
  assertOwner();
  const root = openRoot(path);
  try { if (!sameIdentity(directoryStat(root), expected[0]!)) fail("changed"); }
  finally { closeSync(root); }
  for (let index = 1; index < fds.length; index++) {
    const current = openDirectory(fds[index - 1]!, index === 1 ? CONTROL : DIRECTORY);
    if (current === null) fail("changed");
    try {
      if (!sameIdentity(directoryStat(current), expected[index]!) ||
          !sameIdentity(directoryStat(fds[index]!), expected[index]!)) fail("changed");
    } finally { closeSync(current); }
  }
}
function verifyFile(parent: number, fd: number, readable: boolean, expected: BigIntStats): void {
  if (!sameFile(fileStat(fd, readable), expected)) fail("changed");
  const named = openFile(parent, readable); if (named === null) fail("changed");
  try { if (!sameFile(fileStat(named, readable), expected)) fail("changed"); }
  finally { closeSync(named); }
}

/** Fixed receipt child only. Byte custody does not confer receipt authority. */
class ReceiptStream {
  #closed = false;
  #failed = false;
  #stat: BigIntStats;
  readonly #directories: readonly BigIntStats[];
  readonly #path: string;
  readonly #fds: readonly [number, number, number, number];
  readonly #readable: boolean;
  readonly #assertOwner: () => void;
  constructor(path: string, fds: readonly [number, number, number, number], readable: boolean, assertOwner: () => void) {
    this.#path = path; this.#fds = fds; this.#readable = readable; this.#assertOwner = assertOwner;
    this.#directories = fds.slice(0, 3).map(fd => directoryStat(fd));
    this.#stat = fileStat(fds[3], readable);
  }
  #guard<T>(work: () => T): T {
    if (this.#closed) fail("closed");
    if (this.#failed) fail("failed");
    try { return work(); }
    catch (error) { this.#failed = true; throw mapped(error); }
  }
  #verify(): void {
    verifyDirectories(this.#path, this.#fds.slice(0, 3), this.#directories, this.#assertOwner);
    verifyFile(this.#fds[2], this.#fds[3], this.#readable, this.#stat);
  }
  verifyBinding(): void { this.#guard(() => this.#verify()); }
  readUtf8(): string {
    return this.#guard(() => {
      if (!this.#readable) fail("unsafe");
      this.#verify();
      const bytes = Buffer.alloc(Number(this.#stat.size));
      for (let offset = 0; offset < bytes.length;) {
        const count = readSync(this.#fds[3], bytes, offset, bytes.length - offset, offset);
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) fail("io");
        offset += count;
      }
      this.#verify();
      return bytes.toString("utf8");
    });
  }
  append(input: Uint8Array): void {
    this.#guard(() => {
      if (!(input instanceof Uint8Array)) fail("bounds");
      const bytes = Buffer.from(input);
      this.#verify();
      const expectedSize = this.#stat.size + BigInt(bytes.length);
      if (this.#readable && expectedSize > SOURCE_STREAM_LIMIT) fail("bounds");
      for (let offset = 0; offset < bytes.length;) {
        const count = writeSync(this.#fds[3], bytes, offset, bytes.length - offset);
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) fail("io");
        offset += count;
      }
      const current = fileStat(this.#fds[3], this.#readable);
      if (!sameIdentity(current, this.#stat) || current.size !== expectedSize || current.mode !== this.#stat.mode || current.gid !== this.#stat.gid) fail("changed");
      this.#stat = current;
      this.#verify();
    });
  }
  sync(): void {
    this.#guard(() => { this.#verify(); sync(this.#fds[3]); sync(this.#fds[2]); this.#verify(); });
  }
  close(): void { if (!this.#closed) { this.#closed = true; closeAll(this.#fds); } }
}

export type ReceiptAppendStream = Pick<ReceiptStream, "append" | "sync" | "verifyBinding" | "close">;
export type SourceErasureReceiptFile = ReceiptAppendStream & Pick<ReceiptStream, "readUtf8">;

function openStream(scope: VaultMutationScope, io: CanonIo, readable: boolean): ReceiptStream {
  const files = requireCanonFiles(scope, io);
  const target = Object.freeze({ vault_path: resolve(io.vault_path), db: io.db });
  const assertOwner = (): void => { assertVaultMutationScope(scope, target); assertCanonFiles(files, target.vault_path); };
  const fds: number[] = [];
  let stream: ReceiptStream | undefined;
  try {
    api(); assertOwner();
    const root = openRoot(target.vault_path); fds.push(root);
    const control = openDirectory(root, CONTROL); if (control === null) fail("missing");
    fds.push(control); directoryStat(control);
    const directories = fds.map(fd => directoryStat(fd));
    let parent = openDirectory(control, DIRECTORY);
    if (parent === null && !readable) {
      verifyDirectories(target.vault_path, fds, directories, assertOwner);
      const name = nameBytes(DIRECTORY);
      if (result(api().symbols.mkdirChild(control, ptr(name))) !== 0) fail("io");
      sync(control);
      parent = openDirectory(control, DIRECTORY);
    }
    if (parent === null) fail("missing");
    fds.push(parent); directories.push(directoryStat(parent));
    verifyDirectories(target.vault_path, fds, directories, assertOwner);
    let fd = openFile(parent, readable);
    if (fd === null) fd = openFile(parent, readable, true);
    if (fd === null) fail("changed");
    fds.push(fd);
    const stat = fileStat(fd, readable);
    if (readable) {
      verifyDirectories(target.vault_path, fds.slice(0, 3), directories, assertOwner);
      verifyFile(parent, fd, readable, stat);
      if ((stat.mode & 0o777n) !== 0o600n) fchmodSync(fd, 0o600);
      if ((fileStat(fd, true).mode & 0o777n) !== 0o600n) fail("unsafe");
      sync(fd);
    }
    else if ((stat.mode & 0o022n) !== 0n) fail("unsafe");
    stream = new ReceiptStream(target.vault_path, [root, control, parent, fd], readable, assertOwner);
    stream.verifyBinding();
    return stream;
  } catch (error) {
    try { if (stream) stream.close(); else closeAll(fds); } catch { /* Retain the original refusal. */ }
    throw mapped(error);
  }
}

export function openOrdinaryReceiptStream(scope: VaultMutationScope, io: CanonIo): ReceiptAppendStream { return openStream(scope, io, false); }
export function openSourceErasureReceiptStream(scope: VaultMutationScope, io: CanonIo): SourceErasureReceiptFile { return openStream(scope, io, true); }
