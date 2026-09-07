import { cc, dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, writeFileSync, writeSync } from "node:fs";

// Linux x86_64 only. Return the kernel's signed result directly: consulting
// libc errno after returning through FFI can observe a later runtime operation.
// The fixed flags are RDONLY | NOFOLLOW | NONBLOCK | CLOEXEC, optionally
// DIRECTORY. The read helper cannot create; credential creation has its own
// fixed exclusive-create helper below.
const source = `
long kizuki_open_owned_child(int parent, const char *name, int directory) {
  long result;
  long flags = 0x20000L | 0x800L | 0x80000L | (directory ? 0x10000L : 0);
  register long mode __asm__("r10") = 0;
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(257L), "D"((long)parent), "S"(name), "d"(flags), "r"(mode)
    : "rcx", "r11", "memory", "cc");
  return result;
}
long kizuki_create_credential_child(int parent, const char *name) {
  long result;
  long flags = 0x40L | 0x80L | 0x2L | 0x20000L | 0x80000L;
  register long mode __asm__("r10") = 0600;
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(257L), "D"((long)parent), "S"(name), "d"(flags), "r"(mode)
    : "rcx", "r11", "memory", "cc");
  return result;
}
long kizuki_open_receipt_append_child(int parent, const char *name, int exclusive) {
  if (exclusive != 0 && exclusive != 1) return -22L;
  long result;
  long flags = 0x1L | 0x400L | 0x20000L | 0x800L | 0x80000L | (exclusive ? 0x40L | 0x80L : 0);
  register long mode __asm__("r10") = 0600;
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(257L), "D"((long)parent), "S"(name), "d"(flags), "r"(mode)
    : "rcx", "r11", "memory", "cc");
  return result;
}
long kizuki_open_receipt_read_append_child(int parent, const char *name, int exclusive) {
  if (exclusive != 0 && exclusive != 1) return -22L;
  long result;
  long flags = 0x2L | 0x400L | 0x20000L | 0x800L | 0x80000L | (exclusive ? 0x40L | 0x80L : 0);
  register long mode __asm__("r10") = 0600;
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(257L), "D"((long)parent), "S"(name), "d"(flags), "r"(mode)
    : "rcx", "r11", "memory", "cc");
  return result;
}
long kizuki_stat_owned_child(int parent, const char *name, void *stat_buffer) {
  long result;
  register long flags __asm__("r10") = 0x100L;
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(262L), "D"((long)parent), "S"(name), "d"(stat_buffer), "r"(flags)
    : "rcx", "r11", "memory", "cc");
  return result;
}
long kizuki_mkdir_owned_child(int parent, const char *name) {
  long result;
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(258L), "D"((long)parent), "S"(name), "d"(0700L)
    : "rcx", "r11", "memory", "cc");
  return result;
}
long kizuki_rename_owned_child(int from_parent, const char *from_name,
                              int to_parent, const char *to_name) {
  long result;
  register const char *destination __asm__("r10") = to_name;
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(264L), "D"((long)from_parent), "S"(from_name), "d"((long)to_parent), "r"(destination)
    : "rcx", "r11", "memory", "cc");
  return result;
}
long kizuki_unlink_owned_child(int parent, const char *name) {
  long result;
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(263L), "D"((long)parent), "S"(name), "d"(0L)
    : "rcx", "r11", "memory", "cc");
  return result;
}
long kizuki_rename_owned_child_noreplace(int from_parent, const char *from_name,
                                        int to_parent, const char *to_name) {
  long result;
  register const char *destination __asm__("r10") = to_name;
  register long flags __asm__("r8") = 1L; /* RENAME_NOREPLACE */
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(316L), "D"((long)from_parent), "S"(from_name), "d"((long)to_parent), "r"(destination), "r"(flags)
    : "rcx", "r11", "memory", "cc");
  return result;
}
long kizuki_remove_empty_owned_child(int parent, const char *name) {
  long result;
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(263L), "D"((long)parent), "S"(name), "d"(0x200L) /* AT_REMOVEDIR */
    : "rcx", "r11", "memory", "cc");
  return result;
}
`;

/** Fixed, sealed source needs no compiler executable, headers or writable path.
 * Both library handles remain rooted for the lifetime of the cached API. */
