import type { AuditDenial } from "../agents";
import { timeline, timelineAuditCandidates } from "../query/timeline";
import type { TimelineOptions } from "../query/timeline";
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
  readServableEvents,
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
  return gate(ctx, "timeline", auditArguments(args), ({ ctx }): Served<undefined> => {
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
    const base: Omit<TimelineOptions, "ceiling"> = {
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

    const entries = timeline(ctx.db, { ...base, ceiling: grant.ceiling });
    const live = liveEventIds(ctx.db, entries.map(entry => entry.event_id));
    for (const entry of entries) {
      seen.add(entry.event_id);
      // A tombstoned record is dropped, not counted as a denial.
      if (!live.has(entry.event_id)) continue;
      const source = timelineSource(entry);
      const decision = eventDecision(grant, source, ctx);
      if (!decision.allow) withheld.push({ id: entry.event_id, reason: decision.reason });
      else quoted.push(quotedChunk(source, decision.sensitivity));
    }

    const auditIds = timelineAuditCandidates(ctx.db, base);
    const auditFacts = readServableEvents(ctx.db, auditIds);
    for (const id of auditIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const facts = auditFacts.get(id);
      if (facts === undefined) continue;
      const decision = eventDecision(grant, facts, ctx);
      if (!decision.allow) withheld.push({ id, reason: decision.reason });
    }

    return { canon: [], quoted, withheld };
  });
}
