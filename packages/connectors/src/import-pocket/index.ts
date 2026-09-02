import { lstat, readdir } from "node:fs/promises";
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
  compareStrings,
  errorMessage,
  readBoundedUtf8,
  requireKnownKeys,
  requirePathConfig,
  unixSecondsToIso,
} from "../util";
import { parseCsv } from "./csv";

export { parseCsv } from "./csv";
export type { CsvOptions } from "./csv";

export const POCKET_IMPORT_CONNECTOR_ID = "kizuki.import-pocket" as const;

export interface PocketImportConfig {
  path: string;
}

export interface PocketRow {
  title: string;
  url: string;
  time_added: string;
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

export function parsePocketCsv(text: string, where: string): PocketRow[] {
  const firstLine = text.split("\n", 1)[0] ?? "";
  let columns: string[];
  try {
    columns = (parseCsv(firstLine, where)[0] ?? []).map((name) =>
      name.trim().toLowerCase(),
    );
  } catch (error) {
    throw notPocketExport(where, error);
  }
  if (!REQUIRED_COLUMNS.every((name) => columns.includes(name))) {
    throw notPocketExport(where);
  }

  const rows = parseCsv(text, where);
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
    // Validated here, where the file name and row number exist to name.
    unixSecondsToIso(time_added, at);
    return {
      title: cellOf(cells, "title").trim(),
      url,
      time_added,
      tags: cellOf(cells, "tags")
        .split("|")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      status: cellOf(cells, "status").trim(),
    };
  });
}

export function pocketEvents(
  rows: readonly PocketRow[],
  observed_at: string,
): CaptureEventInput[] {
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    const occurrence = (seen.get(row.url) ?? 0) + 1;
    seen.set(row.url, occurrence);
    return {
      schema: "kizuki.event/v1",
      connector_id: POCKET_IMPORT_CONNECTOR_ID,
      // A repeated url in one export is a second record, never a collapse.
      source_record_id: occurrence === 1 ? row.url : `${row.url}#${occurrence}`,
      kind: "bookmark",
      occurred_at: unixSecondsToIso(row.time_added, `pocket row ${index + 1}`),
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
    };
  });
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
  const entries = await readdir(path, { withFileTypes: true });
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
      await resolveSources(this.path);
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
    const sources = await resolveSources(this.path);
    const rows: PocketRow[] = [];
    for (const source of sources) {
      const text = await readBoundedUtf8(source, POCKET_IMPORT_CONNECTOR_ID);
      rows.push(...parsePocketCsv(text, basename(source)));
    }
    return pocketEvents(rows, new Date().toISOString());
  }
}

export function createPocketImportConnector(
  config: PocketImportConfig,
): PocketImportConnector {
  return new PocketImportConnector(config);
}
