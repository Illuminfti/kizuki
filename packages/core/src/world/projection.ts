import { validateWorldEndpointProofs } from "../claims/occurrences";
import { isUtf16TextBoundary } from "../contracts/producer-v2";
import { authorizedSupportSql, validMeaningSql } from "./policy-sql";
import type { Database } from "bun:sqlite";
import { authorize } from "../agents";
import { compareRfc3339 } from "../agents/time";
import { readEvent } from "../ledger/ledger";
import { getClaim } from "../claims/store";
import { semanticKey, supportKey } from "../claims/claim-v2-keys";
import { readClaimV2Semantic } from "../claims/claim-v2-commit";
import {
  rawSubjectNamespace,
  rawSubjectRefKey,
  type ClaimV2Assertion,
  type ClaimMeaning,
  type RawSubjectRef,
} from "../contracts/claim-v2";
import {
  parseWorldAdmission,
  completeWorldAnchors,
  type WorldAdmission,
} from "../contracts/world-admission";
import {
  type ConceptCard,
  type Relation,
  type ConceptCoverage,
  validateConceptCard,
} from "../contracts/concept-card";
import {
  type SituationCard,
  validateSituationCard,
} from "../contracts/situation-card";
import { getWorldVocabularySpec } from "../contracts/world-vocabulary";
import { isRegisteredPredicate } from "../claims/predicates";
import { eventDecision, readServableEvents } from "../serving/ledger";
import type { ServeContext } from "../serving/types";
import type { WorldValidQuery } from "../serving/world-view";
import { canonicalJson } from "../util/hash";
import { assertionEndpoints } from "./allocation";
import { issueWorldRef, type WorldNamespace, type WireRef } from "./references";

export class WorldProjectionBudgetError extends Error {}
export type ReadBudget = { bytes: number };
function charge(budget: ReadBudget, value: string): void {
  budget.bytes += Buffer.byteLength(value, "utf8");
  if (budget.bytes > 2 * 1024 * 1024) throw new WorldProjectionBudgetError();
}
function checkCardBudget(card: ConceptCard | SituationCard): void {
  if (Buffer.byteLength(JSON.stringify(card), "utf8") > 256 * 1024)
    throw new WorldProjectionBudgetError();
}
const MAX_RELATIONS = 128;
const MAX_SUPPORTS = 32;
export const MAX_WORLD_MATCHES = 32;
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

function rawKey(ref: RawSubjectRef): string {
  return rawSubjectRefKey(ref);
}
function handleFor(db: Database, ref: RawSubjectRef): string | null {
  return (
    db
      .query<
        { handle_id: string },
        [string, string, string]
      >("SELECT handle_id FROM semantic_bindings WHERE raw_kind=? AND raw_namespace=? AND raw_id=?")
      .get(ref.kind, rawSubjectNamespace(ref), ref.id)?.handle_id ?? null
  );
}
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
  return supports.length === 0
    ? null
    : {
        claimId,
        semantic: supports[0]!.admission.semantic,
        supports,
        overflow,
      };
}

