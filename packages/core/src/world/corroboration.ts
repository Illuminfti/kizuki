import type { Database } from "bun:sqlite";
import type { Sensitivity } from "../agents/types";
import { getCanonReceipt } from "../canon/receipts";
import { isWorldCanonReceipt } from "../canon/world-receipt";
import {
  IDENTITY_MERGE_MIN,
  LEGACY_IDENTITY_ENDPOINT_MAX_BYTES,
  LEGACY_IDENTITY_EVIDENCE_MAX_BYTES,
  LEGACY_IDENTITY_EVIDENCE_MAX_REFS,
  LEGACY_IDENTITY_SCAN_MAX_ROWS,
  parseLegacyIdentityEvidence,
} from "../claims/identity";
import {
  rawSubjectNamespace,
  type ClaimMeaning,
  type ClaimV2Assertion,
  type RawSubjectRef,
} from "../contracts/claim-v2";
import { tableExists } from "../ledger/schema";
import { sha256Hex } from "../util/hash";
import { eventDerivation } from "./lineage";

/** Lower-case fragments that give a decision authority, grant or policy meaning. */
export const AUTHORITY_TERMS = ["owner", "agent", "assistant", "grant", "permission", "authoriz", "authoris", "access", "polic", "admin", "credential", "audit", "revok"] as const;
export const IDENTITY_PREDICATES = ["identity.same_as", "identity.handle_on"] as const;
export const CROSS_SOURCE_IDENTITY_PREDICATES = [
  "concept.same_as",
  "concept.distinguished_from",
  "identity.same_as",
  "identity.handle_on",
] as const;
export type CrossSourceIdentityPredicate = (typeof CROSS_SOURCE_IDENTITY_PREDICATES)[number];

/** Independent sources a model-read authority claim needs before it is served. */
export const AUTHORITY_CLAIM_MIN_ROOTS = 2;

const IDENTITY_SQL = IDENTITY_PREDICATES.map(predicate => `'${predicate}'`).join(",");
const CROSS_SOURCE_IDENTITY_SQL = CROSS_SOURCE_IDENTITY_PREDICATES.map(predicate => `'${predicate}'`).join(",");
const OBJECT_TERMS_SQL = AUTHORITY_TERMS.map(term => `lower(json_extract(m.payload,'$.object.value')) LIKE '%${term}%'`).join(" OR ");
const BODY_TERMS_SQL = AUTHORITY_TERMS.map(term => `(lower(json_extract(s.admission,'$.rendering.body')) LIKE '%${term}%')`).join(" OR ");
const EVIDENCE_REF_RE = /^(event|claim):([A-Za-z0-9][A-Za-z0-9._:/-]{0,255})$/;
const SENSITIVITY_RANK: Readonly<Record<Sensitivity, number>> = {
  public: 0,
  personal: 1,
  private: 2,
};

export interface IdentityLinkProposal {
  readonly subject_a: string;
  readonly subject_b: string;
  readonly status: "candidate" | "merged" | "rejected";
  readonly score: number;
  readonly evidence: readonly string[];
  readonly independent_roots: number;
  readonly native_owner: boolean;
  readonly disputed: boolean;
  readonly decided_by: string;
  readonly receipt_id: string | null;
}

export interface CrossSourceIdentityOptions {
  /** Maximum sensitivity visible to this proposal pass. Defaults to owner ("private"). */
  readonly ceiling?: Sensitivity;
  /** RFC 3339 timestamp recorded on proposed rows. */
  readonly at?: string;
  /** Evaluate proposals without writing to `identity_links`. */
  readonly dryRun?: boolean;
  /** Also propose links from shared supplied `raw_id` bindings across distinct active sources. */
  readonly includeSharedBindings?: boolean;
}

export interface CrossSourceIdentityReport {
  readonly proposed: number;
  readonly corroborated: number;
  readonly rejected: number;
  readonly skipped: number;
  readonly links: readonly IdentityLinkProposal[];
}

export function isCrossSourceIdentityPredicate(
  predicate: string,
): predicate is CrossSourceIdentityPredicate {
  return (CROSS_SOURCE_IDENTITY_PREDICATES as readonly string[]).includes(predicate);
}

