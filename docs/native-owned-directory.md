# Native owned directory operations

The owned-directory capability supports Linux x86_64 with glibc. Other
platforms fail closed. It opens children relative to an existing directory
descriptor, refuses symlinks, compares inode identities before removal, and
bounds traversal to 64 levels and 100,000 entries.

## Native error results

Filesystem errors must survive the Bun FFI return boundary. A JavaScript or
runtime operation can change thread-local `errno` before JavaScript reads it.
Preparing the errno view before the call does not eliminate that interval.

A fixed, header-free helper invokes Linux syscall 257 (`openat`) and returns
the kernel result directly. Only exactly `-ENOENT` establishes absence;
permission, symlink, wrong-type and other errors refuse the operation. Its
fixed flags never create files. A successful descriptor must be a valid
nonnegative signed 32-bit integer.

Bun's built-in C compiler loads the helper from a sealed anonymous memory
file. All four write, grow, shrink and further-seal restrictions are applied
and verified before compilation. There is no external compiler, header,
library-development package, writable source path or temporary shared object.
This requires Linux memfd sealing and `/proc/self/fd`; unavailable facilities
produce `owned_directory_native_unavailable`. The source descriptor closes
after compilation, and both native library handles remain live with the API.

Directory enumeration uses bounded `getdents64` buffers. The returned byte
count distinguishes end-of-directory from failure without consulting errno.
Each record length and native filename is checked before use. Filenames are
kept as bytes, including names that are not valid UTF-8.

## Concurrency and verification

An absent result describes the instant of the kernel lookup. It cannot prove
that a name remains absent after the call. Existing exclusive custody,
advisory locks, identity checks, final absence checks and durability barriers
remain required for erasure. Directory timestamps cannot replace those guards.

Run the native regressions with the repository's pinned Bun version:

```bash
bun test packages/core/test/util/owned-directory.test.ts packages/core/test/util/native-enumeration.test.ts packages/core/test/util/native-loader.test.ts
```

These cover late errno changes, failed initialization and cleanup, sealed
source, malformed directory records, opaque names, traversal bounds, root
replacement and observation-time absence. Release acceptance additionally
requires the copied executable on each claimed native platform.

## Private canon adapter

`vault/canon-files.ts` is an internal adapter under qualification. Existing
canon writers, preimage readers and receipt appenders do not use it yet. This
addition alone does not complete canon containment or change canon platform
availability.

The adapter keeps root, parent and file descriptors private. It opens each
component with no-follow semantics, checks directory custody, and returns
owner-bound, closeable file snapshots whose expected bytes cannot be edited.
Files must be regular, single-link, owned by the effective user, and not
writable by a group or others. Reads and writes are limited to 1 MiB; relative
paths are limited to 64 components and 4,096 UTF-8 bytes, with at most 255 bytes
per component. The adapter accepts ordinary nested doctrine and archive names;
the integrating writer retains responsibility for reserved root paths.

The shared sealed loader now also provides fixed 0700 `mkdirat`, `renameat`
and file-only `unlinkat` helpers. Existing native and credential symbols remain
unchanged. Exclusive file creation reuses the existing fixed 0600 helper,
completes every write, verifies its bytes, and syncs the file and parent.
Replacement and removal validate retained snapshots and sync their parents.
Failed creation attempts clean up only when the created inode and the bytes
actually written still match; ambiguous cleanup preserves the entry.

These operations require Linux x64/glibc and the existing native loader
facilities. Unsupported or unavailable backends return a typed, private error
without a pathname fallback. The writer authorization and mutation scope must
surround this capability during integration. Descriptor-relative rename and
unlink still operate on entry names; snapshot checks do not provide atomic
compare-and-swap against an unrestricted external editor. A general crash
journal, publication recovery, descriptor-backed receipt append, and copied
executable qualification remain separate work.

Focused adapter qualification uses synthetic roots and the repaired code:

```bash
bun test packages/core/test/canon/canon-files.test.ts packages/core/test/util/native-loader.test.ts
```

The positive adapter cases require a qualified native filesystem ancestry.
An unsupported or UID-mapped sandbox is recorded as refusal, with positive
cases skipped; those skips provide no backend qualification. Native Linux CI
requires qualified custody. No macOS adapter qualification is claimed.
