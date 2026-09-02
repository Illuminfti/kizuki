import type { AuditDenial } from "../agents";
import { timeline } from "../query/timeline";
import type { TimelineEntry, TimelineOptions } from "../query/timeline";
import {
  day,
  identifier,
  limit,
  rfc3339,
  scopedSubjects,
  scopedTypes,
  scopedWindow,
} from "./arguments";
import { auditArguments, gate } from "./gate";
import type { Served } from "./gate";
import {
  eventDecision,
  liveEventIds,
  quotedChunk,
  timelineSource,
} from "./ledger";
import type { Envelope, QuotedChunk, ServeContext } from "./types";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export interface TimelineArgs {
  day?: string;
  since?: string;
  until?: string;
  subject?: string;
  connector_id?: string;
  kind?: string;
  limit?: number;
}

export function serveTimeline(ctx: ServeContext, args: TimelineArgs): Envelope {
  return gate(ctx, "timeline", auditArguments(args), (): Served<undefined> => {
    const grant = ctx.principal.grant;
    const window = scopedWindow(
      grant,
      args.since === undefined ? undefined : rfc3339("since", args.since),
      args.until === undefined ? undefined : rfc3339("until", args.until),
    );
    const subject =
      args.subject === undefined
        ? undefined
        : identifier("subject", args.subject);
    const kind =
      args.kind === undefined ? undefined : identifier("kind", args.kind);
    // `timeline` takes a single subject and kind, so these calls only check
    // membership; a scoped grant with neither argument is enforced per entry.
    if (subject !== undefined) scopedSubjects(grant, [subject]);
    if (kind !== undefined) scopedTypes(grant, [kind]);

    const rows = limit("limit", args.limit, MAX_LIMIT, DEFAULT_LIMIT);
    const base: TimelineOptions = {
      limit: rows,
      ...(args.day === undefined ? {} : { day: day("day", args.day) }),
      ...window,
      ...(subject === undefined ? {} : { subject }),
      ...(args.connector_id === undefined
        ? {}
        : { connector_id: identifier("connector_id", args.connector_id) }),
      ...(kind === undefined ? {} : { kind }),
    };

    const quoted: QuotedChunk[] = [];
    const withheld: AuditDenial[] = [];
    const seen = new Set<string>();

    const collect = (entries: TimelineEntry[], keep: boolean): void => {
      const live = liveEventIds(
        ctx.db,
        entries.map((entry) => entry.event_id),
      );
      for (const entry of entries) {
        if (seen.has(entry.event_id)) continue;
        seen.add(entry.event_id);
        // A tombstoned record still has a live-looking row; it is dropped,
        // not counted, so fewer than `limit` entries may come back.
        if (!live.has(entry.event_id)) continue;
        const source = timelineSource(entry);
        const decision = eventDecision(grant, source);
        if (!decision.allow) {
          withheld.push({ id: entry.event_id, reason: decision.reason });
          continue;
        }
        if (keep) quoted.push(quotedChunk(source, decision.sensitivity));
      }
    };

    collect(timeline(ctx.db, { ...base, ceiling: grant.ceiling }), true);
    collect(timeline(ctx.db, base), false);

    return { canon: [], quoted, withheld };
  });
}
