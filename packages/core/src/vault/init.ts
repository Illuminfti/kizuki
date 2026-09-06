import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertCanonFiles, type CanonFiles } from "./canon-files";
import { withMutationFilesSync } from "./mutation-files";
import { assertVaultMutationScope, VaultMutationError, withVaultMutationSync, type VaultMutationScope, type VaultMutationTarget } from "./mutation-scope";
import { sha256Hex } from "../util/hash";

export const INIT_JOURNAL_SCHEMA = "kizuki.init/v1" as const;
export const DOCTRINE_VERSION = 2;
export const VAULT_DIR_MODE = 0o700;
export const VAULT_FILE_MODE = 0o600;

const JOURNAL_NAME = "init.json";
const MAX_ROOT_ENTRIES = 4_096;
const MAX_INVENTORY_NAMES = 32;
const MAX_CONTROL_WALK = 4_096;

const CANON_LAYOUT = [
  "entities",
  "facts",
  "events",
  "sources",
  "dashboards",
  "archive",
] as const;

const CONTROL_LAYOUT = [
  ".kizuki",
  join(".kizuki", "connections"),
  join(".kizuki", "receipts"),
  join(".kizuki", "models"),
  join(".kizuki", "exports"),
  join(".kizuki", "retrieval"),
  join(".kizuki", "retrieval", "kizuki.retrieval.fts5"),
] as const;

const RESERVED_DIRS = new Set<string>([".kizuki", ...CANON_LAYOUT]);
const RESERVED_NAMES = new Set<string>([
  ...RESERVED_DIRS,
  "CANON.md",
  "SCHEMA.md",
  ".gitignore",
]);

const CANON_DOCTRINE_V1_PROMOTION = `# Canon

Canon is reviewed Markdown on the owner's disk.
Staging lives only in the database under \`.kizuki/\`.
Only an owner-invoked promotion may write canon.
Every canon page requires a \`sensitivity\` label.
`;

const CANON_DOCTRINE_V1_AUTONOMOUS = `# Canon

Canon is Markdown you own. A loop writes it for you from evidence it can
name, and records a receipt for every write. Nothing here is a secret from
you: \`kizuki audit\` shows every write with its evidence and its diff, and
\`kizuki undo <receipt>\` reverses any of them. If a page is wrong, say so —
\`kizuki tell "..."\` — and the page changes in the same breath. Edit these
files by hand whenever you like; the loop treats your edits as your word
and will not overwrite them.
`;

const CANON_DOCTRINE = `# Canon

kizuki.doctrine/v2

Canon is Markdown you own. A loop writes it for you from evidence it can
name, and records a receipt for every write. Nothing here is a secret from
you: \`kizuki audit\` shows every write with its evidence and its diff, and
\`kizuki undo <receipt>\` reverses any of them. If a page is wrong, say so —
\`kizuki tell "..."\` — and the page changes in the same breath. Edit these
files by hand whenever you like; the loop treats your edits as your word
and will not overwrite them.
`;

const SCHEMA_DOCTRINE_V1_PROMOTION = `# Page schema

Every page requires \`id\`, \`title\`, \`type\`, \`status\`, and \`sensitivity\` frontmatter.
Canon is reviewed Markdown; staging belongs in the database.
Only owner promotion writes canon.
Unknown frontmatter keys must use the \`x-*\` extension namespace.
`;

const SCHEMA_DOCTRINE_V1_REVIEWED_NEITHER = `# Page schema

Every page requires \`id\`, \`title\`, \`type\`, \`status\`, and \`sensitivity\` frontmatter.
Canon is reviewed Markdown; staging belongs in the database.
Every page carries \`sensitivity\` and \`taint\`; a page with
neither is never served to anyone, including you.
Unknown frontmatter keys must use the \`x-*\` extension namespace.
`;

const SCHEMA_DOCTRINE_V1_REVIEWED_MISSING = `# Page schema

Every page requires \`id\`, \`title\`, \`type\`, \`status\`, \`sensitivity\`, and \`taint\` frontmatter.
Canon is reviewed Markdown; staging belongs in the database.
Every page carries \`sensitivity\` and \`taint\`; a page missing
either is never served to anyone, including you.
Unknown frontmatter keys must use the \`x-*\` extension namespace.
`;

