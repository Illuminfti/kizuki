import { groundingDigest, validateWorldAdmissionProofs, witnessEventIds, type GroundingReadCache } from "../../claims/world-grounding";
import { authorize, OWNER } from "../../agents";
import type { Database } from "bun:sqlite";
import { compareRfc3339 } from "../../agents/time";
import { semanticKey, supportKey } from "../../claims/claim-v2-keys";
import { readClaimV2Semantic } from "../../claims/claim-v2-commit";
import { isRegisteredPredicate } from "../../claims/predicates";
import { rawSubjectNamespace, type ClaimMeaning, type ClaimV2Assertion } from "../../contracts/claim-v2";
import type { ClaimKind } from "../../contracts/proposal";
import { isUtf16TextBoundary } from "../../contracts/producer-v2";
import {
  completeWorldAnchors,
  parseWorldAdmission,
  type WorldAdmission,
} from "../../contracts/world-admission";
import { getWorldVocabularySpec } from "../../contracts/world-vocabulary";
import { qualifiedPersonInterest } from "../../contracts/world-vocab/person";
import { readEvent } from "../../ledger/ledger";
import { tableExists } from "../../ledger/schema";
import { inspectSourceGrant, type SourceGrant, type SourceGrantLookup } from "../../ledger/source-grants";
import { eventDecision, readServableEvents } from "../../serving/ledger";
import type { ServeContext } from "../../serving/types";
import type { WorldValidQuery } from "../../serving/world-view";
import { canonicalJson } from "../../util/hash";
import { assertionEndpoints } from "../allocation";
import { AUTHORITY_CLAIM_MIN_ROOTS, hasAuthorityTerm, heldUntilCorroborated, IDENTITY_PREDICATES } from "../corroboration";
import { knownState, knownSupportSql, type KnownCutoff } from "../known/cutoff";
import { charge, chargeBytes, WORLD_CLAIM_VERIFICATION_LIMIT, WorldClaimBudgetError, WorldProjectionBudgetError, type ReadBudget } from "./frame";

const MAX_SUPPORTS = 32;
const OWNER_CACHE_MAX = 512;
type SqlPredicate = { sql: string; bindings: (string | number)[] };
type ReadReuse = {
  readonly grantOf: SourceGrantLookup;
  readonly supportSql: Map<string, SqlPredicate>;
};
const groundingReads = new WeakMap<ReadBudget, GroundingReadCache>();
const txReadReuse = new WeakMap<ReadBudget, WeakMap<Database, ReadReuse>>();
type OwnerCacheEntry = { readonly item: Eligible | null; readonly bytes: number };
type OwnerSnapshotCache = {
  version: number;
  changes: number;
  deriveMatchesRecall: boolean;
  entries: Map<string, OwnerCacheEntry>;
  reuse: ReadReuse;
};
const ownerEligibleCaches = new WeakMap<Database, OwnerSnapshotCache>();

function activeGrantsMatchDeriveRecall(db: Database): boolean {
  if (!tableExists(db, "source_grants")) return true;
  return (
    db
      .query<{ diff: number }, []>(
        `SELECT EXISTS (
           SELECT 1 FROM source_grants
           WHERE status = 'active'
             AND (NOT json_valid(policy)
               OR EXISTS (SELECT 1 FROM json_each(json_extract(policy, '$.purposes')) WHERE value = 'derive')
               <> EXISTS (SELECT 1 FROM json_each(json_extract(policy, '$.purposes')) WHERE value = 'recall'))
         ) AS diff`,
      )
      .get()!.diff === 0
  );
}

function createReadReuse(db: Database): ReadReuse {
  const grants = new Map<string, SourceGrant | null>();
  return {
    grantOf: (sourceKey) => {
      if (grants.has(sourceKey)) return grants.get(sourceKey)!;
      const grant = inspectSourceGrant(db, sourceKey);
      grants.set(sourceKey, grant);
      return grant;
    },
    supportSql: new Map(),
  };
}

/** A new projection proves a new snapshot while retaining the request allowance. */
export function beginWorldClaimProjection(budget: ReadBudget): void {
  budget.claimVerifications ??= 0;
  budget.verifiedClaims = new WeakMap();
  groundingReads.delete(budget);
  txReadReuse.delete(budget);
}

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

type EligibilityOptions = { historical?: true; supportKeys?: readonly string[]; cutoff?: KnownCutoff; includeInactive?: true };

