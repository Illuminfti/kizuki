import type { FrontmatterValue } from "./proposal";
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

const SEGMENT_COUNT_RULE = `target: more than ${MAX_SEGMENTS} path segments`;
const SEGMENT_RULE = "target: unusable path segment";

interface TargetFault {
  rule: string;
  /** The offending segment, for a producer checking a target it built itself. */
  segment?: string;
}

function targetFault(target: string): TargetFault | null {
  const segments = target.split(/[:/]/);
  if (segments.length > MAX_SEGMENTS) return { rule: SEGMENT_COUNT_RULE };
  for (const segment of segments) {
    if (segment.length > MAX_SEGMENT_LENGTH || !PATH_SEGMENT.test(segment)) {
      // Bounded: a segment is refused precisely because it broke the length
      // and character rules, so it can be arbitrary text of arbitrary length.
      return { rule: SEGMENT_RULE, segment: segment.slice(0, MAX_SEGMENT_LENGTH) };
    }
  }
  return null;
}

/**
 * The rule a target breaks, naming nothing from the target itself; null when
 * the target is usable. This is what the canon writer raises, because a claim
 * target is derived from captured text and an error is not a place to echo it.
 */
export function targetRefusal(target: string): string | null {
  return targetFault(target)?.rule ?? null;
}

/**
 * The same rule, naming the segment that broke it. Lives here rather than in
 * the writer so a producer can check a target it is about to mint — its own
 * input, at the moment it can still fix it — against the writer's rule.
 */
export function targetProblem(target: string): string | null {
  const fault = targetFault(target);
  if (fault === null) return null;
  return fault.segment === undefined
    ? fault.rule
    : `${fault.rule} ${JSON.stringify(fault.segment)}`;
}

/**
 * Length in code points, the unit a producer counts in. A UTF-16 count would
 * make an emoji two characters and refuse a title its author sees as short
 * enough, so the check that guards the floor and the code that mints the
 * candidate have to agree on what a character is. Bounded: a string more than
 * twice the cap in units is already too long, and is never expanded.
 */
function tooLong(value: string, max: number): boolean {
  if (value.length <= max) return false;
  if (value.length > max * 2) return true;
  return [...value].length > max;
}

function validateExtensionValue(
  key: string,
  value: unknown,
  errors: string[],
): FrontmatterValue | undefined {
  if (typeof value === "string") {
    if (tooLong(value, MAX_EXTENSION_STRING)) {
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
    if (value.some((item) => tooLong(item, MAX_EXTENSION_STRING))) {
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
    tooLong(title.trim(), MAX_TITLE_LENGTH)
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
