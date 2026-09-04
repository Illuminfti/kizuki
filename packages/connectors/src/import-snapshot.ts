import type { CaptureEventInput, Cursor, SyncBatch } from "@kizuki/core";
import { errorMessage } from "./util";
import {
  importHealthReport,
  misconfiguredHealth,
} from "./import-report";
import type { ImportParseResult, ImportRecordError } from "./import-report";
import { readBoundedUtf8File } from "./read";
import { recordContentHash } from "./source-id";
import {
  encodeImportSnapshotCursor,
  exportIdentityFromBytes,
  parseImportSnapshotCursor,
  sameExport,
  tombstoneEvent,
} from "./snapshot-cursor";
import type { ExportIdentity, ImportSnapshotCursor } from "./snapshot-cursor";

export interface SnapshotParse {
  parse(source: string, observedAt: string): ImportParseResult;
  kind: CaptureEventInput["kind"];
  connectorId: string;
}

export interface SnapshotRead {
  identity: ExportIdentity;
  parsed: ImportParseResult;
  text: string;
}

export async function readSnapshotExport(
  path: string,
  observedAt: string,
  spec: SnapshotParse,
): Promise<SnapshotRead> {
  const file = await readBoundedUtf8File(path, spec.connectorId, undefined, "export");
  return {
    identity: exportIdentityFromBytes(Buffer.from(file.text, "utf8")),
    parsed: spec.parse(file.text, observedAt),
    text: file.text,
  };
}

export function snapshotBatch(
  read: SnapshotRead,
  cursor: Cursor | null,
  observedAt: string,
  spec: SnapshotParse,
): SyncBatch {
  const previous =
    cursor === null
      ? undefined
      : parseImportSnapshotCursor(cursor, spec.connectorId);
  if (previous !== undefined && sameExport(previous.export, read.identity)) {
    return { events: [], cursor };
  }

  const current = new Map<string, string>();
  for (const event of read.parsed.events) {
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
  for (const event of read.parsed.events) {
    const hash = current.get(event.source_record_id);
    if (hash !== undefined && previousHashes.get(event.source_record_id) === hash) {
      continue;
    }
    events.push(event);
  }

  // A dirty parse cannot prove a record is gone: it may only have failed to
  // understand it. Tombstones wait for a clean understanding of the file.
  if (previous !== undefined && read.parsed.errors.length === 0) {
    for (const [sourceRecordId] of previous.records) {
      if (current.has(sourceRecordId)) continue;
      events.push(
        tombstoneEvent(spec.connectorId, sourceRecordId, observedAt, spec.kind),
      );
    }
  }

  const next: ImportSnapshotCursor = {
    schema: "kizuki.import-snapshot.cursor/v1",
    connector_id: spec.connectorId,
    exhausted: true,
    export: read.identity,
    records: [...current.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  };
  return { events, cursor: encodeImportSnapshotCursor(next) };
}

export async function snapshotHealth(
  path: string,
  spec: SnapshotParse,
): Promise<ReturnType<typeof importHealthReport>> {
  const checked_at = new Date().toISOString();
  try {
    const read = await readSnapshotExport(path, checked_at, spec);
    return importHealthReport({
      checked_at,
      events: read.parsed.events.length,
      errors: read.parsed.errors,
    });
  } catch (error) {
    return misconfiguredHealth(checked_at, errorMessage(error));
  }
}

export function lastImportErrors(
  parsed: ImportParseResult,
): ImportRecordError[] {
  return parsed.errors.slice(0, 32);
}
