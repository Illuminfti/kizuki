import type { Database } from "bun:sqlite";
import {
  DISTINCT_SCAN_CAP,
  MAX_PLAN_IDS,
  PLAN_DEADLINE_MS,
  PLAN_PAGE,
} from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { siteHost, slug } from "./map";
import { toSafeNumber } from "./read";

export interface PlanScan {
  ids: string[];
  truncated: boolean;
}

export function planSourceRecords(
  db: Database,
  subjectId: string,
  now: () => number = Date.now,
): PlanScan {
  const deadline = now() + PLAN_DEADLINE_MS;
  const app = prefixedValue(subjectId, "screenpipe:app:");
  if (app !== null) {
    return planByDistinctName(
      db,
      "frames",
      "app_name",
      app,
      "frame",
      deadline,
      now,
    );
  }
  const site = prefixedValue(subjectId, "screenpipe:site:");
  if (site !== null) return pageSiteIds(db, site, deadline, now);

  const speaker = prefixedValue(subjectId, "screenpipe:speaker:");
  if (speaker !== null && /^[1-9]\d*$/.test(speaker)) {
    const id = Number(speaker);
    if (Number.isSafeInteger(id)) {
      return pageIds(
        db,
        "audio_transcriptions",
        "speaker_id = ?",
        [id],
        "transcription",
        deadline,
        now,
      );
    }
  }
  const device = prefixedValue(subjectId, "screenpipe:audio-device:");
  if (device !== null) {
    return planByDistinctName(
      db,
      "audio_transcriptions",
      "device",
      device,
      "transcription",
      deadline,
      now,
    );
  }
  return { ids: [], truncated: false };
}

function pageSiteIds(
  db: Database,
  host: string,
  deadline: number,
  now: () => number,
): PlanScan {
  const ids: string[] = [];
  let afterId = 0;
  let truncated = false;
  while (ids.length < MAX_PLAN_IDS) {
    if (now() >= deadline) {
      truncated = true;
      break;
    }
    const rows = db
      .query<{ id: unknown; browser_url: unknown }, [number, number]>(
        `SELECT id, browser_url
           FROM frames
          WHERE browser_url IS NOT NULL AND browser_url != '' AND id > ?
          ORDER BY id
          LIMIT ?`,
      )
      .all(afterId, PLAN_PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = planId(row.id);
      afterId = id;
      const url = typeof row.browser_url === "string" ? row.browser_url : null;
      if (siteHost(url) === host) ids.push(`frame:${id}`);
      if (ids.length === MAX_PLAN_IDS) {
        truncated = true;
        break;
      }
    }
    if (rows.length < PLAN_PAGE) break;
  }
  return { ids, truncated };
}

function planByDistinctName(
  db: Database,
  table: "frames" | "audio_transcriptions",
  column: "app_name" | "device",
  slugValue: string,
  prefix: "frame" | "transcription",
  deadline: number,
  now: () => number,
): PlanScan {
  const names = distinctText(db, table, column, deadline, now);
  const matched = names.values.filter((name) => slug(name) === slugValue);
  const plan = pageIdsForValues(
    db,
    table,
    column,
    matched,
    prefix,
    deadline,
    now,
  );
  return {
    ids: plan.ids,
    truncated: names.truncated || plan.truncated,
  };
}

function pageIdsForValues(
  db: Database,
  table: "frames" | "audio_transcriptions",
  column: "app_name" | "device",
  values: string[],
  prefix: "frame" | "transcription",
  deadline: number,
  now: () => number,
): PlanScan {
  if (values.length === 0) return { ids: [], truncated: false };
  const placeholders = values.map(() => "?").join(", ");
  return pageIds(
    db,
    table,
    `${column} IN (${placeholders})`,
    values,
    prefix,
    deadline,
    now,
  );
}

function pageIds(
  db: Database,
  table: "frames" | "audio_transcriptions",
  condition: string,
  bindings: Array<string | number>,
  prefix: "frame" | "transcription",
  deadline: number,
  now: () => number,
): PlanScan {
  const ids: string[] = [];
  let afterId = 0;
  let truncated = false;
  while (ids.length < MAX_PLAN_IDS) {
    if (now() >= deadline) {
      truncated = true;
      break;
    }
    const rows = db
      .query<{ id: unknown }, Array<string | number>>(
        `SELECT id FROM ${table}
          WHERE ${condition} AND id > ?
          ORDER BY id
          LIMIT ?`,
      )
      .all(...bindings, afterId, PLAN_PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = planId(row.id);
      afterId = id;
      ids.push(`${prefix}:${id}`);
      if (ids.length === MAX_PLAN_IDS) {
        truncated = true;
        break;
      }
    }
    if (rows.length < PLAN_PAGE) break;
  }
  return { ids, truncated };
}

function distinctText(
  db: Database,
  table: "frames" | "audio_transcriptions",
  column: "app_name" | "device",
  deadline: number,
  now: () => number,
): { values: string[]; truncated: boolean } {
  if (now() >= deadline) return { values: [], truncated: true };
  const rows = db
    .query<{ value: unknown }, [number]>(
      `SELECT DISTINCT ${column} AS value
         FROM ${table}
        WHERE ${column} IS NOT NULL
        ORDER BY ${column}
        LIMIT ?`,
    )
    .all(DISTINCT_SCAN_CAP + 1);
  return {
    values: rows
      .slice(0, DISTINCT_SCAN_CAP)
      .map(({ value }) => value)
      .filter((value): value is string => typeof value === "string"),
    truncated: rows.length > DISTINCT_SCAN_CAP || now() >= deadline,
  };
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
