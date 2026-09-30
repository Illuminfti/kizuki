import type { Claim } from "../contracts/proposal";
import { getClaim } from "../claims/store";
import { claimReadSql } from "../claims/read-scope";
import { tableExists } from "../ledger/schema";
import type { ServeContext } from "../serving/types";
import { authorizedClaimSql, authorizedSupportSql } from "./policy-sql";
import { eligibleWorldClaim } from "./projection";
import type { ReadBudget } from "./projection";

const SITUATION_PREDICATES = [
  "situation.label",
  "situation.objective",
  "situation.blocker",
  "situation.change",
  "situation.commitment",
] as const;
type SituationPredicate = (typeof SITUATION_PREDICATES)[number];

/** Readable statement rows per situation; unreadable rows spend no slots. */
const CLAIMS_PER_SITUATION = 24;

export interface SituationItem {
  /** The stored claim, already cleared by the caller's reader. */
  readonly claim: Claim;
  readonly predicate: SituationPredicate;
  readonly text: string;
  readonly mode: string;
  readonly polarity: "positive" | "negative";
}

export interface SituationState {
  readonly label: string | null;
  readonly objective: readonly SituationItem[];
  readonly blocker: readonly SituationItem[];
  readonly change: readonly SituationItem[];
  readonly commitments: readonly SituationItem[];
  /** Hedged, negated or competing statements. Never merged into the asserted fields. */
  readonly uncertain: readonly SituationItem[];
  readonly subject: string;
}

interface SubjectRow {
  raw_kind: string;
  raw_namespace: string;
  raw_id: string;
}

const isPredicate = (value: string): value is SituationPredicate =>
  (SITUATION_PREDICATES as readonly string[]).includes(value);

/**
 * Current Situations for one principal: a wire-free, write-free read of the
 * world model. Each claim must clear the same per-support policy as
 * `world_view` and the caller's `canRead`, so a denied or unproven claim is
 * absent rather than redacted. Newest situation first.
 */
export function readSituations(
  ctx: ServeContext,
  options: {
    limit: number;
    at: string;
    subjects?: readonly string[];
    canRead: (claim: Claim) => boolean;
  },
): SituationState[] {
  if (
    !tableExists(ctx.db, "claim_v2_semantics") ||
    !tableExists(ctx.db, "semantic_bindings")
  )
    return [];
  const permitted = authorizedSupportSql(ctx);
  const typed = authorizedClaimSql(ctx);
  const readable = claimReadSql(ctx.db, {
    grant: ctx.principal.grant,
    source: {
      owner: ctx.principal.kind === "owner",
      purpose: ctx.sourcePurpose ?? "session",
    },
  }, "base");
  const subjects = ctx.db
    .query<SubjectRow, (string | number)[]>(
      `SELECT b.raw_kind, b.raw_namespace, b.raw_id
         FROM semantic_bindings b
         JOIN claim_v2_semantics c ON c.subject_kind=b.raw_kind AND c.subject_id=b.raw_id
          AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=b.raw_namespace
         JOIN claims base ON base.claim_id=c.claim_id
        WHERE c.predicate='world.kind' AND base.status='live' AND c.polarity='positive'
          AND json_extract(c.payload,'$.object.ref.id')='world/situation'
          AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
          AND ${readable.sql}
          AND ${typed.sql}
        GROUP BY b.handle_id
        ORDER BY max(base.asserted_at) DESC, b.handle_id`,
    )
    .iterate(...permitted.bindings, ...readable.bindings, ...typed.bindings);

  const budget: ReadBudget = { bytes: 0 };
  const out: SituationState[] = [];
  for (const row of subjects) {
    if (out.length === options.limit) break;
    if (
      options.subjects !== undefined &&
      !options.subjects.includes(row.raw_id)
    )
      continue;
    const state = readOne(ctx, row, options, budget);
    if (state !== null) out.push(state);
  }
  return out;
}

