import type { FrontmatterValue } from "../staging/proposals";
import { isPlainObject } from "../util/validate";
import type { ValidationResult } from "../util/validate";
import { PAGE_TYPES } from "../vault/schema";
import type { PageType } from "../vault/schema";

/**
 * An event may carry, under one well-known `metadata` key, a page candidate:
 * a typed page the deterministic floor should stage instead of the generic
 * source capture note. The ingress contract is untouched — `metadata` is still
 * persisted verbatim and hashed — so this is a downstream convention, and the
 * floor validates it strictly: metadata is attacker-controlled by policy.
 */

export const PAGE_CANDIDATE_SCHEMA = "kizuki.page-candidate/v1" as const;
export const PAGE_CANDIDATE_KEY = "page_candidate" as const;

/** Types whose candidate files as `entity`; every other PageType files as `claim`. */
export const ENTITY_PAGE_TYPES = [
  "person",
  "org",
  "project",
  "place",
  "topic",
] as const;

export interface PageCandidate {
  schema: typeof PAGE_CANDIDATE_SCHEMA;
  type: PageType;
  title: string;
  /** `pageRelPath` grammar: 1..8 segments joined by "/" or ":". */
  target: string;
  extensions: Record<string, FrontmatterValue>;
  confidence: number;
}

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT_LENGTH = 64;

const EXTENSION_KEY = /^x-[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const MAX_TITLE_LENGTH = 200;
const MAX_EXTENSION_KEYS = 64;
const MAX_EXTENSION_STRING = 4096;
const MAX_EXTENSION_ARRAY = 256;

/** Keys the floor or promote owns; a candidate that sets one is refused. */
const FLOOR_OWNED_KEYS = new Set([
  "id",
  "status",
  "sensitivity",
  "sources",
  "type",
  "title",
]);

/**
 * The rule `pageRelPath` applies to a target; null when the target is usable.
 * Lives here rather than in promote so a producer can check a target it is
 * about to mint without reaching into the canon writer.
 */
export function targetProblem(target: string): string | null {
  const segments = target.split(/[:/]/);
  if (segments.length > MAX_SEGMENTS) {
    return `target: more than ${MAX_SEGMENTS} path segments`;
  }
  for (const segment of segments) {
    if (segment.length > MAX_SEGMENT_LENGTH || !PATH_SEGMENT.test(segment)) {
      return `target: unusable path segment ${JSON.stringify(segment)}`;
    }
  }
  return null;
}

function validateExtensionValue(
  key: string,
  value: unknown,
  errors: string[],
): FrontmatterValue | undefined {
  if (typeof value === "string") {
    if (value.length > MAX_EXTENSION_STRING) {
      errors.push(
        `extensions: value for ${JSON.stringify(key)} exceeds ${MAX_EXTENSION_STRING} characters`,
      );
      return undefined;
    }
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      errors.push(
        `extensions: value for ${JSON.stringify(key)} must be a string, finite number, boolean, or string array`,
      );
      return undefined;
    }
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    if (value.length > MAX_EXTENSION_ARRAY) {
      errors.push(
        `extensions: value for ${JSON.stringify(key)} must hold at most ${MAX_EXTENSION_ARRAY} strings`,
      );
      return undefined;
    }
    if (value.some((item) => item.length > MAX_EXTENSION_STRING)) {
      errors.push(
        `extensions: value for ${JSON.stringify(key)} exceeds ${MAX_EXTENSION_STRING} characters`,
      );
      return undefined;
    }
    return [...value];
  }
  errors.push(
    `extensions: value for ${JSON.stringify(key)} must be a string, finite number, boolean, or string array`,
  );
  return undefined;
}

function validateExtensions(
  raw: unknown,
  errors: string[],
): Record<string, FrontmatterValue> {
  const extensions: Record<string, FrontmatterValue> = {};
  if (!isPlainObject(raw)) {
    errors.push("extensions: must be a plain object");
    return extensions;
  }
  const keys = Object.keys(raw);
  if (keys.length > MAX_EXTENSION_KEYS) {
    errors.push(`extensions: must carry at most ${MAX_EXTENSION_KEYS} keys`);
    return extensions;
  }
  for (const key of keys) {
    if (FLOOR_OWNED_KEYS.has(key)) {
      errors.push(
        `extensions: key ${JSON.stringify(key)} is set by the floor, not by a candidate`,
      );
      continue;
    }
    if (!EXTENSION_KEY.test(key)) {
      errors.push(
        `extensions: key ${JSON.stringify(key)} must match /${EXTENSION_KEY.source}/`,
      );
      continue;
    }
    const value = validateExtensionValue(key, raw[key], errors);
    if (value !== undefined) extensions[key] = value;
  }
  return extensions;
}

/**
 * Null when the event carries no candidate at all — the common case, and not
 * an error. A candidate that is present but malformed returns errors so the
 * floor can fall back to the capture note rather than staging a typed page
 * built from input it could not check.
 */
export function validatePageCandidate(
  metadata: Record<string, unknown>,
): ValidationResult<PageCandidate> | null {
  if (!Object.prototype.hasOwnProperty.call(metadata, PAGE_CANDIDATE_KEY)) {
    return null;
  }
  const raw = metadata[PAGE_CANDIDATE_KEY];
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [`${PAGE_CANDIDATE_KEY}: must be a plain object`],
    };
  }

  const errors: string[] = [];
  if (raw["schema"] !== PAGE_CANDIDATE_SCHEMA) {
    errors.push(`schema: must be "${PAGE_CANDIDATE_SCHEMA}"`);
  }

  const type = raw["type"];
  if (
    typeof type !== "string" ||
    !(PAGE_TYPES as readonly string[]).includes(type)
  ) {
    errors.push(`type: must be one of ${PAGE_TYPES.join(" | ")}`);
  }

  const title = raw["title"];
  if (typeof title !== "string") {
    errors.push("title: must be a string");
  } else if (CONTROL_CHARACTER.test(title)) {
    errors.push("title: must not contain control characters");
  } else if (
    title.trim().length === 0 ||
    title.trim().length > MAX_TITLE_LENGTH
  ) {
    errors.push(
      `title: must be 1..${MAX_TITLE_LENGTH} characters after trimming`,
    );
  }

  const target = raw["target"];
  if (typeof target !== "string" || target.length === 0) {
    errors.push("target: must be a non-empty string");
  } else {
    const problem = targetProblem(target);
    if (problem !== null) errors.push(problem);
  }

  const extensions = validateExtensions(raw["extensions"], errors);

  const confidence = raw["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    errors.push("confidence: must be a number in [0, 1]");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      schema: PAGE_CANDIDATE_SCHEMA,
      type: type as PageType,
      title: title as string,
      target: target as string,
      extensions,
      confidence: confidence as number,
    },
  };
}
