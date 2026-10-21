import { timelineAuditCandidates } from "../query/timeline";
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
import { expandTimelineDetail, wantsTimelineExpansion } from "./expand";
import type { TimelineExpandData } from "./expand";
import {
  collectAuthorizedTimeline,
  eventDecision,
  readServableEvents,
} from "./ledger";
import type { ServeContext, ResponseContract, ResponseEnvelope } from "./types";
import { ENVELOPE_SCHEMA } from "./types";

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
  /** Expand one captured record by its evidence id. Not a list filter. */
  event_id?: string;
  /** Code-point offset into the served captured text. */
  offset?: number;
  /** Code points to return. Defaults to 512, capped at 2000. */
  span?: number;
  /** When set, a mismatch withholds the text and the current digest. */
  integrity?: string;
}

export type { TimelineExpandData } from "./expand";

export function serveTimeline<C extends ResponseContract = typeof ENVELOPE_SCHEMA>(
  ctx: ServeContext,
  args: TimelineArgs,
  contract: C = ENVELOPE_SCHEMA as C,
): ResponseEnvelope<TimelineExpandData | undefined, C> {
  return gate(ctx, "timeline", auditArguments(args), ({ ctx }): Served<TimelineExpandData | undefined> => {
    if (wantsTimelineExpansion(args)) return expandTimelineDetail(ctx, args);
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
    // membership; a scoped grant with neither argument is enforced in SQL.
    if (subject !== undefined) scopedSubjects(grant, [subject]);
    if (kind !== undefined) scopedTypes(grant, [kind]);

    const rows = limit("limit", args.limit, MAX_LIMIT, DEFAULT_LIMIT);
    const base: Omit<TimelineOptions, "ceiling"> = {
      ...(args.day === undefined ? {} : { day: day("day", args.day) }),
      ...window,
      ...(subject === undefined ? {} : { subject }),
      ...(args.connector_id === undefined
        ? {}
        : { connector_id: identifier("connector_id", args.connector_id) }),
      ...(kind === undefined ? {} : { kind }),
    };

    const { quoted, withheld, seen } = collectAuthorizedTimeline(ctx, base, rows);

    // Privileged denial enumeration belongs to the owner's audit read. A
    // scoped response must never materialize candidates outside its grant.
    const auditIds = ctx.principal.kind === "owner"
      ? timelineAuditCandidates(ctx.db, { ...base, limit: rows }) : [];
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
  }, contract);
}