export function hasAuthorityTerm(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTHORITY_TERMS.some((term) => lower.includes(term));
}

function authoritySemanticSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM claim_v2_semantics m WHERE m.claim_id = ${alias}.claim_id
      AND (m.predicate IN (${IDENTITY_SQL}) OR (m.predicate LIKE 'decision.%' AND m.object_kind = 'literal' AND (${OBJECT_TERMS_SQL}))))`;
}

/**
 * A model-read claim with identity, authority, grant or policy meaning, in its
 * literal or in the prose the page renders, is held, not deleted: it stays in
 * the ledger, is invisible to reads and canon, and is released by a second
 * independent source or by the owner. Two records of one enrolled source are one
 * root, because one attacker-controlled inbox can send both. The owner's own
 * correction is native support and never waits. It counts every support the
 * reader may use, not the subset a caller selected, so the answer does not
 * change with the question.
 */
export function heldUntilCorroborated(
  db: Database,
  claimId: string,
  permitted: { sql: string; bindings: (string | number)[] },
): boolean {
  const held = heldClaimSql("c", permitted);
  // Read one decision, not every admission body: repeated deliveries must not
  // turn the hold into an unbounded allocation. Reads and queues share one rule.
  return db.query(`SELECT 1 FROM claims c WHERE c.claim_id=? AND ${held.sql}`)
    .get(claimId, ...held.bindings) !== null;
}

/**
 * The same rule as a SQL condition over `claims` aliased `alias`, for queues
 * that must not fill with claims that cannot be served yet. `permitted` is the
 * reader's own support filter over `claim_v2_support s`, so the prefilter
 * counts what the read path counts. It is a prefilter: the read path applies
 * `heldUntilCorroborated` itself.
 */
export function heldClaimSql(alias: string, permitted: { sql: string; bindings: (string | number)[] }):
  { sql: string; bindings: (string | number)[] } {
  // Single correlated aggregate over permitted supports avoids triplicating the
  // support policy subquery while preserving exact zero-row aggregate semantics.
  return {
    sql: `EXISTS (SELECT count(*) FROM claim_v2_support s WHERE s.claim_id = ${alias}.claim_id AND ${permitted.sql}
      HAVING coalesce(max(CASE WHEN s.support_origin = 'native_owner' THEN 1 ELSE 0 END), 0) = 0
        AND count(DISTINCT s.source_key) < ${AUTHORITY_CLAIM_MIN_ROOTS}
        AND (coalesce(max(CASE WHEN ${BODY_TERMS_SQL} THEN 1 ELSE 0 END), 0) = 1 OR ${authoritySemanticSql(alias)}))`,
    bindings: [...permitted.bindings],
  };
}

/**
 * Equivalent to `EXISTS(permitted support) AND NOT heldClaimSql(alias, permitted)`
 * evaluated in a single correlated aggregate pass over `claim_v2_support`.
 */
export function permittedAndUnheldSql(alias: string, permitted: { sql: string; bindings: (string | number)[] }):
  { sql: string; bindings: (string | number)[] } {
  return {
    sql: `EXISTS (SELECT count(*) FROM claim_v2_support s WHERE s.claim_id = ${alias}.claim_id AND ${permitted.sql}
      HAVING count(*) > 0
        AND (max(CASE WHEN s.support_origin = 'native_owner' THEN 1 ELSE 0 END) = 1
          OR count(DISTINCT s.source_key) >= ${AUTHORITY_CLAIM_MIN_ROOTS}
          OR (max(CASE WHEN ${BODY_TERMS_SQL} THEN 1 ELSE 0 END) = 0 AND NOT ${authoritySemanticSql(alias)})))`,
    bindings: [...permitted.bindings],
  };
}

function validEndpointText(value: string): boolean {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > LEGACY_IDENTITY_ENDPOINT_MAX_BYTES) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Canonical ordered endpoint pair; rejects self-links, empty ids, control chars and oversized values. */
export function canonicalIdentityPair(left: string, right: string): readonly [string, string] | null {
  const a = left.trim();
  const b = right.trim();
  if (a === b || !validEndpointText(a) || !validEndpointText(b)) return null;
  return a < b ? [a, b] : [b, a];
}

function rawEndpointId(ref: RawSubjectRef): string {
  return ref.kind === "occurrence" ? `occurrence:${ref.id}` : ref.id;
}

function isUnattributedAssertion(semantic: ClaimV2Assertion | ClaimMeaning): boolean {
  return (
    semantic.perspective.mode === "asserted" &&
    semantic.perspective.holder === null &&
    semantic.perspective.speaker === null &&
    semantic.perspective.addressee === null &&
    semantic.context.length === 0
  );
}

/** Extract the canonical identity pair and polarity from a world assertion under containment bounds. */
export function identityAssertionEndpoints(
  semantic: ClaimV2Assertion | ClaimMeaning,
): { readonly pair: readonly [string, string]; readonly kind: "positive" | "negative" } | null {
  if (!isCrossSourceIdentityPredicate(semantic.predicate) || !isUnattributedAssertion(semantic)) return null;
  if (semantic.predicate === "concept.same_as" || semantic.predicate === "concept.distinguished_from") {
    if (semantic.object.kind !== "subject") return null;
    if (semantic.predicate === "concept.distinguished_from" && semantic.polarity !== "positive") return null;
    let left = rawEndpointId(semantic.subject);
    let right = rawEndpointId(semantic.object.ref);
    if (left === right) {
      const leftNs = rawSubjectNamespace(semantic.subject);
      const rightNs = rawSubjectNamespace(semantic.object.ref);
      if (leftNs === rightNs) return null;
      left = `${left}#${sha256Hex(leftNs).slice(0, 12)}`;
      right = `${right}#${sha256Hex(rightNs).slice(0, 12)}`;
    }
    const pair = canonicalIdentityPair(left, right);
    if (pair === null) return null;
    const kind =
      semantic.predicate === "concept.distinguished_from" || semantic.polarity === "negative"
        ? "negative"
        : "positive";
    return { pair, kind };
  }
  if (semantic.object.kind !== "literal") return null;
  const targetRaw = semantic.object.value.trim();
  if (targetRaw.length === 0) return null;
  if (semantic.predicate === "identity.handle_on" && semantic.polarity !== "positive") return null;
  const target =
    semantic.predicate === "identity.handle_on" && !targetRaw.startsWith("handle:")
      ? `handle:${targetRaw}`
      : targetRaw;
  const pair = canonicalIdentityPair(rawEndpointId(semantic.subject), target);
  if (pair === null) return null;
  return { pair, kind: semantic.polarity === "negative" ? "negative" : "positive" };
}

