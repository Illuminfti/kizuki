import type { Database } from "bun:sqlite";
import { MAX_PLAN_IDS, PLAN_PAGE } from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { siteHost, slug } from "./map";
import { toSafeNumber } from "./read";

export function planSourceRecords(
  db: Database,
  subjectId: string,
): string[] {
  const app = prefixedValue(subjectId, "screenpipe:app:");
  if (app !== null) {
    const names = distinctText(db, "frames", "app_name").filter(
      (name) => slug(name) === app,
    );
    return pageIdsForValues(db, "frames", "app_name", names, "frame");
  }
  const site = prefixedValue(subjectId, "screenpipe:site:");
  if (site !== null) return pageSiteIds(db, site);

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
      );
    }
  }
  const device = prefixedValue(subjectId, "screenpipe:audio-device:");
  if (device !== null) {
    const names = distinctText(
      db,
      "audio_transcriptions",
      "device",
    ).filter((name) => slug(name) === device);
    return pageIdsForValues(
      db,
      "audio_transcriptions",
      "device",
      names,
      "transcription",
    );
  }
  return [];
}

function pageSiteIds(db: Database, host: string): string[] {
  const ids: string[] = [];
  let afterId = 0;
  while (ids.length < MAX_PLAN_IDS) {
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
      if (ids.length === MAX_PLAN_IDS) break;
    }
    if (rows.length < PLAN_PAGE) break;
  }
  return ids;
}

function pageIdsForValues(
  db: Database,
  table: "frames" | "audio_transcriptions",
  column: "app_name" | "device",
  values: string[],
  prefix: "frame" | "transcription",
): string[] {
  if (values.length === 0) return [];
  const placeholders = values.map(() => "?").join(", ");
  return pageIds(
    db,
    table,
    `${column} IN (${placeholders})`,
    values,
    prefix,
  );
}

function pageIds(
  db: Database,
  table: "frames" | "audio_transcriptions",
  condition: string,
  bindings: Array<string | number>,
  prefix: "frame" | "transcription",
): string[] {
  const ids: string[] = [];
  let afterId = 0;
  while (ids.length < MAX_PLAN_IDS) {
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
      if (ids.length === MAX_PLAN_IDS) break;
    }
    if (rows.length < PLAN_PAGE) break;
  }
  return ids;
}

function distinctText(
  db: Database,
  table: "frames" | "audio_transcriptions",
  column: "app_name" | "device",
): string[] {
  return db
    .query<{ value: unknown }, []>(
      `SELECT DISTINCT ${column} AS value
         FROM ${table}
        WHERE ${column} IS NOT NULL`,
    )
    .all()
    .map(({ value }) => value)
    .filter((value): value is string => typeof value === "string");
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
