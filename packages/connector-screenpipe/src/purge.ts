import type { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
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
  session_nonce: string;
  after_id: number;
}

interface FileIdentity {
  path: string;
  dev: string;
  ino: string;
  size: string;
  ctime: string;
  mtime: string;
  birthtime: string;
}

interface ScanSession {
  nonce: string;
  identity: FileIdentity;
  dataVersion: number;
}

const scanSessions = new WeakMap<Database, ScanSession>();

/**
 * Lists records only. A continuation belongs to this open Database instance;
 * reopening the source starts a fresh scan rather than resuming an old view.
 */
export function planSourceRecords(
  db: Database,
  subjectId: string,
  now: () => number = Date.now,
  continuation?: string,
): PlanScan {
  const deadline = now() + PLAN_DEADLINE_MS;
  return inReadSnapshot(db, deadline, now, continuation, subjectId, (cursor, session) => {
    const app = exactSubjectValue(subjectId, "app");
    if (app !== null) {
      return pageIds(db, "frames", "app_name = ?", [app], "frame", cursor.after_id, deadline, now, subjectId, session.nonce);
    }
    const device = exactSubjectValue(subjectId, "audio-device");
    if (device !== null) {
      return pageIds(db, "audio_transcriptions", "device = ?", [device], "transcription", cursor.after_id, deadline, now, subjectId, session.nonce);
    }
    const speaker = prefixedValue(subjectId, "screenpipe:speaker:");
    if (speaker !== null && /^[1-9]\d*$/.test(speaker)) {
      return pageIds(db, "audio_transcriptions", "speaker_id = ?", [Number(speaker)], "transcription", cursor.after_id, deadline, now, subjectId, session.nonce);
    }
    const site = prefixedValue(subjectId, "screenpipe:site:");
    if (site !== null) return pageSiteIds(db, site, cursor.after_id, deadline, now, subjectId, session.nonce);
    if (subjectId.startsWith("screenpipe:app:") || subjectId.startsWith("screenpipe:audio-device:")) {
      throw new ScreenpipeConnectorError("not_supported", "kizuki.screenpipe: legacy slug subject identities are ambiguous; rebackfill to use v2 identities");
    }
    return { ids: [], truncated: false, complete: true };
  });
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
  sessionNonce: string,
): PlanScan {
  if (now() >= deadline) return incomplete([], afterId, subjectId, sessionNonce);
  const rows = db.query<{ id: unknown }, Array<string | number>>(
    `SELECT id FROM ${table} WHERE ${condition} AND id > ? ORDER BY id LIMIT ?`,
  ).all(...bindings, afterId, MAX_PLAN_IDS + 1);
  const included = rows.slice(0, MAX_PLAN_IDS).map((row) => planId(row.id));
  const ids = included.map((id) => `${prefix}:${id}`);
  if (rows.length <= MAX_PLAN_IDS) return { ids, truncated: false, complete: true };
  return incomplete(ids, included.at(-1) ?? afterId, subjectId, sessionNonce);
}

function pageSiteIds(
  db: Database,
  host: string,
  afterId: number,
  deadline: number,
  now: () => number,
  subjectId: string,
  sessionNonce: string,
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
        if (ids.length === MAX_PLAN_IDS) return incomplete(ids, after, subjectId, sessionNonce);
      }
    }
    if (rows.length < PLAN_PAGE) return { ids, truncated: false, complete: true };
  }
  return incomplete(ids, after, subjectId, sessionNonce);
}

function incomplete(ids: string[], afterId: number, subjectId: string, sessionNonce: string): PlanScan {
  return { ids, truncated: true, complete: false, continuation: encodeContinuation({ subject_id: subjectId, session_nonce: sessionNonce, after_id: afterId }) };
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

function parseContinuation(value: string | undefined, subjectId: string, session: ScanSession): PlanCursor {
  if (value === undefined) return { subject_id: subjectId, session_nonce: session.nonce, after_id: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PlanCursor>;
    const afterId = parsed.after_id;
    if (parsed.subject_id !== subjectId || parsed.session_nonce !== session.nonce || typeof afterId !== "number" || !Number.isSafeInteger(afterId) || afterId < 0) throw new Error();
    return { subject_id: subjectId, session_nonce: session.nonce, after_id: afterId };
  } catch {
    throw new ScreenpipeConnectorError("parse_error", "kizuki.screenpipe: purge continuation does not match this subject and database");
  }
}

function encodeContinuation(cursor: PlanCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function inReadSnapshot(
  db: Database,
  deadline: number,
  now: () => number,
  continuation: string | undefined,
  subjectId: string,
  page: (cursor: PlanCursor, session: ScanSession) => PlanScan,
): PlanScan {
  db.exec("BEGIN");
  try {
    const before = sourceState(db);
    const prior = scanSessions.get(db);
    const session = continuation === undefined
      ? { nonce: crypto.randomUUID(), identity: before.identity, dataVersion: before.dataVersion }
      : prior;
    if (session === undefined || !sameIdentity(session.identity, before.identity) || session.dataVersion !== before.dataVersion) throw continuationReset();
    if (continuation === undefined) scanSessions.set(db, session);
    const cursor = parseContinuation(continuation, subjectId, session);
    const result = now() >= deadline ? incomplete([], cursor.after_id, subjectId, session.nonce) : page(cursor, session);
    const during = sourceState(db);
    if (!sameIdentity(before.identity, during.identity) || before.dataVersion !== during.dataVersion) throw continuationReset();
    db.exec("COMMIT");
    const after = sourceState(db);
    if (!sameIdentity(before.identity, after.identity) || before.dataVersion !== after.dataVersion) throw continuationReset();
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the transaction may already be closed */ }
    if (error instanceof Error) throw error;
    throw new ScreenpipeConnectorError("reset_detected", "kizuki.screenpipe: purge scan could not establish a stable source snapshot");
  }
}

function sourceState(db: Database): { identity: FileIdentity; dataVersion: number } {
  const main = db.query<{ name: unknown; file: unknown }, []>("PRAGMA database_list").all().find((row) => row.name === "main");
  if (typeof main?.file !== "string" || main.file.length === 0) throw new ScreenpipeConnectorError("misconfigured", "kizuki.screenpipe: purge source database identity is unavailable");
  try {
    const stat = lstatSync(main.file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    const dataVersion = toSafeNumber(db.query<{ data_version: unknown }, []>("PRAGMA data_version").get()?.data_version);
    if (dataVersion === null) throw new Error();
    return { identity: { path: main.file, dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(), ctime: stat.ctimeNs.toString(), mtime: stat.mtimeNs.toString(), birthtime: stat.birthtimeNs.toString() }, dataVersion };
  } catch (error) {
    if (error instanceof ScreenpipeConnectorError) throw error;
    throw new ScreenpipeConnectorError("misconfigured", "kizuki.screenpipe: purge source database identity is unavailable", { cause: error });
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.ctime === right.ctime && left.mtime === right.mtime && left.birthtime === right.birthtime;
}

function continuationReset(): ScreenpipeConnectorError {
  return new ScreenpipeConnectorError("reset_detected", "kizuki.screenpipe: purge continuation source changed or session was reopened; restart enumeration");
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
