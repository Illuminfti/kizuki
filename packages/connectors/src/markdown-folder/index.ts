import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { isPlainObject } from "@kizuki/core";
import type {
  CaptureEventInput,
  Connector,
  Cursor,
  HealthReport,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import { KizukiError } from "../errors";
import {
  importHealthReport,
  misconfiguredHealth,
} from "../import-report";
import type { ImportRecordError } from "../import-report";
import { readBoundedBytes, readReason } from "../read";
import {
  compareStrings,
  errorMessage,
  requireKnownKeys,
  requirePathConfig,
} from "../util";

export const MARKDOWN_FOLDER_CONNECTOR_ID = "kizuki.markdown-folder" as const;
export const MARKDOWN_CURSOR_SCHEMA = "kizuki.markdown-folder.cursor/v1" as const;

export const DEFAULT_PAGE_SIZE = 128;
export const MAX_PAGE_SIZE = 10_000;
export const MAX_DEPTH = 16;
export const MAX_FILES = 50_000;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_SCAN_ENTRIES = 100_000;
const STABLE_READ_ATTEMPTS = 3;

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

interface MarkdownFile {
  content: string;
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

interface FileIdentity {
  sha256: string;
  size: number;
}

export interface MarkdownCursor {
  schema: typeof MARKDOWN_CURSOR_SCHEMA;
  connector_id: typeof MARKDOWN_FOLDER_CONNECTOR_ID;
  root: RootIdentity;
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

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
  version: "0.2.0",
  kinds: ["file"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: true,
    purge: false,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: false,
  auth_modes: ["none"],
};

export class MarkdownFolderConnector implements Connector {
  readonly path: string;
  readonly pageSize: number;
  readonly exclude: readonly string[];

  constructor(config: MarkdownFolderConfig) {
    this.path = requirePathConfig(config, MARKDOWN_FOLDER_CONNECTOR_ID);
    requireKnownKeys(config, MARKDOWN_FOLDER_CONNECTOR_ID, CONFIG_KEYS);
    this.pageSize = parsePageSize(config.page_size);
    this.exclude = parseExclude(config.exclude);
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

  async purgeSource(subject_id: string): Promise<PurgePlan> {
    return {
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: [],
    };
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
    const previous = cursor === null ? undefined : parseCursor(cursor, root, this);
    const scan = await scanMarkdownFiles(root, this.exclude);
    const observedAt = new Date().toISOString();
    const current = new Map(
      scan.files.map((file) => [file.relpath, file] as const),
    );
    const previousFiles = new Map(previous?.files ?? []);

    const fileEvents: CaptureEventInput[] = [];
    for (const file of scan.files) {
      const prior = previousFiles.get(file.relpath);
      if (
        prior !== undefined &&
        prior.sha256 === file.sha256 &&
        prior.size === file.size
      ) {
        continue;
      }
      fileEvents.push(fileEvent(file, observedAt));
    }
    fileEvents.sort((left, right) =>
      compareStrings(left.source_record_id, right.source_record_id),
    );

    const tombstones: CaptureEventInput[] = [];
    if (previous !== undefined && !scan.truncated) {
      const failed = new Set(scan.errors.map((error) => error.location));
      for (const relpath of [...previousFiles.keys()].sort(compareStrings)) {
        if (current.has(relpath) || failed.has(relpath)) continue;
        tombstones.push(tombstone(relpath, observedAt));
      }
    }

    const inTombstones = previous?.phase === "tombstones";
    const fileAfter =
      inTombstones || previous?.exhausted ? null : (previous?.after ?? null);
    const fileFrom = indexAfter(fileEvents, fileAfter);
    const filePage = inTombstones
      ? []
      : fileEvents.slice(fileFrom, fileFrom + this.pageSize);
    const filesDone =
      inTombstones || fileFrom + filePage.length >= fileEvents.length;

    const processed = new Map(previousFiles);
    for (const event of filePage) {
      const file = current.get(event.source_record_id);
      if (file !== undefined) {
        processed.set(event.source_record_id, {
          sha256: file.sha256,
          size: file.size,
        });
      }
    }

    const nextCursor = (
      exhausted: boolean,
      phase: "files" | "tombstones",
      after: string | null,
    ): Cursor =>
      encodeCursor({
        schema: MARKDOWN_CURSOR_SCHEMA,
        connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
        root,
        options: { page_size: this.pageSize, exclude: [...this.exclude] },
        exhausted,
        phase,
        after,
        files: sortedPairs(processed),
      });

    if (!filesDone) {
      const last = filePage[filePage.length - 1];
      return {
        events: filePage,
        cursor: nextCursor(false, "files", last?.source_record_id ?? fileAfter),
      };
    }

    if (filePage.length > 0) {
      const noTombstones = tombstones.length === 0;
      return {
        events: filePage,
        cursor: nextCursor(
          noTombstones && !scan.truncated,
          noTombstones ? "files" : "tombstones",
          null,
        ),
      };
    }

    const tombstoneAfter = inTombstones ? (previous?.after ?? null) : null;
    const tombstoneFrom = indexAfter(tombstones, tombstoneAfter);
    const tombstonePage = tombstones.slice(
      tombstoneFrom,
      tombstoneFrom + this.pageSize,
    );
    for (const event of tombstonePage) {
      processed.delete(event.source_record_id);
    }
    const tombstonesDone =
      tombstoneFrom + tombstonePage.length >= tombstones.length;
    const exhausted = tombstonesDone && !scan.truncated;
    if (exhausted) {
      for (const file of scan.files) {
        processed.set(file.relpath, { sha256: file.sha256, size: file.size });
      }
    }
    const lastTombstone = tombstonePage[tombstonePage.length - 1];
    return {
      events: tombstonePage,
      cursor: nextCursor(
        exhausted,
        exhausted ? "files" : "tombstones",
        exhausted ? null : (lastTombstone?.source_record_id ?? tombstoneAfter),
      ),
    };
  }
}

export function createMarkdownFolderConnector(
  config: MarkdownFolderConfig,
): MarkdownFolderConnector {
  return new MarkdownFolderConnector(config);
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
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    throw new KizukiError(
      "misconfigured",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: cannot access configured root`,
      { cause: error },
    );
  }
  if (!info.isDirectory()) {
    throw new KizukiError(
      "misconfigured",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: path is not a directory`,
    );
  }
  const resolved = await realpath(root);
  const resolvedInfo = await lstat(resolved);
  return { realpath: resolved, dev: resolvedInfo.dev, ino: resolvedInfo.ino };
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
      truncated = true;
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
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      if (truncated) return;
      considered += 1;
      if (considered > MAX_SCAN_ENTRIES) {
        truncated = true;
        errors.push({
          location: relpathOf(root.realpath, directory) || ".",
          code: "scan_limit",
          reason: "scan exceeded the entry bound",
        });
        return;
      }
      if (shouldSkipName(entry.name, exclude)) continue;
      const absolute = path.join(directory, entry.name);
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
      if (files.length >= MAX_FILES) {
        truncated = true;
        errors.push({
          location: relpathOf(root.realpath, absolute),
          code: "file_limit",
          reason: "scan exceeded the file bound",
        });
        return;
      }
      const relpath = relpathOf(root.realpath, absolute);
      const read = await readStableMarkdown(absolute, relpath);
      if ("error" in read) {
        errors.push(read.error);
        continue;
      }
      files.push(read.file);
    }
  };

  await walk(root.realpath, 0);
  files.sort((left, right) => compareStrings(left.relpath, right.relpath));
  return { files, errors, truncated };
}

async function readStableMarkdown(
  absolute: string,
  relpath: string,
): Promise<{ file: MarkdownFile } | { error: ImportRecordError }> {
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = await handle.stat();
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
      const bytes = await readBoundedBytes(
        handle,
        MAX_FILE_BYTES,
        MARKDOWN_FOLDER_CONNECTOR_ID,
        "file",
        before.size,
      );
      const after = await handle.stat();
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
      return {
        error: {
          location: relpath,
          code: "unreadable",
          reason: readReason(error),
        },
      };
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
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

function fileEvent(file: MarkdownFile, observedAt: string): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
    source_record_id: file.relpath,
    kind: "file",
    occurred_at: new Date(file.mtimeMs).toISOString(),
    observed_at: observedAt,
    text: file.content,
    subjects: [],
    deleted: false,
    attachments: [],
    metadata: {
      relpath: file.relpath,
      size: file.size,
      sha256: file.sha256,
    },
  };
}

