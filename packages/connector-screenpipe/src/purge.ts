import type { Database } from "bun:sqlite";
import { MAX_PLAN_IDS, MAX_SUBJECT_CHARS, PLAN_PAGE } from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { siteHost, slug } from "./map";
import { toSafeNumber } from "./read";
import { normalizeTimestamp } from "./time";

/**
 * The code points `String.prototype.trim` removes, spelled out because SQLite's
 * `trim(X, Y)` takes the set as a string. The walk decides a frame has text with
 * `trim`, so a plan built on the ASCII subset alone would name rows the walk
 * skipped; a test pins this list against the runtime's own set.
 */
export const TRIMMED_CODE_POINTS: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
  0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

const BLANK = TRIMMED_CODE_POINTS.map((point) => `char(${point})`).join(" || ");

/** Frames without text are skipped by the walk, so they were never ingested. */
const FRAME_EMITTED = `full_text IS NOT NULL AND trim(full_text, ${BLANK}) != ''`;

export function planSourceRecords(db: Database, subjectId: string): string[] {
  const app = prefixedValue(subjectId, "screenpipe:app:");
  if (app !== null) {
    return pagePlan(
      db,
      framesBy("app_name"),
      [],
      "frame",
      (value) => value !== null && slug(value) === app,
    );
  }
  const site = prefixedValue(subjectId, "screenpipe:site:");
  if (site !== null) {
    return pagePlan(db, framesBy("browser_url"), [], "frame", (value) => {
      const host = siteHost(value);
      return host !== null && slug(host) === site;
    });
  }
  const speaker = prefixedValue(subjectId, "screenpipe:speaker:");
  if (speaker !== null && /^[1-9]\d*$/.test(speaker)) {
    const id = Number(speaker);
    if (Number.isSafeInteger(id)) {
      return pagePlan(
        db,
        transcriptionsBySpeaker(),
        [id],
        "transcription",
        () => true,
      );
    }
  }
  const device = prefixedValue(subjectId, "screenpipe:audio-device:");
  if (device !== null) {
    return pagePlan(
      db,
      transcriptionsBy("device"),
      [],
      "transcription",
      (value) => value !== null && slug(value) === device,
    );
  }
  return [];
}

interface PlanRow {
  id: unknown;
  timestamp: unknown;
  value: unknown;
}

/**
 * The name and the timestamp are provider-controlled and unbounded in the file,
 * so a page reads only as much of each as the match needs.
 */
function matched(column: string, alias: string): string {
  return `CASE WHEN typeof(${column}) = 'text'
               THEN substr(${column}, 1, ${MAX_SUBJECT_CHARS})
               ELSE NULL END AS ${alias}`;
}

function framesBy(column: "app_name" | "browser_url"): string {
  return `SELECT id, ${matched("timestamp", "timestamp")}, ${matched(column, "value")}
            FROM frames
           WHERE ${column} IS NOT NULL AND ${column} != ''
             AND ${FRAME_EMITTED} AND id > ?
           ORDER BY id
           LIMIT ?`;
}

function transcriptionsBy(column: "device"): string {
  return `SELECT id, ${matched("timestamp", "timestamp")}, ${matched(column, "value")}
            FROM audio_transcriptions
           WHERE ${column} IS NOT NULL AND ${column} != '' AND id > ?
           ORDER BY id
           LIMIT ?`;
}

function transcriptionsBySpeaker(): string {
  return `SELECT id, ${matched("timestamp", "timestamp")}, NULL AS value
            FROM audio_transcriptions
           WHERE speaker_id = ? AND id > ?
           ORDER BY id
           LIMIT ?`;
}

/**
 * Every plan walks the primary key in pages and decides one row at a time. How
 * many distinct names reduce to one subject id is provider-controlled, so it
 * may never size a query or an allocation.
 */
function pagePlan(
  db: Database,
  sql: string,
  bindings: number[],
  prefix: "frame" | "transcription",
  matches: (value: string | null) => boolean,
): string[] {
  const ids: string[] = [];
  let afterId = 0;
  while (ids.length < MAX_PLAN_IDS) {
    const rows = db
      .query<PlanRow, number[]>(sql)
      .all(...bindings, afterId, PLAN_PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = planId(row.id);
      afterId = id;
      // A row the walk would skip never reached the ledger, so naming it here
      // would overstate what Kizuki holds for this subject.
      if (normalizeTimestamp(row.timestamp) === null) continue;
      const value = typeof row.value === "string" ? row.value : null;
      if (!matches(value)) continue;
      ids.push(`${prefix}:${id}`);
      if (ids.length === MAX_PLAN_IDS) break;
    }
    if (rows.length < PLAN_PAGE) break;
  }
  return ids;
}

function planId(value: unknown): number {
  const id = toSafeNumber(value);
  if (id === null || id <= 0) {
    throw new ScreenpipeConnectorError(
      "parse_error",
      "kizuki.screenpipe: row id is not a safe integer",
    );
  }
  return id;
}

function prefixedValue(subjectId: string, prefix: string): string | null {
  if (!subjectId.startsWith(prefix)) return null;
  const value = subjectId.slice(prefix.length);
  return value.length > 0 ? value : null;
}
