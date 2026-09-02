import { KizukiError } from "@kizuki/core";

/** Inclusive UID range; `first <= last` always holds after normalisation. */
export interface UidRange {
  first: number;
  last: number;
}

const UID_MAX = 4294967295;

function isUid(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= UID_MAX;
}

function parseNumber(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new KizukiError("parse_error", "sequence set: malformed number");
  }
  const value = Number(raw);
  if (!isUid(value)) {
    throw new KizukiError("parse_error", "sequence set: uid out of range");
  }
  return value;
}

/** Sorts, clamps and coalesces so every set has exactly one wire form. */
export function normalize(ranges: UidRange[]): UidRange[] {
  const sorted = ranges
    .map((range) =>
      range.first <= range.last
        ? { first: range.first, last: range.last }
        : { first: range.last, last: range.first },
    )
    .sort((a, b) => a.first - b.first || a.last - b.last);
  const merged: UidRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.first <= previous.last + 1) {
      previous.last = Math.max(previous.last, range.last);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export function parseSet(text: string): UidRange[] {
  if (text.length === 0) return [];
  const ranges: UidRange[] = [];
  for (const piece of text.split(",")) {
    const bounds = piece.split(":");
    if (bounds.length === 1) {
      const only = parseNumber(bounds[0] ?? "");
      ranges.push({ first: only, last: only });
      continue;
    }
    if (bounds.length !== 2) {
      throw new KizukiError("parse_error", "sequence set: malformed range");
    }
    ranges.push({
      first: parseNumber(bounds[0] ?? ""),
      last: parseNumber(bounds[1] ?? ""),
    });
  }
  return normalize(ranges);
}

export function formatSet(ranges: UidRange[]): string {
  return normalize(ranges)
    .map((range) =>
      range.first === range.last ? `${range.first}` : `${range.first}:${range.last}`,
    )
    .join(",");
}

export function addUid(ranges: UidRange[], uid: number): UidRange[] {
  if (!isUid(uid)) {
    throw new KizukiError("parse_error", "sequence set: uid out of range");
  }
  return normalize([...ranges, { first: uid, last: uid }]);
}

export function removeUid(ranges: UidRange[], uid: number): UidRange[] {
  const result: UidRange[] = [];
  for (const range of normalize(ranges)) {
    if (uid < range.first || uid > range.last) {
      result.push({ ...range });
      continue;
    }
    if (uid > range.first) result.push({ first: range.first, last: uid - 1 });
    if (uid < range.last) result.push({ first: uid + 1, last: range.last });
  }
  return result;
}

/** Used to bound the retry list a folder cursor may carry. */
export function countUids(ranges: UidRange[]): number {
  return normalize(ranges).reduce(
    (total, range) => total + (range.last - range.first + 1),
    0,
  );
}

export function* uids(ranges: UidRange[]): Generator<number> {
  for (const range of normalize(ranges)) {
    for (let uid = range.first; uid <= range.last; uid += 1) yield uid;
  }
}

/**
 * Yields wire-form pieces of at most `size` UIDs, so an existence check never
 * hands a server a command line it will refuse. Lazy on purpose: a caller
 * that stops at a work budget must not have paid for the whole known set of
 * a large mailbox first.
 */
export function* chunk(
  ranges: UidRange[],
  size: number,
): Generator<string> {
  if (!Number.isInteger(size) || size < 1) {
    throw new KizukiError("parse_error", "sequence set: chunk size must be >= 1");
  }
  let current: UidRange[] = [];
  let count = 0;
  for (const range of normalize(ranges)) {
    let first = range.first;
    while (first <= range.last) {
      const room = size - count;
      const last = Math.min(range.last, first + room - 1);
      current.push({ first, last });
      count += last - first + 1;
      first = last + 1;
      if (count === size) {
        yield formatSet(current);
        current = [];
        count = 0;
      }
    }
  }
  if (current.length > 0) yield formatSet(current);
}
