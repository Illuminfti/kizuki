import { authorize } from "../../agents";
import { compareRfc3339 } from "../../agents/time";
import { semanticKey, supportKey } from "../../claims/claim-v2-keys";
import { readClaimV2Semantic } from "../../claims/claim-v2-commit";
import { validateWorldEndpointProofs } from "../../claims/occurrences";
import { isRegisteredPredicate } from "../../claims/predicates";
import { getClaim } from "../../claims/store";
import type { ClaimMeaning, ClaimV2Assertion } from "../../contracts/claim-v2";
import { isUtf16TextBoundary } from "../../contracts/producer-v2";
import {
  completeWorldAnchors,
  parseWorldAdmission,
  type WorldAdmission,
} from "../../contracts/world-admission";
import { getWorldVocabularySpec } from "../../contracts/world-vocabulary";
import { readEvent } from "../../ledger/ledger";
import { eventDecision, readServableEvents } from "../../serving/ledger";
import type { ServeContext } from "../../serving/types";
import type { WorldValidQuery } from "../../serving/world-view";
import { canonicalJson } from "../../util/hash";
import { assertionEndpoints } from "../allocation";
import { authorizedSupportSql } from "../policy-sql";
import { heldUntilCorroborated } from "../corroboration";
import { handleFor } from "../relation";
import { charge, type ReadBudget } from "./frame";

const MAX_SUPPORTS = 32;

type Support = {
  support_origin: "source" | "native_owner";
  support_key: string;
  source_key: string;
  grant_revision: number;
  anchors: string;
  admission: string;
  admitted_at: string;
};
export type EligibleSupport = {
  row: Support;
  admission: WorldAdmission;
  events: readonly { event_id: string; event_content_hash: string }[];
};
export type Eligible = {
  claimId: string;
  semantic: ClaimV2Assertion;
  supports: EligibleSupport[];
  overflow: boolean;
};

function validFor(
  semantic: ClaimV2Assertion | ClaimMeaning,
  valid: WorldValidQuery,
): boolean {
  if (valid.kind === "all") return true;
  if (valid.kind === "unknown_only")
    return semantic.temporal_basis === "unknown";
  if (semantic.temporal_basis === "unknown" || semantic.valid_from === null)
    return false;
  const from = semantic.valid_from,
    until = semantic.valid_to;
  if (valid.kind === "at")
    return (
      compareRfc3339(from, "from", valid.at, "at") <= 0 &&
      (until === null || compareRfc3339(valid.at, "at", until, "until") < 0)
    );
  return (
    compareRfc3339(from, "from", valid.until, "until") < 0 &&
    (until === null || compareRfc3339(until, "until", valid.from, "from") > 0)
  );
}

