import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { closeSync, constants, fstatSync, fsyncSync, openSync } from "node:fs";
import { resolve } from "node:path";

// Qualified Linux x86_64 glibc ABI: bits/dirent.h has u64 ino/off,
// u16 reclen at 16, u8 type at 18, followed by native d_name bytes at 19.
// No ABI claim is made for Darwin or other libc/architecture combinations.
let native: ReturnType<typeof load> | undefined;
function load() {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("owned_directory_unsupported");
  return dlopen("libc.so.6", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
    readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
}
function api() { return native ??= load(); }
function fail(kind = "unsafe"): never { throw new Error(`owned_directory_${kind}`); }
function errno() { const pointer = api().symbols.__errno_location(); if (!pointer) fail(); return new DataView(toArrayBuffer(pointer, 0, 4)); }
function nameBytes(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  if (!bytes.length || bytes.length > 255 || bytes.includes(0) || bytes.includes(47) || bytes.equals(Buffer.from(".")) || bytes.equals(Buffer.from(".."))) fail();
  return Buffer.concat([bytes, Buffer.from([0])]);
}
function childFd(parent: number, name: string | Buffer, directory = false): number | null {
  const bytes = nameBytes(name);
  const fd = api().symbols.openat(parent, ptr(bytes), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x80000 /* Linux O_CLOEXEC */ | (directory ? constants.O_DIRECTORY : 0), 0);
  if (fd >= 0) return fd;
  if (errno().getInt32(0, true) === 2) return null; // ENOENT, never ELOOP/ENOTDIR.
  fail();
}
function openPath(path: string): number {
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of resolve(path).split("/").filter(Boolean)) {
      const next = childFd(fd, component, true); if (next === null) fail("identity_changed");
      closeSync(fd); fd = next;
    }
    return fd;
  } catch { closeSync(fd); fail("identity_changed"); }
}
export interface OwnedDirectoryIdentity { readonly dev: bigint; readonly ino: bigint; }
function identity(fd: number): OwnedDirectoryIdentity { const stat = fstatSync(fd, { bigint: true }); return { dev: stat.dev, ino: stat.ino }; }
function same(a: OwnedDirectoryIdentity | null, b: OwnedDirectoryIdentity | null): boolean { return a === null ? b === null : b !== null && a.dev === b.dev && a.ino === b.ino; }
function entries(fd: number, remaining: number): Buffer[] {
  const duplicate = api().symbols.fcntl(fd, 1030 /* Linux F_DUPFD_CLOEXEC */, 0); if (duplicate < 0) fail();
  const directory = api().symbols.fdopendir(duplicate);
  if (!directory) { closeSync(duplicate); fail(); }
  const result: Buffer[] = [];
  try {
    for (;;) {
      errno().setInt32(0, 0, true);
      const entry = api().symbols.readdir(directory);
      if (!entry) { if (errno().getInt32(0, true) !== 0) fail(); break; }
      const header = new DataView(toArrayBuffer(entry, 0, 19));
      const length = header.getUint16(16, true);
      if (length < 20 || length > 280) fail("abi_invalid");
      const raw = Buffer.from(toArrayBuffer(entry, 19, length - 19));
      const end = raw.indexOf(0); if (end < 1 || end > 255) fail("abi_invalid");
      const name = Buffer.from(raw.subarray(0, end));
      if (name.equals(Buffer.from(".")) || name.equals(Buffer.from(".."))) continue;
      nameBytes(name);
      if (result.length >= remaining) fail("bounds");
      result.push(name);
    }
  } finally { if (api().symbols.closedir(directory) !== 0) fail(); }
  return result;
}
/** Root capability never resolves deletion through a pathname or a /proc fd alias. */
export class OwnedDirectory {
  private closed = false;
  private readonly rootIdentity: OwnedDirectoryIdentity;
  constructor(private readonly path: string, private readonly fd: number) { this.rootIdentity = identity(fd); }
  assertCurrent(): void {
    if (this.closed) fail("closed");
    const current = openPath(this.path);
    try { if (!same(identity(current), this.rootIdentity)) fail("identity_changed"); } finally { closeSync(current); }
  }
  childIdentity(name: string): OwnedDirectoryIdentity | null {
    this.assertCurrent(); const fd = childFd(this.fd, name, true);
    if (fd === null) return null;
    try { return identity(fd); } finally { closeSync(fd); }
  }
  removeTree(name: string, expected: OwnedDirectoryIdentity | null): void {
    this.assertCurrent();
    let count = 1;
    const remove = (parent: number, name: string | Buffer, expected: OwnedDirectoryIdentity | null | undefined, depth: number): void => {
      if (depth > 64) fail("bounds");
      const fd = childFd(parent, name);
      if (fd === null) { if (expected !== undefined && expected !== null) fail("identity_changed"); return; }
      try {
        const opened = identity(fd), stat = fstatSync(fd);
        if (expected !== undefined && !same(opened, expected)) fail("identity_changed");
        if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail();
        if (stat.isDirectory()) {
          const children = entries(fd, 100_000 - count);
          count += children.length;
          for (const child of children) remove(fd, child, undefined, depth + 1);
          fsyncSync(fd);
        }
        const current = childFd(parent, name);
        if (current === null) fail("identity_changed");
        try { if (!same(identity(current), opened)) fail("identity_changed"); } finally { closeSync(current); }
        const bytes = nameBytes(name);
        // unlinkat never follows a final symlink; directory removal requires empty dir.
        if (api().symbols.unlinkat(parent, ptr(bytes), stat.isDirectory() ? 0x200 : 0) !== 0) fail();
      } finally { closeSync(fd); }
    };
    remove(this.fd, name, expected, 0);
    const residual = childFd(this.fd, name);
    if (residual !== null) { closeSync(residual); fail("absence_unproven"); }
    fsyncSync(this.fd);
    this.assertCurrent();
  }
  close(): void { if (!this.closed) { this.closed = true; closeSync(this.fd); } }
}
export function openOwnedDirectory(path: string): OwnedDirectory {
  api();
  const absolute = resolve(path);
  if (absolute.split("/").length > 257) fail("bounds");
  return new OwnedDirectory(absolute, openPath(absolute));
}