function sensitivityAllowed(value: string | null | undefined, ceiling: Sensitivity): boolean {
  const rank =
    value === "public" || value === "personal" || value === "private"
      ? SENSITIVITY_RANK[value]
      : SENSITIVITY_RANK.private;
  return rank <= SENSITIVITY_RANK[ceiling];
}

function sourceGrantAllowed(
  db: Database,
  sourceKey: string,
  ceiling: Sensitivity,
): { readonly ok: boolean; readonly floor: Sensitivity } {
  if (!tableExists(db, "source_grants")) return { ok: true, floor: "public" };
  const row = db
    .query<{ status: string; policy: string }, [string]>(
      "SELECT status, policy FROM source_grants WHERE source_key=?",
    )
    .get(sourceKey);
  if (row === null || row.status !== "active") return { ok: false, floor: "private" };
  let parsed: { purposes?: unknown; sensitivity_floor?: unknown };
  try {
    parsed = JSON.parse(row.policy) as { purposes?: unknown; sensitivity_floor?: unknown };
  } catch {
    return { ok: false, floor: "private" };
  }
  const purposes = Array.isArray(parsed.purposes) ? parsed.purposes : [];
  if (!purposes.includes("derive") && !purposes.includes("recall")) return { ok: false, floor: "private" };
  const floor: Sensitivity =
    parsed.sensitivity_floor === "public" ||
    parsed.sensitivity_floor === "personal" ||
    parsed.sensitivity_floor === "private"
      ? parsed.sensitivity_floor
      : "private";
  return { ok: sensitivityAllowed(floor, ceiling), floor };
}