/** Every candidate support proves its own complete rendering, events and endpoint memberships. */
export function eligibleWorldClaim(
  ctx: ServeContext,
  claimId: string,
  valid: WorldValidQuery,
  budget: ReadBudget,
  options: { historical?: true; supportKeys?: readonly string[] } = {},
): Eligible | null {
  const claim = getClaim(ctx.db, claimId);
  if (claim === null || (options.historical ? !["live", "superseded", "reverted"].includes(claim.status) : claim.status !== "live")) return null;
  if (ctx.db.query("SELECT 1 FROM claims WHERE claim_id=? AND is_world_typed=1").get(claimId) === null) return null;
  const semantic = readClaimV2Semantic(ctx.db, claimId);
  if (
    semantic === null ||
    semantic.discriminator !== "assertion" ||
    !validFor(semantic, valid)
  )
    return null;
  // Existing registry predicates retain their declared literal shape in v2.
  // An otherwise valid assertion token is not a supported domain predicate.
  if (getWorldVocabularySpec(semantic.predicate) === undefined &&
      !(isRegisteredPredicate(semantic.predicate) && semantic.object.kind === "literal")) return null;
  const endpoints = assertionEndpoints(semantic);
  if (
    ctx.principal.grant.subjects !== null &&
    !endpoints.every((ref) => ctx.principal.grant.subjects!.includes(ref.id))
  )
    return null;
  if (
    !authorize(
      { ...ctx.principal.grant, ceiling: "private" },
      {
        id: claimId,
        sensitivity: "public",
        type: claim.kind,
        subjects: endpoints.map((ref) => ref.id),
        occurred_at: claim.asserted_at,
      },
    ).allow
  )
    return null;
  const supports: EligibleSupport[] = [];
  let overflow = false;
  const permitted = authorizedSupportSql(ctx);
  for (const row of ctx.db
    .query<
      Support,
      (string | number)[]
    >(`SELECT s.* FROM claim_v2_support s WHERE claim_id=? AND ${permitted.sql}${options.supportKeys === undefined ? "" : " AND support_key IN (SELECT value FROM json_each(?))"} ORDER BY support_key LIMIT ?`)
    .all(claimId, ...permitted.bindings, ...(options.supportKeys === undefined ? [] : [JSON.stringify(options.supportKeys)]), MAX_SUPPORTS + 1)) {
    let parsed: unknown;
    charge(budget, row.admission);
    try {
      parsed = JSON.parse(row.admission);
    } catch {
      continue;
    }
    const admission = parseWorldAdmission(parsed);
    if (
      admission === null ||
      semanticKey(admission.semantic) !== semanticKey(semantic)
    )
      continue;
    try {
      validateWorldEndpointProofs(
        ctx.db,
        admission.semantic,
        row.support_origin === "native_owner" ? null : row.source_key,
        { restore: true },
      );
    } catch {
      continue;
    }
    const events = ctx.db
      .query<
        { event_id: string; event_content_hash: string },
        [string]
      >("SELECT event_id,event_content_hash FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id")
      .all(row.support_key);
    if (events.length === 0 || events.length > 64) continue;
    const facts = readServableEvents(
      ctx.db,
      events.map((e) => e.event_id),
    );
    if (
      !events.every((event) => {
        const fact = facts.get(event.event_id);
        const stored = ctx.db
          .query<
            {
              content_hash: string;
              source_key: string | null;
              native_valid: number;
            },
            [string]
          >(
            `SELECT e.content_hash,b.source_key,
        EXISTS(SELECT 1 FROM native_owner_evidence n WHERE n.event_id=e.event_id AND n.origin='correction'
          AND n.event_content_hash=e.content_hash
          AND e.origin_binding_kind='native' AND e.connector_id='kizuki.owner') AS native_valid
        FROM events e LEFT JOIN source_event_bindings b USING(event_id) WHERE e.event_id=?`,
          )
          .get(event.event_id);
        let eventIdentity;
        try {
          eventIdentity = readEvent(ctx.db, event.event_id);
        } catch {
          return false;
        }
        if (eventIdentity === null) return false;
        if (
          row.support_origin === "native_owner" &&
          ctx.principal.kind !== "owner" &&
          !ctx.principal.grant.relay_owner_corrections
        )
          return false;
        return (
          fact !== undefined &&
          stored?.content_hash === event.event_content_hash &&
          (row.support_origin === "native_owner"
            ? stored.source_key === null &&
              stored.native_valid === 1 &&
              row.source_key === "native-owner" &&
              row.grant_revision === 0
            : stored.source_key === row.source_key) &&
          eventDecision(ctx.principal.grant, fact, ctx).allow
        );
      })
    )
      continue;
    const anchors = completeWorldAnchors(admission.semantic);
    const allAnchors = anchors;
    if (
      anchors.length === 0 ||
      !allAnchors.every((anchor) => {
        if (!events.some((e) => e.event_id === anchor.event_id)) return false;
        const text = ctx.db
          .query<
            { text: string },
            [string]
          >("SELECT text FROM events WHERE event_id=?")
          .get(anchor.event_id)?.text;
        return (
          text !== undefined &&
          isUtf16TextBoundary(text, anchor.start_utf16) &&
          isUtf16TextBoundary(text, anchor.end_utf16)
        );
      })
    )
      continue;
    let storedAnchors: unknown;
    try {
      storedAnchors = JSON.parse(row.anchors);
    } catch {
      continue;
    }
    if (
      canonicalJson(storedAnchors) !== canonicalJson(anchors) ||
      supportKey({
        support_origin: row.support_origin,
        semantic_key: semanticKey(semantic),
        source_key: row.source_key,
        grant_revision: row.grant_revision,
        events,
        anchors,
      }) !== row.support_key
    )
      continue;
    if (
      !endpoints.every((ref) => {
        const handle = handleFor(ctx.db, ref);
        return (
          handle !== null &&
          ctx.db
            .query(
              "SELECT 1 FROM semantic_allocations WHERE handle_id=? AND support_key=?",
            )
            .get(handle, row.support_key) !== null
        );
      })
    )
      continue;
    if (supports.length === MAX_SUPPORTS) {
      overflow = true;
      break;
    }
    supports.push({ row, admission, events });
  }
  // History retains held claims; current reads need independent sources or owner support.
  if (!options.historical && supports.length > 0 &&
      heldUntilCorroborated(ctx.db, claimId, permitted)) return null;
  return supports.length === 0
    ? null
    : {
        claimId,
        semantic: supports[0]!.admission.semantic,
        supports,
        overflow,
      };
}
