import type { Principal } from "../agents";
import { neutralizeControlTags, sanitizeCapturedText, scrubText, stripInvisibleText, tallyRedactions } from "../producer/scrub";
import type { RedactionCounts } from "../producer/scrub";

export type { RedactionCounts } from "../producer/scrub";

/** Every character a renderer may treat as a line break. */
const LINE_BREAK = /\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/;

/**
 * One call's serving-output redaction. An agent principal's text loses hidden
 * characters and then credential shapes; owners keep credentials except exact
 * live serving secrets. Every principal receives inert angle brackets.
 * Hidden characters go first so they cannot split a secret
 * across the scrubber's patterns.
 */
export interface Redactor {
  /** Replaced spans so far, per kind. Values never enter this. */
  readonly counts: RedactionCounts;
  /** A window is cut only after sanitation, in served code-point coordinates. */
  text(value: string, window?: { offset: number; span: number; inline?: boolean }): string;
  /** Add trusted presentation around sanitized text without reinterpreting it. */
  format(value: string, render: (text: string) => string): string;
  /** Assemble sanitized fields and trusted presentation within this call. */
  join(values: readonly string[]): string;
}

export function stripInvisible(value: string): string {
  return stripInvisibleText(value);
}

export function createRedactor(principal: Pick<Principal, "kind">, exactSecrets: readonly string[] = []): Redactor {
  const counts: RedactionCounts = {};
  const scrub = principal.kind !== "owner";
  // Remember only outputs, never raw secret-bearing inputs. A sliced marker
  // is safe too, even though it no longer looks like a complete marker.
  // This set belongs to one serving call and cannot bless another call's input.
  const served = new Set<string>();
  return {
    counts,
    text(value, window) {
      let output = value;
      if (!served.has(value)) {
        const visible = sanitizeCapturedText(value);
        const scrubbed = scrubText(visible, exactSecrets, scrub);
        tallyRedactions(counts, scrubbed.redactions);
        output = neutralizeControlTags(scrubbed.text);
        served.add(output);
      }
      if (window !== undefined) {
        if (window.inline) output = output.replace(/\s+/g, " ").trim();
        output = Array.from(output).slice(window.offset, window.offset + window.span).join("");
        served.add(output);
      }
      return output;
    },
    format(value, render) {
      const output = neutralizeControlTags(sanitizeCapturedText(render(this.text(value))));
      served.add(output);
      return output;
    },
    join(values) {
      const ranges: { start: number; end: number }[] = [];
      let joined = "";
      for (const value of values) {
        const part = this.text(value);
        ranges.push({ start: joined.length, end: joined.length + part.length });
        joined += part;
      }
      const scrubbed = scrubText(joined, exactSecrets, scrub, ranges);
      tallyRedactions(counts, scrubbed.redactions);
      const output = neutralizeControlTags(scrubbed.text);
      served.add(output);
      return output;
    },
  };
}

/** The call's redactor when the gate set one, and a private one for a context built outside it. */
export function redactorOf(ctx: { principal: Pick<Principal, "kind">; redactor?: Redactor; servingSecrets?: readonly string[] }): Redactor {
  return ctx.redactor ?? createRedactor(ctx.principal, ctx.servingSecrets);
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