function readOne(
  ctx: ServeContext,
  row: SubjectRow,
  options: { at: string; canRead: (claim: Claim) => boolean },
  budget: ReadBudget,
): SituationState | null {
  const permitted = authorizedSupportSql(ctx);
  const typed = authorizedClaimSql(ctx);
  const readable = claimReadSql(ctx.db, {
    grant: ctx.principal.grant,
    source: {
      owner: ctx.principal.kind === "owner",
      purpose: ctx.sourcePurpose ?? "session",
    },
  }, "base");
  const rows = ctx.db
    .query<{ claim_id: string }, (string | number)[]>(
      `SELECT c.claim_id FROM claim_v2_semantics c JOIN claims base USING(claim_id)
        WHERE c.subject_kind=? AND c.subject_id=? AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=?
          AND c.predicate IN ('world.kind', ${SITUATION_PREDICATES.map(() => "?").join(",")})
          AND base.status='live'
          AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
          AND ${readable.sql}
          AND ${typed.sql}
        ORDER BY (c.predicate='world.kind') DESC, base.asserted_at DESC, c.claim_id`,
    )
    .iterate(
      row.raw_kind,
      row.raw_id,
      row.raw_namespace,
      ...SITUATION_PREDICATES,
      ...permitted.bindings,
      ...readable.bindings,
      ...typed.bindings,
    );

  let classified = false;
  const items: SituationItem[] = [];
  let scanned = 0;
  for (const { claim_id } of rows) {
    const eligible = eligibleWorldClaim(ctx, claim_id, { kind: "all" }, budget);
    if (eligible === null) continue;
    const semantic = eligible.semantic;
    // A not-yet-started or ended situation statement is not "now".
    if (
      (semantic.valid_from !== null &&
        Date.parse(semantic.valid_from) > Date.parse(options.at)) ||
      (semantic.valid_to !== null &&
        Date.parse(semantic.valid_to) <= Date.parse(options.at))
    )
      continue;
    if (semantic.predicate === "world.kind") {
      classified ||=
        semantic.polarity === "positive" &&
        semantic.perspective.mode === "asserted" &&
        semantic.object.kind === "vocabulary" &&
        semantic.object.ref.id === "world/situation";
      continue;
    }
    if (!isPredicate(semantic.predicate) || semantic.object.kind !== "literal")
      continue;
    const claim = getClaim(ctx.db, claim_id);
    if (claim === null || !options.canRead(claim)) continue;
    items.push({
      claim,
      predicate: semantic.predicate,
      text: semantic.object.value,
      mode: semantic.perspective.mode,
      polarity: semantic.polarity,
    });
    if (++scanned === CLAIMS_PER_SITUATION) break;
  }
  if (!classified) return null;

  const asserted = (item: SituationItem) =>
    item.polarity === "positive" && item.mode === "asserted";
  const of = (predicate: SituationPredicate) =>
    items.filter((item) => item.predicate === predicate);
  // Several asserted objectives, blockers or changes disagree until proven otherwise:
  // none is chosen, all are reported as uncertain.
  const single = (predicate: SituationPredicate): SituationItem[] => {
    const found = of(predicate).filter(asserted);
    return found.length === 1 ? found : [];
  };
  const competing = (
    ["situation.objective", "situation.blocker", "situation.change"] as const
  ).flatMap((predicate) => {
    const found = of(predicate).filter(asserted);
    return found.length > 1 ? found : [];
  });
  const hedged = items.filter(
    (item) => item.predicate !== "situation.label" && !asserted(item),
  );
  const label = of("situation.label").find(asserted)?.text ?? null;
  return {
    label,
    subject: row.raw_id,
    objective: single("situation.objective"),
    blocker: single("situation.blocker"),
    change: single("situation.change"),
    commitments: of("situation.commitment").filter(asserted),
    uncertain: [...competing, ...hedged],
  };
}
