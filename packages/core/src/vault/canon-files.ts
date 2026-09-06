import { ptr } from "bun:ffi";
import type { BigIntStats } from "node:fs";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadOwnedDirectoryNative } from "../util/owned-directory-native";

// Internal byte adapter. Writer authorization, mutation scope and the receipt
// protocol surround this capability; it does not confer ledger authority.
export const MAX_CANON_FILE_BYTES = 1_048_576;
const MAX_DEPTH = 64;
export type CanonFilesFailure = "unsupported" | "native_unavailable" | "invalid_path" | "bounds" |
  "unsafe" | "changed" | "conflict" | "closed" | "handle" | "io";
export class CanonFilesError extends Error {
  constructor(readonly reason: CanonFilesFailure) { super(`canon_files_${reason}`); this.name = "CanonFilesError"; }
}
function fail(reason: CanonFilesFailure): never { throw new CanonFilesError(reason); }
function guarded<T>(work: () => T): T {
  try { return work(); } catch (error) { if (error instanceof CanonFilesError) throw error; fail("io"); }
}
let native: ReturnType<typeof loadOwnedDirectoryNative> | undefined;
function api() {
  if (process.platform !== "linux" || process.arch !== "x64" || process.geteuid === undefined) fail("unsupported");
  try { return native ??= loadOwnedDirectoryNative(); } catch { fail("native_unavailable"); }
}
function nameBytes(name: string): Buffer {
  const bytes = Buffer.from(name);
  if (!bytes.length || bytes.length > 255 || bytes.includes(0) || name.includes("/") || name.includes("\\") ||
      name === "." || name === ".." || bytes.toString("utf8") !== name) fail("invalid_path");
  return Buffer.concat([bytes, Buffer.from([0])]);
}
function parts(path: string): string[] {
  if (typeof path !== "string" || Buffer.byteLength(path) > 4096) fail("invalid_path");
  const result = path.split("/");
  if (result.length > MAX_DEPTH) fail("bounds");
  for (const part of result) nameBytes(part);
  return result;
}
function result(value: number | bigint): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value > 0x7fffffff || value < -4095) fail("io");
  return value;
}
function openChild(parent: number, name: string, directory: boolean): number | null {
  const bytes = nameBytes(name), fd = result(api().symbols.openChild(parent, ptr(bytes), directory ? 1 : 0));
  if (fd >= 0) return fd;
  if (fd === -2) return null;
  fail("unsafe");
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function directoryStat(fd: number, ancestor = false): BigIntStats {
  const stat = fstatSync(fd, { bigint: true }), uid = BigInt(process.geteuid!());
  if (!stat.isDirectory() || (stat.uid !== uid && (!ancestor || stat.uid !== 0n))) fail("unsafe");
  const trustedStickyAncestor = ancestor && stat.uid === 0n && (stat.mode & 0o1000n) !== 0n;
  if ((stat.mode & 0o022n) !== 0n && !trustedStickyAncestor) fail("unsafe");
  return stat;
}
function openRoot(path: string): number {
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000 /* Linux O_CLOEXEC */);
  try {
    directoryStat(fd, true);
    const components = path.split("/").filter(Boolean);
    for (const [index, part] of components.entries()) {
      const next = openChild(fd, part, true); if (next === null) fail("changed");
      closeSync(fd); fd = next;
      directoryStat(fd, index < components.length - 1);
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function readSnapshot(fd: number): { stat: BigIntStats; bytes: Buffer } {
  const before = fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.geteuid!()) || (before.mode & 0o022n) !== 0n) fail("unsafe");
  if (before.size < 0n || before.size > BigInt(MAX_CANON_FILE_BYTES)) fail("bounds");
  const bytes = Buffer.alloc(Number(before.size));
  for (let offset = 0; offset < bytes.length;) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0 || count > bytes.length - offset) fail("io");
    offset += count;
  }
  const after = fstatSync(fd, { bigint: true });
  if (!sameSnapshot(before, after)) fail("changed");
  return { stat: after, bytes };
}

declare const snapshotBrand: unique symbol;
export interface CanonFileSnapshot {
  readonly [snapshotBrand]: true;
  readonly path: string;
  /** Each access returns a copy; retained expected bytes cannot be edited. */
  readonly bytes: Uint8Array;
  close(): void;
}
export interface CanonFiles {
  read(path: string): CanonFileSnapshot | null;
  ensureDirectory(path: string): void;
  create(path: string, bytes: Uint8Array): CanonFileSnapshot;
  /** Recover only the exact receipt temp beside this live expected target. */
  resumeExactTemporary(target: CanonFileSnapshot, receiptId: string, bytes: Uint8Array): CanonFileSnapshot | null;
  replace(created: CanonFileSnapshot, expected: CanonFileSnapshot): CanonFileSnapshot;
  remove(expected: CanonFileSnapshot): void;
  close(): void;
}
interface FileRecord {
  fd: number;
  parent: number;
  path: string;
  stat: BigIntStats;
  bytes: Buffer;
  created: boolean;
  resumeTarget?: CanonFileSnapshot;
}

