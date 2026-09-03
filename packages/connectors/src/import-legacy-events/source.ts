import { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { KizukiError } from "../errors";
import { errorMessage } from "../util";
import { IDENTIFIER, LEGACY_EVENTS_CONNECTOR_ID, ROWID_ALIAS } from "./mapping";

/**
 * Two keyset readers over an export the owner already has: a read-only SQLite
 * table and a JSONL file. Both page by a strictly increasing position so a run
 * can resume exactly where the last one stopped, and neither reads a whole
 * export into memory.
 */

export const BATCH_ROWS = 1000;
export const MAX_LINE_BYTES = 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

export type RowProblem = "malformed_json" | "not_an_object" | "line_too_long";

export interface LegacyRow {
  /**
   * sqlite: the rowid. jsonl: the byte offset just past the line's newline.
   * Exact rather than a double: a table keyed by a snowflake-scale integer
   * has rowids past 2^53, and a position rounded to the nearest double can
   * land beyond real rows, which `rowid > ?` would then page straight over
   * while the run reported itself done.
   */
  position: bigint;
  values: Record<string, unknown> | null;
  problem?: RowProblem;
}

export interface LegacyRowSource {
  kind: "sqlite" | "jsonl";
  /** sqlite: the declared columns. jsonl: unknowable before reading. */
  columns: string[] | null;
  read(after: bigint, limit: number): LegacyRow[];
  size(): bigint;
  close(): void;
}

function misconfigured(rule: string, cause?: unknown): KizukiError {
  return new KizukiError(
    "misconfigured",
    `${LEGACY_EVENTS_CONNECTOR_ID}: ${rule}`,
    cause === undefined ? undefined : { cause },
  );
}

function quoted(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw misconfigured(`unusable identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

interface SafeIntegerStatement {
  safeIntegers(enabled: boolean): unknown;
}

/**
 * Ask for integers as BigInt, so a legacy key past 2^53 is not silently
 * rounded on its way into a ledger row that has to dedupe exactly. The method
 * is not in the published type surface, so it is probed rather than assumed.
 */
function requestSafeIntegers(statement: object): void {
  if (
    "safeIntegers" in statement &&
    typeof (statement as SafeIntegerStatement).safeIntegers === "function"
  ) {
    (statement as SafeIntegerStatement).safeIntegers(true);
  }
}

function cellValue(value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

export function openSqliteSource(path: string, table: string): LegacyRowSource {
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch (error) {
    throw misconfigured(`cannot open ${path}: ${errorMessage(error)}`, error);
  }
  const name = quoted(table);
  try {
    const columns = db.query(`PRAGMA table_info(${name})`).all() as {
      name: string;
    }[];
    if (columns.length === 0) throw misconfigured(`table not found: ${table}`);
    try {
      db.query(`SELECT rowid FROM ${name} LIMIT 0`).all();
    } catch (error) {
      throw misconfigured(
        `table has no rowid; export it to JSONL: ${table}`,
        error,
      );
    }
    const names = columns.map((column) => column.name);
    if (names.includes(ROWID_ALIAS)) {
      // The reader names the rowid so it can page by it; a declared column of
      // the same name shadows the alias and every position becomes NaN.
      throw misconfigured(
        `table declares the reserved column ${ROWID_ALIAS}; export it to JSONL: ${table}`,
      );
    }
    const read = db.query(
      `SELECT rowid AS ${ROWID_ALIAS}, * FROM ${name} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    );
    requestSafeIntegers(read);
    const max = db.query(`SELECT max(rowid) AS top FROM ${name}`);
    // The extent has to be read in the same width as the positions it is
    // compared against, or a large table looks like one that shrank.
    requestSafeIntegers(max);
    return {
      kind: "sqlite",
      columns: names,
      read(after: bigint, limit: number): LegacyRow[] {
        const rows = read.all(after, limit) as Record<string, unknown>[];
        return rows.map((row) => {
          const values: Record<string, unknown> = {};
          for (const column of names) values[column] = cellValue(row[column]);
          return { position: BigInt(row[ROWID_ALIAS] as bigint | number), values };
        });
      },
      size(): bigint {
        const top = (max.get() as { top: bigint | number | null } | null)?.top;
        return top === null || top === undefined ? 0n : BigInt(top);
      },
      close(): void {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    if (error instanceof KizukiError) throw error;
    throw misconfigured(`cannot read ${table}: ${errorMessage(error)}`, error);
  }
}

/** Replacement characters rather than a throw: an export may hold stray bytes. */
const utf8 = new TextDecoder("utf-8", { fatal: false });

function decodeLine(line: Uint8Array, position: bigint): LegacyRow {
  const text = utf8.decode(line).replace(/\r$/, "");
  if (text.trim().length === 0)
    return { position, values: null, problem: "not_an_object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { position, values: null, problem: "malformed_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { position, values: null, problem: "not_an_object" };
  }
  return { position, values: parsed as Record<string, unknown> };
}

export function openJsonlSource(path: string): LegacyRowSource {
  let handle: number;
  try {
    handle = openSync(path, "r");
  } catch (error) {
    throw misconfigured(`cannot open ${path}: ${errorMessage(error)}`, error);
  }
  const total = statSync(path).size;

  return {
    kind: "jsonl",
    columns: null,
    read(after: bigint, limit: number): LegacyRow[] {
      const rows: LegacyRow[] = [];
      const buffer = Buffer.alloc(CHUNK_BYTES);
      // A byte offset is bounded by the file size, so the reader works in
      // numbers and only the position it hands back is exact.
      let offset = Number(after);
      let pending: Uint8Array = new Uint8Array(0);
      // A line past the cap is reported by position and the reader resumes at
      // the next newline rather than buffering the rest of it.
      let overlong = false;

      const append = (slice: Uint8Array): void => {
        if (overlong) return;
        if (pending.byteLength + slice.byteLength > MAX_LINE_BYTES) {
          overlong = true;
          pending = new Uint8Array(0);
          return;
        }
        const merged = new Uint8Array(pending.byteLength + slice.byteLength);
        merged.set(pending, 0);
        merged.set(slice, pending.byteLength);
        pending = merged;
      };

      while (rows.length < limit && offset < total) {
        const read = readSync(handle, buffer, 0, CHUNK_BYTES, offset);
        if (read === 0) break;
        const chunk = buffer.subarray(0, read);
        let cursor = 0;
        while (cursor < read) {
          const newline = chunk.indexOf(0x0a, cursor);
          if (newline === -1) {
            append(chunk.subarray(cursor));
            cursor = read;
            break;
          }
          append(chunk.subarray(cursor, newline));
          const position = BigInt(offset + newline + 1);
          rows.push(
            overlong
              ? { position, values: null, problem: "line_too_long" }
              : decodeLine(pending, position),
          );
          pending = new Uint8Array(0);
          overlong = false;
          cursor = newline + 1;
          if (rows.length >= limit) break;
        }
        offset += cursor;
      }

      // A final line with no newline is still a record; its position is the
      // end of the file, so a later run resumes past it.
      if (rows.length < limit && (pending.byteLength > 0 || overlong)) {
        const position = BigInt(total);
        rows.push(
          overlong
            ? { position, values: null, problem: "line_too_long" }
            : decodeLine(pending, position),
        );
      }
      return rows;
    },
    size(): bigint {
      return BigInt(total);
    },
    close(): void {
      closeSync(handle);
    },
  };
}
