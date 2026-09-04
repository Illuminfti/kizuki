import { isPlainObject } from "@kizuki/core";
import type { CaptureEventInput, Cursor } from "@kizuki/core";
import { KizukiError } from "./errors";

export const IMPORT_SNAPSHOT_CURSOR_SCHEMA =
  "kizuki.import-snapshot.cursor/v1" as const;

export interface ExportIdentity {
  sha256: string;
  size: number;
}

export interface ImportSnapshotCursor {
  schema: typeof IMPORT_SNAPSHOT_CURSOR_SCHEMA;
  connector_id: string;
  exhausted: true;
  export: ExportIdentity;
  /** `[source_record_id, content_hash]` pairs — an object map would treat
   * `__proto__` as a special key. */
  records: Array<[string, string]>;
}

export function encodeImportSnapshotCursor(
  cursor: ImportSnapshotCursor,
): Cursor {
  return JSON.stringify(cursor);
}

export function parseImportSnapshotCursor(
  cursor: Cursor,
  connectorId: string,
): ImportSnapshotCursor {
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

/**
 * Hash the exact bytes we read. String identity would depend on a later
 * UTF-16 view; the cursor has to match the file.
 */
export function exportIdentityFromBytes(bytes: Uint8Array): ExportIdentity {
  return {
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

export function exportIdentityOf(text: string): ExportIdentity {
  return exportIdentityFromBytes(Buffer.from(text, "utf8"));
}

export function sameExport(
  left: ExportIdentity,
  right: ExportIdentity,
): boolean {
  return left.size === right.size && left.sha256 === right.sha256;
}

export function tombstoneEvent(
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