const SCHEMA_DOCTRINE = `# Page schema

kizuki.doctrine/v2

Every page requires \`id\`, \`title\`, \`type\`, \`status\`, and \`sensitivity\` frontmatter.
Every page carries \`sensitivity\` and \`taint\`; a page missing
either is never served to anyone, including you.
Unknown frontmatter keys must use the \`x-*\` extension namespace.
Canon writes are receipted: provenance that resolves in the ledger,
confidence, a writer stamp, the model reference when a model produced
the page, and before/after hashes. \`kizuki undo <receipt>\` reverses any write.
`;

const ROOT_GITIGNORE_RULE = "/.kizuki/";
const ROOT_GITIGNORE = `${ROOT_GITIGNORE_RULE}\n`;
const CONTROL_GITIGNORE = "*\n!.gitignore\n";

const HISTORICAL_DOCTRINE: Readonly<Record<string, readonly string[]>> = {
  "CANON.md": [CANON_DOCTRINE_V1_PROMOTION, CANON_DOCTRINE_V1_AUTONOMOUS],
  "SCHEMA.md": [
    SCHEMA_DOCTRINE_V1_PROMOTION,
    SCHEMA_DOCTRINE_V1_REVIEWED_NEITHER,
    SCHEMA_DOCTRINE_V1_REVIEWED_MISSING,
  ],
};

const CURRENT_DOCTRINE: Readonly<Record<string, string>> = {
  "CANON.md": CANON_DOCTRINE,
  "SCHEMA.md": SCHEMA_DOCTRINE,
};

export const VAULT_INIT_ERROR_CODES = [
  "not_a_directory",
  "nonempty_requires_adopt",
  "reserved_conflict",
  "insecure_permissions",
  "symlink_escape",
  "inventory_limit",
  "owner_mismatch",
  "tracked_control_state",
  "git_status_unavailable",
  "writer_busy",
] as const;
export type VaultInitErrorCode = (typeof VAULT_INIT_ERROR_CODES)[number];

export interface InitInventory {
  entry_count: number;
  markdown_count: number;
  has_git: boolean;
  symlink_count: number;
  names: string[];
  reserved_conflicts: string[];
}

export class VaultInitError extends Error {
  readonly code: VaultInitErrorCode;
  readonly inventory: InitInventory | undefined;

  constructor(
    code: VaultInitErrorCode,
    message: string,
    inventory?: InitInventory,
  ) {
    super(message);
    this.name = "VaultInitError";
    this.code = code;
    this.inventory = inventory;
  }
}

export type DoctrineFileState =
  | "current"
  | "upgradeable"
  | "owner-edited"
  | "missing";

export interface DoctrineFileReport {
  file: string;
  state: DoctrineFileState;
}

export interface ControlPathReport {
  path: string;
  problem: string;
}

export interface InitJournalAdopt {
  policy: "adopt";
  entry_count: number;
  markdown_count: number;
  has_git: boolean;
  symlink_count: number;
  reserved_conflicts: number;
  inventory_sha256: string;
}

export interface InitJournal {
  schema: typeof INIT_JOURNAL_SCHEMA;
  status: "in_progress" | "ready";
  doctrine_version: number;
  adopt: InitJournalAdopt | null;
}

export interface InitVaultOptions {
  adopt?: boolean;
  dryRun?: boolean;
}

export interface InitVaultResult {
  created: string[];
  repaired: string[];
  upgraded: string[];
  dry_run: boolean;
  status: "ready" | "in_progress" | "dry-run";
  inventory: InitInventory | null;
}

function journalPath(root: string): string {
  return join(root, ".kizuki", JOURNAL_NAME);
}

/** Refuse before writes: native Windows cannot enforce our POSIX custody floor. */
function assertPermissionPlatform(): void {
  if (process.platform === "win32") {
    throw new VaultInitError(
      "insecure_permissions",
      "Native Windows (win32) is unsupported: Kizuki requires owner-only POSIX permissions. " +
        "Use Linux or macOS, or WSL with the vault on its Linux filesystem.",
    );
  }
}

function processUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

interface PathInfo {
  directory: boolean;
  file: boolean;
  symlink: boolean;
  mode: number;
  uid: number;
  dev: number;
  ino: number;
}

