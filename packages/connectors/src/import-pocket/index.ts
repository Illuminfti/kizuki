import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import { HealthReport } from "@kizuki/core";
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
import { readBoundedUtf8File, readFirstLine } from "../read";
import {
  FIXTURE_OBSERVED_AT,
  MAX_EXPORT_BYTES,
  MAX_RECORDS,
  compareStrings,
  errorMessage,
  numberRepeats,
  requireKnownKeys,
  requirePathConfig,
} from "../util";
import { parsePocketCsv, pocketHeaderLine } from "./rows";
import type { PocketRow } from "./rows";

export { parseCsv } from "./csv";
export type { CsvOptions } from "./csv";
export { parsePocketCsv, pocketColumns, pocketHeaderLine } from "./rows";
export type { PocketRow } from "./rows";

export const POCKET_IMPORT_CONNECTOR_ID = "kizuki.import-pocket" as const;

/** A reading list is about the owner, not a secret, and not public either. */
const POCKET_SENSITIVITY = "personal" as const;

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

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: POCKET_IMPORT_CONNECTOR_ID,
  version: "0.1.0",
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
  auth_modes: ["none"],
};

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
  return rows.map((row, index) => ({
    schema: "kizuki.event/v1",
    connector_id: POCKET_IMPORT_CONNECTOR_ID,
    source_record_id: ids[index] ?? row.url,
    kind: "bookmark",
    occurred_at: row.occurred_at,
    observed_at,
    text: row.title.length > 0 ? `${row.title}\n${row.url}` : row.url,
    subjects: [{ subject_id: "pocket:self", role: "from" }],
    sensitivity_hint: POCKET_SENSITIVITY,
    deleted: false,
    attachments: [],
    metadata: {
      title: row.title,
      url: row.url,
      tags: row.tags,
      status: row.status,
    },
  }));
}

export interface PocketReadLimits {
  maxBytes?: number;
  maxRows?: number;
}

/**
 * Reads every CSV of one export under a single budget. A per-file limit would
 * let a directory of a hundred maximal files spend a hundred times the bound,
 * so the bytes read and the rows kept are counted across the whole export.
 */
export async function readPocketRows(
  sources: readonly string[],
  limits: PocketReadLimits = {},
): Promise<PocketRow[]> {
  let bytesLeft = limits.maxBytes ?? MAX_EXPORT_BYTES;
  const maxRows = limits.maxRows ?? MAX_RECORDS;
  let rowsLeft = maxRows;
  const rows: PocketRow[] = [];
  for (const source of sources) {
    const file = await readBoundedUtf8File(
      source,
      POCKET_IMPORT_CONNECTOR_ID,
      bytesLeft,
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

async function resolveSources(path: string): Promise<string[]> {
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
    return [path];
  }
  if (!info.isDirectory()) {
    throw misconfigured(`not an export directory or file: ${path}`);
  }
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
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
    throw misconfigured(`no part_*.csv export in ${path}`);
  }
  return files.map((name) => join(path, name));
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
      const first = sources[0];
      if (first !== undefined) {
        const header = await readFirstLine(first, POCKET_IMPORT_CONNECTOR_ID);
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

  async backfill(_cursor: Cursor | null): Promise<SyncBatch> {
    return { events: await this.read(), cursor: null };
  }

  sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.backfill(cursor);
  }

  async revoke(): Promise<void> {}

  async purgeSource(subject_id: string): Promise<PurgePlan> {
    const events = await this.read();
    return {
      subject_id,
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
