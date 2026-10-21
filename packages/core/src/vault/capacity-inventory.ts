import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, lstatSync, readFileSync, readSync, realpathSync, statfsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// This is a resource upper bound, never a cache of canon meaning. In particular,
// mmap can change a page's status without an inotify event, so EVERY candidate
// reserves a potentially live slot. Exact classification remains a fresh walk.
const MAX_VAULTS = 4;
const MAX_WATCHES = 65_536;
const MAX_DRAIN_BYTES = 4 * 1024 * 1024;
const MODIFY = 0x2, ATTRIB = 0x4, CLOSE_WRITE = 0x8;
const MOVED_FROM = 0x40, MOVED_TO = 0x80, CREATE = 0x100, DELETE = 0x200;
const DELETE_SELF = 0x400, MOVE_SELF = 0x800, UNMOUNT = 0x2000, OVERFLOW = 0x4000, IGNORED = 0x8000;
const ISDIR = 0x40000000, DONT_FOLLOW = 0x02000000, ONLYDIR = 0x01000000;
const MASK = MODIFY | ATTRIB | CLOSE_WRITE | MOVED_FROM | MOVED_TO | CREATE | DELETE | DELETE_SELF | MOVE_SELF;
// Remote, overlay and otherwise unqualified filesystems use the exact fallback.
const LOCAL_FILESYSTEMS = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994]);