function readPath(path: string): PathInfo {
  const st = lstatSync(path);
  return {
    directory: st.isDirectory(),
    file: st.isFile(),
    symlink: st.isSymbolicLink(),
    mode: Number(st.mode),
    uid: Number(st.uid),
    dev: Number(st.dev),
    ino: Number(st.ino),
  };
}

function lstatOrNull(path: string): PathInfo | null {
  try {
    return readPath(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isRealDir(path: string): boolean {
  const st = lstatOrNull(path);
  return st !== null && st.directory;
}

function isRealFile(path: string): boolean {
  const st = lstatOrNull(path);
  return st !== null && st.file;
}

function formatMode(mode: number): string {
  return ((mode & 0o777) + 0o1000).toString(8).slice(1);
}

function assertOwned(path: string, st: Pick<PathInfo, "uid">): void {
  const uid = processUid();
  if (uid === null) return;
  if (st.uid !== uid) {
    throw new VaultInitError(
      "owner_mismatch",
      `path is not owned by this process: ${path}`,
    );
  }
}

function mkdirPrivate(path: string): boolean {
  const st = lstatOrNull(path);
  if (st !== null) {
    if (st.symlink) {
      throw new VaultInitError(
        "symlink_escape",
        `path must be a directory, not a symlink: ${path}`,
      );
    }
    if (!st.directory) {
      throw new VaultInitError(
        "not_a_directory",
        `path exists and is not a directory: ${path}`,
      );
    }
    assertOwned(path, st);
    return false;
  }
  mkdirSync(path, { recursive: true, mode: VAULT_DIR_MODE });
  chmodSync(path, VAULT_DIR_MODE);
  return true;
}

function chmodPrivateDir(path: string): boolean {
  const st = readPath(path);
  if (st.symlink) {
    throw new VaultInitError(
      "symlink_escape",
      `path must be a directory, not a symlink: ${path}`,
    );
  }
  if (!st.directory) {
    throw new VaultInitError(
      "not_a_directory",
      `path exists and is not a directory: ${path}`,
    );
  }
  assertOwned(path, st);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assertOwned(path, opened);
    if (!opened.isDirectory() || opened.dev !== st.dev || opened.ino !== st.ino) {
      throw new VaultInitError("symlink_escape", "vault directory changed during permission repair");
    }
    const changed = (opened.mode & 0o777) !== VAULT_DIR_MODE;
    if (changed) { fchmodSync(fd, VAULT_DIR_MODE); fsyncSync(fd); }
    const after = readPath(path);
    if (after.symlink || !after.directory || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new VaultInitError("symlink_escape", "vault directory changed during permission repair");
    }
    return changed;
  } finally { closeSync(fd); }
}

function chmodPrivateFile(path: string): boolean {
  const st = readPath(path);
  if (st.symlink) {
    throw new VaultInitError(
      "symlink_escape",
      `path must be a file, not a symlink: ${path}`,
    );
  }
  if (!st.file) {
    throw new VaultInitError("not_a_directory", `path is not a file: ${path}`);
  }
  assertOwned(path, st);
  if ((st.mode & 0o777) === VAULT_FILE_MODE) return false;
  chmodSync(path, VAULT_FILE_MODE);
  return true;
}

function writeAtomicFile(files: CanonFiles, path: string, content: string | Uint8Array): void {
  const parent = dirname(path);
  if (parent !== ".") files.ensureDirectory(parent);
  const bytes = Buffer.from(content);
  const prior = files.read(path);
  if (prior === null) { files.create(path, bytes).close(); return; }
  try {
    const temporary = files.create(`${path}.${crypto.randomUUID()}.tmp`, bytes);
    try { files.replace(temporary, prior).close(); }
    catch (error) {
      try { files.remove(temporary); } catch { /* Preserve a changed temporary and the original failure. */ }
      throw error;
    } finally { temporary.close(); }
  } finally { prior.close(); }
}

function ensureRootGitIgnore(files: CanonFiles, path: string, existing: Buffer): boolean {
  const text = existing.toString("utf8");
  let protectedControl = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.replace(/ +$/, "") === ROOT_GITIGNORE_RULE) protectedControl = true;
    // Keep owner rules intact, but place the exclusion after any later
    // negation so a preexisting rule cannot reopen the control directory.
    else if (line.startsWith("!")) protectedControl = false;
  }
  if (protectedControl) return false;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const separator = existing.length === 0 || text.endsWith("\n") ? "" : newline;
  writeAtomicFile(files, path, Buffer.concat([
    existing,
    Buffer.from(`${separator}${ROOT_GITIGNORE_RULE}${newline}`),
  ]));
  return true;
}