function loadLinuxOwnedDirectoryNative() {
  const libc = dlopen("libc.so.6", {
    memfd_create: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
  });
  try {
    const label = Buffer.from("kizuki-owned-directory\0");
    const fd = libc.symbols.memfd_create(ptr(label), 3 /* CLOEXEC | ALLOW_SEALING */);
    if (fd < 0) throw new Error("owned_directory_native_unavailable");
    try {
      writeFileSync(fd, source);
      if (libc.symbols.fcntl(fd, 1033 /* F_ADD_SEALS */, 15) !== 0 ||
          libc.symbols.fcntl(fd, 1034 /* F_GET_SEALS */, 0) !== 15) {
        throw new Error("owned_directory_native_unavailable");
      }
      const compiled = cc({
        flags: ["-nostdlib", "-x", "c"],
        source: `/proc/self/fd/${fd}`,
        symbols: {
          kizuki_open_owned_child: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64_fast },
          kizuki_create_credential_child: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
          kizuki_open_receipt_append_child: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64_fast },
          kizuki_open_receipt_read_append_child: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64_fast },
          kizuki_stat_owned_child: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i64_fast },
          kizuki_mkdir_owned_child: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
          kizuki_rename_owned_child: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
          kizuki_unlink_owned_child: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
          kizuki_rename_owned_child_noreplace: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
          kizuki_remove_empty_owned_child: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
        },
      });
      return {
        libc,
        compiled,
        symbols: {
          ...libc.symbols,
          duplicateDirectory: (descriptor: number) => libc.symbols.fcntl(descriptor, 1030 /* F_DUPFD_CLOEXEC */, 0),
          readDirectory: (descriptor: number, address: ReturnType<typeof ptr>, length: number) =>
            libc.symbols.syscall(217n, BigInt(descriptor), address, BigInt(length)),
          openChild: compiled.symbols.kizuki_open_owned_child,
          createCredentialChild: compiled.symbols.kizuki_create_credential_child,
          openReceiptAppendChild: compiled.symbols.kizuki_open_receipt_append_child,
          openReceiptReadAppendChild: compiled.symbols.kizuki_open_receipt_read_append_child,
          statChild: compiled.symbols.kizuki_stat_owned_child,
          mkdirChild: compiled.symbols.kizuki_mkdir_owned_child,
          renameChild: compiled.symbols.kizuki_rename_owned_child,
          unlinkChild: compiled.symbols.kizuki_unlink_owned_child,
          renameChildNoReplace: compiled.symbols.kizuki_rename_owned_child_noreplace,
          removeEmptyChild: compiled.symbols.kizuki_remove_empty_owned_child,
        },
      };
    } finally { closeSync(fd); }
  } catch {
    libc.close();
    throw new Error("owned_directory_native_unavailable");
  }
}