function tombstone(relpath: string, observedAt: string): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
    source_record_id: relpath,
    kind: "file",
    occurred_at: observedAt,
    observed_at: observedAt,
    text: "",
    subjects: [],
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
    subjects: [],
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
  return JSON.stringify(cursor);
}

function parseCursor(
  cursor: Cursor,
  root: RootIdentity,
  connector: MarkdownFolderConnector,
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
    typeof parsed["root"]["dev"] !== "number" ||
    typeof parsed["root"]["ino"] !== "number" ||
    !isPlainObject(parsed["options"]) ||
    typeof parsed["options"]["page_size"] !== "number" ||
    !Array.isArray(parsed["options"]["exclude"]) ||
    !Array.isArray(parsed["files"])
  ) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor snapshot`,
    );
  }
  if (
    parsed["root"]["realpath"] !== root.realpath ||
    parsed["root"]["dev"] !== root.dev ||
    parsed["root"]["ino"] !== root.ino
  ) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: cursor does not belong to this root`,
    );
  }
  if (
    parsed["options"]["page_size"] !== connector.pageSize ||
    JSON.stringify(parsed["options"]["exclude"]) !==
      JSON.stringify([...connector.exclude])
  ) {
    throw new KizukiError(
      "parse_error",
      `${MARKDOWN_FOLDER_CONNECTOR_ID}: cursor does not match this configuration`,
    );
  }
  const files: Array<[string, FileIdentity]> = [];
  for (const entry of parsed["files"]) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !isPlainObject(entry[1]) ||
      typeof entry[1]["sha256"] !== "string" ||
      typeof entry[1]["size"] !== "number"
    ) {
      throw new KizukiError(
        "parse_error",
        `${MARKDOWN_FOLDER_CONNECTOR_ID}: invalid cursor file identity`,
      );
    }
    files.push([
      entry[0],
      { sha256: entry[1]["sha256"], size: entry[1]["size"] },
    ]);
  }
  return {
    schema: MARKDOWN_CURSOR_SCHEMA,
    connector_id: MARKDOWN_FOLDER_CONNECTOR_ID,
    root: {
      realpath: parsed["root"]["realpath"],
      dev: parsed["root"]["dev"],
      ino: parsed["root"]["ino"],
    },
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

function indexAfter(
  events: readonly CaptureEventInput[],
  after: string | null,
): number {
  if (after === null) return 0;
  const start = events.findIndex(
    (event) => compareStrings(event.source_record_id, after) > 0,
  );
  return start === -1 ? events.length : start;
}

function sortedPairs(
  files: Map<string, FileIdentity>,
): Array<[string, FileIdentity]> {
  return [...files.entries()].sort(([left], [right]) =>
    compareStrings(left, right),
  );
}
