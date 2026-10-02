import { closeSync, constants, fstatSync } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  EVENT_LIMITS,
  MAX_CURSOR_BYTES,
  MAX_SYNC_BATCH_BYTES,
  MAX_SYNC_BATCH_EVENTS,
  freezeManifest,
  isPlainObject,
  massWithdrawalDetail,
  massWithdrawalHeld,
  openSourceChild,
  policyForConnector,
  SourceReadError,
} from "@kizuki/core";
import type {
  CaptureEventInput,
  SubjectRef,
  Connector,
  Cursor,
  HealthReport,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import { KizukiError, notSupported } from "../errors";
import {
  importHealthReport,
  misconfiguredHealth,
  summarizeImportErrors,
} from "../import-report";
import type { ImportRecordError } from "../import-report";
import { EpochReader, pairMoves } from "../mirror";
import type { RecordHistoryReader } from "../mirror";
import { readBoundedFd, readReason } from "../read";
import {
  compareStrings,
  errorMessage,
  requireKnownKeys,
  requirePathConfig,
} from "../util";

export const MARKDOWN_FOLDER_CONNECTOR_ID = "kizuki.markdown-folder" as const;
export const MARKDOWN_CURSOR_SCHEMA = "kizuki.markdown-folder.cursor/v1" as const;

/** The default is the largest capture page Core accepts. */
export const DEFAULT_PAGE_SIZE = MAX_SYNC_BATCH_EVENTS;
export const MAX_PAGE_SIZE = 10_000;
export const MAX_DEPTH = 16;
export const MAX_FILES = 50_000;
export const MAX_FILE_BYTES = EVENT_LIMITS.textBytes;
export const MAX_SCAN_ENTRIES = 100_000;
/** Identity JSON, including the optional 64-hex subject digest, without the path. */
const PACK_IDENTITY_JSON_OVERHEAD_BYTES = 182;
/** NAME_MAX-class path budget per identity at MAX_FILES. */
const PACK_PATH_BUDGET_BYTES = 256;
/** gunzip ceiling for `pack`; scan MAX_FILES is unchanged. */
export const MAX_PACK_DECODED_BYTES =
  MAX_FILES * (PACK_PATH_BUDGET_BYTES + PACK_IDENTITY_JSON_OVERHEAD_BYTES);
const STABLE_READ_ATTEMPTS = 3;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".kizuki",
  "node_modules",
  "vendor",
  "dist",
]);

const CONFIG_KEYS = ["path", "page_size", "exclude"];

export interface MarkdownFolderConfig {
  path: string;
  page_size?: number;
  exclude?: string[];
}

export interface MarkdownFileIdentity {
  sha256: string;
  size: number;
  /** The original document identity, retained when a unique byte match moves. */
  subject_sha256?: string;
}

type FileIdentity = MarkdownFileIdentity;

/** Factory-only. Never serialized into connection config or protected state. */
export interface MarkdownFolderDeps {
  /**
   * Latest live `[relativePath, {sha256,size}]` identities for this source.
   * Called on every non-null capture page; null input must not consult it.
   */
  committedFiles?: () =>
    | ReadonlyArray<readonly [string, MarkdownFileIdentity]>
    | Promise<ReadonlyArray<readonly [string, MarkdownFileIdentity]>>;
  /**
   * What the ledger holds for each of these records. A record whose state
   * changes (deleted then restored, edited then reverted) is emitted with
   * `revision_epoch`, so bytes the ledger has seen before are not swallowed as
   * a duplicate.
   */
  recordHistory?: RecordHistoryReader;
  /**
   * The owner's release of a held mass withdrawal: a pass that withdraws at
   * most this many records proceeds. Set by the sync command for one run.
   */
  confirmWithdrawals?: number;
}

/** A file with its bytes in hand. */
type LoadedFile = MarkdownFile & { content: string };

interface MarkdownFile {
  /** Null on a continuation page; read it again before emitting. */
  content: string | null;
  sha256: string;
  size: number;
  relpath: string;
  mtimeMs: number;
}

interface RootIdentity {
  realpath: string;
  dev: number;
  ino: number;
}

/**
 * The folder is identified by its path and its files' content, never by the
 * device and inode it happens to sit on: a disk migration, a restore or a
 * recreated folder keeps its checkpoint and emits only real differences.
 */
interface CursorRoot {
  realpath: string;
}

export interface MarkdownCursor {
  schema: typeof MARKDOWN_CURSOR_SCHEMA;
  connector_id: typeof MARKDOWN_FOLDER_CONNECTOR_ID;
  root: CursorRoot;
  options: { page_size: number; exclude: string[] };
  exhausted: boolean;
  phase: "files" | "tombstones";
  after: string | null;
  files: Array<[string, FileIdentity]>;
}