function retainedOwnerReceipt(db: Database, claimId: string, receiptId: string | null): string | null {
  if (receiptId === null || !tableExists(db, "canon_receipts")) return null;
  const receipt = getCanonReceipt(db, receiptId);
  if (receipt === null || !isWorldCanonReceipt(receipt) || receipt.state !== "retained") return null;
  return receipt.claim_ids.includes(claimId) ? receiptId : null;
}

function buildBoundedEvidence(refs: Iterable<string>): string[] {
  const unique = [...new Set(refs)].filter((ref) => EVIDENCE_REF_RE.test(ref)).sort();
  const bounded: string[] = [];
  for (const ref of unique) {
    if (bounded.length >= LEGACY_IDENTITY_EVIDENCE_MAX_REFS) break;
    bounded.push(ref);
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > LEGACY_IDENTITY_EVIDENCE_MAX_BYTES) {
      bounded.pop();
      break;
    }
  }
  const serialized = JSON.stringify(bounded);
  return parseLegacyIdentityEvidence(serialized).ok ? bounded : [];
}

function countIndependentRoots(fingerprintSets: readonly ReadonlySet<string>[]): number {
  if (fingerprintSets.length === 0) return 0;
  const parent = fingerprintSets.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const seen = new Map<string, number>();
  for (let i = 0; i < fingerprintSets.length; i += 1) {
    for (const fp of fingerprintSets[i]!) {
      const prior = seen.get(fp);
      if (prior !== undefined) parent[find(i)] = find(prior);
      else seen.set(fp, i);
    }
  }
  const roots = new Set<number>();
  for (let i = 0; i < fingerprintSets.length; i += 1) roots.add(find(i));
  return roots.size;
}

function corroborationScore(roots: number): number {
  if (roots >= AUTHORITY_CLAIM_MIN_ROOTS) {
    return Math.min(1, Number((IDENTITY_MERGE_MIN + 0.05 * (roots - AUTHORITY_CLAIM_MIN_ROOTS)).toFixed(4)));
  }
  return roots === 1 ? 0.5 : 0.25;
}

interface CandidateSupportRow {
  claim_id: string;
  payload: string;
  sensitivity: string;
  receipt_id: string | null;
  support_key: string;
  source_key: string;
  support_origin: string;
  anchors: string;
}

function witnessEventIdsFromAnchors(anchorsJson: string): Set<string> {
  const ids = new Set<string>();
  try {
    const parsed = JSON.parse(anchorsJson);
    if (Array.isArray(parsed)) {
      for (const anchor of parsed) {
        if (anchor && typeof anchor === "object" && typeof (anchor as { event_id?: unknown }).event_id === "string") {
          ids.add((anchor as { event_id: string }).event_id);
        }
      }
    }
  } catch {
    // Fall back to empty set so inspectSupportEvents checks all support events.
  }
  return ids;
}

function inspectSupportEvents(
  db: Database,
  supportKey: string,
  witnessIds: ReadonlySet<string>,
  ceiling: Sensitivity,
): {
  readonly valid: boolean;
  readonly independent: boolean;
  readonly fingerprints: Set<string>;
  readonly eventIds: string[];
} {
  const eventRows = db
    .query<
      {
        event_id: string;
        event_content_hash: string;
        content_hash: string | null;
        text_hash: string | null;
        metadata: string | null;
        origin: string | null;
        deleted: number | null;
        sensitivity_hint: string | null;
      },
      [string]
    >(
      `SELECT se.event_id, se.event_content_hash, e.content_hash, e.text_hash, e.metadata, e.origin, e.deleted, e.sensitivity_hint
         FROM claim_v2_support_events se
         LEFT JOIN events e ON e.event_id = se.event_id
        WHERE se.support_key = ?
        ORDER BY se.event_id`,
    )
    .all(supportKey);
  if (eventRows.length === 0) {
    return { valid: false, independent: false, fingerprints: new Set(), eventIds: [] };
  }
  const fingerprints = new Set<string>();
  const eventIds: string[] = [];
  let independent = true;
  for (const ev of eventRows) {
    if (
      ev.deleted !== 0 ||
      ev.content_hash === null ||
      ev.content_hash !== ev.event_content_hash ||
      ev.text_hash === null ||
      ev.metadata === null
    ) {
      return { valid: false, independent: false, fingerprints: new Set(), eventIds: [] };
    }
    if (!sensitivityAllowed(ev.sensitivity_hint ?? "public", ceiling)) {
      return { valid: false, independent: false, fingerprints: new Set(), eventIds: [] };
    }
    eventIds.push(ev.event_id);
    const isWitness = witnessIds.size === 0 || witnessIds.has(ev.event_id);
    if (isWitness) {
      fingerprints.add(`version:${ev.content_hash}`);
      fingerprints.add(`text:${ev.text_hash}`);
      let meta: unknown;
      try {
        meta = JSON.parse(ev.metadata);
      } catch {
        independent = false;
        continue;
      }
      if (ev.origin === "self" || eventDerivation(meta) !== "independent") {
        independent = false;
      }
    }
  }
  return { valid: true, independent, fingerprints, eventIds };
}

