import type { Database } from "bun:sqlite";
import { readRailCursor, writeRailCursor } from "../ledger/checkpoints";
import { isPlainObject } from "../util/validate";
import { MODEL_PRODUCER_ID } from "../producer";

/**
 * What extraction has learned from refused answers, kept across passes so a
 * pass at one request never forgets its predecessor. One row in `rail_cursors`
 * beside the extraction cursor; a lost or unreadable row reads as no history.
 */
const REJECTIONS_KEY = "extract-rejections";

/** This many different records refused the same way is the model's fault, not the records'. */
export const SYSTEMIC_REJECTION_RECORDS = 3;
const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60_000;
const MAX_LISTED = SYSTEMIC_REJECTION_RECORDS;

export interface RejectionState {
  /** Refused requests in a row, across passes, since the model last answered. */
  readonly consecutive: number;
  /** The diagnostic rule of the latest refusal; a different rule starts the count again. */
  readonly rule: string;
  /** Distinct first records of those requests, up to the systemic limit. */
  readonly heads: readonly string[];
  /** The first record of the request last refused, to be asked for alone next. */
  readonly narrow: string | null;
  /** Records passed over during this streak, queued again if the streak proves systemic. */
  readonly passed_over: readonly string[];
  /** No request leaves before this instant; set while the streak is judged systemic. */
  readonly backoff_until: string | null;
  /** Times the streak has been judged systemic, doubling each wait. */
  readonly trips: number;
}

/** What to do about a refused request. */
export type RejectionAction =
  /** Ask for the first record alone next. */
  | { readonly kind: "narrow" }
  /** The record was refused on its own twice: pass over it. */
  | { readonly kind: "skip" }
  /** Different records fail alike: stop, wait, and queue the records passed over in this streak again. */
  | { readonly kind: "trip"; readonly requeue: readonly string[] };

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_LISTED &&
  value.every((item) => typeof item === "string" && item.length <= 64);

export function readRejections(db: Database): RejectionState | null {
  const raw = readRailCursor(db, MODEL_PRODUCER_ID, REJECTIONS_KEY);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPlainObject(value)) return null;
    const {
      consecutive,
      rule,
      heads,
      narrow,
      passed_over,
      backoff_until,
      trips,
    } = value;
    if (
      typeof consecutive !== "number" ||
      !Number.isSafeInteger(consecutive) ||
      consecutive < 1
    )
      return null;
    if (typeof rule !== "string" || rule.length === 0 || rule.length > 64)
      return null;
    if (!strings(heads) || !strings(passed_over)) return null;
    if (narrow !== null && typeof narrow !== "string") return null;
    if (
      backoff_until !== null &&
      (typeof backoff_until !== "string" ||
        Number.isNaN(Date.parse(backoff_until)))
    )
      return null;
    if (typeof trips !== "number" || !Number.isSafeInteger(trips) || trips < 0)
      return null;
    return {
      consecutive,
      rule,
      heads,
      narrow,
      passed_over,
      backoff_until,
      trips,
    };
  } catch {
    return null;
  }
}

/** Null clears: the model answered, so no refusal is history any more. */
export function writeRejections(
  db: Database,
  state: RejectionState | null,
): void {
  if (state === null) {
    db.query("DELETE FROM rail_cursors WHERE rail=? AND source_key=?").run(
      MODEL_PRODUCER_ID,
      REJECTIONS_KEY,
    );
    return;
  }
  writeRailCursor(db, MODEL_PRODUCER_ID, REJECTIONS_KEY, JSON.stringify(state));
}

/** Milliseconds to wait after the streak has been judged systemic `trips` times. */
export function rejectionBackoffMs(trips: number): number {
  return Math.min(
    BACKOFF_CAP_MS,
    BACKOFF_BASE_MS * 2 ** Math.max(0, trips - 1),
  );
}

/** The instant before which the model is not asked again, or null when it may be. */
export function backoffRemaining(
  state: RejectionState | null,
  now: string,
): string | null {
  if (state?.backoff_until == null) return null;
  return Date.parse(now) < Date.parse(state.backoff_until)
    ? state.backoff_until
    : null;
}

/**
 * Fold one refused request into the history. `head` is the first record the
 * request carried and `single` says it carried that record alone.
 */
export function recordRejection(
  prior: RejectionState | null,
  refused: {
    readonly head: string;
    readonly rule: string;
    readonly single: boolean;
  },
  now: string,
): { readonly state: RejectionState; readonly action: RejectionAction } {
  const { head, rule, single } = refused;
  const same = prior !== null && prior.rule === rule;
  const base: RejectionState = same
    ? prior
    : {
        consecutive: 0,
        rule,
        heads: [],
        narrow: null,
        passed_over: [],
        backoff_until: null,
        trips: 0,
      };
  const heads =
    base.heads.includes(head) || base.heads.length >= MAX_LISTED
      ? base.heads
      : [...base.heads, head];
  const next = { ...base, consecutive: base.consecutive + 1, heads };
  if (heads.length >= SYSTEMIC_REJECTION_RECORDS) {
    const trips = base.trips + 1;
    const backoff_until = new Date(
      Date.parse(now) + rejectionBackoffMs(trips),
    ).toISOString();
    return {
      state: { ...next, narrow: null, passed_over: [], backoff_until, trips },
      action: { kind: "trip", requeue: base.passed_over },
    };
  }
  if (single && base.narrow === head) {
    return {
      state: {
        ...next,
        narrow: null,
        passed_over: [...base.passed_over, head].slice(-MAX_LISTED),
      },
      action: { kind: "skip" },
    };
  }
  return { state: { ...next, narrow: head }, action: { kind: "narrow" } };
}
