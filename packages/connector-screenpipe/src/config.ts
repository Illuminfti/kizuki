import type { Database } from "bun:sqlite";
import path from "node:path";
import { isPlainObject, isRfc3339 } from "@kizuki/core";
import { DEFAULT_SETTLE_SECONDS } from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { parseTimeZone } from "./time";

export const SCREENPIPE_CONNECTOR_ID = "kizuki.screenpipe" as const;

export interface ScreenpipeConfig {
  path: string;
  since?: string;
  settle_seconds?: number;
  timezone?: string;
  retain_full_urls?: boolean;
}

export interface ScreenpipeDeps {
  now: () => number;
  open: (path: string) => Database;
}

export interface ParsedScreenpipeConfig {
  path: string;
  since: string | null;
  settle_seconds: number;
  timezone: string | null;
  retain_full_urls: boolean;
}

const CONFIG_KEYS = new Set([
  "path",
  "since",
  "settle_seconds",
  "timezone",
  "retain_full_urls",
]);

export function parseConfig(config: unknown): ParsedScreenpipeConfig {
  if (!isPlainObject(config)) {
    misconfigured("config must be an object");
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      misconfigured("config contains an unknown key");
    }
  }

  const configuredPath = config["path"];
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    misconfigured("config.path must be a non-empty string");
  }
  const since = config["since"];
  if (since !== undefined && !isRfc3339(since)) {
    misconfigured("config.since must be an RFC3339 timestamp");
  }
  const settleSeconds = config["settle_seconds"];
  if (
    settleSeconds !== undefined &&
    (typeof settleSeconds !== "number" ||
      !Number.isInteger(settleSeconds) ||
      settleSeconds < 0 ||
      settleSeconds > 86_400)
  ) {
    misconfigured("config.settle_seconds must be an integer from 0 to 86400");
  }
  const timezone = config["timezone"];
  const retainFullUrls = config["retain_full_urls"];
  if (retainFullUrls !== undefined && typeof retainFullUrls !== "boolean") {
    misconfigured("config.retain_full_urls must be a boolean");
  }

  return {
    path: path.resolve(configuredPath),
    since: since ?? null,
    settle_seconds: settleSeconds ?? DEFAULT_SETTLE_SECONDS,
    timezone: timezone === undefined ? null : parseTimeZone(timezone),
    retain_full_urls: retainFullUrls === true,
  };
}

function misconfigured(detail: string): never {
  throw new ScreenpipeConnectorError(
    "misconfigured",
    `${SCREENPIPE_CONNECTOR_ID}: ${detail}`,
  );
}
