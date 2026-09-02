import { isPlainObject, PortError } from "@kizuki/core";
import { isAbsolute } from "node:path";

export const PINNED_CONTEXT_SIZE_MIN = 1;
export const PINNED_CONTEXT_SIZE_MAX = 8192;
export const PINNED_BATCH_SIZE_MIN = 1;
export const PINNED_BATCH_SIZE_MAX = 64;

export interface GgufEmbeddingConfig {
  readonly model_path: string;
  readonly context_size: number;
  readonly batch_size: number;
  readonly expected_space: string | null;
}

function invalid(message: string): never {
  throw new PortError("config_invalid", message, false);
}

function pinnedInteger(
  value: unknown,
  field: "context_size" | "batch_size",
  min: number,
  max: number,
): number {
  if (value === "auto" || value === undefined || value === null) {
    invalid(`${field} must be pinned explicitly; auto-sizing is forbidden`);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    invalid(`${field} must be a pinned integer`);
  }
  if (value < min || value > max) {
    invalid(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

export function parseGgufEmbeddingConfig(
  value: Readonly<Record<string, unknown>>,
): GgufEmbeddingConfig {
  if (!isPlainObject(value)) invalid("embedding config must be a table");
  const modelPath = value["model_path"];
  if (typeof modelPath !== "string" || modelPath.length === 0) {
    invalid("model_path is required");
  }
  if (!isAbsolute(modelPath)) invalid("model_path must be an absolute path");

  const expected = value["expected_space"];
  if (
    expected !== undefined &&
    expected !== null &&
    (typeof expected !== "string" || expected.length === 0)
  ) {
    invalid("expected_space must be a non-empty string when set");
  }

  return Object.freeze({
    model_path: modelPath,
    context_size: pinnedInteger(
      value["context_size"],
      "context_size",
      PINNED_CONTEXT_SIZE_MIN,
      PINNED_CONTEXT_SIZE_MAX,
    ),
    batch_size: pinnedInteger(
      value["batch_size"],
      "batch_size",
      PINNED_BATCH_SIZE_MIN,
      PINNED_BATCH_SIZE_MAX,
    ),
    expected_space:
      typeof expected === "string" ? expected : null,
  });
}
