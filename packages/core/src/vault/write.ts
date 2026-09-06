import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { serializePage } from "./frontmatter";
import type { VaultPage } from "./frontmatter";
import { validatePage } from "./schema";

/**
 * RFC 0002 §4.5. There is no "owner" writer: the owner corrects or edits the
 * file by hand, and the writer never overwrites a hand edit.
 */
export const WRITERS = ["loop", "correction", "revert", "import"] as const;
export type Writer = (typeof WRITERS)[number];

export function isWriter(value: unknown): value is Writer {
  return (
    typeof value === "string" && (WRITERS as readonly string[]).includes(value)
  );
}

/**
 * The brand is a runtime symbol that this module never exports, and every
 * minted capability is also remembered here. A cast can forge the type but
 * not the membership, so `writePage` refuses anything it did not mint.
 */
const CAPABILITY: unique symbol = Symbol("kizuki.canon-write-capability");
const MINTED = new WeakSet<CanonWriteCapability>();

export interface CanonWriteCapability {
  readonly [CAPABILITY]: true;
  readonly writer: Writer;
  readonly receipt_id: string;
}

export class CanonWriteRefused extends Error {
  override readonly name = "CanonWriteRefused";

  constructor(
    readonly reason:
      | "capability_invalid"
      | "capability_spent"
      | "invalid_page"
      | "page_exists"
      | "page_missing"
      | "page_changed"
      | "symlink"
      | "expected_hash_required"
      | "write_verify_failed"
      | "archive_exists"
      | "parent_invalid",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The only constructor. Called in exactly one module, `canon/apply.ts`, and
 * the source scan in `test/canon/write-capability.test.ts` proves it.
 */
export function grantCanonWrite(
  writer: Writer,
  receipt_id: string,
): CanonWriteCapability {
  if (!isWriter(writer)) {
    throw new CanonWriteRefused(
      "capability_invalid",
      `writer must be one of ${WRITERS.join(" | ")}`,
    );
  }
  if (typeof receipt_id !== "string" || receipt_id.length === 0) {
    throw new CanonWriteRefused(
      "capability_invalid",
      "a canon write capability is bound to a non-empty receipt_id",
    );
  }
  const cap: CanonWriteCapability = Object.freeze({
    [CAPABILITY]: true as const,
    writer,
    receipt_id,
  });
  MINTED.add(cap);
  return cap;
}

/** One capability, one write. Retained references are refused afterwards. */
function consume(cap: CanonWriteCapability): void {
  if (typeof cap !== "object" || cap === null || !MINTED.has(cap)) {
    const branded =
      typeof cap === "object" && cap !== null && cap[CAPABILITY] === true;
    throw new CanonWriteRefused(
      branded ? "capability_spent" : "capability_invalid",
      branded
        ? "canon write capability was already used"
        : "writePage requires a capability minted by grantCanonWrite",
    );
  }
  MINTED.delete(cap);
}

export interface WritePageOptions {
  /** An existing page may only be replaced as an explicit revision. */
  revision?: boolean;
  /**
   * Required for a revision: sha256 of the bytes the caller read. The write
   * refuses when the file changed in between, so a hand edit is never lost.
   */
  expected_hash?: string;
  /**
   * RFC 0002 §7.2: undo of a create deletes the file. The capability is
   * still consumed; the prior bytes are archived so the delete is itself
   * reversible.
   */
  delete?: boolean;
  /** Native source erasure: retain hashes/receipts, never a payload preimage. */
  erase_prior?: boolean;
}

export interface WriteOutcome {
  /** Vault-relative path of the archived prior revision; null for a create. */
  archive_path: string | null;
  /** sha256 of the bytes read back from disk after the write. */
  after_hash: string;
}

export function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** sha256 of the empty byte string — the after-hash of a deleted page. */
export const ABSENT_PAGE_HASH = hashBytes(new Uint8Array());

export function hashFile(path: string): string {
  return hashBytes(readFileSync(path));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function findVaultRoot(file: string): string {
  let current = dirname(resolve(file));
  while (true) {
    if (
      isDirectory(join(current, "archive")) &&
      isDirectory(join(current, ".kizuki"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`cannot find vault root for ${file}`);
}

/**
 * Exclusive archive name: vault-relative path plus the receipt id. Two
 * pages that share a basename cannot collide, and a second writer with a
 * different receipt cannot choose the same path.
 */
export function archiveRelPath(relPath: string, receiptId: string): string {
  return `archive/${relPath.replaceAll("/", "__")}--${receiptId}.md`;
}

function writeDurably(
  path: string,
  content: string | Uint8Array,
  flag: "wx" | "w",
  mode?: number,
): void {
  const fd = openSync(path, flag, mode);
  try {
    if (typeof content === "string") writeSync(fd, content);
    else writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function vaultRelPath(vault: string, path: string): string {
  const rel = relative(resolve(vault), resolve(path));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new CanonWriteRefused("parent_invalid", "Refusing to write outside the vault");
  }
  return rel.split(sep).join("/");
}

function ensureCanonParents(vault: string, filePath: string): void {
  const rel = vaultRelPath(vault, filePath);
  const parent = dirname(rel);
  if (parent === "." || parent === "") return;
  const segments = parent.split("/").filter((segment) => segment.length > 0);
  let current = vault;
  for (const segment of segments) {
    if (segment === ".." || segment === ".kizuki" || segment === "archive") {
      throw new CanonWriteRefused(
        "parent_invalid",
        "Refusing to create an unusable parent directory",
      );
    }
    current = join(current, segment);
    if (isSymlink(current)) {
      throw new CanonWriteRefused("symlink", `Refusing to write through a symlink: ${current}`);
    }
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    if (!isDirectory(current)) {
      throw new CanonWriteRefused(
        "parent_invalid",
        "Refusing to create a page under a non-directory",
      );
    }
  }
}

function archiveExclusively(source: string, dest: string): void {
  const prior = readFileSync(source);
  try {
    writeDurably(dest, prior, "wx");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new CanonWriteRefused("archive_exists", "Refusing to overwrite an archive copy");
    }
    throw error;
  }
}

function hashOnDisk(path: string, expected: string): string {
  const written = readFileSync(path);
  const afterHash = hashBytes(written);
  if (afterHash !== expected) {
    throw new CanonWriteRefused(
      "write_verify_failed",
      "bytes on disk do not match the bytes just written",
    );
  }
  return afterHash;
}

function replaceAtomically(
  path: string,
  content: string,
  stamp: string,
  resumeExact = false,
): void {
  const temp = join(dirname(path), `.${basename(path)}.${stamp}.tmp`);
  if (resumeExact && existsSync(temp)) {
    const before = lstatSync(temp);
    const fd = openSync(temp, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        before.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev ||
        stat.uid !== process.geteuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size !== Buffer.byteLength(content) ||
        readFileSync(fd, "utf8") !== content
      ) {
        throw new CanonWriteRefused("page_changed", "source erasure temporary revision changed");
      }
      fsyncSync(fd);
      const current = lstatSync(temp);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.isSymbolicLink()) {
        throw new CanonWriteRefused("page_changed", "source erasure temporary revision changed");
      }
    } finally {
      closeSync(fd);
    }
  } else {
    writeDurably(temp, content, "wx", resumeExact ? 0o600 : undefined);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

function deleteExistingPage(
  path: string,
  expectedHash: string | undefined,
  receiptId: string,
  erasePrior = false,
): WriteOutcome {
  if (!existsSync(path)) {
    throw new CanonWriteRefused(
      "page_missing",
      `Refusing to delete a missing page: ${path}`,
    );
  }
  if (expectedHash === undefined) {
    throw new CanonWriteRefused(
      "expected_hash_required",
      "deleting a page must name the hash of the bytes it read",
    );
  }
  if (hashFile(path) !== expectedHash) {
    throw new CanonWriteRefused(
      "page_changed",
      `Refusing to delete a page that changed since it was read: ${path}`,
    );
  }
  if (erasePrior) {
    unlinkSync(path);
    const fd = openSync(dirname(path), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { archive_path: null, after_hash: ABSENT_PAGE_HASH };
  }
  const vault = findVaultRoot(path);
  mkdirSync(join(vault, "archive"), { recursive: true, mode: 0o700 });
  const archiveRel = archiveRelPath(vaultRelPath(vault, path), receiptId);
  const archive = join(vault, archiveRel);
  archiveExclusively(path, archive);
  unlinkSync(path);
  if (existsSync(path)) {
    throw new CanonWriteRefused(
      "write_verify_failed",
      "bytes on disk do not match the bytes just written",
    );
  }
  return { archive_path: archiveRel, after_hash: ABSENT_PAGE_HASH };
}

/**
 * The single byte path into canon. Everything above it goes through
 * `applyCanonWrite`, which mints the capability, and every write is
 * described by the hash of what is actually on disk afterwards.
 */
export function writePage(
  cap: CanonWriteCapability,
  path: string,
  page: VaultPage,
  opts: WritePageOptions = {},
): WriteOutcome {
  consume(cap);

  if (isSymlink(path)) {
    throw new CanonWriteRefused(
      "symlink",
      `Refusing to write through a symlink: ${path}`,
    );
  }

  if (opts.delete === true) {
    return deleteExistingPage(
      path,
      opts.expected_hash,
      cap.receipt_id,
      opts.erase_prior === true,
    );
  }

  const errors = validatePage(page.data);
  if (errors.length > 0) {
    throw new CanonWriteRefused(
      "invalid_page",
      `Invalid page:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }
  const content = serializePage(page);
  const expectedHash = hashBytes(Buffer.from(content, "utf8"));
  const exists = existsSync(path);
  const vault = findVaultRoot(path);

  if (exists && opts.revision !== true) {
    throw new CanonWriteRefused(
      "page_exists",
      `Refusing to overwrite existing page: ${path}`,
    );
  }
  if (!exists) {
    if (opts.revision === true) {
      throw new CanonWriteRefused(
        "page_missing",
        `Refusing to revise a missing page: ${path}`,
      );
    }
    ensureCanonParents(vault, path);
    writeDurably(path, content, "wx");
    return { archive_path: null, after_hash: hashOnDisk(path, expectedHash) };
  }

  if (opts.expected_hash === undefined) {
    throw new CanonWriteRefused(
      "expected_hash_required",
      "a revision must name the hash of the bytes it read",
    );
  }
  if (hashFile(path) !== opts.expected_hash) {
    throw new CanonWriteRefused(
      "page_changed",
      `Refusing to revise a page that changed since it was read: ${path}`,
    );
  }

  if (opts.erase_prior === true) {
    replaceAtomically(path, content, cap.receipt_id, true);
    const fd = openSync(dirname(path), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { archive_path: null, after_hash: hashOnDisk(path, expectedHash) };
  }

  mkdirSync(join(vault, "archive"), { recursive: true, mode: 0o700 });
  const archiveRel = archiveRelPath(vaultRelPath(vault, path), cap.receipt_id);
  const archive = join(vault, archiveRel);
  archiveExclusively(path, archive);
  replaceAtomically(path, content, cap.receipt_id);
  return {
    archive_path: archiveRel,
    after_hash: hashOnDisk(path, expectedHash),
  };
}
