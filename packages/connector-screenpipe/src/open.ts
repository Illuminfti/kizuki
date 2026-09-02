import { Database } from "bun:sqlite";
import { SCREENPIPE_CONNECTOR_ID } from "./config";
import {
  ScreenpipeConnectorError,
  type ScreenpipeErrorCode,
} from "./errors";

export const BUSY_TIMEOUT_MS = 5_000;

export function openReadOnly(path: string): Database {
  let db: Database | null = null;
  try {
    db = new Database(path, {
      readonly: true,
      create: false,
      safeIntegers: true,
    });
    db.exec("PRAGMA query_only = 1");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.query("SELECT name FROM sqlite_master LIMIT 1").get();
    return db;
  } catch (error) {
    closeQuietly(db);
    throw classifyDatabaseError(error, path);
  }
}

export function classifyDatabaseError(
  error: unknown,
  path: string,
): ScreenpipeConnectorError {
  if (error instanceof ScreenpipeConnectorError) return error;
  const message = errorMessage(error);
  if (isLockedMessage(message)) {
    return new ScreenpipeConnectorError(
      "locked",
      `${SCREENPIPE_CONNECTOR_ID}: screenpipe database is locked; retry`,
      { cause: error },
    );
  }
  return databaseError(
    "misconfigured",
    `${SCREENPIPE_CONNECTOR_ID}: cannot open ${path}: ${message}`,
    error,
  );
}

function databaseError(
  code: ScreenpipeErrorCode,
  message: string,
  cause: unknown,
): ScreenpipeConnectorError {
  return new ScreenpipeConnectorError(code, message, { cause });
}

function isLockedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("database is locked") ||
    lower.includes("database table is locked") ||
    lower.includes("sqlite_busy") ||
    lower.includes("sqlite_locked")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeQuietly(db: Database | null): void {
  if (db === null) return;
  try {
    db.close();
  } catch {
    // The original open/read failure is the actionable error.
  }
}
