import { lstat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import {
  freezeManifest,
  HealthReport,
  isPlainObject,
  MAX_SYNC_BATCH_BYTES,
  MAX_SYNC_BATCH_EVENTS,
  validateEventInput,
} from "@kizuki/core";
import type {
  CaptureEventInput,
  Connector,
  Cursor,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import { KizukiError } from "../errors";
import { resolveSensitivity } from "../sensitivity";
import type { SensitivityPolicy } from "../sensitivity";
import {
  folderEntries,
  readFolderFile,
  readFolderFirstLine,
} from "../folder";
import type { ExportFolder } from "../folder";
import { readBoundedUtf8File, readFirstLine } from "../read";
import { sha256Hex } from "../source-id";
import {
  FIXTURE_OBSERVED_AT,
  MAX_EXPORT_BYTES,
  MAX_RECORDS,
  compareStrings,
  errorMessage,
  numberRepeats,
  requireKnownKeys,
  requirePathConfig,
  unixSecondsToIso,
} from "../util";
import { parsePocketCsv, pocketHeaderLine } from "./rows";
import type { PocketRow } from "./rows";

export { parseCsv } from "./csv";
export type { CsvOptions } from "./csv";
export { parsePocketCsv, pocketHeaderLine } from "./rows";
export type { PocketRow } from "./rows";

export const POCKET_IMPORT_CONNECTOR_ID = "kizuki.import-pocket" as const;
export const POCKET_CURSOR_SCHEMA = "kizuki.import-pocket.cursor/v1" as const;

/** A reading list is about the owner, not a secret, and not public either. */
const POCKET_SENSITIVITY: SensitivityPolicy = {
  default_sensitivity: "personal",
  sensitivity_floor: "public",
};

export interface PocketImportConfig {
  path: string;
}

const CONFIG_KEYS = ["path"];

/**
 * The export names its parts, and only these names are taken from inside a
 * directory. A file name is attacker-controlled input that ends up in a
 * refusal and in `kizuki doctor`, and this shape cannot carry a control
 * character or anything else a terminal would act on.
 */
const PART_FILE = /^part_\d+\.csv$/;

export const POCKET_FIXTURE_EXPORT = `${[
  "title,url,time_added,tags,status",
  '"Local-first software, explained",https://example.com/local-first,1767225600,software|reading,unread',
  "Quartz heron field notes,https://example.com/heron,1767312000,,archive",
  '"A ""quoted"" title",https://example.com/quoted,1767398400,notes,unread',
  "Quartz heron field notes,https://example.com/heron,1767484800,birds,unread",
].join("\n")}\n`;

const MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1",
  connector_id: POCKET_IMPORT_CONNECTOR_ID,
  version: "0.1.0",
  contract_minor: 1,
  implementation: "@kizuki/connectors",
  allowed_egress: [],
  cursor_schema: POCKET_CURSOR_SCHEMA,
  kinds: ["bookmark"],
  capabilities: {
    backfill: true,
    sync: true,
    // A shorter export is not a deletion, and the importer cannot tell the
    // difference, so it never claims one.
    tombstones: false,
    purge: true,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: true,
  ...POCKET_SENSITIVITY,
  auth_modes: ["none"],
});

function misconfigured(detail: string): KizukiError {
  return new KizukiError(
    "misconfigured",
    `${POCKET_IMPORT_CONNECTOR_ID}: ${detail}`,
  );
}

export function pocketEvents(
  rows: readonly PocketRow[],
  observed_at: string,
): CaptureEventInput[] {
  // A bookmark is the url it saved, and the same url saved twice is two
  // records rather than one overwritten.
  const ids = numberRepeats(rows.map((row) => row.url));
  const sensitivity_hint = resolveSensitivity(POCKET_SENSITIVITY);
  return rows.map((row, index) => {
    const at = `row ${index + 1}`;
    const event: CaptureEventInput = {
      schema: "kizuki.event/v1",
      connector_id: POCKET_IMPORT_CONNECTOR_ID,
      source_record_id: ids[index] ?? row.url,
      kind: "bookmark",
      // The reader refused an unreadable timestamp where it could name the file
      // and the line; a row handed straight to this function is named by its
      // place in the batch.
      occurred_at: unixSecondsToIso(row.time_added, at),
      observed_at,
      text: row.title.length > 0 ? `${row.title}\n${row.url}` : row.url,
      subjects: [{ subject_id: "pocket:self", role: "from" }],
      sensitivity_hint,
      deleted: false,
      attachments: [],
      metadata: {
        title: row.title,
        url: row.url,
        tags: row.tags,
        status: row.status,
      },
    };
    const validated = validateEventInput(event);
    if (!validated.ok) {
      throw new KizukiError(
        "parse_error",
        `${at}: ${validated.errors[0] ?? "invalid event"}`,
      );
    }
    return validated.value;
  });
}

interface PocketExportIdentity {
  sha256: string;
  size: number;
}

interface PocketCursor {
  schema: typeof POCKET_CURSOR_SCHEMA;
  connector_id: typeof POCKET_IMPORT_CONNECTOR_ID;
  export: PocketExportIdentity;
  /** Next row index to emit; 0 is the start of this snapshot. */
  after: number;
}

function malformedCursor(cause?: unknown): never {
  throw new KizukiError(
    "parse_error",
    `${POCKET_IMPORT_CONNECTOR_ID}: malformed cursor`,
    cause === undefined ? undefined : { cause },
  );
}

function pocketIdentity(rows: readonly PocketRow[]): PocketExportIdentity {
  const canonical = JSON.stringify(
    rows.map((row) => [
      row.title,
      row.url,
      row.time_added,
      row.tags,
      row.status,
    ]),
  );
  return {
    sha256: sha256Hex(canonical),
    size: new TextEncoder().encode(canonical).byteLength,
  };
}

function decodePocketCursor(cursor: Cursor): PocketCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch (error) {
    malformedCursor(error);
  }
  if (!isPlainObject(parsed)) malformedCursor();
  const exported = parsed["export"];
  if (!isPlainObject(exported)) malformedCursor();
  const after = parsed["after"];
  const size = exported["size"];
  const sha256 = exported["sha256"];
  if (
    parsed["schema"] !== POCKET_CURSOR_SCHEMA ||
    parsed["connector_id"] !== POCKET_IMPORT_CONNECTOR_ID ||
    typeof sha256 !== "string" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof after !== "number" ||
    !Number.isSafeInteger(after) ||
    after < 0
  ) {
    malformedCursor();
  }
  return {
    schema: POCKET_CURSOR_SCHEMA,
    connector_id: POCKET_IMPORT_CONNECTOR_ID,
    export: { sha256, size },
    after,
  };
}