function objectRef(
  db: Database,
  ns: WorldNamespace,
  ref: RawSubjectRef,
): WireRef<"object"> {
  const handle = handleFor(db, ref);
  if (handle === null) throw new Error("world endpoint support changed");
  return issueWorldRef(db, ns, "object", handle);
}
function relation(
  ctx: ServeContext,
  ns: WorldNamespace,
  item: Eligible,
): Relation {
  const semantic = item.semantic;
  if (
    item.supports.reduce(
      (count, support) =>
        count + support.admission.semantic.perspective.anchors.length,
      0,
    ) > 256
  )
    throw new WorldProjectionBudgetError();
  const evidence = (
    support: EligibleSupport,
    anchors = support.admission.semantic.anchors,
  ) =>
    anchors.map((anchor) => ({
      admission: issueWorldRef(
        ctx.db,
        ns,
        "admission",
        support.row.support_key,
      ),
      eventVersion: issueWorldRef(ctx.db, ns, "event_version", anchor.event_id),
      span: {
        kind: "text" as const,
        startUtf16: anchor.start_utf16,
        endUtf16: anchor.end_utf16,
      },
    }));
  const ref = (value: RawSubjectRef | null) =>
    value === null ? null : objectRef(ctx.db, ns, value);
  return {
    schema: "kizuki.relation/v1",
    claim: issueWorldRef(ctx.db, ns, "claim", item.claimId),
    subject: objectRef(ctx.db, ns, semantic.subject),
    predicate: semantic.predicate,
    object:
      semantic.object.kind === "literal"
        ? { kind: "literal", value: semantic.object.value }
        : semantic.object.kind === "vocabulary"
          ? { kind: "vocabulary", id: semantic.object.ref.id }
          : { kind: "node", ref: objectRef(ctx.db, ns, semantic.object.ref) },
    perspective: {
      holder: ref(semantic.perspective.holder),
      speaker: ref(semantic.perspective.speaker),
      addressee: ref(semantic.perspective.addressee),
      mode: semantic.perspective.mode,
      interpretation: semantic.perspective.interpretation,
      evidence: item.supports.flatMap((support) =>
        evidence(support, support.admission.semantic.perspective.anchors),
      ),
    },
    context: semantic.context.map((value) => objectRef(ctx.db, ns, value)),
    polarity: semantic.polarity,
    valid:
      semantic.temporal_basis === "unknown" || semantic.valid_from === null
        ? { kind: "unknown" }
        : {
            kind: "known",
            from: semantic.valid_from,
            until: semantic.valid_to,
          },
    temporalBasis: semantic.temporal_basis,
    assessments: item.supports.map((support) => ({
      admission: issueWorldRef(
        ctx.db,
        ns,
        "admission",
        support.row.support_key,
      ),
      epistemicKind: support.admission.epistemicKind,
      authority: support.admission.authority,
      confidence: { kind: "known", value: support.admission.confidence },
      independence: "unknown",
      evidence: evidence(support),
    })),
    conflict: "unknown",
  };
}

