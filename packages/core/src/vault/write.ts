import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { serializePage } from "./frontmatter";
import type { VaultPage } from "./frontmatter";
import { validatePage } from "./schema";
import { assertPageRelPath, assertStoredPageRelPath } from "../canon/paths";
import { assertCanonFiles, CanonFilesError, MAX_CANON_FILE_BYTES, openCanonFiles, type CanonFiles, type CanonFileSnapshot } from "./canon-files";

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
const BORROWED_FILES = new WeakMap<CanonWriteCapability, CanonFiles>();

export interface CanonWriteCapability {
  readonly [CAPABILITY]: true;
  readonly writer: Writer;
  readonly receipt_id: string;
  readonly vault_path: string;
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
      | "parent_invalid"
      | "native_unsupported"
      | "native_unavailable",
    message: string,
    readonly code?: string,
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
  vault_path: string,
  files?: CanonFiles,
): CanonWriteCapability {
  if (!isWriter(writer)) {
    throw new CanonWriteRefused(
      "capability_invalid",
      `writer must be one of ${WRITERS.join(" | ")}`,
    );
  }
  if (typeof receipt_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(receipt_id)) {
    throw new CanonWriteRefused(
      "capability_invalid",
      "a canon write capability requires a safe receipt identifier",
    );
  }
  const vault = resolve(vault_path);
  if (files !== undefined) {
    try { assertCanonFiles(files, vault); } catch (error) { refuseNative(error); }
  }
  const cap: CanonWriteCapability = Object.freeze({
    [CAPABILITY]: true as const,
    writer,
    receipt_id,
    vault_path: vault,
  });
  MINTED.add(cap);
  if (files !== undefined) BORROWED_FILES.set(cap, files);
  return cap;
}