function encodePocketCursor(
  identity: PocketExportIdentity,
  after: number,
): Cursor {
  const next: PocketCursor = {
    schema: POCKET_CURSOR_SCHEMA,
    connector_id: POCKET_IMPORT_CONNECTOR_ID,
    export: identity,
    after,
  };
  return JSON.stringify(next);
}

/**
 * Core refuses a SyncBatch over its event and byte budgets. A Pocket export is
 * still one snapshot — numbering and identity are decided on the whole file —
 * but it has to arrive in host-sized pages. A null cursor means this snapshot
 * is exhausted, so a later run of the same file starts from the first row.
 */
function pagePocketEvents(
  events: readonly CaptureEventInput[],
  identity: PocketExportIdentity,
  cursor: Cursor | null,
): SyncBatch {
  const previous = cursor === null ? null : decodePocketCursor(cursor);
  const start =
    previous !== null &&
    previous.export.sha256 === identity.sha256 &&
    previous.export.size === identity.size
      ? previous.after
      : 0;
  if (start >= events.length) return { events: [], cursor: null };

  const utf8 = new TextEncoder();
  const page: CaptureEventInput[] = [];
  let bytes = 2;
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]!;
    const piece = utf8.encode(JSON.stringify(event)).byteLength;
    const nextBytes = bytes + piece + (page.length === 0 ? 0 : 1);
    if (
      page.length > 0 &&
      (page.length >= MAX_SYNC_BATCH_EVENTS ||
        nextBytes > MAX_SYNC_BATCH_BYTES)
    ) {
      return {
        events: page,
        cursor: encodePocketCursor(identity, index),
      };
    }
    page.push(event);
    bytes = nextBytes;
  }
  return { events: page, cursor: null };
}

export interface PocketReadLimits {
  maxBytes?: number;
  maxRows?: number;
}

/**
 * The files of one export. `folder` is the directory they were listed in,
 * remembered by identity so every read comes out of that directory and not out
 * of whatever its name points at by the time the read happens; it is `null`
 * when the owner named a single file, which is then read as configured.
 */
export interface PocketSources {
  folder: ExportFolder | null;
  names: string[];
}

/**
 * Reads every CSV of one export under a single budget. A per-file limit would
 * let a directory of a hundred maximal files spend a hundred times the bound,
 * so the bytes read and the rows kept are counted across the whole export.
 */