// Darwin ARM64 uses libSystem entry points, with errno captured in C before
// another FFI/runtime call. The normalized stat and directory records retain
// this module's existing private Linux-shaped layout; callers never decode a
// Darwin struct. No SDK headers, linker search paths or external compiler are
// needed. openat's variadic mode argument is deliberately passed inside C.
const darwinSource = `
static void *functions[9];
#define FN(n, type) ((type)functions[n])
void kizuki_initialize(void *a, void *b, void *c, void *d, void *e, void *f, void *g, void *h, void *i) {
  functions[0]=a; functions[1]=b; functions[2]=c; functions[3]=d; functions[4]=e;
  functions[5]=f; functions[6]=g; functions[7]=h; functions[8]=i;
}
static long result(long value) {
  if (value >= 0) return value;
  int error = *FN(8, int *(*)(void))();
  switch (error) {
    case 45: case 102: error=95; break;
    case 62: error=40; break;
    case 63: error=36; break;
    case 66: error=39; break;
    case 78: error=38; break;
  }
  return error > 0 && error < 4096 ? -error : -5;
}
long kizuki_open_owned_child(int parent, const char *name, int directory) {
  if (directory != 0 && directory != 1) return -22;
  return result(FN(0, int (*)(int, const char *, int, ...))(parent, name,
    0x100 | 0x4 | 0x1000000 | (directory ? 0x100000 : 0), 0));
}
long kizuki_create_credential_child(int parent, const char *name) {
  return result(FN(0, int (*)(int, const char *, int, ...))(parent, name,
    0x200 | 0x800 | 0x2 | 0x100 | 0x1000000, 0600));
}
long kizuki_open_receipt_append_child(int parent, const char *name, int exclusive) {
  if (exclusive != 0 && exclusive != 1) return -22;
  return result(FN(0, int (*)(int, const char *, int, ...))(parent, name,
    0x1 | 0x8 | 0x100 | 0x4 | 0x1000000 | (exclusive ? 0x200 | 0x800 : 0), 0600));
}
long kizuki_open_receipt_read_append_child(int parent, const char *name, int exclusive) {
  if (exclusive != 0 && exclusive != 1) return -22;
  return result(FN(0, int (*)(int, const char *, int, ...))(parent, name,
    0x2 | 0x8 | 0x100 | 0x4 | 0x1000000 | (exclusive ? 0x200 | 0x800 : 0), 0600));
}
struct darwin_stat {
  unsigned int dev; unsigned short mode, nlink; unsigned long ino;
  unsigned int uid, gid, rdev;
  long times[8], size, blocks;
  int blocksize; unsigned int flags, generation; int spare; long reserved[2];
};
_Static_assert(sizeof(struct darwin_stat) == 144, "Darwin ARM64 stat ABI");
long kizuki_stat_owned_child(int parent, const char *name, unsigned char *out) {
  struct darwin_stat value;
  long status=result(FN(1, int (*)(int, const char *, void *, int))(parent, name, &value, 0x20));
  if (status < 0) return status;
  for (int i=0; i<144; i++) out[i]=0;
  *(unsigned long *)(out+0)=value.dev; *(unsigned long *)(out+8)=value.ino;
  *(unsigned long *)(out+16)=value.nlink; *(unsigned int *)(out+24)=value.mode;
  *(unsigned int *)(out+28)=value.uid; *(unsigned int *)(out+32)=value.gid;
  *(long *)(out+48)=value.size;
  *(long *)(out+88)=value.times[2]; *(long *)(out+96)=value.times[3];
  *(long *)(out+104)=value.times[4]; *(long *)(out+112)=value.times[5];
  return 0;
}
long kizuki_mkdir_owned_child(int parent, const char *name) {
  return result(FN(2, int (*)(int, const char *, unsigned int))(parent, name, 0700));
}
long kizuki_rename_owned_child(int from, const char *name, int to, const char *destination) {
  return result(FN(3, int (*)(int, const char *, int, const char *))(from, name, to, destination));
}
long kizuki_unlink_owned_child(int parent, const char *name) {
  return result(FN(4, int (*)(int, const char *, int))(parent, name, 0));
}
long kizuki_rename_owned_child_noreplace(int from, const char *name, int to, const char *destination) {
  return result(FN(5, int (*)(int, const char *, int, const char *, unsigned int))(from, name, to, destination, 4));
}
long kizuki_remove_empty_owned_child(int parent, const char *name) {
  return result(FN(4, int (*)(int, const char *, int))(parent, name, 0x80));
}
long kizuki_duplicate_directory(int descriptor) {
  return result(FN(7, int (*)(int, int, void *))(descriptor, 67, (void *)0));
}
long kizuki_read_directory(int descriptor, unsigned char *out, unsigned long capacity) {
  unsigned char bytes[16384]; long position=0;
  if (capacity < 280 || capacity > sizeof(bytes)) return -22;
  long count=result(FN(6, long (*)(int, void *, unsigned long, long *))(descriptor, bytes, capacity, &position));
  if (count <= 0) return count;
  if ((unsigned long)count > capacity) return -22;
  unsigned long used=0;
  for (unsigned long offset=0; offset<(unsigned long)count;) {
    if ((unsigned long)count-offset < 24) return -22;
    unsigned short length=*(unsigned short *)(bytes+offset+16);
    if (length < 24 || length > 1048 || (length & 3) != 0 || offset+length > (unsigned long)count) return -22;
    // A nonempty native page must never normalize to an EOF observation.
    // Refuse an unidentifiable record instead of silently dropping its name.
    if (*(unsigned long *)(bytes+offset) == 0) return -22;
    unsigned short namesize=*(unsigned short *)(bytes+offset+18);
    if (namesize < 1 || namesize > 255 || 21UL+namesize >= length) return -22;
    if (bytes[offset+21+namesize] != 0) return -22;
    for (int i=0; i<namesize; i++) if (bytes[offset+21+i] == 0) return -22;
    // Darwin permits extra alignment padding (including vnode conversion's
    // struct tail padding), but it must be null. A forged oversized dot record
    // must not hide a following entry and become a false emptiness observation.
    for (unsigned long i=22UL+namesize; i<length; i++) if (bytes[offset+i] != 0) return -22;
    unsigned short normalized=(20UL+namesize+3UL)&~3UL;
    if (used+normalized > capacity) return -22;
    for (int i=0; i<normalized; i++) out[used+i]=0;
    *(unsigned short *)(out+used+16)=normalized; out[used+18]=bytes[offset+20];
    for (int i=0; i<namesize; i++) out[used+19+i]=bytes[offset+21+i];
    used+=normalized; offset+=length;
  }
  return used;
}
`;