function assertControlNotTracked(path: string): void {
  const root = resolve(path);
  let repository = root;
  while (lstatOrNull(join(repository, ".git")) === null) {
    const parent = dirname(repository);
    if (parent === repository) return;
    repository = parent;
  }
  // Inspect this worktree's real index, independently of Git overrides in
  // the caller's environment. The command never stages or removes files.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const control = relative(repository, join(root, ".kizuki")).split(sep).join("/");
  let tracked: Buffer;
  try {
    tracked = execFileSync("git", [
      "-C", repository, "ls-files", "--cached", "-z", "--",
      `:(top,literal)${control}`,
    ], {
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      maxBuffer: 1_048_576,
    });
  } catch {
    throw new VaultInitError(
      "git_status_unavailable",
      "cannot inspect the vault's Git index; initialization refused. Ensure Git is available and the repository is readable before retrying",
    );
  }
  if (tracked.length !== 0) {
    throw new VaultInitError(
      "tracked_control_state",
      "Git already tracks entries under .kizuki; initialization refused. Resolve tracked control files before retrying. Git's index and history were not changed",
    );
  }
}


function listRootNames(root: string): string[] {
  try {
    return readdirSync(root).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function inspectInventory(root: string): InitInventory {
  const names = listRootNames(root);
  if (names.length > MAX_ROOT_ENTRIES) {
    throw new VaultInitError(
      "inventory_limit",
      `vault root has too many entries to inventory (${names.length})`,
    );
  }
  const reserved_conflicts: string[] = [];
  let markdown_count = 0;
  let symlink_count = 0;
  let has_git = false;
  for (const name of names) {
    const target = join(root, name);
    const st = lstatOrNull(target);
    if (st === null) continue;
    if (st.symlink) symlink_count += 1;
    if (name === ".git") has_git = true;
    if (name.endsWith(".md") && st.file) markdown_count += 1;
    if (!RESERVED_NAMES.has(name)) continue;
    if (RESERVED_DIRS.has(name)) {
      if (st.symlink || !st.directory) reserved_conflicts.push(name);
    } else if (st.symlink || !st.file) {
      reserved_conflicts.push(name);
    }
  }
  return {
    entry_count: names.length,
    markdown_count,
    has_git,
    symlink_count,
    names: names.slice(0, MAX_INVENTORY_NAMES),
    reserved_conflicts,
  };
}

function isRepairableVault(root: string): boolean {
  if (isRealDir(join(root, ".kizuki"))) return true;
  if (isRealFile(journalPath(root))) return true;
  return isRealFile(join(root, "CANON.md")) && isRealFile(join(root, "SCHEMA.md"));
}

function inventoryReceipt(inventory: InitInventory): InitJournalAdopt {
  return {
    policy: "adopt",
    entry_count: inventory.entry_count,
    markdown_count: inventory.markdown_count,
    has_git: inventory.has_git,
    symlink_count: inventory.symlink_count,
    reserved_conflicts: inventory.reserved_conflicts.length,
    inventory_sha256: sha256Hex(inventory.names.join("\n")),
  };
}

function isTornTemplate(content: string, template: string): boolean {
  return content.length < template.length && template.startsWith(content);
}

function classifyDoctrine(content: string, file: string): Exclude<DoctrineFileState, "missing"> {
  const current = CURRENT_DOCTRINE[file];
  if (current !== undefined && content === current) return "current";
  const historical = HISTORICAL_DOCTRINE[file] ?? [];
  if (historical.includes(content)) return "upgradeable";
  if (current !== undefined && isTornTemplate(content, current)) return "upgradeable";
  if (historical.some((template) => isTornTemplate(content, template))) return "upgradeable";
  return "owner-edited";
}

export function inspectDoctrineFiles(root: string): DoctrineFileReport[] {
  return (["CANON.md", "SCHEMA.md"] as const).map((file) => {
    const target = join(root, file);
    if (!existsSync(target)) return { file, state: "missing" };
    return { file, state: classifyDoctrine(readFileSync(target, "utf8"), file) };
  });
}

function reportControlDir(reports: ControlPathReport[], root: string, rel: string, required: boolean): void {
  const st = lstatOrNull(join(root, rel));
  if (st === null) {
    if (required) reports.push({ path: rel, problem: "missing" });
    return;
  }
  if (st.symlink) {
    reports.push({ path: rel, problem: "symlink" });
    return;
  }
  if (!st.directory) {
    reports.push({ path: rel, problem: "not a directory" });
    return;
  }
  if ((st.mode & 0o777) !== VAULT_DIR_MODE) {
    reports.push({ path: rel, problem: `mode ${formatMode(st.mode)}, expected 0700` });
  }
  const uid = processUid();
  if (uid !== null && st.uid !== uid) {
    reports.push({ path: rel, problem: "owner mismatch" });
  }
}

function reportControlFile(reports: ControlPathReport[], root: string, rel: string): void {
  const st = lstatOrNull(join(root, rel));
  if (st === null) return;
  if (st.symlink || !st.file) {
    reports.push({ path: rel, problem: st.symlink ? "symlink" : "not a file" });
    return;
  }
  if ((st.mode & 0o077) !== 0) {
    reports.push({ path: rel, problem: `mode ${formatMode(st.mode)}, expected 0600` });
  }
}

export function inspectVaultControl(root: string): ControlPathReport[] {
  assertPermissionPlatform();
  const reports: ControlPathReport[] = [];
  hardenLedgerFile(join(root, ".kizuki", "kizuki.db"));
  reportControlDir(reports, root, ".kizuki", true);
  for (const rel of CONTROL_LAYOUT) {
    if (rel === ".kizuki") continue;
    reportControlDir(reports, root, rel, false);
  }
  reportControlFile(reports, root, join(".kizuki", "kizuki.db"));
  reportControlFile(reports, root, join(".kizuki", "init.json"));
  return reports;
}

function parseJournal(raw: string): InitJournal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  if (row.schema !== INIT_JOURNAL_SCHEMA) return null;
  if (row.status !== "ready" && row.status !== "in_progress") return null;
  if (row.doctrine_version !== DOCTRINE_VERSION && row.doctrine_version !== 1) return null;
  return {
    schema: INIT_JOURNAL_SCHEMA,
    status: row.status,
    doctrine_version: row.doctrine_version,
    adopt: parseAdopt(row.adopt),
  };
}

function parseAdopt(value: unknown): InitJournalAdopt | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.policy !== "adopt") return null;
  if (typeof row.entry_count !== "number" || typeof row.inventory_sha256 !== "string") {
    return null;
  }
  return {
    policy: "adopt",
    entry_count: row.entry_count,
    markdown_count: typeof row.markdown_count === "number" ? row.markdown_count : 0,
    has_git: row.has_git === true,
    symlink_count: typeof row.symlink_count === "number" ? row.symlink_count : 0,
    reserved_conflicts: typeof row.reserved_conflicts === "number" ? row.reserved_conflicts : 0,
    inventory_sha256: row.inventory_sha256,
  };
}