interface ScanResult {
  files: MarkdownFile[];
  errors: ImportRecordError[];
  truncated: boolean;
}

const MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1",
  connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
  version: "0.2.0",
  contract_minor: 2,
  implementation: "@kizuki/connectors",
  allowed_egress: [],
  cursor_schema: MARKDOWN_CURSOR_SCHEMA,
  kinds: ["file"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: true,
    purge: false,
    fixture: true,
    sync_from_backfill_before_first_success: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: false,
  ...policyForConnector(MARKDOWN_FOLDER_CONNECTOR_ID),
  auth_modes: ["none"],
});

export class MarkdownFolderConnector implements Connector {
  readonly path: string;
  readonly pageSize: number;
  readonly exclude: readonly string[];
  private readonly committedFiles: MarkdownFolderDeps["committedFiles"];
  private readonly recordHistory: MarkdownFolderDeps["recordHistory"];
  private readonly confirmedWithdrawals: number;
  /** A bounded scan reused only by the next page of this drain, never a later sync. */
  private continuation: { cursor: Cursor; root: RootIdentity; scan: ScanResult } | null = null;

  constructor(config: MarkdownFolderConfig, deps: MarkdownFolderDeps = {}) {
    this.path = requirePathConfig(config, MARKDOWN_FOLDER_CONNECTOR_ID);
    requireKnownKeys(config, MARKDOWN_FOLDER_CONNECTOR_ID, CONFIG_KEYS);
    this.pageSize = parsePageSize(config.page_size);
    this.exclude = parseExclude(config.exclude);
    this.committedFiles = deps.committedFiles;
    this.recordHistory = deps.recordHistory;
    this.confirmedWithdrawals = deps.confirmWithdrawals ?? 0;
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  async health(): Promise<HealthReport> {
    const checked_at = new Date().toISOString();
    try {
      const root = await rootIdentity(this.path);
      const scan = await scanMarkdownFiles(root, this.exclude);
      return importHealthReport({
        checked_at,
        events: scan.files.length,
        errors: scan.errors,
        truncated: scan.truncated,
      });
    } catch (error) {
      return misconfiguredHealth(checked_at, errorMessage(error));
    }
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(cursor: Cursor | null): Promise<SyncBatch> {
    return this.sweep(cursor);
  }

  async sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.sweep(cursor);
  }

  async revoke(): Promise<void> {}

  async purgeSource(_subject_id: string): Promise<PurgePlan> {
    return notSupported(MARKDOWN_FOLDER_CONNECTOR_ID, "purge");
  }

  async fixture(): Promise<CaptureEventInput[]> {
    return [
      fixtureEvent("journal/2026-01-01.md", "A quiet beginning."),
      fixtureEvent("people/ada.md", "# Ada\n\nMet at the library."),
      fixtureEvent("projects/kizuki.md", "# Kizuki\n\nLocal-first memory."),
    ];
  }

  private async sweep(cursor: Cursor | null): Promise<SyncBatch> {
    const root = await rootIdentity(this.path);
    const previous =
      cursor === null ? undefined : parseCursor(cursor, root, this, this.committedFiles !== undefined);
    const previousFiles = await this.snapshotIdentities(previous);
    const pending = this.continuation;
    this.continuation = null;
    const continuing = pending !== null && pending.cursor === cursor &&
      pending.root.realpath === root.realpath && pending.root.dev === root.dev && pending.root.ino === root.ino;
    const scan = continuing ? pending.scan : await scanMarkdownFiles(root, this.exclude);
    const observedAt = new Date().toISOString();
    const current = new Map(
      scan.files.map((file) => [file.relpath, file] as const),
    );
    const scanErrors = [...scan.errors];
    const finish = (batch: SyncBatch): SyncBatch => {
      if (!filesDone && batch.has_more === true && batch.cursor !== null && scanErrors.length === 0 && !scan.truncated) {
        // Retain identities only. Each later emitted page reopens its files
        // through the existing descriptor-bound reader. A root replacement
        // discards this continuation; another sync always walks anew.
        if (!continuing) for (const file of scan.files) file.content = null;
        this.continuation = { cursor: batch.cursor, root, scan };
      }
      return batch;
    };
    const hostBacked = this.committedFiles !== undefined;
    const emitPageSize = Math.min(this.pageSize, MAX_SYNC_BATCH_EVENTS);

    // Files whose bytes differ from the last committed identity, relpath order.
    const changed = scan.files.filter((file) => {
      const prior = previousFiles.get(file.relpath);
      return !(
        prior !== undefined &&
        prior.sha256 === file.sha256 &&
        prior.size === file.size
      );
    });

    // Records gone from the source, unless a scan error hides them.
    let absent: string[] = [];
    if (previous !== undefined && !scan.truncated) {
      const failed = scanErrors.map((error) => error.location);
      absent = [...previousFiles.keys()]
        .sort(compareStrings)
        .filter((relpath) => !current.has(relpath) && !hiddenByScanError(relpath, failed));
    }

    // A file that reappears under a new name with the same bytes is a move:
    // one event that names its origin, and no tombstone for the old name.
    const moves = pairMoves(
      changed
        .filter((file) => !previousFiles.has(file.relpath))
        .map((file) => ({ relpath: file.relpath, hash: file.sha256, size: file.size })),
      absent.flatMap((relpath) => {
        const identity = previousFiles.get(relpath);
        return identity === undefined
          ? []
          : [{ relpath, hash: identity.sha256 }];
      }),
    );
    const movedAway = new Set(moves.values());
    const withdrawn = absent.filter((relpath) => !movedAway.has(relpath));
    const held =
      previous !== undefined &&
      massWithdrawalHeld(withdrawn.length, previousFiles.size, this.confirmedWithdrawals);
    const tombstones = held
      ? []
      : withdrawn.map((relpath) => tombstone(relpath, observedAt, previousFiles.get(relpath)?.subject_sha256));

    // Each sweep diffs against the durable identities updated by prior pages.
    // An interrupted drain walks anew and includes changes below `after`.
    // Keep phase/after as compatible cursor hints, never as exclusion bounds.
    // Events are built for the page only: a batch costs its page, not the tree.
    const epochs = new EpochReader(this.recordHistory);
    const changedNames = changed.map((file) => file.relpath);
    const filePage: CaptureEventInput[] = [];
    const emitted = new Map<string, LoadedFile>();
    let encoded = 2;
    let index = 0;
    for (; index < changed.length && filePage.length < emitPageSize; index += 1) {
      const file = await this.loadFile(root, changed[index]!, scanErrors);
      if (file === null) continue;
      if (file.sha256 !== changed[index]!.sha256 || file.size !== changed[index]!.size) {
        scanErrors.push({ location: file.relpath, code: "unstable", reason: "file changed during the capture drain" });
        continue;
      }
      const movedFrom = moves.get(file.relpath);
      const prior = previousFiles.get(movedFrom ?? file.relpath);
      const epoch = await epochs.of(changedNames, index, (relpath) => previousFiles.has(relpath));
      const subject = prior?.subject_sha256 ??
        (movedFrom === undefined ? epochs.subjectOf(file.relpath) : subjectDigest(movedFrom));
      const event = fileEvent(
        file,
        observedAt,
        epoch,
        movedFrom,
        subject,
      );
      const extra = utf8Bytes(JSON.stringify(event));
      if (extra + 2 > MAX_SYNC_BATCH_BYTES) {
        scanErrors.push({
          location: file.relpath,
          code: "too_large",
          reason: "encoded event exceeds the sync batch bound",
        });
        continue;
      }
      if (filePage.length > 0 && encoded + extra + 1 > MAX_SYNC_BATCH_BYTES) break;
      filePage.push(event);
      emitted.set(file.relpath, file);
      encoded += extra + (filePage.length === 1 ? 0 : 1);
    }
    const filesDone = index >= changed.length;
    const pendingRefusal = scanErrors.length > 0 || scan.truncated;

    const processed = new Map(previousFiles);
    for (const event of filePage) {
      const file = emitted.get(event.source_record_id);
      if (file !== undefined) {
        processed.set(event.source_record_id, {
          sha256: file.sha256,
          size: file.size,
          ...(typeof event.metadata["subject_sha256"] === "string"
            ? { subject_sha256: event.metadata["subject_sha256"] } : {}),
        });
      }
      const movedFrom = moves.get(event.source_record_id);
      if (movedFrom !== undefined) processed.delete(movedFrom);
    }

    const mint = (
      exhausted: boolean,
      phase: "files" | "tombstones",
      after: string | null,
    ): Cursor | undefined => {
      const encoded = hostBacked
        ? encodeCompactCursor({
            schema: MARKDOWN_CURSOR_SCHEMA,
            connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
            root: { realpath: root.realpath },
            options: { page_size: this.pageSize, exclude: [...this.exclude] },
            exhausted,
            phase,
            after,
          })
        : encodeCursor({
            schema: MARKDOWN_CURSOR_SCHEMA,
            connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
            root: { realpath: root.realpath },
            options: { page_size: this.pageSize, exclude: [...this.exclude] },
            exhausted,
            phase,
            after,
            files: sortedPairs(processed),
          });
      return utf8Bytes(encoded) > MAX_CURSOR_BYTES ? undefined : encoded;
    };

    const overflow = (): SyncBatch => ({
      events: [],
      cursor,
      status: "unavailable",
      detail: `partial_import: ${summarizeImportErrors([
        ...scanErrors,
        {
          location: ".",
          code: "cursor_limit",
          reason: "snapshot exceeds the resume cursor bound",
        },
      ])}${scan.truncated ? "; scan truncated" : ""}`,
    });

    if (!filesDone) {
      const last = filePage[filePage.length - 1];
      const next = mint(false, "files", last?.source_record_id ?? null);
      if (next === undefined) return overflow();
      return finish({ events: filePage, cursor: next, has_more: true });
    }

    if (filePage.length > 0) {
      const noTombstones = tombstones.length === 0 && !held;
      const next = mint(
        noTombstones && !scan.truncated,
        noTombstones ? "files" : "tombstones",
        null,
      );
      if (next === undefined) return overflow();
      return finish({
        events: filePage,
        cursor: next,
        has_more: !noTombstones || pendingRefusal,
      });
    }

    if (held) {
      // The hold changes no checkpoint: the next pass measures the source
      // again, so restoring the tree clears it and a confirmation releases it.
      return {
        events: [],
        cursor,
        status: "unavailable",
        detail: massWithdrawalDetail(withdrawn.length, previousFiles.size),
      };
    }

    if (tombstones.length === 0) {
      // Valid pages have already checkpointed. Keep unreadable identities in
      // that checkpoint and report the incomplete sweep without advancing it.
      if (pendingRefusal) {
        return {
          events: [],
          cursor,
          status: "unavailable",
          detail: `partial_import: ${summarizeImportErrors(scanErrors)}${scan.truncated ? "; scan truncated" : ""}`,
        };
      }
      const next = mint(!scan.truncated, "files", null);
      if (next === undefined) return overflow();
      return { events: [], cursor: next, has_more: false };
    }

    const { page: tombstonePage, rest: tombstoneRest } = takePage(
      tombstones,
      emitPageSize,
    );
    for (const event of tombstonePage) {
      processed.delete(event.source_record_id);
    }
    const tombstonesDone = tombstoneRest.length === 0;
    const exhausted = tombstonesDone && !scan.truncated;
    if (exhausted) {
      for (const file of scan.files) {
        processed.set(file.relpath, { ...processed.get(file.relpath), sha256: file.sha256, size: file.size });
      }
    }
    const lastTombstone = tombstonePage[tombstonePage.length - 1];
    const next = mint(
      exhausted,
      exhausted ? "files" : "tombstones",
      exhausted ? null : (lastTombstone?.source_record_id ?? null),
    );
    if (next === undefined) return overflow();
    return finish({
      events: tombstonePage,
      cursor: next,
      has_more: !exhausted || pendingRefusal,
    });
  }

  /** Reopen a continuation file through the same descriptor-bound reader. */
  private async loadFile(
    root: RootIdentity,
    file: MarkdownFile,
    errors: ImportRecordError[],
  ): Promise<LoadedFile | null> {
    if (file.content !== null) return { ...file, content: file.content };
    const read = await readMarkdownAt(root, file.relpath);
    if ("error" in read) {
      errors.push(read.error);
      return null;
    }
    return { ...read.file, content: read.file.content ?? "" };
  }

  private async snapshotIdentities(
    previous: MarkdownCursor | undefined,
  ): Promise<Map<string, FileIdentity>> {
    if (previous === undefined) return new Map();
    if (this.committedFiles === undefined) return new Map(previous.files);
    return new Map(parseCommittedIdentities(await this.committedFiles()));
  }
}

export function createMarkdownFolderConnector(
  config: MarkdownFolderConfig,
  deps: MarkdownFolderDeps = {},
): MarkdownFolderConnector {
  return new MarkdownFolderConnector(config, deps);
}

function parsePageSize(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_PAGE_SIZE
  ) {
    throw new KizukiError(
      "misconfigured",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: page_size must be an integer from 1 to ${MAX_PAGE_SIZE}`,
    );
  }
  return value;
}

function parseExclude(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new KizukiError(
      "misconfigured",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: exclude must be an array of non-empty strings`,
    );
  }
  return [...value].sort(compareStrings);
}