function loadDarwinOwnedDirectoryNative() {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    dlclose: { args: [FFIType.ptr], returns: FFIType.i32 },
    pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
    // Apple's fixed-arity syscall veneer under the variadic fcntl wrapper.
    // Using fcntl itself with a fixed FFI signature misplaces its ARM64 vararg.
    __fcntl_nocancel: { args: [FFIType.i32, FFIType.i32, FFIType.u64], returns: FFIType.i32 },
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fstatat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    renameatx_np: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    __getdirentries64: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i64_fast },
    __error: { args: [], returns: FFIType.ptr },
  });
  let reader = -1, writer = -1;
  let compiled: ReturnType<typeof cc> | undefined;
  let systemHandle: import("bun:ffi").Pointer | null = null;
  const releaseLibc = () => {
    if (systemHandle !== null) { libc.symbols.dlclose(systemHandle); systemHandle = null; }
    libc.close();
  };
  let phase = "pipe";
  try {
    const descriptors = new Int32Array(2);
    if (libc.symbols.pipe(ptr(descriptors)) !== 0) throw new Error();
    [reader, writer] = [descriptors[0]!, descriptors[1]!];
    const fcntl = libc.symbols.__fcntl_nocancel;
    phase = "descriptor_flags";
    for (const descriptor of [reader, writer]) {
      if (fcntl(descriptor, 2 /* F_SETFD */, 1n) !== 0 || fcntl(descriptor, 1 /* F_GETFD */, 0n) !== 1) throw new Error();
    }
    if (fcntl(writer, 4 /* F_SETFL */, 4n /* O_NONBLOCK */) !== 0) throw new Error();
    phase = "source_write";
    const bytes = Buffer.from(darwinSource);
    if (bytes.length > 16384 || writeSync(writer, bytes) !== bytes.length) throw new Error();
    closeSync(writer); writer = -1;
    phase = "compile";
    const library = cc({
      flags: ["-nostdlib", "-x", "c"],
      source: `/dev/fd/${reader}`,
      symbols: {
        kizuki_initialize: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
        kizuki_open_owned_child: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64_fast },
        kizuki_create_credential_child: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
        kizuki_open_receipt_append_child: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64_fast },
        kizuki_open_receipt_read_append_child: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64_fast },
        kizuki_stat_owned_child: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i64_fast },
        kizuki_mkdir_owned_child: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
        kizuki_rename_owned_child: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
        kizuki_unlink_owned_child: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
        kizuki_rename_owned_child_noreplace: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
        kizuki_remove_empty_owned_child: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i64_fast },
        kizuki_duplicate_directory: { args: [FFIType.i32], returns: FFIType.i64_fast },
        kizuki_read_directory: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
      },
    });
    compiled = library;
    phase = "function_addresses";
    const entries = ["openat", "fstatat", "mkdirat", "renameat", "unlinkat", "renameatx_np", "__getdirentries64", "__fcntl_nocancel", "__error"] as const;
    // Bun 1.3.14's function .ptr property is not the same representation as an
    // FFIType.ptr result. Resolve from the exact library handle and pass those
    // typed pointers directly, without address arithmetic or reinterpretation.
    systemHandle = libc.symbols.dlopen(ptr(Buffer.from("/usr/lib/libSystem.B.dylib\0")), 2 /* RTLD_NOW */);
    if (systemHandle === null) throw new Error();
    const addresses = entries.map(name => {
      const address = libc.symbols.dlsym(systemHandle, ptr(Buffer.from(`${name}\0`)));
      if (address === null) throw new Error();
      return address;
    });
    phase = "initialize";
    library.symbols.kizuki_initialize(...addresses);
    return { libc: { symbols: libc.symbols, close: releaseLibc }, compiled: library, symbols: {
      unlinkat: libc.symbols.unlinkat,
      duplicateDirectory: library.symbols.kizuki_duplicate_directory,
      readDirectory: (descriptor: number, address: ReturnType<typeof ptr>, length: number) =>
        library.symbols.kizuki_read_directory(descriptor, address, BigInt(length)),
      openChild: library.symbols.kizuki_open_owned_child,
      createCredentialChild: library.symbols.kizuki_create_credential_child,
      openReceiptAppendChild: library.symbols.kizuki_open_receipt_append_child,
      openReceiptReadAppendChild: library.symbols.kizuki_open_receipt_read_append_child,
      statChild: library.symbols.kizuki_stat_owned_child,
      mkdirChild: library.symbols.kizuki_mkdir_owned_child,
      renameChild: library.symbols.kizuki_rename_owned_child,
      unlinkChild: library.symbols.kizuki_unlink_owned_child,
      renameChildNoReplace: library.symbols.kizuki_rename_owned_child_noreplace,
      removeEmptyChild: library.symbols.kizuki_remove_empty_owned_child,
    } };
  } catch {
    compiled?.close(); releaseLibc();
    throw new Error("owned_directory_native_unavailable", { cause: new Error(`owned_directory_native_${phase}`) });
  } finally {
    if (writer >= 0) closeSync(writer);
    if (reader >= 0) closeSync(reader);
  }
}

export function loadOwnedDirectoryNative() {
  if (process.platform === "linux" && process.arch === "x64") return loadLinuxOwnedDirectoryNative();
  if (process.platform === "darwin" && process.arch === "arm64") return loadDarwinOwnedDirectoryNative();
  throw new Error("owned_directory_unsupported");
}