export function projectWorldCard(
  ctx: ServeContext,
  ns: WorldNamespace,
  handle: string,
  kind: "concept" | "situation",
  valid: WorldValidQuery,
): ConceptCard | SituationCard | null {
  const budget: ReadBudget = { bytes: 0 };
  const raw = ctx.db
    .query<
      {
        raw_kind: RawSubjectRef["kind"];
        raw_namespace: string;
        raw_id: string;
      },
      [string]
    >("SELECT raw_kind,raw_namespace,raw_id FROM semantic_bindings WHERE handle_id=?")
    .get(handle);
  if (raw === null) return null;
  const anchor: RawSubjectRef =
    raw.raw_namespace === ""
      ? { kind: raw.raw_kind, id: raw.raw_id }
      : {
          kind: "supplied",
          id: raw.raw_id,
          namespace: JSON.parse(raw.raw_namespace),
        };
  const items: Eligible[] = [];
  let overflow = false;
  const permitted = authorizedSupportSql(ctx),
    time = validMeaningSql(valid);
  const candidates = ctx.db.query<
    { claim_id: string },
    (string | number)[]
  >(`SELECT c.claim_id FROM claim_v2_semantics c JOIN claims base USING(claim_id)
    WHERE discriminator='assertion' AND base.status='live' AND ${time.sql} AND
    ((subject_kind=? AND subject_id=? AND coalesce(json_extract(payload,'$.subject.namespace'),'')=?) OR (json_extract(payload,'$.object.ref.kind')=? AND json_extract(payload,'$.object.ref.id')=? AND coalesce(json_extract(payload,'$.object.ref.namespace'),'')=?))
    AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
    ORDER BY CASE c.predicate WHEN 'world.kind' THEN 0 WHEN 'concept.label' THEN 1 WHEN 'situation.label' THEN 1 ELSE 2 END,c.claim_id LIMIT ?`);
  for (const row of candidates.all(
    ...time.bindings,
    anchor.kind,
    anchor.id,
    rawSubjectNamespace(anchor),
    anchor.kind,
    anchor.id,
    rawSubjectNamespace(anchor),
    ...permitted.bindings,
    MAX_RELATIONS + 1,
  )) {
    const item = eligibleWorldClaim(ctx, row.claim_id, valid, budget);
    if (item === null) continue;
    if (items.length === MAX_RELATIONS) {
      overflow = true;
      break;
    }
    items.push(item);
    overflow ||= item.overflow;
  }
  const classification = items.filter(
    (item) =>
      rawKey(item.semantic.subject) === rawKey(anchor) &&
      item.semantic.predicate === "world.kind" &&
      item.semantic.polarity === "positive" &&
      item.semantic.object.kind === "vocabulary" &&
      item.semantic.object.ref.id === `world/${kind}` &&
      item.semantic.perspective.mode === "asserted",
  );
  if (classification.length === 0) return null;
  const projected = items.map((item) => relation(ctx, ns, item));
  const own = projected.filter(
    (item) =>
      item.subject.token === issueWorldRef(ctx.db, ns, "object", handle).token,
  );
  const labels = own
    .filter(
      (item) =>
        item.predicate === `${kind}.label` &&
        item.perspective.mode === "asserted" &&
        item.polarity === "positive" &&
        item.object.kind === "literal",
    )
    .map((item) => ({
      text: item.object.kind === "literal" ? item.object.value : "",
      claim: item.claim,
    }));
  const coverage: ConceptCoverage = {
    status: overflow ? "partial" : "complete_for_query",
    gaps: overflow ? ["traversal_limit"] : [],
    validWindow: valid,
    history: "unavailable",
  };
  const node = {
    schema: "kizuki.knowledge-node/v1" as const,
    ref: issueWorldRef(ctx.db, ns, "object", handle),
    kind,
    classificationClaims: classification.map((item) =>
      issueWorldRef(ctx.db, ns, "claim", item.claimId),
    ),
    labels,
    resolution: "distinct" as const,
  };
  if (kind === "concept") {
    const card: ConceptCard = {
      schema: "kizuki.concept-card/v1",
      concept: { ...node, kind: "concept" },
      summary: null,
      definitions: own.filter(
        (item) => item.predicate === "concept.definition",
      ),
      relations: own.filter(
        (item) =>
          item.predicate !== "concept.definition" &&
          item.predicate !== "concept.label" &&
          item.predicate !== "world.kind",
      ),
      learning: projected
        .filter(
          (item) =>
            /^learning\.(exposure|explanation|application|demonstration)$/.test(
              item.predicate,
            ) &&
            item.object.kind === "node" &&
            item.object.ref.token === node.ref.token,
        )
        .map((item) => ({
          facet: item.predicate.slice(9) as
            | "exposure"
            | "explanation"
            | "application"
            | "demonstration",
          assertion: item,
          assistance: "unknown",
          assistanceEvidence: [],
        })),
      knownAt: { kind: "current" },
      coverage,
    };
    checkCardBudget(card);
    if (!validateConceptCard(card).ok)
      throw new Error("world concept projection violated its codec");
    return card;
  }
  const select = (predicate: string) =>
    own.filter((item) => item.predicate === predicate);
  const one = (predicate: string) => {
    const found = select(predicate).filter(
      (item) =>
        item.polarity === "positive" && item.perspective.mode === "asserted",
    );
    return found.length === 1 ? found[0]! : null;
  };
  const uncertainty = own.filter(
    (item) =>
      item.perspective.mode !== "asserted" ||
      item.polarity === "negative" ||
      ([
        "situation.objective",
        "situation.blocker",
        "situation.change",
      ].includes(item.predicate) &&
        select(item.predicate).length > 1),
  );
  const card: SituationCard = {
    schema: "kizuki.situation-card/v1",
    situation: { ...node, kind: "situation" },
    summary: null,
    objective: one("situation.objective"),
    participants: select("situation.participant").filter(item=>item.polarity==="positive" && item.perspective.mode==="asserted").flatMap((item) =>
      item.object.kind === "node" ? [item.object.ref] : [],
    ),
    commitments: select("situation.commitment"),
    blocker: one("situation.blocker"),
    recentChange: one("situation.change"),
    uncertainty,
    knownAt: { kind: "current" },
    coverage,
  };
  checkCardBudget(card);
  if (!validateSituationCard(card).ok)
    throw new Error("world situation projection violated its codec");
  return card;
}