async function rootIdentity(root: string): Promise<RootIdentity> {
  let resolved: string;
  try {
    resolved = await realpath(root);
  } catch (error) {
    throw new KizukiError(
      "misconfigured",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: cannot access configured root`,
      { cause: error },
    );
  }
  const info = await lstat(resolved);
  if (!info.isDirectory()) {
    throw new KizukiError(
      "misconfigured",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: path is not a directory`,
    );
  }
  // Resolve aliases first. A source inside any Kizuki vault is derived output,
  // even when the selected child is named archive, auto, or an ordinary folder.
  await assertOutsideVault(resolved);
  return { realpath: resolved, dev: info.dev, ino: info.ino };
}

function refuseVaultSource(): never {
  throw new KizukiError("misconfigured", "source_contains_kizuki_vault: choose an independent source folder outside Kizuki canon, archives and control data");
}

async function assertOutsideVault(directory: string): Promise<void> {
  let current = directory;
  for (let depth = 0; depth < 256; depth++) {
    try {
      // lstat also recognizes a dangling or hostile marker symlink. Exclude
      // patterns cannot suppress this identity check.
      await lstat(path.join(current, ".kizuki"));
      refuseVaultSource();
    } catch (error) {
      if (!isPlainObject(error) && !(error instanceof Error)) throw error;
      if (!("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
  throw new KizukiError("misconfigured", "source_path_depth: source ancestry exceeds the verification bound");
}

function underPinnedRoot(root: string, resolved: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return resolved === root || resolved.startsWith(prefix);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function replacedDirectoryError(): Error {
  return Object.assign(
    new Error("the listed directory was replaced while it was read"),
    { code: "ELOOP" },
  );
}

async function classifyReplacedDirectory(directory: string): Promise<void> {
  let resolved: string;
  try {
    resolved = await realpath(directory);
  } catch {
    return;
  }
  await assertOutsideVault(resolved);
}

/** The listed parent inode is the authority for all children opened through it. */
async function openPinnedDirectory(
  parent: RootIdentity,
): Promise<FileHandle> {
  const directory = await open(
    parent.realpath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await directory.stat();
    if (
      !info.isDirectory() ||
      info.dev !== parent.dev ||
      info.ino !== parent.ino
    ) {
      throw replacedDirectoryError();
    }
    return directory;
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
}

// Between lstat and readdir a child can be replaced with a symlink. Keep the
// listing only when this path still resolves under the pinned source; a
// vault-child target refuses the batch so earlier files are not published.
async function pinnedDescent(
  root: string,
  directory: string,
): Promise<
  | { kind: "directory"; realpath: string; dev: number; ino: number }
  | { kind: "symlink" }
  | { kind: "unreadable"; reason: string }
> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    return { kind: "unreadable", reason: readReason(error) };
  }
  if (info.isSymbolicLink()) {
    let resolved: string;
    try {
      resolved = await realpath(directory);
    } catch {
      return { kind: "symlink" };
    }
    await assertOutsideVault(resolved);
    return { kind: "symlink" };
  }
  if (!info.isDirectory()) {
    return { kind: "unreadable", reason: "path is not a directory" };
  }
  let resolved: string;
  try {
    resolved = await realpath(directory);
  } catch (error) {
    return { kind: "unreadable", reason: readReason(error) };
  }
  if (!underPinnedRoot(root, resolved)) {
    await assertOutsideVault(resolved);
    return { kind: "symlink" };
  }
  return { kind: "directory", realpath: resolved, dev: info.dev, ino: info.ino };
}

async function scanMarkdownFiles(
  root: RootIdentity,
  exclude: readonly string[],
): Promise<ScanResult> {
  const files: MarkdownFile[] = [];
  const errors: ImportRecordError[] = [];
  let truncated = false;
  let considered = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (depth > MAX_DEPTH) {
      errors.push({
        location: relpathOf(root.realpath, directory),
        code: "depth",
        reason: "directory exceeds the scan depth limit",
      });
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({
        location: relpathOf(root.realpath, directory) || ".",
        code: "unreadable",
        reason: readReason(error),
      });
      return;
    }
    // The listing may already have followed a replacement symlink. A nested
    // vault marker on that listing must abort before any of these names are
    // published, including when the path is later skipped as a symlink.
    if (entries.some(entry => entry.name === ".kizuki")) refuseVaultSource();
    const descent = await pinnedDescent(root.realpath, directory);
    if (descent.kind !== "directory") {
      errors.push({
        location: relpathOf(root.realpath, directory) || ".",
        code: descent.kind === "symlink" ? "symlink" : "unreadable",
        reason: descent.kind === "symlink" ? "symlink skipped" : descent.reason,
      });
      return;
    }
    if (depth === 0 && (descent.dev !== root.dev || descent.ino !== root.ino)) {
      await classifyReplacedDirectory(descent.realpath);
      errors.push({
        location: ".",
        code: "unreadable",
        reason: "root was replaced while it was read",
      });
      return;
    }
    let parent: FileHandle;
    try {
      parent = await openPinnedDirectory(descent);
    } catch (error) {
      await classifyReplacedDirectory(descent.realpath);
      errors.push({
        location: relpathOf(root.realpath, directory) || ".",
        code: "unreadable",
        reason: readReason(error),
      });
      return;
    }
    try {
      entries.sort((left, right) => compareStrings(left.name, right.name));
      for (const entry of entries) {
        if (truncated) return;
        considered += 1;
        if (considered > MAX_SCAN_ENTRIES) {
          truncated = true;
          errors.push({
            location: relpathOf(root.realpath, descent.realpath) || ".",
            code: "scan_limit",
            reason: "scan exceeded the entry bound",
          });
          return;
        }
        if (shouldSkipName(entry.name, exclude)) continue;
        const absolute = path.join(descent.realpath, entry.name);
        let info;
        try {
          info = await lstat(absolute);
        } catch (error) {
          errors.push({
            location: relpathOf(root.realpath, absolute),
            code: "unreadable",
            reason: readReason(error),
          });
          continue;
        }
        if (info.isSymbolicLink()) {
          errors.push({
            location: relpathOf(root.realpath, absolute),
            code: "symlink",
            reason: "symlink skipped",
          });
          continue;
        }
        if (info.isDirectory()) {
          await walk(absolute, depth + 1);
          continue;
        }
        if (!info.isFile() || !isMarkdownName(entry.name)) continue;
        const relpath = relpathOf(root.realpath, absolute);
        if (files.length >= MAX_FILES) {
          truncated = true;
          errors.push({
            location: relpath,
            code: "file_limit",
            reason: "scan exceeded the file bound",
          });
          return;
        }
        const read = await readStableMarkdown(parent.fd, entry.name, relpath);
        if ("error" in read) {
          errors.push(read.error);
          continue;
        }
        files.push(read.file);
      }
    } finally {
      await parent.close().catch(() => undefined);
    }
  };

  await walk(root.realpath, 0);
  await assertOutsideVault(root.realpath);
  files.sort((left, right) => compareStrings(left.relpath, right.relpath));
  return { files, errors, truncated };
}

async function readStableMarkdown(
  parentFd: number,
  name: string,
  relpath: string,
): Promise<{ file: MarkdownFile } | { error: ImportRecordError }> {
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = openSourceChild(parentFd, name);
      const before = fstatSync(fd);
      if (!before.isFile()) {
        return {
          error: {
            location: relpath,
            code: "not_file",
            reason: "path is not a regular file",
          },
        };
      }
      if (before.size > MAX_FILE_BYTES) {
        return {
          error: {
            location: relpath,
            code: "too_large",
            reason: "file exceeds the per-file byte bound",
          },
        };
      }
      const bytes = readBoundedFd(
        fd,
        MAX_FILE_BYTES,
        MARKDOWN_FOLDER_CONNECTOR_ID,
        "file",
        before.size,
      );
      const after = fstatSync(fd);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino
      ) {
        continue;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return {
          error: {
            location: relpath,
            code: "not_utf8",
            reason: "file is not valid UTF-8",
          },
        };
      }
      const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
      return {
        file: {
          content: withoutBom,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
          relpath,
          mtimeMs: after.mtimeMs,
        },
      };
    } catch (error) {
      if (error instanceof KizukiError) throw error;
      if (
        (error instanceof SourceReadError && error.reason === "symlink") ||
        isErrno(error, "ELOOP") ||
        isErrno(error, "ENOTDIR")
      ) {
        return {
          error: {
            location: relpath,
            code: "symlink",
            reason: "symlink skipped",
          },
        };
      }
      return {
        error: {
          location: relpath,
          code: "unreadable",
          reason: error instanceof SourceReadError ? error.reason : readReason(error),
        },
      };
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* The descriptor is already gone. */ }
    }
  }
  return {
    error: {
      location: relpath,
      code: "unstable",
      reason: "file changed while it was read",
    },
  };
}

