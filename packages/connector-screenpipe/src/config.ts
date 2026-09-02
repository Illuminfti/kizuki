import type { Database } from "bun:sqlite";
import path from "node:path";
import { isPlainObject, isRfc3339 } from "@kizuki/core";
import { DEFAULT_SETTLE_SECONDS } from "./cursor";
import { ScreenpipeConnectorError } from "./errors";
import { normalizeTimestamp } from "./time";

export const SCREENPIPE_CONNECTOR_ID = "kizuki.screenpipe" as const;

export interface ScreenpipeConfig {
  path: string;
  since?: string;
  settle_seconds?: number;
}

export interface ScreenpipeDeps {
  now: () => number;
  open: (path: string) => Database;
}

export interface ParsedScreenpipeConfig {
  path: string;
  /** Normalized to UTC milliseconds so the walk can compare it as text. */
  since: string | null;
  settle_seconds: number;
}

const CONFIG_KEYS = new Set(["path", "since", "settle_seconds"]);

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
  // RFC3339 permits the leap second, which the runtime has no date for, and an
  // extreme zone offset can carry a value out of the years the format covers.
  // Normalizing here settles both, and gives the walk one comparable form.
  const normalizedSince =
    since === undefined
      ? null
      : isRfc3339(since)
        ? normalizeTimestamp(since)
        : null;
  if (since !== undefined && normalizedSince === null) {
    misconfigured(
      "config.since must be an RFC3339 timestamp the runtime can represent",
    );
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

  return {
    path: path.resolve(configuredPath),
    since: normalizedSince,
    settle_seconds: settleSeconds ?? DEFAULT_SETTLE_SECONDS,
  };
}

function misconfigured(detail: string): never {
  throw new ScreenpipeConnectorError(
    "misconfigured",
    `${SCREENPIPE_CONNECTOR_ID}: ${detail}`,
  );
}
