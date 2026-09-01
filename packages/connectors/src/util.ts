import { readFile, stat } from "node:fs/promises";
import { HealthReport, isPlainObject } from "@kizuki/core";
import { KizukiError } from "./errors";

export function requirePathConfig(config: unknown, connectorId: string): string {
  if (!isPlainObject(config) || typeof config["path"] !== "string") {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: config.path must be a non-empty string`,
    );
  }
  const path = config["path"];
  if (path.length === 0) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: config.path must be a non-empty string`,
    );
  }
  return path;
}

export async function pathHealth(
  path: string,
  expected: "file" | "directory",
): Promise<HealthReport> {
  try {
    const info = await stat(path);
    const matches = expected === "file" ? info.isFile() : info.isDirectory();
    return new HealthReport({
      state: matches ? "ok" : "misconfigured",
      checked_at: new Date().toISOString(),
      ...(!matches ? { detail: `path is not a ${expected}: ${path}` } : {}),
    });
  } catch (error) {
    return new HealthReport({
      state: "misconfigured",
      checked_at: new Date().toISOString(),
      detail: `cannot access ${path}: ${errorMessage(error)}`,
    });
  }
}

export async function readUtf8(path: string, connectorId: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: cannot read ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function parseJsonArray(source: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new KizukiError("parse_error", `${label}: malformed JSON`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new KizukiError("parse_error", `${label}: expected a JSON array`);
  }
  return parsed;
}

export function normalizedDate(
  value: unknown,
  fallback: string,
  unit: "seconds" | "date",
): string {
  const raw =
    unit === "seconds" && typeof value === "number" ? value * 1000 : value;
  if (typeof raw === "number" || typeof raw === "string") {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