/** Reads one file again through its pinned parent directory, as the scan does. */
async function readMarkdownAt(
  root: RootIdentity,
  relpath: string,
): Promise<{ file: MarkdownFile } | { error: ImportRecordError }> {
  const absolute = path.join(root.realpath, ...relpath.split("/"));
  const descent = await pinnedDescent(root.realpath, path.dirname(absolute));
  if (descent.kind !== "directory") {
    return {
      error: {
        location: relpath,
        code: descent.kind === "symlink" ? "symlink" : "unreadable",
        reason: descent.kind === "symlink" ? "symlink skipped" : descent.reason,
      },
    };
  }
  let parent: FileHandle;
  try {
    parent = await openPinnedDirectory(descent);
  } catch (error) {
    await classifyReplacedDirectory(descent.realpath);
    return { error: { location: relpath, code: "unreadable", reason: readReason(error) } };
  }
  try {
    return await readStableMarkdown(parent.fd, path.basename(absolute), relpath);
  } finally {
    await parent.close().catch(() => undefined);
  }
}

function shouldSkipName(name: string, exclude: readonly string[]): boolean {
  if (name.startsWith(".")) return true;
  if (SKIP_DIRECTORIES.has(name)) return true;
  return exclude.includes(name);
}

function isMarkdownName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function relpathOf(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function hiddenByScanError(
  relpath: string,
  failed: readonly string[],
): boolean {
  for (const location of failed) {
    if (location === "." || location === relpath) return true;
    if (location.length > 0 && relpath.startsWith(`${location}/`)) return true;
  }
  return false;
}

/** Source-record identity, bounded without lossy path normalization or mtime dependence. */
function subjectDigest(relpath: string): string {
  return new Bun.CryptoHasher("sha256").update(relpath).digest("hex");
}

function documentSubject(relpath: string, digest = subjectDigest(relpath)): SubjectRef {
  return {
    subject_id: `markdown-folder:${digest}`,
    role: "about",
    display_name: path.basename(relpath),
  };
}

function fileEvent(
  file: LoadedFile,
  observedAt: string,
  epoch: number,
  movedFrom: string | undefined,
  subjectSha256?: string,
): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
    source_record_id: file.relpath,
    kind: "file",
    occurred_at: new Date(file.mtimeMs).toISOString(),
    observed_at: observedAt,
    text: file.content,
    subjects: [documentSubject(file.relpath, subjectSha256)],
    deleted: false,
    attachments: [],
    metadata: {
      relpath: file.relpath,
      size: file.size,
      sha256: file.sha256,
      ...(epoch > 0 ? { revision_epoch: epoch } : {}),
      ...(movedFrom === undefined ? {} : { moved_from: movedFrom }),
      ...(subjectSha256 === undefined ? {} : { subject_sha256: subjectSha256 }),
    },
  };
}

