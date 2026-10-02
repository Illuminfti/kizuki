import { boundScrubText } from "../producer/scrub";
import { timingSafeEqual } from "node:crypto";
import { sha256 } from "../agents/hash";
import { identifier, range } from "./arguments";
import type { Served } from "./gate";
import { currentQuotedSource, eventDecision } from "./ledger";
import { redactorOf } from "./redact";
import { ServeError } from "./types";
import type { ServeContext } from "./types";

/** Code points of the served text, matching the timeline preview and canon excerpt cuts. */
export const EXPAND_OFFSET_MAX = 100_000;
export const EXPAND_SPAN_MAX = 2_000;
const DEFAULT_SPAN = 512;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface TimelineExpandData {
  /** SHA-256 of the bounded served projection; owner reads retain the raw capture digest. */
  integrity: string;
  /** SHA-256 of the returned window. */
  slice_integrity: string;
  offset: number;
  returned: number;
  total: number;
  truncated: boolean;
}

export interface ExpandTimelineArgs {
  event_id?: string;
  offset?: number;
  span?: number;
  integrity?: string;
  day?: string;
  since?: string;
  until?: string;
  subject?: string;
  connector_id?: string;
  kind?: string;
  limit?: number;
}

const LIST_KEYS = [
  "day",
  "since",
  "until",
  "subject",
  "connector_id",
  "kind",
  "limit",
] as const;

export function wantsTimelineExpansion(args: ExpandTimelineArgs): boolean {
  return (
    args.event_id !== undefined ||
    args.offset !== undefined ||
    args.span !== undefined ||
    args.integrity !== undefined
  );
}

function digestOf(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new ServeError(
      "invalid_arguments",
      `invalid arguments: ${field}: must be a sha256 hex digest`,
    );
  }
  return value;
}

function sameDigest(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Recover one omitted span from a live evidence reference. This is not a
 * file reader: the id is a ledger key, and a miss, a pin mismatch, and a
 * denial all withhold the captured text.
 */
export function expandTimelineDetail(
  ctx: ServeContext,
  args: ExpandTimelineArgs,
): Served<TimelineExpandData | undefined> {
  for (const key of LIST_KEYS) {
    if (args[key] !== undefined) {
      throw new ServeError(
        "invalid_arguments",
        "invalid arguments: event_id: cannot be combined with a timeline list filter",
      );
    }
  }
  if (args.event_id === undefined) {
    throw new ServeError(
      "invalid_arguments",
      "invalid arguments: event_id: required to expand one record",
    );
  }
  const eventId = identifier("event_id", args.event_id);
  const offset = range("offset", args.offset, 0, EXPAND_OFFSET_MAX, 0);
  const span = range("span", args.span, 1, EXPAND_SPAN_MAX, DEFAULT_SPAN);
  const pinned = digestOf("integrity", args.integrity);

  const source = currentQuotedSource(ctx.db, eventId);
  if (source === null) return { canon: [], quoted: [], withheld: [] };
  const decision = eventDecision(ctx.principal.grant, source, ctx);
  if (!decision.allow) {
    return {
      canon: [],
      quoted: [],
      withheld: [{ id: eventId, reason: decision.reason }],
    };
  }

  const bounded = boundScrubText(source.text, 128 * 1024);
  const redactor = redactorOf(ctx);
  const served = redactor.text(bounded.text);
  const integrity = sha256(ctx.principal.kind === "owner" ? source.text : served);
  if (pinned !== undefined && !sameDigest(pinned, integrity)) {
    return { canon: [], quoted: [], withheld: [] };
  }

  // Offsets and totals describe the bounded served projection.
  const points = Array.from(served);
  const start = Math.min(offset, points.length);
  const slice = redactor.text(served, { offset: start, span });
  const returned = Array.from(slice).length;
  return {
    canon: [],
    quoted: [
      {
        event_id: source.event_id,
        connector_id: source.connector_id,
        kind: source.kind,
        occurred_at: source.occurred_at,
        sensitivity: decision.sensitivity,
        subjects: source.subjects,
        text: slice,
        tainted: true,
      },
    ],
    withheld: [],
    data: {
      integrity,
      slice_integrity: sha256(slice),
      offset: start,
      returned,
      total: points.length,
      truncated: bounded.truncated || start + returned < points.length,
    },
  };
}
