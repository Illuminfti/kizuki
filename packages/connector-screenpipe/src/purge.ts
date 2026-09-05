import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { MAX_PLAN_IDS, PLAN_DEADLINE_MS, PLAN_PAGE } from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { siteHost } from "./map";
import { toSafeNumber } from "./read";

export interface PlanScan {
  ids: string[];
  /** Kept for callers of the previous helper surface. */
  truncated: boolean;
  complete: boolean;
  continuation?: string;
}

interface PlanCursor {
  subject_id: string;
  database_fingerprint: string;
  after_id: number;
}

/** Lists records only; continuations bind to this subject and database. */
export function planSourceRecords(
  db: Database,
  subjectId: string,
  now: () => number = Date.now,
  continuation?: string,
): PlanScan {
  const fingerprint = databaseFingerprint(db);
  const cursor = parseContinuation(continuation, subjectId, fingerprint);
  const deadline = now() + PLAN_DEADLINE_MS;
  const app = exactSubjectValue(subjectId, "app");
  if (app !== null) {
    return pageIds(db, "frames", "app_name = ?", [app], "frame", cursor.after_id, deadline, now, subjectId, fingerprint);
  }
  const device = exactSubjectValue(subjectId, "audio-device");
  if (device !== null) {
    return pageIds(db, "audio_transcriptions", "device = ?", [device], "transcription", cursor.after_id, deadline, now, subjectId, fingerprint);
  }
  const speaker = prefixedValue(subjectId, "screenpipe:speaker:");
  if (speaker !== null && /^[1-9]\d*$/.test(speaker)) {
    return pageIds(db, "audio_transcriptions", "speaker_id = ?", [Number(speaker)], "transcription", cursor.after_id, deadline, now, subjectId, fingerprint);
  }
  const site = prefixedValue(subjectId, "screenpipe:site:");
  if (site !== null) return pageSiteIds(db, site, cursor.after_id, deadline, now, subjectId, fingerprint);
  if (subjectId.startsWith("screenpipe:app:") || subjectId.startsWith("screenpipe:audio-device:")) {
    throw new ScreenpipeConnectorError("not_supported", "kizuki.screenpipe: legacy slug subject identities are ambiguous; rebackfill to use v2 identities");
  }
  return { ids: [], truncated: false, complete: true };
}

function pageIds(
  db: Database,
  table: "frames" | "audio_transcriptions",
  condition: string,
  bindings: Array<string | number>,
  prefix: "frame" | "transcription",
  afterId: number,
  deadline: number,
  now: () => number,
  subjectId: string,
  fingerprint: string,
): PlanScan {
  if (now() >= deadline) return incomplete([], afterId, subjectId, fingerprint);
  const rows = db.query<{ id: unknown }, Array<string | number>>(
    `SELECT id FROM ${table} WHERE ${condition} AND id > ? ORDER BY id LIMIT ?`,
  ).all(...bindings, afterId, MAX_PLAN_IDS + 1);
  const included = rows.slice(0, MAX_PLAN_IDS).map((row) => planId(row.id));
  const ids = included.map((id) => `${prefix}:${id}`);
  if (rows.length <= MAX_PLAN_IDS) return { ids, truncated: false, complete: true };
  return incomplete(ids, included.at(-1) ?? afterId, subjectId, fingerprint);
}

function pageSiteIds(
  db: Database,
  host: string,
  afterId: number,
  deadline: number,
  now: () => number,
  subjectId: string,
  fingerprint: string,
): PlanScan {
  const ids: string[] = [];
  let after = afterId;
  while (now() < deadline && ids.length < MAX_PLAN_IDS) {
    const rows = db.query<{ id: unknown; browser_url: unknown }, [number, number]>(
      "SELECT id, browser_url FROM frames WHERE browser_url IS NOT NULL AND browser_url != '' AND id > ? ORDER BY id LIMIT ?",
    ).all(after, PLAN_PAGE);
    if (rows.length === 0) return { ids, truncated: false, complete: true };
    for (const row of rows) {
      after = planId(row.id);
      if (siteHost(typeof row.browser_url === "string" ? row.browser_url : null) === host) {
        ids.push(`frame:${after}`);
        if (ids.length === MAX_PLAN_IDS) return incomplete(ids, after, subjectId, fingerprint);
      }
    }
    if (rows.length < PLAN_PAGE) return { ids, truncated: false, complete: true };
  }
  return incomplete(ids, after, subjectId, fingerprint);
}

function incomplete(ids: string[], afterId: number, subjectId: string, fingerprint: string): PlanScan {
  return { ids, truncated: true, complete: false, continuation: encodeContinuation({ subject_id: subjectId, database_fingerprint: fingerprint, after_id: afterId }) };
}

function exactSubjectValue(subjectId: string, kind: "app" | "audio-device"): string | null {
  const prefix = `screenpipe:${kind}:v2:`;
  if (!subjectId.startsWith(prefix)) return null;
  const encoded = subjectId.slice(prefix.length);
  if (encoded.length === 0) return null;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new ScreenpipeConnectorError("parse_error", "kizuki.screenpipe: malformed v2 subject identity");
  }
}

function parseContinuation(value: string | undefined, subjectId: string, fingerprint: string): PlanCursor {
  if (value === undefined) return { subject_id: subjectId, database_fingerprint: fingerprint, after_id: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PlanCursor>;
    const afterId = parsed.after_id;
    if (parsed.subject_id !== subjectId || parsed.database_fingerprint !== fingerprint || typeof afterId !== "number" || !Number.isSafeInteger(afterId) || afterId < 0) throw new Error();
    return { subject_id: subjectId, database_fingerprint: fingerprint, after_id: afterId };
  } catch {
    throw new ScreenpipeConnectorError("parse_error", "kizuki.screenpipe: purge continuation does not match this subject and database");
  }
}

function encodeContinuation(cursor: PlanCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function databaseFingerprint(db: Database): string {
  const migrations = db.query<{ version: unknown; installed_on: unknown }, []>("SELECT version, installed_on FROM _sqlx_migrations WHERE success = 1 ORDER BY version").all();
  const maxima = db.query<{ frames: unknown; transcriptions: unknown }, []>("SELECT (SELECT MAX(id) FROM frames) AS frames, (SELECT MAX(id) FROM audio_transcriptions) AS transcriptions").get();
  const file = db.query<{ file: unknown }, []>("PRAGMA database_list").all().map((row) => row.file);
  const source = file.map((value) => fileSnapshot(typeof value === "string" ? value : ""));
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ migrations, maxima, file, source }, (_key, value) => typeof value === "bigint" ? value.toString() : value))
    .digest("hex");
}

function fileSnapshot(path: string): string | null {
  if (path.length === 0) return null;
  try {
    const stat = statSync(path, { bigint: true });
    const hash = new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
    let wal: string | null = null;
    try { wal = new Bun.CryptoHasher("sha256").update(readFileSync(`${path}-wal`)).digest("hex"); } catch { /* no WAL */ }
    return JSON.stringify({ dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(), ctime: stat.ctimeNs.toString(), birthtime: stat.birthtimeNs.toString(), hash, wal });
  } catch {
    return null;
  }
}

function planId(value: unknown): number {
  const id = toSafeNumber(value);
  if (id === null || id <= 0) throw new ScreenpipeConnectorError("parse_error", "kizuki.screenpipe: row id is not a safe integer");
  return id;
}

function prefixedValue(subjectId: string, prefix: string): string | null {
  if (!subjectId.startsWith(prefix)) return null;
  const value = subjectId.slice(prefix.length);
  return value.length > 0 ? value : null;
}