export function readInitJournal(root: string): InitJournal | null {
  const path = journalPath(root);
  if (!isRealFile(path)) return null;
  return parseJournal(readFileSync(path, "utf8"));
}

function writeJournal(files: CanonFiles, journal: InitJournal): void {
  writeAtomicFile(files, `.kizuki/${JOURNAL_NAME}`, `${JSON.stringify(journal, null, 2)}\n`);
}

function hardenControlTree(root: string, repaired: string[]): void {
  const control = join(root, ".kizuki");
  const stack = [control];
  let walked = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    walked += 1;
    if (walked > MAX_CONTROL_WALK) {
      throw new VaultInitError("inventory_limit", "control directory walk exceeded bound");
    }
    const st = lstatOrNull(current);
    if (st === null) continue;
    const rel = current.slice(root.length + 1);
    if (st.directory) {
      if (chmodPrivateDir(current)) repaired.push(rel);
      for (const name of readdirSync(current)) {
        stack.push(join(current, name));
      }
      continue;
    }
    if (st.file && chmodPrivateFile(current)) repaired.push(rel);
  }
}

export function hardenLedgerFile(dbPath: string): void {
  assertPermissionPlatform();
  if (!existsSync(dbPath)) return;
  chmodPrivateFile(dbPath);
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) chmodPrivateFile(sidecar);
  }
}

