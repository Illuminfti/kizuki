import { ptr } from "bun:ffi";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync, type BigIntStats } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadOwnedDirectoryNative } from "../util/owned-directory-native";

const MAX_CREDENTIAL_BYTES = 1024;

type Native = ReturnType<typeof loadOwnedDirectoryNative>;
let native: Native | undefined;

export interface CredentialFileIdentity {
  readonly dev: string;
  readonly ino: string;
}

export interface CredentialFileInspection {
  readonly identity: CredentialFileIdentity;
  /** A bounded observation only; verification always rereads the inode. */
  readonly bytes: Uint8Array;
  close(): void;
}

type HandleState = {
  readonly directory: CredentialDirectory;
  readonly fd: number;
  readonly name: string;
  readonly writable: boolean;
  readonly identity: CredentialFileIdentity;
  closed: boolean;
};

const handles = new WeakMap<object, HandleState>();
const directories = new WeakSet<CredentialDirectory>();
const directoryToken = {};

function fail(kind = "unsafe"): never { throw new Error(`credential_file_${kind}`); }
function call<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof Error && error.message.startsWith("credential_file_")) throw error;
    fail();
  }
}
function api(): Native {
  if (process.platform !== "linux" || process.arch !== "x64") fail("unsupported");
  try { return native ??= loadOwnedDirectoryNative(); } catch { fail("unavailable"); }
}
function euid(): bigint {
  if (process.geteuid === undefined) fail("unsupported");
  return BigInt(process.geteuid());
}
function validName(name: string): Buffer {
  const bytes = Buffer.from(name);
  if (!bytes.length || bytes.length > 255 || bytes.includes(0) || bytes.includes(47) ||
      bytes.equals(Buffer.from(".")) || bytes.equals(Buffer.from(".."))) fail();
  return Buffer.concat([bytes, Buffer.from([0])]);
}
function validFd(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) fail("native");
  return value;
}
function identity(fd: number): CredentialFileIdentity {
  const stat = call(() => fstatSync(fd, { bigint: true }));
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function same(left: CredentialFileIdentity, right: CredentialFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameBigStat(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mode === after.mode && before.uid === after.uid && before.nlink === after.nlink &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
function fileIsSafe(fd: number, expected?: CredentialFileIdentity): void {
  const stat = call(() => fstatSync(fd, { bigint: true }));
  const owner = euid();
  if (!stat.isFile() || stat.uid !== owner || stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o600n ||
      (expected !== undefined && !same({ dev: stat.dev.toString(), ino: stat.ino.toString() }, expected))) fail("identity_changed");
}
function readBounded(fd: number, expected?: CredentialFileIdentity): Uint8Array {
  const before = call(() => fstatSync(fd, { bigint: true }));
  fileIsSafe(fd, expected);
  if (before.size < 0n || before.size > BigInt(MAX_CREDENTIAL_BYTES)) fail("bounds");
  const bytes = Buffer.alloc(Number(before.size));
  for (let offset = 0; offset < bytes.length;) {
    const count = call(() => readSync(fd, bytes, offset, bytes.length - offset, offset));
    if (count <= 0) fail("changed");
    offset += count;
  }
  const after = call(() => fstatSync(fd, { bigint: true }));
  if (!sameBigStat(before, after)) fail("changed");
  return bytes;
}
function ownerIsSafe(stat: BigIntStats, euid: bigint): boolean {
  if (!stat.isDirectory() || (stat.uid !== 0n && stat.uid !== euid)) return false;
  const writable = (stat.mode & 0o022n) !== 0n;
  return !writable || (stat.mode & 0o1000n) !== 0n;
}
function openChild(parent: number, name: string, directory: boolean): number {
  const result = api().symbols.openChild(parent, ptr(validName(name)), directory ? 1 : 0);
  return validFd(result);
}
function openQualifiedParent(path: string): number {
  if (!isAbsolute(path) || resolve(path) !== path || path.split("/").length > 257) fail();
  const owner = euid();
  let fd = call(() => openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000));
  try {
    if (!ownerIsSafe(call(() => fstatSync(fd, { bigint: true })), owner)) fail();
    for (const component of path.split("/").filter(Boolean)) {
      const next = openChild(fd, component, true);
      call(() => closeSync(fd));
      fd = next;
      if (!ownerIsSafe(call(() => fstatSync(fd, { bigint: true })), owner)) fail();
    }
    const parent = call(() => fstatSync(fd, { bigint: true }));
    if (parent.uid !== owner || (parent.mode & 0o7777n) !== 0o700n) fail();
    return fd;
  } catch (error) {
    call(() => closeSync(fd));
    throw error;
  }
}

function makeHandle(state: HandleState, bytes: Uint8Array): CredentialFileInspection {
  const handle: CredentialFileInspection = Object.freeze({
    identity: Object.freeze({ ...state.identity }),
    bytes: bytes.slice(),
    close() {
      const current = handles.get(handle);
      if (current === undefined || current.closed) return;
      current.closed = true;
      try { closeSync(current.fd); } catch { /* a closed descriptor has no further capability */ }
    },
  });
  handles.set(handle, state);
  return handle;
}

/** Descriptor-rooted custody for one already-existing, private credential directory. */
export class CredentialDirectory {
  readonly identity: CredentialFileIdentity;
  private closed = false;

  private constructor(token: object, private readonly path: string, private readonly fd: number) {
    if (token !== directoryToken) fail("handle");
    this.identity = Object.freeze(identity(fd));
    directories.add(this);
  }

  private assertCurrent(): void {
    if (!directories.has(this) || this.closed) fail("closed");
    const current = openQualifiedParent(this.path);
    try { if (!same(identity(current), this.identity)) fail("identity_changed"); }
    finally { call(() => closeSync(current)); }
  }

  private openExisting(name: string): number | null {
    const result = api().symbols.openChild(this.fd, ptr(validName(name)), 0);
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result > 0x7fffffff) fail("native");
    if (result === -2) return null;
    if (result < 0) fail();
    return result;
  }

  private state(handle: CredentialFileInspection): HandleState {
    if (typeof handle !== "object" || handle === null) fail();
    const state = handles.get(handle);
    if (state === undefined || state.directory !== this || state.closed) fail("handle");
    return state;
  }

  private verifyName(name: string, expected: CredentialFileIdentity): Uint8Array {
    const fd = this.openExisting(name);
    if (fd === null) fail("identity_changed");
    try { return readBounded(fd, expected); }
    finally { call(() => closeSync(fd)); }
  }

  inspect(name: string): CredentialFileInspection | null {
    this.assertCurrent();
    const fd = this.openExisting(name);
    if (fd === null) return null;
    try {
      fileIsSafe(fd);
      const found = identity(fd), bytes = readBounded(fd, found);
      this.assertCurrent();
      return makeHandle({ directory: this, fd, name, writable: false, identity: found, closed: false }, bytes);
    } catch (error) {
      call(() => closeSync(fd));
      throw error;
    }
  }

  create(name: string): CredentialFileInspection {
    this.assertCurrent();
    const result = api().symbols.createCredentialChild(this.fd, ptr(validName(name)));
    const fd = validFd(result);
    try {
      fileIsSafe(fd);
      const created = identity(fd);
      call(() => fsyncSync(fd));
      call(() => fsyncSync(this.fd));
      this.assertCurrent();
      const bytes = this.verifyName(name, created);
      if (bytes.length !== 0) fail("changed");
      return makeHandle({ directory: this, fd, name, writable: true, identity: created, closed: false }, bytes);
    } catch (error) {
      call(() => closeSync(fd));
      throw error;
    }
  }

  syncAndVerify(handle: CredentialFileInspection, expectedBytes: Uint8Array): void {
    if (!(expectedBytes instanceof Uint8Array) || expectedBytes.byteLength > MAX_CREDENTIAL_BYTES) fail("bounds");
    const state = this.state(handle);
    this.assertCurrent();
    fileIsSafe(state.fd, state.identity);
    call(() => fsyncSync(state.fd));
    call(() => fsyncSync(this.fd));
    const actual = this.verifyName(state.name, state.identity);
    if (!Buffer.from(actual).equals(Buffer.from(expectedBytes))) fail("changed");
    this.assertCurrent();
  }

  writeComplete(handle: CredentialFileInspection, bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_CREDENTIAL_BYTES) fail("bounds");
    const state = this.state(handle);
    if (!state.writable) fail("handle");
    let complete = false;
    try {
      this.assertCurrent();
      if (this.verifyName(state.name, state.identity).length !== 0) fail("changed");
      for (let offset = 0; offset < bytes.byteLength;) {
        const count = call(() => writeSync(state.fd, bytes, offset, bytes.byteLength - offset, offset));
        if (count <= 0) fail("write");
        offset += count;
      }
      this.syncAndVerify(handle, bytes);
      complete = true;
    } finally { if (complete) handle.close(); }
  }

  /** Same-process cleanup only. Restarted files are intentionally retained. */
  removeCreated(handle: CredentialFileInspection): void {
    const state = this.state(handle);
    if (!state.writable) fail("handle");
    this.assertCurrent();
    const fd = this.openExisting(state.name);
    if (fd === null) fail("identity_changed");
    try {
      fileIsSafe(state.fd, state.identity);
      fileIsSafe(fd, state.identity);
      this.assertCurrent();
      if (api().symbols.unlinkat(this.fd, ptr(validName(state.name)), 0) !== 0) fail();
      call(() => fsyncSync(this.fd));
      const residual = this.openExisting(state.name);
      if (residual !== null) { call(() => closeSync(residual)); fail("identity_changed"); }
      this.assertCurrent();
      handle.close();
    } finally { call(() => closeSync(fd)); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { closeSync(this.fd); } catch { /* closed capabilities have no effects */ }
  }

  static open(path: string): CredentialDirectory {
    api();
    const fd = openQualifiedParent(path);
    try { return new CredentialDirectory(directoryToken, path, fd); }
    catch (error) { call(() => closeSync(fd)); throw error; }
  }
}

export function openCredentialDirectory(absoluteParent: string): CredentialDirectory {
  return CredentialDirectory.open(absoluteParent);
}
