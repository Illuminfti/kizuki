import {
  MAX_CURSOR_BYTES,
  MAX_SYNC_BATCH_BYTES,
  MAX_SYNC_BATCH_EVENTS,
  isPlainObject,
} from "@kizuki/core";
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
  summarizeImportErrors,
} from "./import-report";
import type { ImportParseResult, ImportRecordError } from "./import-report";
import { readBoundedUtf8File } from "./read";
import { sha256Hex } from "./source-id";
import { errorMessage } from "./util";

export const IMPORT_SNAPSHOT_CURSOR_SCHEMA =
  "kizuki.import-snapshot.cursor/v1" as const;

export interface SnapshotParse {
  parse(source: string, observedAt: string): ImportParseResult;
  connectorId: string;
}

interface ExportIdentity {
  sha256: string;
  size: number;
}

interface SnapshotResume {
  export: ExportIdentity;
  exhausted: boolean;
  offset: number;
}

function exportIdentity(text: string): ExportIdentity {
  return {
    sha256: sha256Hex(text),
    size: Buffer.byteLength(text, "utf8"),
  };
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function parseCursor(cursor: Cursor, connectorId: string): SnapshotResume {
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
    parsed["connector_id"] !== connectorId ||
    !isPlainObject(parsed["export"]) ||
    typeof parsed["export"]["sha256"] !== "string" ||
    typeof parsed["export"]["size"] !== "number" ||
    !Number.isSafeInteger(parsed["export"]["size"]) ||
    parsed["export"]["size"] < 0
  ) {
    throw new KizukiError(
      "parse_error",
      `${connectorId}: snapshot cursor does not match this source`,
    );
  }
  const identity: ExportIdentity = {
    sha256: parsed["export"]["sha256"],
    size: parsed["export"]["size"],
  };
  const offset = parsed["offset"];
  if (
    typeof offset === "number" &&
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    typeof parsed["exhausted"] === "boolean"
  ) {
    return { export: identity, exhausted: parsed["exhausted"], offset };
  }
  if (parsed["exhausted"] !== true || !Array.isArray(parsed["records"])) {
    throw new KizukiError(
      "parse_error",
      `${connectorId}: snapshot cursor does not match this source`,
    );
  }
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
  }
  return { export: identity, exhausted: true, offset: 0 };
}

function encodeCursor(
  connectorId: string,
  identity: ExportIdentity,
  offset: number,
  exhausted: boolean,
): string {
  return JSON.stringify({
    schema: IMPORT_SNAPSHOT_CURSOR_SCHEMA,
    connector_id: connectorId,
    exhausted,
    export: identity,
    offset,
  });
}

function sameExport(left: ExportIdentity, right: ExportIdentity): boolean {
  return left.size === right.size && left.sha256 === right.sha256;
}

function takePage(
  events: readonly CaptureEventInput[],
  start: number,
): { page: CaptureEventInput[]; next: number } {
  const page: CaptureEventInput[] = [];
  let encoded = 2;
  for (let index = start; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) break;
    const extra = utf8Bytes(JSON.stringify(event)) + (page.length === 0 ? 0 : 1);
    if (page.length === 0 && encoded + extra > MAX_SYNC_BATCH_BYTES) {
      throw new KizukiError("parse_error", "snapshot event exceeds the capture page bound");
    }
    if (
      page.length > 0 &&
      (page.length >= MAX_SYNC_BATCH_EVENTS ||
        encoded + extra > MAX_SYNC_BATCH_BYTES)
    ) {
      return { page, next: index };
    }
    page.push(event);
    encoded += extra;
  }
  return { page, next: events.length };
}

function incomplete(
  cursor: Cursor | null,
  errors: readonly ImportRecordError[],
): SyncBatch {
  return {
    events: [],
    cursor,
    status: "unavailable",
    detail: `partial_import: ${summarizeImportErrors(errors)}`,
  };
}

function idle(cursor: Cursor): SyncBatch {
  return { events: [], cursor, has_more: false };
}

function overflow(cursor: Cursor | null): SyncBatch {
  return incomplete(cursor, [
    {
      location: ".",
      code: "cursor_limit",
      reason: "snapshot exceeds the resume cursor bound",
    },
  ]);
}

/**
 * Export snapshots have no tombstones: absence from a later file is not
 * deletion (importers-exports §0.3). An unchanged digest resumes by offset;
 * a changed file rescans from the start and the ledger dedupes repeats.
 */
function drain(
  text: string,
  parsed: ImportParseResult,
  cursor: Cursor | null,
  spec: SnapshotParse,
): SyncBatch {
  const identity = exportIdentity(text);
  const previous =
    cursor === null ? undefined : parseCursor(cursor, spec.connectorId);
  // Valid records can be accepted independently, but malformed members prevent
  // a successful drain. Unsupported parts retain their existing health warning.
  const dirty = parsed.errors.some((error) => error.code !== "unsupported_part");
  const matched =
    previous !== undefined && sameExport(previous.export, identity);
  if (matched && previous !== undefined && previous.offset > parsed.events.length) {
    throw new KizukiError("parse_error", "snapshot cursor offset exceeds this export");
  }
  const start =
    matched && previous !== undefined
      ? previous.offset
      : 0;
  if (
    cursor !== null &&
    matched &&
    previous !== undefined &&
    (previous.exhausted || start >= parsed.events.length)
  ) {
    return dirty ? incomplete(cursor, parsed.errors) : idle(cursor);
  }

  const { page, next } = takePage(parsed.events, start);
  const moreValid = next < parsed.events.length;
  const exhausted = !dirty && !moreValid;
  const encoded = encodeCursor(spec.connectorId, identity, next, exhausted);
  if (utf8Bytes(encoded) > MAX_CURSOR_BYTES) return overflow(cursor);
  if (page.length === 0) {
    return dirty ? incomplete(cursor, parsed.errors) : idle(encoded);
  }
  return { events: page, cursor: encoded, has_more: moreValid || dirty };
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

/** Re-read one export file. Records missing from a later export are not tombstones. */
export async function runSnapshot(
  path: string,
  cursor: Cursor | null,
  spec: SnapshotParse,
): Promise<SyncBatch> {
  const observedAt = new Date().toISOString();
  const { text, parsed } = await readExport(path, observedAt, spec);
  return drain(text, parsed, cursor, spec);
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