/** Receipt integrity only. Never export through the projection/serving facade. */
export function retainedWorldClaimForReceipt(
  db: Database, claimId: string, budget: ReadBudget, supportKeys: readonly string[],
): Eligible | null {
  if (supportKeys.length === 0 || supportKeys.length > MAX_SUPPORTS) return null;
  return readEligibleWorldClaim({ db, vaultPath: "", principal: OWNER, sourcePurpose: "derive" },
    claimId, { kind: "all" }, budget, { historical: true, supportKeys }, "receipt_custody");
}

/** Every candidate support proves its own complete rendering, events and endpoint memberships. */
export function eligibleWorldClaim(
  ctx: ServeContext,
  claimId: string,
  valid: WorldValidQuery,
  budget: ReadBudget,
  options: EligibilityOptions = {},
): Eligible | null {
  // A composed child can reuse proof only inside the same database transaction,
  // with identical authority, filters and time. The caller records its own
  // dependency closure even when proof is reused.
  const caches = ctx.db.inTransaction ? budget.verifiedClaims : undefined;
  let cache = caches?.get(ctx.db);
  if (caches !== undefined && cache === undefined) {
    cache = new Map(); caches.set(ctx.db, cache);
  }
  const key = cache === undefined ? "" : canonicalJson([claimId, ctx.principal,
    ctx.sourcePurpose ?? "recall", ctx.selection ?? null, valid, options]);
  if (cache?.has(key)) return cache.get(key)!;
  if (budget.claimVerifications !== undefined) {
    if (budget.claimVerifications >= WORLD_CLAIM_VERIFICATION_LIMIT) throw new WorldClaimBudgetError();
    budget.claimVerifications += 1;
  }
  // Owner-only snapshot cache for repeated non-transactional canon evidence checks
  // (e.g. visibleIndexDegraded). Invalidated on any local or external SQLite write.
  if (
    cache === undefined &&
    ctx.principal.kind === "owner" &&
    budget.claimVerifications === undefined &&
    options.cutoff === undefined &&
    ctx.selection === undefined
  ) {
    const snap = ctx.db
      .query<{ changes: number; version: number }, []>(
        "SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version",
      )
      .get()!;
    let ownerCache = ownerEligibleCaches.get(ctx.db);
    if (ownerCache === undefined || ownerCache.version !== snap.version || ownerCache.changes !== snap.changes) {
      ownerCache = {
        version: snap.version,
        changes: snap.changes,
        deriveMatchesRecall: activeGrantsMatchDeriveRecall(ctx.db),
        entries: new Map(),
        reuse: createReadReuse(ctx.db),
      };
      ownerEligibleCaches.set(ctx.db, ownerCache);
    }
    const rawPurpose = ctx.sourcePurpose ?? "recall";
    const cachePurpose = ownerCache.deriveMatchesRecall && rawPurpose === "derive" ? "recall" : rawPurpose;
    const ownerKey = canonicalJson([claimId, ctx.principal.grant, cachePurpose, valid, options]);
    const hit = ownerCache.entries.get(ownerKey);
    if (hit !== undefined) {
      chargeBytes(budget, hit.bytes);
      return hit.item;
    }
    const bytesBefore = budget.bytes;
    const item = readEligibleWorldClaim(ctx, claimId, valid, budget, options, undefined, ownerCache.reuse);
    if (ownerCache.entries.size >= OWNER_CACHE_MAX) {
      ownerCache.entries.delete(ownerCache.entries.keys().next().value!);
    }
    ownerCache.entries.set(ownerKey, { item, bytes: budget.bytes - bytesBefore });
    return item;
  }
  let reuse: ReadReuse | undefined;
  if (cache !== undefined) {
    let byDb = txReadReuse.get(budget);
    if (byDb === undefined) {
      byDb = new WeakMap();
      txReadReuse.set(budget, byDb);
    }
    reuse = byDb.get(ctx.db);
    if (reuse === undefined) {
      reuse = createReadReuse(ctx.db);
      byDb.set(ctx.db, reuse);
    }
  }
  const item = readEligibleWorldClaim(ctx, claimId, valid, budget, options, undefined, reuse);
  // An exhausted budget never becomes a cached proof or a false absence.
  cache?.set(key, item);
  return item;
}

