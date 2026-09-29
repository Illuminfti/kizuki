import { KizukiError, MAX_CURSOR_BYTES, isPlainObject } from "@kizuki/core";
import type { Cursor } from "@kizuki/core";

export const AGENT_SESSIONS_CURSOR_SCHEMA = "kizuki.agent-sessions-cursor/v1" as const;

/** Files are visited in (mtime, relpath) order; this is the last line consumed. */
export interface SessionPosition {
  mtime_ms: number;
  relpath: string;
  line: number;
}

/**
 * A per-file offset map cannot fit MAX_CURSOR_BYTES for thousands of files, so
 * the cursor holds one watermark and the position inside the current pass.
 * Every file touched since `watermark_ms` (less an overlap) is read again from
 * its start, and the ledger deduplicates what it already has.
 */
export interface SessionsCursor {
  schema: typeof AGENT_SESSIONS_CURSOR_SCHEMA;
  root_sha256: string;
  watermark_ms: number;
  after: SessionPosition | null;
  exhausted: boolean;
}

/** Longest relpath a cursor can carry, worst-case JSON-escaped, inside the bound. */
export const MAX_RELPATH_CHARS = 1024;

const HEX64 = /^[0-9a-f]{64}$/;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function corrupted(): never {
  throw new KizukiError("corrupted", "agent-sessions cursor is not valid");
}

export function initialCursor(rootSha256: string): SessionsCursor {
  return {
    schema: AGENT_SESSIONS_CURSOR_SCHEMA,
    root_sha256: rootSha256,
    watermark_ms: 0,
    after: null,
    exhausted: true,
  };
}

export function encodeCursor(cursor: SessionsCursor): Cursor {
  const encoded = JSON.stringify({
    schema: cursor.schema,
    root_sha256: cursor.root_sha256,
    watermark_ms: cursor.watermark_ms,
    after: cursor.after === null
      ? null
      : { mtime_ms: cursor.after.mtime_ms, relpath: cursor.after.relpath, line: cursor.after.line },
    exhausted: cursor.exhausted,
  });
  if (Buffer.byteLength(encoded) > MAX_CURSOR_BYTES) {
    throw new KizukiError("corrupted", "agent-sessions cursor exceeds its size bound");
  }
  return encoded;
}

/** Throws a typed error for anything this connector did not mint. */
export function parseCursor(raw: Cursor): SessionsCursor {
  if (Buffer.byteLength(raw) > MAX_CURSOR_BYTES) return corrupted();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return corrupted();
  }
  if (!isPlainObject(value)) return corrupted();
  const keys = Object.keys(value).sort().join();
  if (keys !== "after,exhausted,root_sha256,schema,watermark_ms") return corrupted();
  const { schema, root_sha256, watermark_ms, after, exhausted } = value;
  if (
    schema !== AGENT_SESSIONS_CURSOR_SCHEMA ||
    typeof root_sha256 !== "string" || !HEX64.test(root_sha256) ||
    !isCount(watermark_ms) || typeof exhausted !== "boolean"
  ) return corrupted();
  if (after === null) return { schema, root_sha256, watermark_ms, after: null, exhausted };
  if (
    exhausted || !isPlainObject(after) ||
    Object.keys(after).sort().join() !== "line,mtime_ms,relpath" ||
    !isCount(after["mtime_ms"]) || !isCount(after["line"]) ||
    typeof after["relpath"] !== "string" || after["relpath"].length === 0 ||
    after["relpath"].length > MAX_RELPATH_CHARS
  ) return corrupted();
  return {
    schema,
    root_sha256,
    watermark_ms,
    after: { mtime_ms: after["mtime_ms"], relpath: after["relpath"], line: after["line"] },
    exhausted,
  };
}