let native: ReturnType<typeof load> | undefined;
function load() {
  return dlopen("libc.so.6", {
    inotify_init1: { args: [FFIType.i32], returns: FFIType.i32 },
    inotify_add_watch: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    inotify_rm_watch: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}

function mounts(): string {
  const bytes = readFileSync("/proc/self/mountinfo");
  if (bytes.length > 1024 * 1024) throw new Error("mount inventory bound");
  return bytes.toString("utf8");
}

function candidate(path: string): boolean {
  return path.endsWith(".md") && path !== "CANON.md" && path !== "SCHEMA.md";
}

interface Watch { path: string; directory: boolean; identity: string }
export interface CapacityBound { readonly files: number; readonly bytes: number }

/** Private, disposable, process-local resource accounting. No serving data. */
export class CapacityInventory {
  private fd: number;
  private watches = new Map<number, Watch>();
  private byPath = new Map<string, number>();
  private retired = new Set<number>();
  private sizes = new Map<string, number>();
  private bytes = 0;
  private ready = false;
  private readonly root: string;
  private readonly mountTable: string;
  private readonly rootIdentity: string;
  private readonly device: number;

  constructor(readonly vault: string) {
    if (process.platform !== "linux") throw new Error("resource notifications unavailable");
    this.root = realpathSync(vault);
    const root = lstatSync(this.root);
    if (!root.isDirectory() || !LOCAL_FILESYSTEMS.has(statfsSync(this.root).type)) throw new Error("unqualified filesystem");
    this.device = root.dev;
    this.rootIdentity = `${root.dev}:${root.ino}`;
    this.mountTable = mounts();
    // A nested/bind mount can hide an unmonitored backing tree. A mount-table
    // change invalidates every established bound before it can authorize work.
    for (const line of this.mountTable.split("\n")) {
      const target = line.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if (target?.startsWith(`${this.root}/`)) throw new Error("nested mount");
    }
    native ??= load();
    this.fd = native.symbols.inotify_init1(0x800 | 0x80000); // NONBLOCK | CLOEXEC
    if (this.fd < 0) throw new Error("resource watch unavailable");
  }

  close(): void {
    this.ready = false;
    if (this.fd >= 0) { closeSync(this.fd); this.fd = -1; }
    this.watches.clear(); this.byPath.clear(); this.retired.clear(); this.sizes.clear();
  }

  private watch(path: string, directory: boolean): void {
    if (this.fd < 0) return;
    const absolute = join(this.root, path);
    const stat = lstatSync(absolute);
    if (stat.dev !== this.device || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("inventory identity");
    const identity = `${stat.dev}:${stat.ino}`;
    const previous = this.byPath.get(path);
    if (previous !== undefined && this.watches.get(previous)?.identity === identity) {
      if (!directory) this.size(path, stat.size);
      return;
    }
    if (previous !== undefined) this.remove(path);
    if (this.watches.size >= MAX_WATCHES) throw new Error("resource watch bound");
    const encoded = Buffer.from(`${absolute}\0`);
    const wd = native!.symbols.inotify_add_watch(this.fd, ptr(encoded), MASK | DONT_FOLLOW | (directory ? ONLYDIR : 0));
    if (wd < 0 || this.watches.has(wd)) throw new Error("resource watch alias or limit");
    this.watches.set(wd, { path, directory, identity });
    this.byPath.set(path, wd);
    const watched = lstatSync(absolute);
    if (`${watched.dev}:${watched.ino}` !== identity || watched.isSymbolicLink()) throw new Error("resource watch replaced");
    if (!directory) this.size(path, watched.size);
  }

  private size(path: string, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("resource size");
    this.bytes += size - (this.sizes.get(path) ?? 0);
    if (!Number.isSafeInteger(this.bytes) || this.bytes < 0) throw new Error("resource total");
    this.sizes.set(path, size);
  }

  private remove(path: string): void {
    const wd = this.byPath.get(path);
    if (wd !== undefined) {
      native!.symbols.inotify_rm_watch(this.fd, wd);
      this.retired.add(wd); this.watches.delete(wd); this.byPath.delete(path);
      if (this.retired.size > MAX_WATCHES) throw new Error("retired resource watch bound");
    }
    this.bytes -= this.sizes.get(path) ?? 0;
    this.sizes.delete(path);
  }

  /** Called by the existing walk BEFORE it enumerates a directory or reads a file. */
  observe(path: string, directory: boolean): void {
    if (this.fd < 0) return;
    try { this.watch(relative(resolve(this.vault), path).split(sep).join("/"), directory); }
    catch { this.close(); }
  }

  private drain(): Set<string> {
    const dirty = new Set<string>();
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      let count: number;
      try { count = readSync(this.fd, buffer, 0, buffer.length, null); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EAGAIN") break; throw error; }
      if (count === 0 || (total += count) > MAX_DRAIN_BYTES) throw new Error("resource notification bound");
      for (let offset = 0; offset < count;) {
        if (offset + 16 > count) throw new Error("resource notification shape");
        const wd = buffer.readInt32LE(offset), mask = buffer.readUInt32LE(offset + 4), length = buffer.readUInt32LE(offset + 12);
        if (offset + 16 + length > count || (mask & (OVERFLOW | UNMOUNT)) !== 0) throw new Error("resource notification loss");
        const watch = this.watches.get(wd);
        if (watch === undefined) {
          if (!this.retired.has(wd)) throw new Error("unknown resource watch");
          if ((mask & IGNORED) !== 0) this.retired.delete(wd);
        } else if (watch.directory) {
          if ((mask & (DELETE_SELF | MOVE_SELF | IGNORED)) !== 0) throw new Error("directory identity changed");
          const nameBytes = buffer.subarray(offset + 16, offset + 16 + length);
          const end = nameBytes.indexOf(0);
          if (end < 0) throw new Error("directory event termination");
          const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes.subarray(0, end));
          if (name === "" || name.includes("/") || name === "." || name === "..") throw new Error("directory event shape");
          const path = watch.path === "" ? name : `${watch.path}/${name}`;
          if (watch.path === "" && (name === ".kizuki" || name === "archive")) { /* excluded control trees */ }
          else if ((mask & ISDIR) !== 0) throw new Error("directory inventory changed");
          else if (candidate(path)) {
            if (path.split("/").length > 8) throw new Error("resource path depth");
            dirty.add(path);
          }
        } else {
          dirty.add(watch.path);
          // The kernel can retire an inode watch after unlink. Do not reuse its
          // old identity even if the filesystem later recycles that inode.
          if ((mask & IGNORED) !== 0) {
            this.watches.delete(wd);
            if (this.byPath.get(watch.path) === wd) this.byPath.delete(watch.path);
          }
        }
        offset += 16 + length;
      }
    }
    return dirty;
  }

  finish(complete: boolean): void {
    if (!complete || this.fd < 0) { this.close(); return; }
    try {
      // A concurrent change during the establishing scan must not be dismissed.
      if (this.drain().size !== 0) throw new Error("inventory changed during scan");
      this.ready = true;
    } catch { this.close(); }
  }

  current(): CapacityBound | null {
    if (!this.ready || this.fd < 0) return null;
    try {
      const root = lstatSync(this.root);
      if (realpathSync(this.vault) !== this.root || `${root.dev}:${root.ino}` !== this.rootIdentity || mounts() !== this.mountTable) throw new Error("inventory root changed");
      for (let round = 0; round < 4; round++) {
        const dirty = this.drain();
        if (dirty.size === 0) return { files: this.sizes.size, bytes: this.bytes };
        for (const path of dirty) {
          let stat;
          try { stat = lstatSync(join(this.root, path)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.remove(path); continue; }
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("candidate identity changed");
          this.watch(path, false);
        }
      }
      throw new Error("inventory continuously changing");
    } catch { this.close(); return null; }
  }
}

const inventories = new Map<string, CapacityInventory>();

/** Only full, unscoped maintenance walks may seed a writer resource bound. */
export function beginCapacityInventory(vault: string): CapacityInventory | null {
  const key = resolve(vault);
  inventories.get(key)?.close(); inventories.delete(key);
  while (inventories.size >= MAX_VAULTS) {
    const oldest = inventories.keys().next().value!;
    inventories.get(oldest)!.close(); inventories.delete(oldest);
  }
  try { const inventory = new CapacityInventory(key); inventories.set(key, inventory); return inventory; }
  catch { return null; }
}

export function currentCapacityBound(vault: string): CapacityBound | null {
  const key = resolve(vault), inventory = inventories.get(key);
  if (inventory === undefined) return null;
  const bound = inventory.current();
  if (bound === null) inventories.delete(key);
  else { inventories.delete(key); inventories.set(key, inventory); }
  return bound;
}