function tombstone(relpath: string, observedAt: string, subjectSha256?: string): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
    source_record_id: relpath,
    kind: "file",
    occurred_at: observedAt,
    observed_at: observedAt,
    text: "",
    subjects: [documentSubject(relpath, subjectSha256)],
    deleted: true,
    attachments: [],
    metadata: { relpath, snapshot: "absent" },
  };
}

function fixtureEvent(relpath: string, text: string): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
    source_record_id: relpath,
    kind: "file",
    occurred_at: "2026-01-01T00:00:00.000Z",
    observed_at: "2026-01-01T00:00:00.000Z",
    text,
    subjects: [documentSubject(relpath)],
    deleted: false,
    attachments: [],
    metadata: {
      relpath,
      size: Buffer.byteLength(text),
      sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
    },
  };
}

function encodeCursor(cursor: MarkdownCursor): Cursor {
  const plain = JSON.stringify(cursor);
  // Core refuses resume tokens over MAX_CURSOR_BYTES; pack the identity map.
  if (utf8Bytes(plain) <= MAX_CURSOR_BYTES) return plain;
  const { files, ...header } = cursor;
  const identityJson = Buffer.from(JSON.stringify(files));
  if (identityJson.byteLength > MAX_PACK_DECODED_BYTES) return plain;
  return JSON.stringify({
    ...header,
    pack: Buffer.from(gzipSync(identityJson)).toString("base64"),
  });
}