const ROOT_TOKEN = Symbol("canon-files-root");
const SCOPES = new WeakMap<CanonFiles, { path: string; assertCurrent(): void }>();

/** Validate a borrowed internal scope without exposing its root or descriptors. */
export function assertCanonFiles(files: CanonFiles, vaultPath: string): void {
  guarded(() => {
    const scope = SCOPES.get(files);
    if (!scope || typeof vaultPath !== "string" || scope.path !== resolve(vaultPath)) fail("handle");
    scope.assertCurrent();
  });
}

class NativeCanonFiles implements CanonFiles {
  readonly #records = new Map<CanonFileSnapshot, FileRecord>();
  readonly #identity: BigIntStats;
  readonly #path: string;
  readonly #fd: number;
  #closed = false;
  constructor(token: symbol, path: string, fd: number) {
    if (token !== ROOT_TOKEN) fail("handle");
    this.#path = path; this.#fd = fd; this.#identity = directoryStat(fd);
    SCOPES.set(this, { path, assertCurrent: () => this.#assertCurrent() });
  }
  #assertCurrent(): void {
    if (this.#closed) fail("closed");
    const current = openRoot(this.#path);
    try { if (!sameIdentity(directoryStat(current), this.#identity)) fail("changed"); }
    finally { closeSync(current); }
  }
  #directory(components: readonly string[], create = false): number | null {
    // Reopening the root through its captured absolute path validates its name;
    // child resolution below uses only the retained root descriptor.
    this.#assertCurrent();
    const dot = Buffer.from(".\0");
    let fd = result(api().symbols.openChild(this.#fd, ptr(dot), 1));
    if (fd < 0) fail("io");
    try {
      for (const name of components) {
        let next = openChild(fd, name, true);
        if (next === null && create) {
          const bytes = nameBytes(name), made = result(api().symbols.mkdirChild(fd, ptr(bytes)));
          if (made !== 0 && made !== -17) fail("io");
          next = openChild(fd, name, true);
          if (next === null) fail("changed");
          fsyncSync(fd);
        }
        if (next === null) { closeSync(fd); return null; }
        closeSync(fd); fd = next; directoryStat(fd);
      }
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  #release(handle: CanonFileSnapshot): void {
    const state = this.#records.get(handle); if (!state) return;
    this.#records.delete(handle);
    try { closeSync(state.fd); } finally { closeSync(state.parent); }
  }
  #handle(state: FileRecord): CanonFileSnapshot {
    const scope = this;
    const handle = Object.freeze({ path: state.path,
      get bytes() { return guarded(() => { scope.#record(handle); return Uint8Array.from(state.bytes); }); },
      close() { guarded(() => scope.#release(handle)); },
    }) as CanonFileSnapshot;
    this.#records.set(handle, state);
    return handle;
  }
  #record(handle: CanonFileSnapshot): FileRecord {
    if (this.#closed) fail("closed");
    const state = this.#records.get(handle); if (!state) fail("handle");
    return state;
  }
  #verify(state: FileRecord): void {
    const components = parts(state.path), name = components.pop()!;
    const parent = this.#directory(components); if (parent === null) fail("changed");
    try { if (!sameIdentity(directoryStat(parent), directoryStat(state.parent))) fail("changed"); }
    finally { closeSync(parent); }
    if (!sameSnapshot(state.stat, fstatSync(state.fd, { bigint: true }))) fail("changed");
    const current = openChild(state.parent, name, false); if (current === null) fail("changed");
    try {
      const observed = readSnapshot(current);
      if (!sameSnapshot(state.stat, observed.stat) || !state.bytes.equals(observed.bytes)) fail("changed");
    } finally { closeSync(current); }
  }
  read(path: string): CanonFileSnapshot | null {
    return guarded(() => {
      const components = parts(path), name = components.pop()!;
      const parent = this.#directory(components); if (parent === null) return null;
      let fd: number | null = null;
      try {
        fd = openChild(parent, name, false);
        if (fd === null) { closeSync(parent); return null; }
        const observed = readSnapshot(fd);
        const state = { fd, parent, path, ...observed, created: false };
        this.#verify(state);
        return this.#handle(state);
      } catch (error) { try { if (fd !== null) closeSync(fd); } finally { closeSync(parent); } throw error; }
    });
  }
  ensureDirectory(path: string): void {
    guarded(() => { const fd = this.#directory(parts(path), true); if (fd === null) fail("changed"); closeSync(fd); this.#assertCurrent(); });
  }
  create(path: string, input: Uint8Array): CanonFileSnapshot {
    return guarded(() => {
      const components = parts(path), name = components.pop()!;
      if (!(input instanceof Uint8Array) || input.byteLength > MAX_CANON_FILE_BYTES) fail("bounds");
      const bytes = Buffer.from(input), encoded = nameBytes(name);
      const parent = this.#directory(components); if (parent === null) fail("changed");
      let fd = -1, written = 0, opened: BigIntStats | undefined;
      try {
        fd = result(api().symbols.createCredentialChild(parent, ptr(encoded)));
        if (fd === -17) fail("conflict");
        if (fd < 0) fail("io");
        opened = fstatSync(fd, { bigint: true });
        while (written < bytes.length) {
          const count = writeSync(fd, bytes, written, bytes.length - written, written);
          if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - written) fail("io");
          written += count;
        }
        fsyncSync(fd); fsyncSync(parent);
        const observed = readSnapshot(fd);
        if (!observed.bytes.equals(bytes) || (observed.stat.mode & 0o777n) !== 0o600n) fail("changed");
        const state = { fd, parent, path, ...observed, created: true };
        this.#verify(state);
        return this.#handle(state);
      } catch (error) {
        // Best-effort cleanup is confined to this exclusive creation. A changed
        // entry is preserved; a later durability protocol owns crash recovery.
        try {
          if (opened) {
            const current = openChild(parent, name, false);
            if (current !== null) {
              let owned: boolean;
              try {
                const observed = readSnapshot(current);
                owned = sameIdentity(opened, observed.stat) && observed.bytes.equals(bytes.subarray(0, written));
              } finally { closeSync(current); }
              if (owned && result(api().symbols.unlinkChild(parent, ptr(encoded))) === 0) fsyncSync(parent);
            }
          }
        } catch { /* Preserve the original typed failure. */ }
        try { if (fd >= 0) closeSync(fd); } finally { closeSync(parent); }
        throw error;
      }
    });
  }
  resumeExactTemporary(target: CanonFileSnapshot, receiptId: string, input: Uint8Array): CanonFileSnapshot | null {
    return guarded(() => {
      const expected = this.#record(target); this.#verify(expected);
      if (typeof receiptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(receiptId)) fail("handle");
      if (!(input instanceof Uint8Array) || input.byteLength > MAX_CANON_FILE_BYTES) fail("bounds");
      const bytes = Buffer.from(input), components = parts(expected.path), name = components.pop()!;
      const temporary = [...components, `.${name}.${receiptId}.tmp`].join("/");
      const recovered = this.read(temporary); if (recovered === null) return null;
      try {
        const state = this.#record(recovered);
        if ((state.stat.mode & 0o077n) !== 0n || !state.bytes.equals(bytes)) fail("changed");
        fsyncSync(state.fd); this.#verify(state); this.#verify(expected);
        // This token can only replace this exact retained target. It gains no
        // creation or removal authority and makes no ledger-intent assertion.
        state.resumeTarget = target;
        return recovered;
      } catch (error) { recovered.close(); throw error; }
    });
  }
  replace(created: CanonFileSnapshot, expected: CanonFileSnapshot): CanonFileSnapshot {
    return guarded(() => {
      const source = this.#record(created), target = this.#record(expected);
      if ((!source.created && source.resumeTarget !== expected) || created === expected || source.path === target.path) fail("handle");
      this.#verify(source); this.#verify(target);
      const from = nameBytes(parts(source.path).at(-1)!), to = nameBytes(parts(target.path).at(-1)!);
      if (result(api().symbols.renameChild(source.parent, ptr(from), target.parent, ptr(to))) !== 0) fail("io");
      // renameat publishes by entry name, not compare-and-swap. Cooperating
      // writer exclusion is supplied by the separate mutation scope.
      try {
        fsyncSync(source.parent); fsyncSync(target.parent);
        const published = this.read(target.path);
        if (!published) fail("changed");
        const observed = this.#record(published);
        if (!sameIdentity(observed.stat, source.stat) || !observed.bytes.equals(source.bytes)) { published.close(); fail("changed"); }
        return published;
      } finally { try { this.#release(created); } finally { this.#release(expected); } }
    });
  }
  remove(expected: CanonFileSnapshot): void {
    guarded(() => {
      const state = this.#record(expected);
      if (state.resumeTarget !== undefined) fail("handle");
      this.#verify(state);
      const bytes = nameBytes(parts(state.path).at(-1)!);
      if (result(api().symbols.unlinkChild(state.parent, ptr(bytes))) !== 0) fail("io");
      try {
        const residual = openChild(state.parent, parts(state.path).at(-1)!, false);
        if (residual !== null) { closeSync(residual); fail("changed"); }
        fsyncSync(state.parent); this.#assertCurrent();
      }
      finally { this.#release(expected); }
    });
  }
  close(): void {
    guarded(() => {
      if (this.#closed) return; this.#closed = true;
      let failed = false;
      for (const handle of this.#records.keys()) { try { this.#release(handle); } catch { failed = true; } }
      try { closeSync(this.#fd); } catch { failed = true; }
      if (failed) fail("io");
    });
  }
}

/** Private Linux x64/glibc capability; no fallback or public core re-export. */
export function openCanonFiles(vaultPath: string): CanonFiles {
  return guarded(() => {
    api();
    if (typeof vaultPath !== "string" || !isAbsolute(vaultPath) || vaultPath.includes("\0")) fail("invalid_path");
    const absolute = resolve(vaultPath);
    if (absolute === "/" || absolute.split("/").length > 257) fail("bounds");
    const fd = openRoot(absolute);
    try { return new NativeCanonFiles(ROOT_TOKEN, absolute, fd); } catch (error) { closeSync(fd); throw error; }
  });
}