function rawSubjectIdFromEndpoint(endpoint: string): string {
  const withoutOccurrence = endpoint.startsWith("occurrence:") ? endpoint.slice("occurrence:".length) : endpoint;
  const hashIdx = withoutOccurrence.lastIndexOf("#");
  if (hashIdx > 0 && /^[a-f0-9]{12}$/.test(withoutOccurrence.slice(hashIdx + 1))) {
    return withoutOccurrence.slice(0, hashIdx);
  }
  return withoutOccurrence;
}

function rawLiteralFromEndpoint(endpoint: string): string {
  return endpoint.startsWith("handle:") ? endpoint.slice("handle:".length) : endpoint;
}

/**
 * Deterministically evaluate cross-source corroboration for one canonical
 * identity pair across live world assertions, enforcing active source grants,
 * sensitivity ceilings, root independence, receipted native-owner authority,
 * and negative-edge disputes.
 */
export function evaluateIdentityLinkPair(
  db: Database,
  left: string,
  right: string,
  options: { readonly ceiling?: Sensitivity } = {},
): IdentityLinkProposal | null {
  const pair = canonicalIdentityPair(left, right);
  if (pair === null) return null;
  if (
    !tableExists(db, "claims") ||
    !tableExists(db, "claim_v2_semantics") ||
    !tableExists(db, "claim_v2_support") ||
    !tableExists(db, "claim_v2_support_events")
  ) {
    return null;
  }
  const ceiling: Sensitivity = options.ceiling ?? "private";
  const rawA = rawSubjectIdFromEndpoint(pair[0]);
  const rawB = rawSubjectIdFromEndpoint(pair[1]);
  const litA = rawLiteralFromEndpoint(pair[0]);
  const litB = rawLiteralFromEndpoint(pair[1]);
  const rows = db
    .query<CandidateSupportRow, [string, string, string, string, string, string, string, string]>(
      `SELECT m.claim_id, m.payload, c.sensitivity, c.receipt_id,
              s.support_key, s.source_key, s.support_origin, s.anchors
         FROM claim_v2_semantics m
         JOIN claims c USING(claim_id)
         JOIN claim_v2_support s USING(claim_id)
        WHERE c.status = 'live'
          AND m.discriminator = 'assertion'
          AND m.predicate IN (${CROSS_SOURCE_IDENTITY_SQL})
          AND (
            m.subject_id IN (?, ?)
            OR json_extract(m.payload, '$.object.ref.id') IN (?, ?)
            OR trim(coalesce(json_extract(m.payload, '$.object.value'), '')) IN (?, ?, ?, ?)
          )
        ORDER BY m.claim_id, s.support_key`,
    )
    .all(rawA, rawB, rawA, rawB, pair[0], pair[1], litA, litB);

  const positiveRoots: Set<string>[] = [];
  const evidenceRefs: string[] = [];
  let positiveCount = 0;
  let disputed = false;
  let nativeOwner = false;
  let nativeReceiptId: string | null = null;

  for (const row of rows) {
    if (!sensitivityAllowed(row.sensitivity, ceiling)) continue;
    let semantic: ClaimV2Assertion | ClaimMeaning;
    try {
      semantic = JSON.parse(row.payload) as ClaimV2Assertion | ClaimMeaning;
    } catch {
      continue;
    }
    const extracted = identityAssertionEndpoints(semantic);
    if (extracted === null || extracted.pair[0] !== pair[0] || extracted.pair[1] !== pair[1]) continue;

    const witnessIds = witnessEventIdsFromAnchors(row.anchors);
    if (row.support_origin === "native_owner") {
      const retained = retainedOwnerReceipt(db, row.claim_id, row.receipt_id);
      if (retained === null) continue;
      const inspected = inspectSupportEvents(db, row.support_key, witnessIds, ceiling);
      if (!inspected.valid) continue;
      evidenceRefs.push(`claim:${row.claim_id}`, ...inspected.eventIds.map((id) => `event:${id}`));
      if (extracted.kind === "negative") {
        disputed = true;
      } else {
        nativeOwner = true;
        nativeReceiptId ??= retained;
        positiveCount += 1;
      }
      continue;
    }

    const grant = sourceGrantAllowed(db, row.source_key, ceiling);
    if (!grant.ok) continue;
    const inspected = inspectSupportEvents(db, row.support_key, witnessIds, ceiling);
    if (!inspected.valid) continue;

    evidenceRefs.push(`claim:${row.claim_id}`, ...inspected.eventIds.map((id) => `event:${id}`));
    if (extracted.kind === "negative") {
      disputed = true;
    } else {
      positiveCount += 1;
      if (inspected.independent) {
        inspected.fingerprints.add(`source:${row.source_key}`);
        positiveRoots.push(inspected.fingerprints);
      }
    }
  }

  if (positiveCount === 0 && !disputed) return null;
  const evidence = buildBoundedEvidence(evidenceRefs);
  if (evidence.length === 0) return null;
  const independentRoots = countIndependentRoots(positiveRoots);

  if (disputed) {
    return {
      subject_a: pair[0],
      subject_b: pair[1],
      status: "rejected",
      score: 0,
      evidence,
      independent_roots: independentRoots,
      native_owner: nativeOwner,
      disputed: true,
      decided_by: "corroboration:disputed",
      receipt_id: null,
    };
  }
  if (nativeOwner) {
    return {
      subject_a: pair[0],
      subject_b: pair[1],
      status: "merged",
      score: 1,
      evidence,
      independent_roots: independentRoots,
      native_owner: true,
      disputed: false,
      decided_by: "corroboration:native_owner",
      receipt_id: nativeReceiptId,
    };
  }
  if (independentRoots >= AUTHORITY_CLAIM_MIN_ROOTS) {
    return {
      subject_a: pair[0],
      subject_b: pair[1],
      status: "merged",
      score: corroborationScore(independentRoots),
      evidence,
      independent_roots: independentRoots,
      native_owner: false,
      disputed: false,
      decided_by: "corroboration:cross_source",
      receipt_id: null,
    };
  }
  return {
    subject_a: pair[0],
    subject_b: pair[1],
    status: "candidate",
    score: corroborationScore(independentRoots),
    evidence,
    independent_roots: independentRoots,
    native_owner: false,
    disputed: false,
    decided_by: "corroboration:single_source",
    receipt_id: null,
  };
}

