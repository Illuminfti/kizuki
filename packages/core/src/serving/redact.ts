import type { Principal } from "../agents";
import { scrubText, tallyRedactions } from "../producer/scrub";
import type { RedactionCounts } from "../producer/scrub";

export type { RedactionCounts } from "../producer/scrub";

/**
 * Unicode tag characters (U+E0000 to U+E007F) render as nothing yet a model
 * reads them, and the bidirectional controls reorder what a reviewer sees.
 * Served text never carries either.
 */
const INVISIBLE = /[\u{E0000}-\u{E007F}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
/** Every character a renderer may treat as a line break. */
const LINE_BREAK = /\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/;

/**
 * One call's serving-output redaction. An agent principal's text loses hidden
 * characters and then credential shapes; the owner's text loses hidden
 * characters only. Hidden characters go first so they cannot split a secret
 * across the scrubber's patterns.
 */
export interface Redactor {
  /** Replaced spans so far, per kind. Values never enter this. */
  readonly counts: RedactionCounts;
  text(value: string): string;
}

export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE, "");
}

export function createRedactor(principal: Pick<Principal, "kind">): Redactor {
  const counts: RedactionCounts = {};
  const scrub = principal.kind !== "owner";
  return {
    counts,
    text(value) {
      const visible = stripInvisible(value);
      if (!scrub) return visible;
      const scrubbed = scrubText(visible);
      tallyRedactions(counts, scrubbed.redactions);
      return scrubbed.text;
    },
  };
}

/** The call's redactor when the gate set one, and a private one for a context built outside it. */
export function redactorOf(ctx: { principal: Pick<Principal, "kind">; redactor?: Redactor }): Redactor {
  return ctx.redactor ?? createRedactor(ctx.principal);
}

/** A copy of `value` in which every string, at any depth, has passed through `redactor`. */
export function redactValue<T>(redactor: Redactor, value: T): T {
  return walk(redactor, value) as T;
}

function walk(redactor: Redactor, value: unknown): unknown {
  if (typeof value === "string") return redactor.text(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => walk(redactor, item));
  // What JSON would serialize is what is walked, so no object shape is a way around it.
  const json = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof json === "function") return walk(redactor, json.call(value));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = walk(redactor, item);
  return copy;
}

/**
 * Captured and canon text inside a packet is quoted, never prose: every line
 * carries the blockquote prefix, blank lines included, so a body line that
 * imitates a stamp reads as quotation and cannot open a packet line of its own.
 */
export function blockquote(text: string): string {
  return text
    .split(LINE_BREAK)
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** A title, path or label kept on the single stamped line it belongs to. */
export function oneLine(text: string): string {
  return text.replace(/[\s\u0085\u2028\u2029]+/g, " ").trim();
}