export function assertVaultControl(root: string): void {
  assertPermissionPlatform();
  const control = join(root, ".kizuki");
  const st = lstatOrNull(control);
  if (st === null) {
    throw new VaultInitError("not_a_directory", `missing control directory: ${control}`);
  }
  if (st.symlink) {
    throw new VaultInitError("symlink_escape", ".kizuki must be a directory, not a symlink");
  }
  if (!st.directory) {
    throw new VaultInitError("not_a_directory", ".kizuki exists and is not a directory");
  }
  assertOwned(control, st);
  if ((st.mode & 0o077) !== 0) {
    throw new VaultInitError(
      "insecure_permissions",
      `.kizuki is not owner-only (mode ${formatMode(st.mode)})`,
    );
  }
  const db = join(control, "kizuki.db");
  hardenLedgerFile(db);
  const dbStat = lstatOrNull(db);
  if (dbStat === null) return;
  if (!dbStat.file) {
    throw new VaultInitError("not_a_directory", "kizuki.db exists and is not a file");
  }
  assertOwned(db, dbStat);
  if ((dbStat.mode & 0o077) !== 0) {
    throw new VaultInitError(
      "insecure_permissions",
      `kizuki.db is not owner-only (mode ${formatMode(dbStat.mode)})`,
    );
  }
}

function classifyTarget(
  root: string,
  options: InitVaultOptions,
): { inventory: InitInventory | null; adopt: InitJournalAdopt | null } {
  if (!existsSync(root)) return { inventory: null, adopt: null };
  const st = lstatOrNull(root);
  if (st === null) return { inventory: null, adopt: null };
  if (st.symlink) {
    throw new VaultInitError("symlink_escape", "vault path must not be a symlink");
  }
  if (!st.directory) {
    throw new VaultInitError("not_a_directory", "vault path exists and is not a directory");
  }
  const inventory = inspectInventory(root);
  if (inventory.entry_count === 0 || isRepairableVault(root)) {
    return {
      inventory: options.adopt === true ? inventory : null,
      adopt: options.adopt === true ? inventoryReceipt(inventory) : null,
    };
  }
  if (options.adopt !== true) {
    throw new VaultInitError(
      "nonempty_requires_adopt",
      "vault path is not empty; pass --adopt to take ownership",
      inventory,
    );
  }
  const conflict = inventory.reserved_conflicts[0];
  if (conflict !== undefined) {
    throw new VaultInitError(
      "reserved_conflict",
      `reserved path is not a usable vault entry: ${conflict}`,
      inventory,
    );
  }
  return { inventory, adopt: inventoryReceipt(inventory) };
}

export function initVault(path: string, options: InitVaultOptions = {}): InitVaultResult {
  assertPermissionPlatform();
  path = resolve(path);
  const { adopt, dryRun } = options;
  options = Object.freeze({ ...(adopt === undefined ? {} : { adopt }), ...(dryRun === undefined ? {} : { dryRun }) });
  const existed = existsSync(path);
  if (options.dryRun === true) {
    if (existed) {
      const st = lstatOrNull(path);
      if (st !== null && st.symlink) throw new VaultInitError("symlink_escape", "vault path must not be a symlink");
      if (st !== null && !st.directory) throw new VaultInitError("not_a_directory", "vault path exists and is not a directory");
    }
    assertControlNotTracked(path);
    return { created: [], repaired: [], upgraded: [], dry_run: true, status: "dry-run", inventory: existed ? inspectInventory(path) : null };
  }
  // Classify before bootstrap creates the writer control directory.
  const classification = classifyTarget(path, options);
  assertControlNotTracked(path);
  const createdRoot = mkdirPrivate(path);
  const createdControl = !existsSync(join(path, ".kizuki"));
  const target = Object.freeze({ vault_path: path });
  try {
    return withVaultMutationSync(target, scope => initVaultOwned(scope, target, classification, createdRoot, createdControl));
  } catch (error) {
    if (error instanceof VaultMutationError && error.code === "writer_busy") {
      throw new VaultInitError("writer_busy", "canon writer is busy; retry vault initialization");
    }
    // Retain an incomplete bootstrap for repair: removing its active writer
    // inode could let a concurrent initializer acquire a different lock.
    throw error;
  }
}

