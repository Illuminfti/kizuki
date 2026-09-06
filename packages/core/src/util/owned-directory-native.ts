import { cc, dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, writeFileSync } from "node:fs";

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
long kizuki_stat_owned_child(int parent, const char *name, void *stat_buffer) {
  long result;
  register long flags __asm__("r10") = 0x100L;
  __asm__ volatile ("syscall" : "=a"(result)
    : "a"(262L), "D"((long)parent), "S"(name), "d"(stat_buffer), "r"(flags)
    : "rcx", "r11", "memory", "cc");
  return result;
}
`;

/** Fixed, sealed source needs no compiler executable, headers or writable path.
 * Both library handles remain rooted for the lifetime of the cached API. */
export function loadOwnedDirectoryNative() {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("owned_directory_unsupported");
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
          kizuki_stat_owned_child: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i64_fast },
        },
      });
      return {
        libc,
        compiled,
        symbols: {
          ...libc.symbols,
          openChild: compiled.symbols.kizuki_open_owned_child,
          createCredentialChild: compiled.symbols.kizuki_create_credential_child,
          statChild: compiled.symbols.kizuki_stat_owned_child,
        },
      };
    } finally { closeSync(fd); }
  } catch {
    libc.close();
    throw new Error("owned_directory_native_unavailable");
  }
}