function upsertCorroboratedIdentityLink(
  db: Database,
  proposal: IdentityLinkProposal,
  at: string,
): boolean {
  if (!tableExists(db, "identity_links")) return false;
  const existing = db
    .query<{ n: number }, [string, string]>(
      "SELECT 1 AS n FROM identity_links WHERE subject_a=? AND subject_b=?",
    )
    .get(proposal.subject_a, proposal.subject_b);
  if (existing === null) {
    const total = db.query<{ n: number }, []>("SELECT count(*) AS n FROM identity_links").get()?.n ?? 0;
    if (total >= LEGACY_IDENTITY_SCAN_MAX_ROWS) return false;
  }
  db.query(
    `INSERT INTO identity_links (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject_a, subject_b) DO UPDATE SET
       score = excluded.score,
       evidence = excluded.evidence,
       status = excluded.status,
       decided_by = excluded.decided_by,
       receipt_id = excluded.receipt_id,
       at = excluded.at`,
  ).run(
    proposal.subject_a,
    proposal.subject_b,
    proposal.score,
    JSON.stringify(proposal.evidence),
    proposal.status,
    proposal.decided_by,
    proposal.receipt_id,
    at,
  );
  return true;
}

/**
 * Called by `allocateWorldEndpoints` inside the claim transaction. Only fires
 * on explicit asserted identity predicates, never altering non-identity claims
 * or violating legacy containment / purge bounds.
 */