export function discoverWorld(
  ctx: ServeContext,
  ns: WorldNamespace,
  kind: "concept" | "situation",
  label: string,
  valid: WorldValidQuery,
): {
  schema: "kizuki.concept-matches/v1" | "kizuki.situation-matches/v1";
  matches: readonly { ref: WireRef<"object">; labels: readonly string[] }[];
  coverage: ConceptCoverage;
} {
  const budget: ReadBudget = { bytes: 0 };
  const matches: { ref: WireRef<"object">; labels: readonly string[] }[] = [];
  let overflow = false;
  const permitted = authorizedSupportSql(ctx),
    time = validMeaningSql(valid);
  const labelPolicy = authorizedSupportSql(ctx, "ls"),
    labelTime = validMeaningSql(valid, "lc");
  const query = ctx.db.query<
    { handle_id: string },
    (string | number)[]
  >(`SELECT DISTINCT b.handle_id FROM semantic_bindings b JOIN claim_v2_semantics c
    ON c.subject_kind=b.raw_kind AND c.subject_id=b.raw_id AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=b.raw_namespace JOIN claims base ON base.claim_id=c.claim_id
    WHERE c.predicate='world.kind' AND base.status='live' AND c.polarity='positive' AND json_extract(c.payload,'$.object.ref.id')=? AND ${time.sql}
    AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
    AND (?='' OR EXISTS(SELECT 1 FROM claim_v2_semantics lc JOIN claims lb ON lb.claim_id=lc.claim_id
      WHERE lc.subject_kind=b.raw_kind AND lc.subject_id=b.raw_id AND coalesce(json_extract(lc.payload,'$.subject.namespace'),'')=b.raw_namespace AND lc.predicate=? AND lb.status='live' AND lc.polarity='positive'
      AND ${labelTime.sql} AND instr(json_extract(lc.payload,'$.object.value'),?)>0
      AND EXISTS(SELECT 1 FROM claim_v2_support ls WHERE ls.claim_id=lc.claim_id AND ${labelPolicy.sql})))
    ORDER BY b.handle_id LIMIT ?`);
  for (const row of query.all(
    `world/${kind}`,
    ...time.bindings,
    ...permitted.bindings,
    label,
    `${kind}.label`,
    ...labelTime.bindings,
    label,
    ...labelPolicy.bindings,
    MAX_WORLD_MATCHES + 1,
  )) {
    const raw = ctx.db
      .query<
        {
          raw_kind: RawSubjectRef["kind"];
          raw_namespace: string;
          raw_id: string;
        },
        [string]
      >("SELECT raw_kind,raw_namespace,raw_id FROM semantic_bindings WHERE handle_id=?")
      .get(row.handle_id);
    if (raw === null) continue;
    const labels: string[] = [];
    let classified = false;
    const candidates = ctx.db
      .query<{ claim_id: string }, (string | number)[]>(
        `SELECT c.claim_id FROM claim_v2_semantics c JOIN claims base USING(claim_id)
      WHERE c.subject_kind=? AND c.subject_id=? AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=? AND c.predicate IN ('world.kind',?) AND base.status='live' AND ${time.sql}
      AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
      ORDER BY CASE c.predicate WHEN 'world.kind' THEN 0 ELSE 1 END,c.claim_id LIMIT ?`,
      )
      .all(
        raw.raw_kind,
        raw.raw_id,
        raw.raw_namespace,
        `${kind}.label`,
        ...time.bindings,
        ...permitted.bindings,
        MAX_RELATIONS + 1,
      );
    for (const candidate of candidates.slice(0, MAX_RELATIONS)) {
      const item = eligibleWorldClaim(ctx, candidate.claim_id, valid, budget);
      if (item === null) continue;
      const semantic = item.semantic;
      if (
        semantic.polarity !== "positive" ||
        semantic.perspective.mode !== "asserted"
      )
        continue;
      if (
        semantic.predicate === "world.kind" &&
        semantic.object.kind === "vocabulary" &&
        semantic.object.ref.id === `world/${kind}`
      )
        classified = true;
      if (
        semantic.predicate === `${kind}.label` &&
        semantic.object.kind === "literal"
      )
        labels.push(semantic.object.value);
    }
    if (
      !classified ||
      (label.length > 0 && !labels.some((text) => text.includes(label)))
    )
      continue;
    if (matches.length === MAX_WORLD_MATCHES) {
      overflow = true;
      break;
    }
    matches.push({
      ref: issueWorldRef(ctx.db, ns, "object", row.handle_id),
      labels,
    });
    overflow ||= candidates.length > MAX_RELATIONS;
  }
  matches.sort(
    (a, b) =>
      (a.labels[0] ?? "").localeCompare(b.labels[0] ?? "") ||
      a.ref.token.localeCompare(b.ref.token),
  );
  return {
    schema:
      kind === "concept"
        ? "kizuki.concept-matches/v1"
        : "kizuki.situation-matches/v1",
    matches,
    coverage: {
      status: overflow ? "partial" : "complete_for_query",
      gaps: overflow ? ["traversal_limit"] : [],
      validWindow: valid,
      history: "unavailable",
    },
  };
}
