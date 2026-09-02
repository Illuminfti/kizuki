import { isPlainObject } from "@kizuki/core";
import type { Cursor } from "@kizuki/core";
import { KizukiError } from "../errors";
import { LEGACY_EVENTS_CONNECTOR_ID } from "./mapping";
import { MAX_REPORTED_SKIPS } from "./report";
import type { LegacyEventsReport } from "./report";
import type { RowSkip } from "./rows";

/**
 * The resume token for an event import: where the last page stopped, and what
 * the run has read since it started. The spine persists it verbatim, so every
 * field is validated on the way back in.
 */

export const LEGACY_EVENTS_CURSOR_SCHEMA =
  "kizuki.legacy-events-cursor/v1" as const;

/**
 * What the run has read since it started, carried across pages. A migration
 * pages through an export one call at a time, often one process per call, so
 * a report built from the last page alone would describe a run that read
 * nothing and erase the record of every row the earlier pages dropped.
 */
export interface RunTotals {
  from_position: string;
  counts: LegacyEventsReport["counts"];
  skipped: RowSkip[];
}

export interface LegacyEventsCursor {
  schema: typeof LEGACY_EVENTS_CURSOR_SCHEMA;
  mapping_hash: string;
  /** Decimal: a rowid past 2^53 must survive the round trip exactly. */
  position: string;
  done: boolean;
  run: RunTotals;
}

const POSITION = /^(?:0|[1-9]\d{0,29})$/;

export function emptyTotals(from: bigint): RunTotals {
  return {
    from_position: from.toString(),
    counts: {
      rows: 0,
      events: 0,
      tombstones: 0,
      skipped: 0,
      blobs_dropped: 0,
      kinds: {},
    },
    skipped: [],
  };
}

function decodeTotals(raw: unknown, from: bigint): RunTotals {
  if (!isPlainObject(raw)) return emptyTotals(from);
  const counts = raw["counts"];
  const skipped = raw["skipped"];
  if (
    typeof raw["from_position"] !== "string" ||
    !POSITION.test(raw["from_position"]) ||
    !isPlainObject(counts) ||
    !Array.isArray(skipped)
  ) {
    throw new KizukiError(
      "parse_error",
      `${LEGACY_EVENTS_CONNECTOR_ID}: malformed cursor`,
    );
  }
  const totals = emptyTotals(BigInt(raw["from_position"]));
  for (const key of ["rows", "events", "tombstones", "skipped", "blobs_dropped"] as const) {
    const value = counts[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new KizukiError(
        "parse_error",
        `${LEGACY_EVENTS_CONNECTOR_ID}: malformed cursor`,
      );
    }
    totals.counts[key] = value;
  }
  const kinds = counts["kinds"];
  if (!isPlainObject(kinds)) {
    throw new KizukiError(
      "parse_error",
      `${LEGACY_EVENTS_CONNECTOR_ID}: malformed cursor`,
    );
  }
  for (const [kind, count] of Object.entries(kinds)) {
    if (typeof count !== "number") {
      throw new KizukiError(
        "parse_error",
        `${LEGACY_EVENTS_CONNECTOR_ID}: malformed cursor`,
      );
    }
    totals.counts.kinds[kind] = count;
  }
  for (const skip of skipped.slice(0, MAX_REPORTED_SKIPS)) {
    if (
      !isPlainObject(skip) ||
      typeof skip["position"] !== "string" ||
      !POSITION.test(skip["position"]) ||
      typeof skip["reason"] !== "string"
    ) {
      throw new KizukiError(
        "parse_error",
        `${LEGACY_EVENTS_CONNECTOR_ID}: malformed cursor`,
      );
    }
    totals.skipped.push({
      position: skip["position"],
      reason: skip["reason"] as RowSkip["reason"],
    });
  }
  return totals;
}

export function decodeCursor(cursor: Cursor): LegacyEventsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch (error) {
    throw new KizukiError(
      "parse_error",
      `${LEGACY_EVENTS_CONNECTOR_ID}: malformed cursor`,
      { cause: error },
    );
  }
  if (
    !isPlainObject(parsed) ||
    parsed["schema"] !== LEGACY_EVENTS_CURSOR_SCHEMA ||
    typeof parsed["mapping_hash"] !== "string" ||
    typeof parsed["position"] !== "string" ||
    !POSITION.test(parsed["position"]) ||
    typeof parsed["done"] !== "boolean"
  ) {
    throw new KizukiError(
      "parse_error",
      `${LEGACY_EVENTS_CONNECTOR_ID}: malformed cursor`,
    );
  }
  const position = BigInt(parsed["position"]);
  return {
    schema: LEGACY_EVENTS_CURSOR_SCHEMA,
    mapping_hash: parsed["mapping_hash"],
    position: parsed["position"],
    done: parsed["done"],
    run: decodeTotals(parsed["run"], position),
  };
}