function cachedKnownSupportSql(ctx: ServeContext, cutoff: KnownCutoff | undefined, reuse: ReadReuse | undefined): SqlPredicate {
  if (reuse === undefined) return knownSupportSql(ctx, cutoff);
  const key = canonicalJson([ctx.principal, ctx.sourcePurpose ?? "recall", ctx.selection ?? null, cutoff ?? null]);
  let cached = reuse.supportSql.get(key);
  if (cached === undefined) {
    cached = knownSupportSql(ctx, cutoff);
    reuse.supportSql.set(key, cached);
  }
  return cached;
}

function readEligibleWorldClaim(
  ctx: ServeContext,
  claimId: string,
  valid: WorldValidQuery,
  budget: ReadBudget,
  options: EligibilityOptions,
  proof?: "receipt_custody",
  reuse?: ReadReuse,
): Eligible | null {
  const claim = ctx.db
    .query<{ status: string; kind: ClaimKind; asserted_at: string; is_world_typed: number }, [string]>(
      "SELECT status, kind, asserted_at, is_world_typed FROM claims WHERE claim_id=?",
    )
    .get(claimId);
  if (
    claim === null ||
    claim.is_world_typed !== 1 ||
    (options.cutoff !== undefined
      ? claim.status === "purged"
      : options.historical
        ? !["live", "superseded", "reverted"].includes(claim.status)
        : claim.status !== "live")
  )
    return null;
  const semantic = readClaimV2Semantic(ctx.db, claimId);
  const state = options.cutoff === undefined ? null : knownState(ctx.db, claimId, options.cutoff);
  if (options.cutoff !== undefined && (state === null || (!options.includeInactive && state.after_status !== "live"))) return null;
  if (
    semantic === null ||
    semantic.discriminator !== "assertion" ||
    !validFor(state === null ? semantic : { ...semantic, valid_to: state.valid_to }, valid)
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
  const targetSemanticKey = semanticKey(semantic);
  const isAuthoritySemantic =
    (IDENTITY_PREDICATES as readonly string[]).includes(semantic.predicate) ||
    (semantic.predicate.startsWith("decision.") &&
      semantic.object.kind === "literal" &&
      hasAuthorityTerm(semantic.object.value));
  let rawHasNative = false;
  let rawHasBodyTerm = false;
  const rawSourceKeys = new Set<string>();
  // Custody selects only the receipt's exact bounded keys. The full admission,
  // immutable event identity and CURRENT source policy are still proved below.
  const permitted = proof === "receipt_custody" ? { sql: "length(s.admission)<=524288", bindings: [] } : cachedKnownSupportSql(ctx, options.cutoff, reuse);
  const grantOf = reuse?.grantOf ?? createReadReuse(ctx.db).grantOf;
  const supportRows = ctx.db
    .query<
      Support,
      (string | number)[]
    >(`SELECT s.* FROM claim_v2_support s WHERE claim_id=? AND ${permitted.sql}${options.supportKeys === undefined ? "" : " AND support_key IN (SELECT value FROM json_each(?))"} ORDER BY support_key LIMIT ${MAX_SUPPORTS + 1}`)
    .all(claimId, ...permitted.bindings, ...(options.supportKeys === undefined ? [] : [JSON.stringify(options.supportKeys)]));
  for (const row of supportRows) {
    if (row.support_origin === "native_owner") rawHasNative = true;
    rawSourceKeys.add(row.source_key);
    let parsed: unknown;
    charge(budget, row.admission);
    try {
      parsed = JSON.parse(row.admission);
    } catch {
      continue;
    }
    if (!rawHasBodyTerm && parsed !== null && typeof parsed === "object" && "rendering" in parsed) {
      const rendering = (parsed as { rendering?: { body?: unknown } }).rendering;
      if (typeof rendering?.body === "string" && hasAuthorityTerm(rendering.body)) rawHasBodyTerm = true;
    }
    const admission = parseWorldAdmission(parsed);
    if (
      admission === null ||
      semanticKey(admission.semantic) !== targetSemanticKey
    )
      continue;
    // Registration must not turn an older, unqualified admission into a fact
    // about a person. Native owner evidence is verified by the normal path below.
    if (semantic.predicate === "person.interest" && !qualifiedPersonInterest(admission.semantic, row.support_origin === "native_owner")) continue;
    let cache = groundingReads.get(budget);
    if (cache === undefined) { cache = new Map(); groundingReads.set(budget, cache); }
    let grounding: readonly { event_id: string; event_content_hash: string }[];
    try {
      grounding = validateWorldAdmissionProofs(
        ctx.db,
        admission,
        row.support_origin === "native_owner" ? null : row.source_key,
        { restore: true, charge: value => charge(budget, value), cache },
      );
    } catch (error) {
      if (error instanceof WorldProjectionBudgetError) throw error;
      continue;
    }
    const events = ctx.db
      .query<
        { event_id: string; event_content_hash: string },
        [string]
      >("SELECT event_id,event_content_hash FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id")
      .all(row.support_key);
    if (events.length === 0 || events.length > 64) continue;
    if (admission.schema === "kizuki.world-admission/v2") {
      const expected = new Set([...witnessEventIds(admission), ...grounding.map(e => e.event_id)]);
      if (row.support_origin !== "source" || expected.size !== events.length || events.some(e => !expected.has(e.event_id))) continue;
    }
    const facts = proof === "receipt_custody" ? undefined : readServableEvents(
      ctx.db,
      events.map((e) => e.event_id),
    );
    const eventTexts = new Map<string, string>();
    if (
      !events.every((event) => {
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
        if (eventIdentity === null || eventIdentity.deleted) return false;
        eventTexts.set(event.event_id, eventIdentity.text);
        const fact = facts?.get(event.event_id) ?? (proof === "receipt_custody" ? {
          event_id: eventIdentity.event_id, kind: eventIdentity.kind,
          occurred_at: eventIdentity.occurred_at,
          sensitivity: eventIdentity.sensitivity_hint ?? "unlabeled",
          subjects: eventIdentity.subjects.map(subject => subject.subject_id),
        } : undefined);
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
            : stored.source_key === row.source_key || grounding.some(e => e.event_id === event.event_id && e.event_content_hash === event.event_content_hash)) &&
          eventDecision(ctx.principal.grant, fact, ctx, grantOf).allow
        );
      })
    )
      continue;
    const anchors = completeWorldAnchors(admission.semantic);
    if (
      anchors.length === 0 ||
      !anchors.every((anchor) => {
        const text = eventTexts.get(anchor.event_id);
        return (
          text !== undefined &&
          isUtf16TextBoundary(text, anchor.start_utf16) &&
          isUtf16TextBoundary(text, anchor.end_utf16)
        );
      })
    )
      continue;
    const anchorsCanonical = canonicalJson(anchors);
    if (row.anchors !== anchorsCanonical) {
      let storedAnchors: unknown;
      try {
        storedAnchors = JSON.parse(row.anchors);
      } catch {
        continue;
      }
      if (canonicalJson(storedAnchors) !== anchorsCanonical) continue;
    }
    if (
      supportKey({
        support_origin: row.support_origin,
        grounding_digest: groundingDigest(admission),
        semantic_key: targetSemanticKey,
        source_key: row.source_key,
        grant_revision: row.grant_revision,
        events,
        anchors,
      }) !== row.support_key
    )
      continue;
    if (
      !endpoints.every(
        (ref) =>
          ctx.db
            .query(
              "SELECT 1 FROM semantic_bindings b JOIN semantic_allocations a USING(handle_id) WHERE b.raw_kind=? AND b.raw_namespace=? AND b.raw_id=? AND a.support_key=?",
            )
            .get(ref.kind, rawSubjectNamespace(ref), ref.id, row.support_key) !== null,
      )
    )
      continue;
    if (supports.length === MAX_SUPPORTS) {
      overflow = true;
      break;
    }
    supports.push({ row, admission, events });
  }
  // Current reads hold model authority claims until their permitted support
  // corroborates them. Historical validation still verifies the recorded basis.
  if (!options.historical && supports.length > 0) {
    if (options.supportKeys === undefined && options.cutoff === undefined && supportRows.length <= MAX_SUPPORTS) {
      if (!rawHasNative && rawSourceKeys.size < AUTHORITY_CLAIM_MIN_ROOTS && (rawHasBodyTerm || isAuthoritySemantic)) return null;
    } else if (options.cutoff !== undefined) {
      if (heldUntilCorroborated(ctx.db, claimId, permitted) || heldUntilCorroborated(ctx.db, claimId, cachedKnownSupportSql(ctx, undefined, reuse))) return null;
    } else if (!rawHasNative && rawSourceKeys.size < AUTHORITY_CLAIM_MIN_ROOTS && heldUntilCorroborated(ctx.db, claimId, permitted)) {
      return null;
    }
  }
  return supports.length === 0
    ? null
    : {
        claimId,
        semantic: state === null ? supports[0]!.admission.semantic : { ...supports[0]!.admission.semantic, valid_to: state.valid_to },
        supports,
        overflow,
      };
}