function initVaultOwned(
  scope: VaultMutationScope,
  target: VaultMutationTarget,
  classification: { inventory: InitInventory | null; adopt: InitJournalAdopt | null },
  createdRoot: boolean,
  createdControl: boolean,
): InitVaultResult {
  assertVaultMutationScope(scope, target);
  const path = target.vault_path;
  assertControlNotTracked(path);
  const { inventory, adopt } = classification;
  const created: string[] = createdRoot ? ["./"] : [];
  const repaired: string[] = [];
  const upgraded: string[] = [];
  if (!createdRoot && chmodPrivateDir(path)) repaired.push("./");
  for (const directory of [...CANON_LAYOUT, ...CONTROL_LAYOUT]) {
    const directoryPath = join(path, directory);
    if (mkdirPrivate(directoryPath) || (directory === ".kizuki" && createdControl)) created.push(`${directory}/`);
    else if (chmodPrivateDir(directoryPath)) repaired.push(`${directory}/`);
  }
  // Permission repair precedes opening the owned descriptor capability; every
  // repair is already within the same writer scope as the subsequent bytes.
  hardenControlTree(path, repaired);
  for (const relativePath of ["CANON.md", "SCHEMA.md", ".gitignore"]) {
    if (existsSync(join(path, relativePath)) && chmodPrivateFile(join(path, relativePath))) repaired.push(relativePath);
    const leftover = join(path, `${relativePath}.tmp`);
    if (existsSync(leftover)) chmodPrivateFile(leftover);
  }
  return withMutationFilesSync(scope, target, files => {
    assertVaultMutationScope(scope, target);
    assertCanonFiles(files, path);
    const journal = files.read(`.kizuki/${JOURNAL_NAME}`);
    let previous: InitJournal | null;
    try { previous = journal === null ? null : parseJournal(Buffer.from(journal.bytes).toString("utf8")); }
    finally { journal?.close(); }
    writeJournal(files, { schema: INIT_JOURNAL_SCHEMA, status: "in_progress", doctrine_version: DOCTRINE_VERSION, adopt: adopt ?? previous?.adopt ?? null });
    const entries: ReadonlyArray<readonly [string, string]> = [
      ["CANON.md", CANON_DOCTRINE], ["SCHEMA.md", SCHEMA_DOCTRINE],
      [".gitignore", ROOT_GITIGNORE], [".kizuki/.gitignore", CONTROL_GITIGNORE],
    ];
    for (const [relativePath, content] of entries) {
      const leftover = files.read(`${relativePath}.tmp`);
      if (leftover !== null) {
        try { files.remove(leftover); } finally { leftover.close(); }
      }
      const prior = files.read(relativePath);
      if (prior === null) {
        writeAtomicFile(files, relativePath, content);
        created.push(relativePath);
        continue;
      }
      try {
        if (relativePath === ".gitignore") {
          if (ensureRootGitIgnore(files, relativePath, Buffer.from(prior.bytes)) && !repaired.includes(relativePath)) repaired.push(relativePath);
          continue;
        }
        if ((relativePath === "CANON.md" || relativePath === "SCHEMA.md") &&
            classifyDoctrine(Buffer.from(prior.bytes).toString("utf8"), relativePath) === "upgradeable") {
          writeAtomicFile(files, relativePath, content);
          upgraded.push(relativePath);
        }
      } finally { prior.close(); }
    }
    writeJournal(files, { schema: INIT_JOURNAL_SCHEMA, status: "ready", doctrine_version: DOCTRINE_VERSION, adopt: adopt ?? previous?.adopt ?? null });
    return { created, repaired, upgraded, dry_run: false, status: "ready" as const, inventory };
  });
}