function encodeCompactCursor(
  header: Omit<MarkdownCursor, "files">,
): Cursor {
  return JSON.stringify({
    schema: header.schema,
    connector_id: header.connector_id,
    root: header.root,
    options: header.options,
    exhausted: header.exhausted,
    phase: header.phase,
    after: header.after,
    committed_identities: true,
  });
}

function parseCursor(
  cursor: Cursor,
  root: RootIdentity,
  connector: MarkdownFolderConnector,
  committedReader: boolean,
): MarkdownCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch (error) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: malformed cursor`,
      { cause: error },
    );
  }
  if (
    !isPlainObject(parsed) ||
    parsed["schema"] !== MARKDOWN_CURSOR_SCHEMA ||
    parsed["connector_id"] !== MARKDOWN_FOLDER_CONNECTOR_ID ||
    typeof parsed["exhausted"] !== "boolean" ||
    (parsed["phase"] !== "files" && parsed["phase"] !== "tombstones") ||
    !(parsed["after"] === null || typeof parsed["after"] === "string") ||
    !isPlainObject(parsed["root"]) ||
    typeof parsed["root"]["realpath"] !== "string" ||
    !isPlainObject(parsed["options"]) ||
    typeof parsed["options"]["page_size"] !== "number" ||
    !Array.isArray(parsed["options"]["exclude"])
  ) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor snapshot`,
    );
  }
  const packed = parsed["pack"];
  const hasPack = typeof packed === "string";
  const hasFiles = Array.isArray(parsed["files"]);
  const committed = parsed["committed_identities"] === true;
  if (Object.hasOwn(parsed, "committed_identities") && !committed) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor snapshot`,
    );
  }
  if (committed) {
    if (
      hasPack ||
      hasFiles ||
      Object.hasOwn(parsed, "files") ||
      Object.hasOwn(parsed, "pack")
    ) {
      throw new KizukiError(
        "parse_error",
        `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor snapshot`,
      );
    }
    if (!committedReader) {
      throw new KizukiError(
        "parse_error",
        `${MARKDOWN_FOLDER_CONNECTOR_ID}: committed identities required`,
      );
    }
  } else if (hasPack === hasFiles) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor snapshot`,
    );
  }
  // A compact cursor names no files: its baseline is the source's committed
  // identities, so the same connection resumes on a restored, migrated or
  // recreated folder and emits only what differs. A cursor that carries its
  // own snapshot belongs to the folder it was taken from. Tokens minted
  // before this rule also pinned the device and inode; they are still read.
  if (!committed && parsed["root"]["realpath"] !== root.realpath) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: cursor does not belong to this root`,
    );
  }
  // The page size only sets how much one batch emits, so a token taken at
  // another size resumes at this one. The exclusions decide which files exist.
  if (
    JSON.stringify(parsed["options"]["exclude"]) !==
    JSON.stringify([...connector.exclude])
  ) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: cursor does not match this configuration`,
    );
  }
  const files = committed
    ? []
    : typeof packed === "string"
      ? parsePackedFiles(packed)
      : parseFilePairs(parsed["files"]);
  return {
    schema: MARKDOWN_CURSOR_SCHEMA,
    connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
    root: { realpath: parsed["root"]["realpath"] },
    options: {
      page_size: parsed["options"]["page_size"],
      exclude: parsed["options"]["exclude"].map(String),
    },
    exhausted: parsed["exhausted"],
    phase: parsed["phase"],
    after: parsed["after"],
    files,
  };
}