export async function readPocketRows(
  sources: PocketSources,
  limits: PocketReadLimits = {},
): Promise<PocketRow[]> {
  let bytesLeft = limits.maxBytes ?? MAX_EXPORT_BYTES;
  const maxRows = limits.maxRows ?? MAX_RECORDS;
  let rowsLeft = maxRows;
  const rows: PocketRow[] = [];
  const folder = sources.folder;
  for (const source of sources.names) {
    const file =
      folder === null
        ? await readBoundedUtf8File(
            source,
            POCKET_IMPORT_CONNECTOR_ID,
            bytesLeft,
          )
        : await readFolderFile(
            folder,
            source,
            POCKET_IMPORT_CONNECTOR_ID,
            bytesLeft,
            join(folder.path, source),
          );
    bytesLeft -= file.byte_size;
    // The header counts as a row to the reader, so a file may hold what the
    // export has left, its own header line, and one row over the bound — which
    // is what proves the bound was passed.
    const parsed = parsePocketCsv(file.text, basename(source), {
      maxRows: rowsLeft + 2,
    });
    if (parsed.length > rowsLeft) {
      throw new KizukiError(
        "parse_error",
        `export holds more than ${maxRows} rows`,
      );
    }
    rowsLeft -= parsed.length;
    // One row at a time: spreading a file's rows into `push` passes each of
    // them as an argument, and a legal export at the row bound is more
    // arguments than a call can carry.
    for (const row of parsed) rows.push(row);
  }
  return rows;
}

async function resolveSources(path: string): Promise<PocketSources> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw misconfigured(`cannot access ${path}: ${errorMessage(error)}`);
  }
  if (path.toLowerCase().endsWith(".zip")) {
    throw misconfigured(`unzip the export first: ${path}`);
  }
  if (info.isFile()) {
    if (!path.toLowerCase().endsWith(".csv")) {
      throw misconfigured(`not a .csv export: ${path}`);
    }
    return { folder: null, names: [path] };
  }
  if (!info.isDirectory()) {
    throw misconfigured(`not an export directory or file: ${path}`);
  }
  // The directory that answered the listing is the one every part is read
  // from, whatever its name points at afterwards.
  const folder: ExportFolder = { path, dev: info.dev, ino: info.ino };
  let entries: Dirent[];
  try {
    entries = await folderEntries(folder);
  } catch (error) {
    // A directory that cannot be listed is a configuration problem like any
    // other unreadable path, not an error only the filesystem understands.
    throw misconfigured(`cannot read ${path}: ${errorMessage(error)}`);
  }
  const files = entries
    .filter((entry) => entry.isFile() && PART_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareStrings);
  if (files.length === 0) {
    // A CSV under any other name is still importable; it just has to be named
    // rather than found, because only the export's own part names are safe to
    // take from inside a directory.
    throw misconfigured(
      `no part_*.csv export in ${path}; pass the .csv file path`,
    );
  }
  return { folder, names: files };
}

export class PocketImportConnector implements Connector {
  readonly path: string;

  constructor(config: PocketImportConfig) {
    this.path = requirePathConfig(config, POCKET_IMPORT_CONNECTOR_ID);
    requireKnownKeys(config, POCKET_IMPORT_CONNECTOR_ID, CONFIG_KEYS);
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  async health(): Promise<HealthReport> {
    const checked_at = new Date().toISOString();
    try {
      const sources = await resolveSources(this.path);
      // A path that resolves is not yet an export. The first file is opened
      // and its header read, so an unreadable file or a CSV that is not a
      // Pocket export is reported now rather than at ingest.
      const first = sources.names[0];
      if (first !== undefined) {
        const header =
          sources.folder === null
            ? await readFirstLine(first, POCKET_IMPORT_CONNECTOR_ID)
            : await readFolderFirstLine(
                sources.folder,
                first,
                POCKET_IMPORT_CONNECTOR_ID,
                join(sources.folder.path, first),
              );
        pocketHeaderLine(header, basename(first));
      }
      return new HealthReport({ state: "ok", checked_at });
    } catch (error) {
      return new HealthReport({
        state: "misconfigured",
        checked_at,
        detail: errorMessage(error),
      });
    }
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(cursor: Cursor | null): Promise<SyncBatch> {
    const rows = await readPocketRows(await resolveSources(this.path));
    return pagePocketEvents(
      pocketEvents(rows, new Date().toISOString()),
      pocketIdentity(rows),
      cursor,
    );
  }

  sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.backfill(cursor);
  }

  async revoke(): Promise<void> {}

  async purgeSource(subject_id: string): Promise<PurgePlan> {
    const events = await this.read();
    return {
      subject_id,
      complete: true,
      source_record_ids: [],
      unreachable_source_record_ids: events
        .filter((event) =>
          event.subjects.some((subject) => subject.subject_id === subject_id),
        )
        .map((event) => event.source_record_id)
        .sort(compareStrings),
    };
  }

  async fixture(): Promise<CaptureEventInput[]> {
    return pocketEvents(
      parsePocketCsv(POCKET_FIXTURE_EXPORT, "fixture"),
      FIXTURE_OBSERVED_AT,
    );
  }

  private async read(): Promise<CaptureEventInput[]> {
    const rows = await readPocketRows(await resolveSources(this.path));
    return pocketEvents(rows, new Date().toISOString());
  }
}

export function createPocketImportConnector(
  config: PocketImportConfig,
): PocketImportConnector {
  return new PocketImportConnector(config);
}
