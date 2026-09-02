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
import {
  FIXTURE_OBSERVED_AT,
  MAX_EXPORT_BYTES,
  MAX_RECORDS,
  compareStrings,
  errorMessage,
  readBoundedUtf8File,
  readFirstLine,
  requireKnownKeys,
  requirePathConfig,
  unixSecondsToIso,
} from "../util";
import { parseCsv } from "./csv";
import type { CsvOptions } from "./csv";

export { parseCsv } from "./csv";
export type { CsvOptions } from "./csv";

export const POCKET_IMPORT_CONNECTOR_ID = "kizuki.import-pocket" as const;

export interface PocketImportConfig {
  path: string;
}

export interface PocketRow {
  title: string;
  url: string;
  /** Unix seconds, exactly as the export wrote them. */
  time_added: string;
  /**
   * The instant `time_added` names, resolved once where the file and the row
   * number are known, so one record carries one position through both seams.
   */
  occurred_at: string;
  tags: string[];
  status: string;
}

const CONFIG_KEYS = ["path"];

// The final export format. `time_added` is unix seconds and `tags` are
// pipe-separated; column order is not guaranteed, so the parser is
// header-driven and ignores columns it does not know.
const REQUIRED_COLUMNS = ["url", "time_added"];
const MAX_URL_LENGTH = 4096;

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

function notPocketExport(where: string, cause?: unknown): KizukiError {
  return new KizukiError(
    "parse_error",
    `${where}: not a Pocket CSV export`,
    cause === undefined ? undefined : { cause },
  );
}

/** The header line's columns, or a refusal naming the file but never a cell. */
export function pocketColumns(headerLine: string, where: string): string[] {
  let columns: string[];
  try {
    columns = (parseCsv(headerLine, where)[0] ?? []).map((name) =>
      name.trim().toLowerCase(),
    );
  } catch (error) {
    throw notPocketExport(where, error);
  }
  if (!REQUIRED_COLUMNS.every((name) => columns.includes(name))) {
    throw notPocketExport(where);
  }
  return columns;
}

export function parsePocketCsv(
  text: string,
  where: string,
  opts: CsvOptions = {},
): PocketRow[] {
  const columns = pocketColumns(text.split("\n", 1)[0] ?? "", where);

  const rows = parseCsv(text, where, opts);
  const cellOf = (cells: string[], name: string): string => {
    const at = columns.indexOf(name);
    return at === -1 ? "" : (cells[at] ?? "");
  };

  return rows.slice(1).map((cells, index) => {
    // Row 1 is the header, so the first record is row 2 in the file.
    const at = `${where} row ${index + 2}`;
    if (cells.length !== columns.length) {
      throw new KizukiError(
        "parse_error",
        `${at}: expected ${columns.length} columns, found ${cells.length}`,
      );
    }
    const url = cellOf(cells, "url").trim();
    if (url.length === 0) {
      throw new KizukiError("parse_error", `${at}: url is required`);
    }
    if (url.length > MAX_URL_LENGTH) {
      throw new KizukiError(
        "parse_error",
        `${at}: url exceeds ${MAX_URL_LENGTH} characters`,
      );
    }
    const time_added = cellOf(cells, "time_added").trim();
    return {
      title: cellOf(cells, "title").trim(),
      url,
      time_added,
      // Resolved here, where the file name and the row number exist to name.
      occurred_at: unixSecondsToIso(time_added, at),
      tags: cellOf(cells, "tags")
        .split("|")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      status: cellOf(cells, "status").trim(),
    };
  });
}

/**
 * A bookmark is the url it saved. The same url saved twice is two records,
 * numbered in file order, so a doubled export cannot collapse two saves into
 * one. A url that already ends in the suffix a repeat would take keeps its own
 * identity: the number moves on rather than renaming a record that exists.
 */
function pocketRecordIds(rows: readonly PocketRow[]): string[] {
  const taken = new Set(rows.map((row) => row.url));
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const count = (seen.get(row.url) ?? 0) + 1;
    seen.set(row.url, count);
    if (count === 1) return row.url;
    let suffix = count;
    while (taken.has(`${row.url}#${suffix}`)) suffix += 1;
    const id = `${row.url}#${suffix}`;
    taken.add(id);
    return id;
  });
}

export function pocketEvents(
  rows: readonly PocketRow[],
  observed_at: string,
): CaptureEventInput[] {
  const ids = pocketRecordIds(rows);
  return rows.map((row, index) => ({
    schema: "kizuki.event/v1",
    connector_id: POCKET_IMPORT_CONNECTOR_ID,
    source_record_id: ids[index] ?? row.url,
    kind: "bookmark",
    occurred_at: row.occurred_at,
    observed_at,
    text: row.title.length > 0 ? `${row.title}\n${row.url}` : row.url,
    subjects: [{ subject_id: "pocket:self", role: "from" }],
    // A reading list is about the owner, not a secret.
    sensitivity_hint: "personal",
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
  const rows: PocketRow[] = [];
  for (const source of sources) {
    const file = await readBoundedUtf8File(
      source,
      POCKET_IMPORT_CONNECTOR_ID,
      bytesLeft,
    );
    bytesLeft -= file.byte_size;
    // The header counts as a row to the reader, so one file may hold every
    // record the export is allowed plus its own header line.
    rows.push(
      ...parsePocketCsv(file.text, basename(source), { maxRows: maxRows + 1 }),
    );
    if (rows.length > maxRows) {
      throw new KizukiError(
        "parse_error",
        `export holds more than ${maxRows} rows`,
      );
    }
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
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"),
    )
    .map((entry) => entry.name)
    .sort(compareStrings);
  if (files.length === 0) {
    throw misconfigured(`no .csv export in ${path}`);
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
        pocketColumns(header, basename(first));
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
