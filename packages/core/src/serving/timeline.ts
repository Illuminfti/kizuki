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
import { HISTORY_MAX_BUDGET, HISTORY_MIN_BUDGET, historyTree } from "./history";
import type { HistoryTreeData } from "./history";
import { sourcePolicyEpoch } from "../ledger/source-grants";
import { purgeReadEpoch } from "../derived-holds";
import { sha256Hex } from "../util/hash";
import {
  collectAuthorizedTimeline,
  eventDecision,
  readServableEvents,
} from "./ledger";
import type { Envelope, ServeContext } from "./types";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const TIMELINE_KEYS = new Set([
  "day", "since", "until", "subject", "connector_id", "kind", "limit",
  "event_id", "offset", "span", "integrity", "view", "budget_bytes", "snapshot", "node",
]);

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
  /** Optional extractive, rebuildable view over currently authorized events. */
  view?: "tree";
  /** UTF-8 byte ceiling for the extractive tree view. */
  budget_bytes?: number;
  /** Opaque snapshot returned by a previous tree response. */
  snapshot?: string;
  /** Tree node returned by a previous tree response. */
  node?: string;
}

export type TimelineHistoryArgs = TimelineArgs & { view: "tree" };
export type TimelineListArgs = Omit<TimelineArgs, "view" | "budget_bytes" | "snapshot" | "node"> & {
  view?: undefined;
  budget_bytes?: undefined;
  snapshot?: undefined;
  node?: undefined;
};

export type { TimelineExpandData } from "./expand";

export function serveTimeline(
  ctx: ServeContext,
  args: TimelineHistoryArgs,
): Envelope<HistoryTreeData>;
export function serveTimeline(
  ctx: ServeContext,
  args: TimelineListArgs,
): Envelope<TimelineExpandData | undefined>;
export function serveTimeline(
  ctx: ServeContext,
  args: TimelineArgs,
): Envelope<TimelineExpandData | HistoryTreeData | undefined>;
export function serveTimeline(
  ctx: ServeContext,
  args: TimelineArgs,
): Envelope<TimelineExpandData | HistoryTreeData | undefined> {
  return gate(ctx, "timeline", auditArguments(args), ({ ctx }): Served<TimelineExpandData | HistoryTreeData | undefined> => {
    const historyRequested = args.view !== undefined || args.budget_bytes !== undefined || args.snapshot !== undefined || args.node !== undefined;
    if (historyRequested && Object.keys(args).some((key) => !TIMELINE_KEYS.has(key))) {
      throw new RangeError("timeline history arguments are invalid");
    }
    if (historyRequested && wantsTimelineExpansion(args)) {
      throw new RangeError("timeline history view cannot be combined with event expansion");
    }
    if (wantsTimelineExpansion(args)) return expandTimelineDetail(ctx, args);
    if (historyRequested && args.view !== "tree") {
      throw new RangeError("timeline history view must be tree");
    }
    if (historyRequested && (args.limit !== undefined || args.integrity !== undefined)) {
      throw new RangeError("timeline history view cannot be combined with list or expansion arguments");
    }
    if ((args.snapshot === undefined) !== (args.node === undefined)) {
      throw new RangeError("timeline history zoom requires snapshot and node");
    }
    for (const [field, value] of [["snapshot", args.snapshot], ["node", args.node]] as const) {
      if (value !== undefined && (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))) {
        throw new RangeError(`timeline history ${field} is invalid`);
      }
    }
    const historyBudget = historyRequested
      ? args.budget_bytes === undefined
        ? 1_024
        : limit("budget_bytes", args.budget_bytes, HISTORY_MAX_BUDGET, 1_024)
      : undefined;
    if (historyBudget !== undefined && historyBudget < HISTORY_MIN_BUDGET) {
      throw new RangeError("timeline history budget is too small");
    }
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

    const rows = historyRequested ? MAX_LIMIT : limit("limit", args.limit, MAX_LIMIT, DEFAULT_LIMIT);
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

    // Source and ceiling filters intentionally run in SQL before a public
    // projection. Audit the same bounded identity-only candidate set without
    // putting denied metadata on a tree response.
    const auditIds = timelineAuditCandidates(ctx.db, { ...base, limit: rows });
    const auditFacts = readServableEvents(ctx.db, auditIds);
    for (const id of auditIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const facts = auditFacts.get(id);
      if (facts === undefined) continue;
      const decision = eventDecision(grant, facts, ctx);
      if (!decision.allow) withheld.push({ id, reason: decision.reason });
    }

    if (historyRequested) {
      // A tree never reports denied rows or their counts. The tree is rebuilt
      // solely from currently servable sources, so it cannot become a cache
      // or metadata oracle for a revoked/purged source.
      return {
        canon: [],
        quoted: [],
        withheld: [],
        audit_denials: withheld,
        audit_served: quoted.map((chunk) => ({
          id: chunk.event_id,
          sensitivity: chunk.sensitivity,
          taint: "quoted",
          authority: null,
          provenance_count: 1,
        })),
        data: historyTree(
          ctx.principal,
          quoted,
          historyBudget!,
          args.snapshot === undefined ? undefined : { snapshot: args.snapshot, node: args.node! },
          // The handle is never authority. Recompute it from current scope,
          // source policy and purge state before every zoom.
          sha256Hex(JSON.stringify({
            base,
            source_purpose: ctx.sourcePurpose ?? "recall",
            source_policy_epoch: sourcePolicyEpoch(ctx.db),
            purge_read_epoch: purgeReadEpoch(ctx.db),
            vault: ctx.vaultPath,
          })),
        ),
      };
    }

    return { canon: [], quoted, withheld };
  });
}