/** One capability, one write. Retained references are refused afterwards. */
function consume(cap: CanonWriteCapability): CanonFiles | undefined {
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
  const files = BORROWED_FILES.get(cap);
  BORROWED_FILES.delete(cap);
  return files;
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

/**
 * Exclusive archive name: vault-relative path plus the receipt id. Two
 * pages that share a basename cannot collide, and a second writer with a
 * different receipt cannot choose the same path.
 */
export function archiveRelPath(relPath: string, receiptId: string): string {
  return `archive/${relPath.replaceAll("/", "__")}--${receiptId}.md`;
}

function vaultRelPath(vault: string, path: string): string {
  const rel = relative(resolve(vault), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CanonWriteRefused("parent_invalid", "Refusing to write outside the vault");
  }
  return rel.split(sep).join("/");
}

/** Path identity checks protect existing state; native swap-resistant handles are separate. */
export function containedVaultFile(vaultPath: string, filePath: string): string {
  const vault = resolve(vaultPath);
  const path = resolve(vault, filePath);
  const rel = vaultRelPath(vault, path);
  const parts = rel.split("/");
  let current = vault;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = join(current, parts[index]!);
    let entry;
    try { entry = lstatSync(current); }
    catch (error) {
      if (index >= 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return path;
      throw error;
    }
    if (entry.isSymbolicLink()) throw new CanonWriteRefused("symlink", "vault file path contains a symlink");
    const last = index === parts.length - 1;
    if (last ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory()) {
      throw new CanonWriteRefused("parent_invalid", "vault file path has an unusable component", last && entry.isDirectory() ? "EISDIR" : "EIO");
    }
  }
  return path;
}

/** Native errors cross the writer boundary without paths or captured bytes. */
function refuseNative(error: unknown): never {
  if (!(error instanceof CanonFilesError)) throw error;
  const reasons = {
    unsupported: "native_unsupported", native_unavailable: "native_unavailable",
    invalid_path: "parent_invalid", bounds: "parent_invalid", unsafe: "parent_invalid",
    changed: "page_changed", conflict: "page_exists", closed: "capability_invalid",
    handle: "capability_invalid", io: "write_verify_failed",
  } as const;
  const message = error.reason === "unsafe"
    ? "canon file has unsafe ownership, type, or a symlink component"
    : `canon byte operation refused: ${error.reason}`;
  throw new CanonWriteRefused(reasons[error.reason], message);
}

function pageRelPath(vault: string, path: string, opts: WritePageOptions): string {
  const rel = vaultRelPath(vault, resolve(vault, path));
  try {
    // Source erasure must purge existing historical copies as well as live
    // pages. Explicit revision/delete cannot create a missing archive entry.
    if (opts.erase_prior === true && (opts.revision === true || opts.delete === true)) assertStoredPageRelPath(rel);
    else assertPageRelPath(rel);
  }
  catch { throw new CanonWriteRefused("parent_invalid", "Refusing to write an unusable canon page path"); }
  return rel;
}

function ensureCanonParents(files: CanonFiles, rel: string): void {
  const parent = dirname(rel);
  if (parent !== ".") files.ensureDirectory(parent);
}

function archiveSnapshot(files: CanonFiles, prior: CanonFileSnapshot, receiptId: string): string {
  const rel = archiveRelPath(prior.path, receiptId);
  files.ensureDirectory("archive");
  try { files.create(rel, prior.bytes).close(); }
  catch (error) {
    if (error instanceof CanonFilesError && error.reason === "conflict") {
      throw new CanonWriteRefused("archive_exists", "Refusing to overwrite an archive copy");
    }
    throw error;
  }
  return rel;
}

function expectedPrior(prior: CanonFileSnapshot | null, expectedHash: string | undefined, deleting: boolean): CanonFileSnapshot {
  if (prior === null) {
    throw new CanonWriteRefused("page_missing", deleting ? "Refusing to delete a missing page" : "Refusing to revise a missing page");
  }
  if (expectedHash === undefined) {
    throw new CanonWriteRefused("expected_hash_required", "a revision or deletion must name the hash of the bytes it read");
  }
  if (hashBytes(prior.bytes) !== expectedHash) {
    throw new CanonWriteRefused("page_changed", "Refusing to change a page that changed since it was read");
  }
  return prior;
}

function replaceSnapshot(
  files: CanonFiles,
  prior: CanonFileSnapshot,
  bytes: Uint8Array,
  receiptId: string,
  erasePrior: boolean,
): string {
  const tempPath = join(dirname(prior.path), `.${basename(prior.path)}.${receiptId}.tmp`);
  let temp = erasePrior ? files.resumeExactTemporary(prior, receiptId, bytes) : null;
  if (temp === null) {
    try { temp = files.create(tempPath, bytes); }
    catch (error) {
      if (error instanceof CanonFilesError && error.reason === "conflict") {
        throw new CanonWriteRefused("page_changed", "Refusing an existing temporary revision");
      }
      throw error;
    }
  }
  try {
    const published = files.replace(temp, prior);
    try { return hashBytes(published.bytes); }
    finally { published.close(); }
  } catch (error) {
    // Ordinary cleanup only removes the identified creation if still live.
    // Source erasure preserves its exact receipt temp for a same-ID retry.
    if (!erasePrior) { try { files.remove(temp); } catch { /* Preserve the original failure. */ } }
    throw error;
  } finally { temp.close(); }
}

function writeWithFiles(
  cap: CanonWriteCapability,
  files: CanonFiles,
  rel: string,
  page: VaultPage,
  opts: WritePageOptions,
): WriteOutcome {
  const prior = files.read(rel);
  try {
    if (opts.delete === true) {
      const expected = expectedPrior(prior, opts.expected_hash, true);
      const archive = opts.erase_prior === true ? null : archiveSnapshot(files, expected, cap.receipt_id);
      files.remove(expected);
      return { archive_path: archive, after_hash: ABSENT_PAGE_HASH };
    }

    const errors = validatePage(page.data);
    if (errors.length > 0) {
      throw new CanonWriteRefused("invalid_page", `Invalid page:\n${errors.map(error => `- ${error}`).join("\n")}`);
    }
    const bytes = Buffer.from(serializePage(page), "utf8");
    if (bytes.byteLength > MAX_CANON_FILE_BYTES) {
      throw new CanonWriteRefused("invalid_page", "canon page exceeds the supported byte limit");
    }
    if (prior !== null && opts.revision !== true) {
      throw new CanonWriteRefused("page_exists", "Refusing to overwrite an existing page");
    }
    if (prior === null) {
      if (opts.revision === true) throw new CanonWriteRefused("page_missing", "Refusing to revise a missing page");
      ensureCanonParents(files, rel);
      const created = files.create(rel, bytes);
      try { return { archive_path: null, after_hash: hashBytes(created.bytes) }; }
      finally { created.close(); }
    }

    const expected = expectedPrior(prior, opts.expected_hash, false);
    const archive = opts.erase_prior === true ? null : archiveSnapshot(files, expected, cap.receipt_id);
    return {
      archive_path: archive,
      after_hash: replaceSnapshot(files, expected, bytes, cap.receipt_id, opts.erase_prior === true),
    };
  } finally { prior?.close(); }
}

/**
 * The single byte path into canon. apply.ts mints the one-use capability.
 * An optional borrowed file scope remains owned by its enclosing operation;
 * otherwise this synchronous write closes its own scope before returning.
 */
export function writePage(
  cap: CanonWriteCapability,
  path: string,
  page: VaultPage,
  opts: WritePageOptions = {},
): WriteOutcome {
  const borrowed = consume(cap);
  try {
    const rel = pageRelPath(cap.vault_path, path, opts);
    const files = borrowed ?? openCanonFiles(cap.vault_path);
    try {
      assertCanonFiles(files, cap.vault_path);
      return writeWithFiles(cap, files, rel, page, opts);
    } finally { if (borrowed === undefined) files.close(); }
  } catch (error) { refuseNative(error); }
}