function sortedPairs(
  files: Map<string, FileIdentity>,
): Array<[string, FileIdentity]> {
  return [...files.entries()].sort(([left], [right]) =>
    compareStrings(left, right),
  );
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function takePage(
  events: CaptureEventInput[],
  pageSize: number,
): { page: CaptureEventInput[]; rest: CaptureEventInput[] } {
  const page: CaptureEventInput[] = [];
  let encoded = 2;
  let index = 0;
  while (index < events.length && page.length < pageSize) {
    const event = events[index]!;
    const extra = utf8Bytes(JSON.stringify(event)) + (page.length === 0 ? 0 : 1);
    if (page.length > 0 && encoded + extra > MAX_SYNC_BATCH_BYTES) break;
    page.push(event);
    encoded += extra;
    index += 1;
  }
  return { page, rest: events.slice(index) };
}

function parseCommittedIdentities(
  value: unknown,
): Array<[string, FileIdentity]> {
  try {
    return parseFilePairs(value);
  } catch (error) {
    if (error instanceof KizukiError) {
      throw new KizukiError(
        "parse_error",
        `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid committed identities`,
        { cause: error },
      );
    }
    throw error;
  }
}

function parsePackedFiles(pack: string): Array<[string, FileIdentity]> {
  let unpacked: unknown;
  try {
    unpacked = JSON.parse(
      Buffer.from(
        gunzipSync(Buffer.from(pack, "base64"), {
          maxOutputLength: MAX_PACK_DECODED_BYTES,
        }),
      ).toString("utf8"),
    ) as unknown;
  } catch (error) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: malformed cursor pack`,
      { cause: error },
    );
  }
  return parseFilePairs(unpacked);
}

function parseFilePairs(value: unknown): Array<[string, FileIdentity]> {
  if (!Array.isArray(value) || value.length > MAX_FILES) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor file identity`,
    );
  }
  const files: Array<[string, FileIdentity]> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isPlainObject(entry[1])) {
      throw new KizukiError(
        "parse_error",
        `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor file identity`,
      );
    }
    const relpath = entry[0];
    const sha256 = entry[1]["sha256"];
    const size = entry[1]["size"];
    const subject = entry[1]["subject_sha256"];
    if (
      typeof relpath !== "string" ||
      relpath.length === 0 ||
      utf8Bytes(relpath) > EVENT_LIMITS.sourceRecordIdBytes ||
      seen.has(relpath) ||
      typeof sha256 !== "string" ||
      !SHA256_HEX.test(sha256) ||
      typeof size !== "number" ||
      !Number.isInteger(size) ||
      size < 0 ||
      size > MAX_FILE_BYTES ||
      (subject !== undefined && (typeof subject !== "string" || !SHA256_HEX.test(subject)))
    ) {
      throw new KizukiError(
        "parse_error",
        `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor file identity`,
      );
    }
    seen.add(relpath);
    files.push([relpath, { sha256, size, ...(typeof subject === "string" ? { subject_sha256: subject } : {}) }]);
  }
  return files;
}
