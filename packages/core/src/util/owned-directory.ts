import { ptr } from "bun:ffi";
import type { Stats } from "node:fs";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync } from "node:fs";
import { tryAdvisoryFileLockFd, type AdvisoryFileLock } from "./advisory-file-lock";
import { resolve } from "node:path";
import { loadOwnedDirectoryNative } from "./owned-directory-native";

// Qualified Linux x86_64 glibc ABI: getdents64 is syscall 217; linux_dirent64
// has u64 ino/off, u16 reclen at 16, u8 type at 18, then d_name bytes at 19.
// No ABI claim is made for Darwin or other libc/architecture combinations.
let native: ReturnType<typeof loadOwnedDirectoryNative> | undefined;
function api() { return native ??= loadOwnedDirectoryNative(); }
function fail(kind = "unsafe"): never { throw new Error(`owned_directory_${kind}`); }
function nameBytes(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  if (!bytes.length || bytes.length > 255 || bytes.includes(0) || bytes.includes(47) || bytes.equals(Buffer.from(".")) || bytes.equals(Buffer.from(".."))) fail();
  return Buffer.concat([bytes, Buffer.from([0])]);
}
function childFd(parent: number, name: string | Buffer, directory = false): number | null {
  const bytes = nameBytes(name);
  const fd = api().symbols.openChild(parent, ptr(bytes), directory ? 1 : 0);
  if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd > 0x7fffffff) fail("abi_invalid");
  if (fd >= 0) return fd;
  if (fd === -2 /* kernel ENOENT at this open */) return null;
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
export type OwnedDirectoryPublicationReason = "invalid_name" | "bounds" | "unsafe" | "closed" | "identity_changed" | "abi_invalid" | "unsupported" | "native_unavailable" | "io" | "durability" | "destination_exists" | "destination_changed" | "destination_not_empty" | "reservation_exists";
export interface OwnedDirectoryPublicationState {
  readonly publication: "not_published" | "published" | "uncertain";
  readonly durability: "not_applicable" | "synced" | "uncertain";
  readonly cleanup_safe: boolean;
  /** Recovery hint only. Revalidate the inode before taking any later action. */
  readonly parked: { readonly name: string; readonly identity: OwnedDirectoryIdentity } | null;
}
export class OwnedDirectoryPublicationError extends Error implements OwnedDirectoryPublicationState {
  readonly publication: OwnedDirectoryPublicationState["publication"];
  readonly durability: OwnedDirectoryPublicationState["durability"];
  readonly cleanup_safe: boolean;
  readonly parked: OwnedDirectoryPublicationState["parked"];
  constructor(readonly reason: OwnedDirectoryPublicationReason, state: OwnedDirectoryPublicationState) {
    super(`owned_directory_publication_${reason}`);
    this.name = "OwnedDirectoryPublicationError";
    this.publication = state.publication;
    this.durability = state.durability;
    this.cleanup_safe = state.cleanup_safe;
    this.parked = state.parked;
  }
}
function publicationReason(error: unknown): OwnedDirectoryPublicationReason {
  const suffix = error instanceof Error ? error.message.replace(/^owned_directory_/, "") : "";
  switch (suffix) {
    case "invalid_name": case "bounds": case "unsafe": case "closed": case "identity_changed": case "abi_invalid":
    case "unsupported": case "native_unavailable": case "io": case "durability": case "destination_exists":
    case "destination_changed": case "destination_not_empty": case "reservation_exists": return suffix;
    default: return "io";
  }
}
function publicationName(name: string): void {
  if (typeof name !== "string" || name.includes("\\") || Buffer.from(name).toString("utf8") !== name) fail("invalid_name");
  try { nameBytes(name); } catch { fail("invalid_name"); }
}
function publicationIdentity(value: OwnedDirectoryIdentity): OwnedDirectoryIdentity {
  const dev = value?.dev, ino = value?.ino;
  if (typeof dev !== "bigint" || typeof ino !== "bigint" || dev < 0n || ino < 1n || dev > 0xffffffffffffffffn || ino > 0xffffffffffffffffn) fail("bounds");
  return { dev, ino };
}
function nativeStatus(status: number | bigint, exists: OwnedDirectoryPublicationReason): void {
  if (typeof status !== "number" || !Number.isInteger(status) || status > 0 || status < -4095) fail("abi_invalid");
  if (status === -17) fail(exists);
  if (status === -38 || status === -22 || status === -95) fail("unsupported");
  if (status !== 0) fail("io");
}
function childPresent(parent: number, name: string): boolean {
  const bytes = nameBytes(name), stat = Buffer.alloc(144); // Linux x86_64 struct stat.
  const status = api().symbols.statChild(parent, ptr(bytes), ptr(stat));
  if (status === -2) return false;
  nativeStatus(status, "destination_exists");
  return true;
}
function privateDirectory(fd: number, ownerOnly = true): void {
  const stat = fstatSync(fd, { bigint: true }), uid = process.geteuid?.();
  const stickyParent = !ownerOnly && stat.uid === 0n && (stat.mode & 0o1000n) !== 0n;
  if (uid === undefined || !stat.isDirectory() || stat.nlink < 1n || (!stickyParent && (stat.uid !== BigInt(uid) || (stat.mode & (ownerOnly ? 0o077n : 0o022n)) !== 0n))) fail("unsafe");
}
function emptyDirectory(fd: number): boolean {
  const dot = Buffer.from([46, 0]);
  const fresh = api().symbols.openChild(fd, ptr(dot), 1);
  if (typeof fresh !== "number" || !Number.isInteger(fresh) || fresh < 0 || fresh > 0x7fffffff) fail("unsafe");
  try {
    const before = fstatSync(fresh, { bigint: true });
    const empty = entries(fresh, 1, true).length === 0;
    const after = fstatSync(fresh, { bigint: true });
    if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.nlink !== after.nlink || before.size !== after.size) fail("identity_changed");
    return empty;
  } finally { closeSync(fresh); }
}
function syncDirectory(fd: number): void { try { fsyncSync(fd); } catch { fail("durability"); } }
function identity(fd: number): OwnedDirectoryIdentity { const stat = fstatSync(fd, { bigint: true }); return { dev: stat.dev, ino: stat.ino }; }
function same(a: OwnedDirectoryIdentity | null, b: OwnedDirectoryIdentity | null): boolean { return a === null ? b === null : b !== null && a.dev === b.dev && a.ino === b.ino; }
function entries(fd: number, remaining: number, stopAtFirst = false): Buffer[] {
  const duplicate = api().symbols.fcntl(fd, 1030 /* Linux F_DUPFD_CLOEXEC */, 0); if (duplicate < 0) fail();
  const result: Buffer[] = [];
  try {
    const buffer = Buffer.alloc(16_384), address = ptr(buffer);
    for (;;) {
      const count = api().symbols.syscall(217n, BigInt(duplicate), address, BigInt(buffer.length));
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count > buffer.length) fail("abi_invalid");
      if (count < 0) fail();
      if (count === 0) break;
      for (let offset = 0; offset < count;) {
        if (count - offset < 19) fail("abi_invalid");
        const length = buffer.readUInt16LE(offset + 16);
        if (length < 20 || length > 280 || offset + length > count) fail("abi_invalid");
        const raw = buffer.subarray(offset + 19, offset + length);
        const end = raw.indexOf(0); if (end < 1 || end > 255) fail("abi_invalid");
        const name = Buffer.from(raw.subarray(0, end));
        offset += length;
        if (name.equals(Buffer.from(".")) || name.equals(Buffer.from(".."))) continue;
        nameBytes(name);
        if (result.length >= remaining) fail("bounds");
        result.push(name);
        if (stopAtFirst) return result;
      }
    }
  } finally { closeSync(duplicate); }
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
  /** Read-only emptiness observation. A fresh description avoids inherited
   * readdir offsets; at most one non-dot entry is read and retained. */
  isEmpty(): boolean {
    this.assertCurrent();
    const dot = Buffer.from([46, 0]);
    const fd = api().symbols.openChild(this.fd, ptr(dot), 1);
    if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 0 || fd > 0x7fffffff) fail();
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!same({ dev: before.dev, ino: before.ino }, this.rootIdentity)) fail("identity_changed");
      const empty = entries(fd, 1, true).length === 0;
      const after = fstatSync(fd, { bigint: true });
      if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.nlink !== after.nlink || before.size !== after.size) fail("identity_changed");
      this.assertCurrent();
      return empty;
    } finally { closeSync(fd); }
  }
  childIdentity(name: string): OwnedDirectoryIdentity | null {
    this.assertCurrent(); const fd = childFd(this.fd, name, true);
    if (fd === null) return null;
    try { return identity(fd); } finally { closeSync(fd); }
  }
  private publicationParent(): void {
    this.assertCurrent();
    if (!same(identity(this.fd), this.rootIdentity)) fail("identity_changed");
    privateDirectory(this.fd, false);
  }
  private publicationChild(name: string, expected: OwnedDirectoryIdentity, empty = false): number {
    const fd = childFd(this.fd, name, true);
    if (fd === null) fail("identity_changed");
    try {
      if (!same(identity(fd), expected)) fail("identity_changed");
      privateDirectory(fd);
      if (empty && !emptyDirectory(fd)) fail("destination_not_empty");
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  /** Exclusive, descriptor-relative private staging creation. A thrown error
   * never authorizes deleting a name whose new inode was not returned. */
  createStaging(name: string): OwnedDirectoryIdentity {
    let attempted = false, fd: number | null = null;
    try {
      publicationName(name);
      this.publicationParent();
      const bytes = nameBytes(name);
      attempted = true;
      nativeStatus(api().symbols.mkdirChild(this.fd, ptr(bytes)), "destination_exists");
      fd = childFd(this.fd, name, true);
      if (fd === null) fail("identity_changed");
      privateDirectory(fd);
      const selected = identity(fd);
      syncDirectory(fd); syncDirectory(this.fd);
      this.publicationParent();
      const current = this.publicationChild(name, selected, true); closeSync(current);
      return selected;
    } catch (error) {
      throw new OwnedDirectoryPublicationError(publicationReason(error), {
        publication: "not_published", durability: attempted ? "uncertain" : "not_applicable", cleanup_safe: false, parked: null,
      });
    } finally { if (fd !== null) closeSync(fd); }
  }
  /** Publish a pinned private sibling without overwriting a destination entry.
   * The caller owns file-content sync and exclusion of other same-owner writers.
   * This is not an atomic source-inode compare-and-swap or a crash journal. */
  publishStaging(stagingName: string, stagingIdentity: OwnedDirectoryIdentity, destinationName: string,
    expectedDestinationIdentity: OwnedDirectoryIdentity | null): { publication: "published"; durability: "synced" } {
    let stage: OwnedDirectoryIdentity | null = null, destination: OwnedDirectoryIdentity | null = null;
    let stageFd: number | null = null, destinationFd: number | null = null;
    let parked: OwnedDirectoryPublicationState["parked"] = null;
    let parkingAttempted = false, publicationAttempted = false, published = false;
    const move = (from: string, to: string, exists: OwnedDirectoryPublicationReason): void => {
      const fromBytes = nameBytes(from), toBytes = nameBytes(to);
      nativeStatus(api().symbols.renameChildNoReplace(this.fd, ptr(fromBytes), this.fd, ptr(toBytes)), exists);
    };
    const checkChild = (name: string, expected: OwnedDirectoryIdentity, empty = false): void => {
      const fd = this.publicationChild(name, expected, empty); closeSync(fd);
    };
    try {
      publicationName(stagingName); publicationName(destinationName);
      if (stagingName === destinationName) fail("invalid_name");
      stage = publicationIdentity(stagingIdentity);
      destination = expectedDestinationIdentity === null ? null : publicationIdentity(expectedDestinationIdentity);
      if (same(stage, destination)) fail("invalid_name");
      this.publicationParent();
      stageFd = this.publicationChild(stagingName, stage);
      if (stage.dev !== this.rootIdentity.dev) fail("unsupported");
      if (destination === null) {
        if (childPresent(this.fd, destinationName)) fail("destination_exists");
      } else {
        if (!same(this.childIdentity(destinationName), destination)) fail("destination_changed");
        destinationFd = this.publicationChild(destinationName, destination, true);
        if (destination.dev !== this.rootIdentity.dev) fail("unsupported");
        const name = `.kizuki-empty-${destination.dev.toString(16)}-${destination.ino.toString(16)}-${stage.ino.toString(16)}`;
        if (name === stagingName || name === destinationName) fail("invalid_name");
        if (childPresent(this.fd, name)) fail("reservation_exists");
        parked = { name, identity: destination };
      }
      syncDirectory(stageFd);
      this.publicationParent(); checkChild(stagingName, stage);
      if (parked !== null && destination !== null) {
        checkChild(destinationName, destination, true);
        parkingAttempted = true;
        move(destinationName, parked.name, "reservation_exists");
        this.publicationParent(); checkChild(parked.name, destination, true);
        syncDirectory(destinationFd!); syncDirectory(this.fd);
      }
      this.publicationParent(); checkChild(stagingName, stage);
      if (childPresent(this.fd, destinationName)) fail("destination_exists");
      publicationAttempted = true;
      move(stagingName, destinationName, "destination_exists");
      published = true;
      this.publicationParent(); checkChild(destinationName, stage);
      if (childPresent(this.fd, stagingName)) fail("identity_changed");
      syncDirectory(stageFd); syncDirectory(this.fd);
      if (parked !== null && destination !== null) {
        this.publicationParent(); checkChild(parked.name, destination, true);
        const bytes = nameBytes(parked.name);
        nativeStatus(api().symbols.removeEmptyChild(this.fd, ptr(bytes)), "reservation_exists");
        if (childPresent(this.fd, parked.name)) fail("identity_changed");
        parked = null;
        syncDirectory(this.fd);
      }
      this.publicationParent(); checkChild(destinationName, stage);
      if (childPresent(this.fd, stagingName)) fail("identity_changed");
      return { publication: "published", durability: "synced" };
    } catch (error) {
      const reason = publicationReason(error);
      let publication: OwnedDirectoryPublicationState["publication"] = published || publicationAttempted ? "uncertain" : "not_published";
      let durability: OwnedDirectoryPublicationState["durability"] = parkingAttempted || publicationAttempted ? "uncertain" : "not_applicable";
      let cleanup_safe = false;
      try {
        this.publicationParent();
        if (stage !== null && stageFd !== null) {
          if (publicationAttempted && !childPresent(this.fd, stagingName) && same(this.childIdentity(destinationName), stage)) {
            checkChild(destinationName, stage);
            publication = "published";
          } else if (!published) {
            checkChild(stagingName, stage);
            if (parkingAttempted && parked !== null && destination !== null) {
              if (childPresent(this.fd, parked.name)) {
                checkChild(parked.name, destination, true);
                if (childPresent(this.fd, destinationName)) fail("destination_changed");
                move(parked.name, destinationName, "destination_exists");
              }
              checkChild(destinationName, destination, true);
              if (childPresent(this.fd, parked.name)) fail("identity_changed");
              parked = null;
            }
            if (destination !== null) checkChild(destinationName, destination, true);
            if (publicationAttempted && childPresent(this.fd, destinationName) && destination === null) fail("destination_changed");
            if (parkingAttempted || publicationAttempted) {
              if (destinationFd !== null) syncDirectory(destinationFd);
              syncDirectory(this.fd); durability = "synced";
            }
            this.publicationParent(); checkChild(stagingName, stage);
            publication = "not_published"; cleanup_safe = true;
          }
        }
      } catch { /* Preserve all remaining names when original state is unproven. */ }
      throw new OwnedDirectoryPublicationError(reason, { publication, durability, cleanup_safe, parked: parkingAttempted ? parked : null });
    } finally {
      if (stageFd !== null) closeSync(stageFd);
      if (destinationFd !== null) closeSync(destinationFd);
    }
  }
  private relativeFd(parts: readonly string[]): number | null {
    if (this.closed) fail("closed");
    if (parts.length < 1 || parts.length > 64) fail("bounds");
    let parent = this.fd, owned = false;
    try {
      for (const [index, part] of parts.entries()) {
        const next = childFd(parent, part, index < parts.length - 1);
        if (owned) { closeSync(parent); owned = false; }
        if (next === null) return null;
        parent = next; owned = true;
      }
      owned = false; return parent;
    } finally { if (owned) closeSync(parent); }
  }
  /** Bounded descriptor-relative metadata inspection; no pathname side effects. */
  inspect(parts: readonly string[]): Stats | null {
    const fd = this.relativeFd(parts); if (fd === null) return null;
    try { return fstatSync(fd); } finally { closeSync(fd); }
  }
  readFile(parts: readonly string[], maxBytes: number): Uint8Array | null {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) fail("bounds");
    const fd = this.relativeFd(parts); if (fd === null) return null;
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) fail();
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) { const read = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) fail(); offset += read; }
      const after = fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("identity_changed");
      return bytes;
    } finally { closeSync(fd); }
  }
  /** Maintenance locks only an existing inode, using the ordinary flock owner. */
  tryLock(parts: readonly string[]): AdvisoryFileLock | null {
    this.assertCurrent();
    const fd = this.relativeFd(parts); if (fd === null) fail("lock_missing");
    return tryAdvisoryFileLockFd(fd, () => {
      this.assertCurrent();
      const current = this.inspect(parts); if (current === null) fail("identity_changed");
      return current;
    });
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