export function reconcileIdentityLinkFromAllocation(
  db: Database,
  semantic: ClaimV2Assertion,
  at: string,
): IdentityLinkProposal | null {
  if (!isCrossSourceIdentityPredicate(semantic.predicate) || !tableExists(db, "identity_links")) {
    return null;
  }
  const extracted = identityAssertionEndpoints(semantic);
  if (extracted === null) return null;
  const proposal = evaluateIdentityLinkPair(db, extracted.pair[0], extracted.pair[1]);
  if (proposal === null) return null;
  upsertCorroboratedIdentityLink(db, proposal, at);
  return proposal;
}

function proposeSharedBindingLinks(
  db: Database,
  ceiling: Sensitivity,
): IdentityLinkProposal[] {
  if (
    !tableExists(db, "semantic_bindings") ||
    !tableExists(db, "semantic_allocations") ||
    !tableExists(db, "claim_v2_support") ||
    !tableExists(db, "claim_v2_support_events")
  ) {
    return [];
  }
  const sharedRawIds = db
    .query<{ raw_id: string }, []>(
      `SELECT raw_id FROM semantic_bindings
        WHERE raw_kind = 'supplied' AND raw_namespace <> ''
        GROUP BY raw_id
       HAVING count(DISTINCT raw_namespace) >= 2
        ORDER BY raw_id`,
    )
    .all();

  const proposals: IdentityLinkProposal[] = [];
  for (const { raw_id } of sharedRawIds) {
    const bindings = db
      .query<
        {
          handle_id: string;
          raw_namespace: string;
          support_key: string;
          claim_id: string;
          source_key: string;
          support_origin: string;
          sensitivity: string;
        },
        [string]
      >(
        `SELECT b.handle_id, b.raw_namespace, s.support_key, s.claim_id, s.source_key, s.support_origin, c.sensitivity
           FROM semantic_bindings b
           JOIN semantic_allocations a USING(handle_id)
           JOIN claim_v2_support s USING(support_key)
           JOIN claims c USING(claim_id)
          WHERE b.raw_kind = 'supplied' AND b.raw_id = ? AND c.status = 'live' AND s.support_origin = 'source'
          ORDER BY b.raw_namespace, s.support_key`,
      )
      .all(raw_id);

    const bySource = new Map<
      string,
      {
        readonly sourceKey: string;
        readonly floor: Sensitivity;
        readonly endpoint: string;
        readonly fingerprints: Set<string>;
        readonly evidence: Set<string>;
        readonly independent: boolean;
      }
    >();

    for (const row of bindings) {
      if (!sensitivityAllowed(row.sensitivity, ceiling)) continue;
      const grant = sourceGrantAllowed(db, row.source_key, ceiling);
      if (!grant.ok) continue;
      const inspected = inspectSupportEvents(db, row.support_key, new Set(), ceiling);
      if (!inspected.valid) continue;
      const current = bySource.get(row.source_key);
      const endpoint = `${raw_id}#${sha256Hex(row.raw_namespace).slice(0, 12)}`;
      if (current === undefined) {
        const fps = new Set(inspected.fingerprints);
        fps.add(`source:${row.source_key}`);
        bySource.set(row.source_key, {
          sourceKey: row.source_key,
          floor: grant.floor,
          endpoint,
          fingerprints: fps,
          evidence: new Set([`claim:${row.claim_id}`, ...inspected.eventIds.map((id) => `event:${id}`)]),
          independent: inspected.independent,
        });
      } else {
        current.evidence.add(`claim:${row.claim_id}`);
        for (const id of inspected.eventIds) current.evidence.add(`event:${id}`);
        for (const fp of inspected.fingerprints) current.fingerprints.add(fp);
      }
    }

    const sources = [...bySource.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
    for (let i = 0; i < sources.length; i += 1) {
      for (let j = i + 1; j < sources.length; j += 1) {
        const left = sources[i]!;
        const right = sources[j]!;
        const pair = canonicalIdentityPair(left.endpoint, right.endpoint);
        if (pair === null) continue;
        const evidence = buildBoundedEvidence([...left.evidence, ...right.evidence]);
        if (evidence.length === 0) continue;
        const rootSets: Set<string>[] = [];
        if (left.independent) rootSets.push(left.fingerprints);
        if (right.independent) rootSets.push(right.fingerprints);
        const independentRoots = countIndependentRoots(rootSets);
        const sameSensitivityTier = left.floor === right.floor;
        const corroborated = sameSensitivityTier && independentRoots >= AUTHORITY_CLAIM_MIN_ROOTS;
        proposals.push({
          subject_a: pair[0],
          subject_b: pair[1],
          status: corroborated ? "merged" : "candidate",
          score: corroborated ? corroborationScore(independentRoots) : 0.5,
          evidence,
          independent_roots: independentRoots,
          native_owner: false,
          disputed: false,
          decided_by: corroborated ? "corroboration:cross_source_binding" : "corroboration:containment_held",
          receipt_id: null,
        });
      }
    }
  }
  return proposals;
}

/**
 * Deterministic cross-source identity link proposal and corroboration sweep.
 * Evaluates explicit world identity assertions and optional shared cross-source
 * bindings under sensitivity, grant, and root-independence containment rules.
 */
export function proposeCrossSourceIdentityLinks(
  db: Database,
  options: CrossSourceIdentityOptions = {},
): CrossSourceIdentityReport {
  const ceiling: Sensitivity = options.ceiling ?? "private";
  const at = options.at ?? new Date().toISOString();
  const dryRun = options.dryRun ?? false;
  const includeSharedBindings = options.includeSharedBindings ?? true;

  const byPair = new Map<string, IdentityLinkProposal>();
  let skipped = 0;

  if (tableExists(db, "claims") && tableExists(db, "claim_v2_semantics")) {
    const claimRows = db
      .query<{ payload: string; sensitivity: string }, []>(
        `SELECT m.payload, c.sensitivity
           FROM claim_v2_semantics m
           JOIN claims c USING(claim_id)
          WHERE c.status = 'live'
            AND m.discriminator = 'assertion'
            AND m.predicate IN (${CROSS_SOURCE_IDENTITY_SQL})
          ORDER BY m.claim_id`,
      )
      .all();

    const pairKeys = new Map<string, readonly [string, string]>();
    for (const row of claimRows) {
      if (!sensitivityAllowed(row.sensitivity, ceiling)) {
        skipped += 1;
        continue;
      }
      let semantic: ClaimV2Assertion;
      try {
        semantic = JSON.parse(row.payload) as ClaimV2Assertion;
      } catch {
        skipped += 1;
        continue;
      }
      const extracted = identityAssertionEndpoints(semantic);
      if (extracted === null) {
        skipped += 1;
        continue;
      }
      const key = `${extracted.pair[0]}\0${extracted.pair[1]}`;
      if (!pairKeys.has(key)) pairKeys.set(key, extracted.pair);
    }

    for (const [key, pair] of pairKeys) {
      const proposal = evaluateIdentityLinkPair(db, pair[0], pair[1], { ceiling });
      if (proposal === null) {
        skipped += 1;
        continue;
      }
      byPair.set(key, proposal);
    }
  }

  if (includeSharedBindings) {
    for (const proposal of proposeSharedBindingLinks(db, ceiling)) {
      const key = `${proposal.subject_a}\0${proposal.subject_b}`;
      if (!byPair.has(key)) byPair.set(key, proposal);
    }
  }

  const links = [...byPair.values()].sort(
    (a, b) => a.subject_a.localeCompare(b.subject_a) || a.subject_b.localeCompare(b.subject_b),
  );

  if (!dryRun && tableExists(db, "identity_links")) {
    const writeAll = () => {
      for (const link of links) upsertCorroboratedIdentityLink(db, link, at);
    };
    if (db.inTransaction) writeAll();
    else db.transaction(writeAll).immediate();
  }

  return {
    proposed: links.length,
    corroborated: links.filter((link) => link.status === "merged").length,
    rejected: links.filter((link) => link.status === "rejected").length,
    skipped,
    links,
  };
}
