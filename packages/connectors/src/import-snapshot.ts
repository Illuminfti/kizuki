import { isPlainObject } from "@kizuki/core";
import type {
  CaptureEventInput,
  Cursor,
  HealthReport,
  SyncBatch,
} from "@kizuki/core";
import { KizukiError } from "./errors";
import {
  importHealthReport,
  misconfiguredHealth,
} from "./import-report";
import type { ImportParseResult } from "./import-report";
import { readBoundedUtf8File } from "./read";
import { recordContentHash, sha256Hex } from "./source-id";
import { errorMessage } from "./util";

export const IMPORT_SNAPSHOT_CURSOR_SCHEMA =
  "kizuki.import-snapshot.cursor/v1" as const;

export interface SnapshotParse {
  parse(source: string, observedAt: string): ImportParseResult;
  kind: CaptureEventInput["kind"];
  connectorId: string;
}

interface ExportIdentity {
  sha256: string;
  size: number;
}

interface ImportSnapshotCursor {
  schema: typeof IMPORT_SNAPSHOT_CURSOR_SCHEMA;
  connector_id: string;
  exhausted: true;
  export: ExportIdentity;
  /** `[source_record_id, content_hash]` pairs — an object map would treat
   * `__proto__` as a special key. */
  records: Array<[string, string]>;
}

function exportIdentity(text: string): ExportIdentity {
  return {
    sha256: sha256Hex(text),
    size: Buffer.byteLength(text, "utf8"),
  };
}

function parseCursor(cursor: Cursor, connectorId: string): ImportSnapshotCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch (error) {
    throw new KizukiError(
      "parse_error",
      `${connectorId}: malformed snapshot cursor`,
      { cause: error },
    );
  }
  if (
    !isPlainObject(parsed) ||
    parsed["schema"] !== IMPORT_SNAPSHOT_CURSOR_SCHEMA ||
    parsed["exhausted"] !== true ||
    parsed["connector_id"] !== connectorId ||
    !isPlainObject(parsed["export"]) ||
    typeof parsed["export"]["sha256"] !== "string" ||
    typeof parsed["export"]["size"] !== "number" ||
    !Array.isArray(parsed["records"])
  ) {
    throw new KizukiError(
      "parse_error",
      `${connectorId}: snapshot cursor does not match this source`,
    );
  }
  const records: Array<[string, string]> = [];
  for (const entry of parsed["records"]) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw new KizukiError(
        "parse_error",
        `${connectorId}: snapshot cursor record is not a pair`,
      );
    }
    records.push([entry[0], entry[1]]);
  }
  return {
    schema: IMPORT_SNAPSHOT_CURSOR_SCHEMA,
    connector_id: connectorId,
    exhausted: true,
    export: {
      sha256: parsed["export"]["sha256"],
      size: parsed["export"]["size"],
    },
    records,
  };
}

function tombstoneEvent(
  connectorId: string,
  sourceRecordId: string,
  observedAt: string,
  kind: CaptureEventInput["kind"],
): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: connectorId,
    source_record_id: sourceRecordId,
    kind,
    occurred_at: observedAt,
    observed_at: observedAt,
    text: "",
    subjects: [],
    deleted: true,
    attachments: [],
    metadata: { snapshot: "absent" },
  };
}

function drain(
  text: string,
  parsed: ImportParseResult,
  cursor: Cursor | null,
  observedAt: string,
  spec: SnapshotParse,
): SyncBatch {
  const identity = exportIdentity(text);
  const previous =
    cursor === null ? undefined : parseCursor(cursor, spec.connectorId);
  if (
    previous !== undefined &&
    previous.export.size === identity.size &&
    previous.export.sha256 === identity.sha256
  ) {
    return { events: [], cursor };
  }

  const current = new Map<string, string>();
  for (const event of parsed.events) {
    current.set(
      event.source_record_id,
      recordContentHash({
        text: event.text,
        occurred_at: event.occurred_at,
        deleted: event.deleted,
        attachments: event.attachments,
      }),
    );
  }

  const events: CaptureEventInput[] = [];
  const previousHashes = new Map(previous?.records ?? []);
  for (const event of parsed.events) {
    const hash = current.get(event.source_record_id);
    if (hash !== undefined && previousHashes.get(event.source_record_id) === hash) {
      continue;
    }
    events.push(event);
  }

  // unsupported_part rides with an emitted event that kept its real id.
  // missing_id (and every other code) is not proof a prior id is gone.
  const dirty = parsed.errors.some((error) => error.code !== "unsupported_part");

  // A dirty parse cannot prove a record is gone. Keep prior identities so a
  // later clean export can still tombstone them.
  const records = new Map<string, string>(
    dirty && previous !== undefined ? previous.records : [],
  );
  for (const [sourceRecordId, hash] of current) {
    records.set(sourceRecordId, hash);
  }

  if (previous !== undefined && !dirty) {
    for (const [sourceRecordId] of previous.records) {
      if (current.has(sourceRecordId)) continue;
      events.push(
        tombstoneEvent(spec.connectorId, sourceRecordId, observedAt, spec.kind),
      );
    }
  }

  const next: ImportSnapshotCursor = {
    schema: IMPORT_SNAPSHOT_CURSOR_SCHEMA,
    connector_id: spec.connectorId,
    exhausted: true,
    export: identity,
    records: [...records.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  };
  return { events, cursor: JSON.stringify(next) };
}

async function readExport(
  path: string,
  observedAt: string,
  spec: SnapshotParse,
): Promise<{ text: string; parsed: ImportParseResult }> {
  const file = await readBoundedUtf8File(
    path,
    spec.connectorId,
    undefined,
    "export",
  );
  return { text: file.text, parsed: spec.parse(file.text, observedAt) };
}

export async function runSnapshot(
  path: string,
  cursor: Cursor | null,
  spec: SnapshotParse,
): Promise<SyncBatch> {
  const observedAt = new Date().toISOString();
  const { text, parsed } = await readExport(path, observedAt, spec);
  return drain(text, parsed, cursor, observedAt, spec);
}

export async function snapshotHealth(
  path: string,
  spec: SnapshotParse,
): Promise<HealthReport> {
  const checked_at = new Date().toISOString();
  try {
    const { parsed } = await readExport(path, checked_at, spec);
    return importHealthReport({
      checked_at,
      events: parsed.events.length,
      errors: parsed.errors,
    });
  } catch (error) {
    return misconfiguredHealth(checked_at, errorMessage(error));
  }
}
