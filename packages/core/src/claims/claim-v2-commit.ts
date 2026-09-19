import type { Database } from "bun:sqlite";
import type { Sensitivity } from "../agents/types";
import {
  CLAIM_V2_SCHEMA,
  CLAIM_V2_SNAPSHOT_LIMITS,
  isTextAnchorList,
  type ClaimV2Semantic,
} from "../contracts/claim-v2";
import type { TextAnchor } from "../contracts/producer-v2";
import { CLAIM_SCHEMA, type Claim } from "../contracts/proposal";
import {
  inspectSourceGrant,
  requireSourceEvents,
  sourceSensitivity,
  type SourceReadScope,
} from "../ledger/source-grants";
import { stricter } from "../sensitivity/resolve";
import { canonicalJson } from "../util/hash";
import { isRfc3339 } from "../util/time";
import { cloneExactJson, isPlainObject, type ExactJson } from "../util/validate";
import { supportKey, type ClaimV2SupportEventRef } from "./claim-v2-keys";
import {
  fromClaimV2SemanticRow,
  toClaimV2SemanticRow,
} from "./claim-v2-rows";
import { ClaimError } from "./errors";
import { getClaim } from "./store";

/**
 * RFC 0003 B1c: the v2 children of the shared prepare/commit writer.
 * Callers still create the `claims` row through `prepareClaimInsert` /
 * `apply`; this writes semantics and immutable support in that same
 * transaction. It is not a second insert function and not a public v2
 * Core writer.
 */

export interface ClaimV2SupportAdmission {
  readonly source_key: string;
  readonly grant_revision: number;
  readonly events: readonly ClaimV2SupportEventRef[];
  readonly anchors: readonly TextAnchor[];
  readonly admission: unknown;
  readonly admitted_at: string;
}

export interface ClaimV2CommitInput {
  readonly semantic: unknown;
  readonly support: ClaimV2SupportAdmission;
  /** The reading scope the caller is authorized for, as `prepareClaimInsert` derives it. */
  readonly scope: SourceReadScope;
}

export interface ClaimV2CommitResult {
  readonly semantic_key: string;
  readonly support_key: string;
  readonly duplicate_support: boolean;
}

export type ClaimRecord =
  | { readonly schema: typeof CLAIM_SCHEMA; readonly claim: Claim }
  | {
      readonly schema: typeof CLAIM_V2_SCHEMA;
      readonly claim: Claim;
      readonly semantic: ClaimV2Semantic;
    };

function eventHash(db: Database, eventId: string): string {
  const row = db
    .query<{ content_hash: string }, [string]>(
      "SELECT content_hash FROM events WHERE event_id = ?",
    )
    .get(eventId);
  if (row === null) {
    throw new ClaimError(
      "provenance_unresolved",
      "claim/v2 support cites an unknown event",
    );
  }
  return row.content_hash;
}

/**
 * The admission record is caller-supplied JSON headed for a durable column, so
 * it is snapshotted under the same bound as the v2 payload before it is bound
 * as a parameter. An unbounded blob is ledger bloat and an unreviewed sink for
 * personal data no erasure path knows how to scrub; an `undefined` one would
 * serialize to SQL NULL against a NOT NULL column.
 */
function requireSupport(input: ClaimV2SupportAdmission): ExactJson {
  if (input.source_key.length === 0) {
    throw new ClaimError("schema_invalid", "claim/v2 support needs a source key");
  }
  if (!Number.isInteger(input.grant_revision) || input.grant_revision < 0) {
    throw new ClaimError(
      "schema_invalid",
      "claim/v2 support needs a whole grant revision",
    );
  }
  if (input.events.length === 0) {
    throw new ClaimError(
      "schema_invalid",
      "claim/v2 support needs at least one event",
    );
  }
  if (!isRfc3339(input.admitted_at)) {
    throw new ClaimError(
      "schema_invalid",
      "claim/v2 support needs an RFC 3339 admitted_at",
    );
  }
  // Anchors are caller-supplied, hashed into the support key and written
  // durably, so they pass exactly the guard the semantic's own anchors pass -
  // one predicate, not a second looser parser - and may point only at events
  // this support already cites. An anchor on a foreign or more sensitive event
  // would otherwise publish that event's id and its exact character offsets
  // under this claim's label, reachable by `claim_v2_support.claim_id`, while
  // every consent check below runs on `events` alone and so never raises the
  // claim to that event's source floor.
  if (!isTextAnchorList(input.anchors, 0)) {
    throw new ClaimError(
      "schema_invalid",
      "claim/v2 support needs well-formed anchors",
    );
  }
  const cited = new Set(input.events.map((event) => event.event_id));
  if (!input.anchors.every((anchor) => cited.has(anchor.event_id))) {
    throw new ClaimError(
      "provenance_unresolved",
      "claim/v2 support anchors an event its support does not cite",
    );
  }
  const errors: string[] = [];
  const admission = cloneExactJson(
    input.admission,
    "claim_v2_admission",
    CLAIM_V2_SNAPSHOT_LIMITS,
    errors,
  );
  if (admission === undefined || errors.length > 0 || !isPlainObject(admission)) {
    throw new ClaimError(
      "schema_invalid",
      "claim/v2 support needs a valid admission",
    );
  }
  return admission;
}

/**
 * `source_key` and `grant_revision` snapshot the *verified* source identity at
 * admission, so they are checked here rather than trusted: every cited event
 * must actually be bound to that source, the caller must be allowed to read
 * those events under its own scope, and the snapshot must name the grant
 * revision that is live now. Without this, evidence supplied by one source
 * could be recorded as admitted under another source's consent, and the first
 * source's revocation sweep - which is keyed on `source_key` - would miss it.
 */
function requireAdmittedSource(
  db: Database,
  support: ClaimV2SupportAdmission,
  scope: SourceReadScope,
): void {
  for (const event of support.events) {
    const binding = db
      .query<{ source_key: string }, [string]>(
        "SELECT source_key FROM source_event_bindings WHERE event_id = ?",
      )
      .get(event.event_id);
    if (binding === null || binding.source_key !== support.source_key) {
      throw new ClaimError(
        "provenance_unresolved",
        "claim/v2 support cites an event its named source did not supply",
      );
    }
  }
  requireSourceEvents(
    db,
    support.events.map((event) => event.event_id),
    scope,
  );
  const grant = inspectSourceGrant(db, support.source_key);
  if (
    grant === null ||
    grant.status !== "active" ||
    grant.revision !== support.grant_revision
  ) {
    throw new ClaimError(
      "provenance_unresolved",
      "claim/v2 support needs the live grant revision of its source",
    );
  }
}

/**
 * Support binds events that the v1 provenance may not carry, and a by-event
 * index makes them reachable from the claim. The claim's label therefore has
 * to absorb their source floors too, or a reader filtering on
 * `claims.sensitivity` would expand support it is not cleared for. Mirrors the
 * raise `applyClaimInsert` performs over the v1 provenance.
 */
function raiseClaimSensitivity(
  db: Database,
  claimId: string,
  current: Sensitivity,
  eventIds: readonly string[],
): void {
  const raised = stricter(current, sourceSensitivity(db, eventIds, current));
  if (raised === current) return;
  db.query("UPDATE claims SET sensitivity = ? WHERE claim_id = ?").run(
    raised,
    claimId,
  );
}

export function commitClaimV2(
  db: Database,
  claimId: string,
  input: ClaimV2CommitInput,
): ClaimV2CommitResult {
  if (!db.inTransaction) {
    throw new Error("prepared claim requires a transaction");
  }
  const parent = db
    .query<{ claim_id: string; sensitivity: Sensitivity }, [string]>(
      "SELECT claim_id, sensitivity FROM claims WHERE claim_id = ?",
    )
    .get(claimId);
  if (parent === null) {
    throw new ClaimError(
      "schema_invalid",
      "claim/v2 commit needs an existing claims row",
    );
  }

  const admission = requireSupport(input.support);
  const mapped = toClaimV2SemanticRow(claimId, input.semantic);
  if (!mapped.ok) {
    throw new ClaimError("schema_invalid", "invalid claim/v2 payload");
  }
  const row = mapped.value;

  for (const event of input.support.events) {
    const stored = eventHash(db, event.event_id);
    if (stored !== event.event_content_hash) {
      throw new ClaimError(
        "schema_invalid",
        "claim/v2 support event hash does not match the stored event",
      );
    }
  }
  requireAdmittedSource(db, input.support, input.scope);

  const existing = db
    .query<{ semantic_key: string }, [string]>(
      "SELECT semantic_key FROM claim_v2_semantics WHERE claim_id = ?",
    )
    .get(claimId);
  if (existing === null) {
    db.query(
      `INSERT INTO claim_v2_semantics
         (claim_id, semantic_key, schema, discriminator, subject_kind, subject_id,
          predicate, object_kind, polarity, temporal_basis, valid_from, valid_to, payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.claim_id,
      row.semantic_key,
      row.schema,
      row.discriminator,
      row.subject_kind,
      row.subject_id,
      row.predicate,
      row.object_kind,
      row.polarity,
      row.temporal_basis,
      row.valid_from,
      row.valid_to,
      row.payload,
    );
  } else if (existing.semantic_key !== row.semantic_key) {
    throw new ClaimError(
      "schema_invalid",
      "claim/v2 semantics are immutable once written",
    );
  }

  const supportKeyValue = supportKey({
    semantic_key: row.semantic_key,
    source_key: input.support.source_key,
    grant_revision: input.support.grant_revision,
    events: input.support.events,
    anchors: input.support.anchors,
  });
  // Duplicate support is a primary-key collision on a key we can look up, so it
  // is read rather than inferred from a swallowed write: `OR IGNORE` would
  // report any other constraint failure as an already-recorded sighting and
  // leave a durable claim behind with no evidence chain at all.
  const duplicateSupport =
    db
      .query<{ support_key: string }, [string]>(
        "SELECT support_key FROM claim_v2_support WHERE support_key = ?",
      )
      .get(supportKeyValue) !== null;
  if (!duplicateSupport) {
    const written = db.query(
      `INSERT INTO claim_v2_support
         (support_key, claim_id, anchors, source_key, grant_revision, admission, admitted_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      supportKeyValue,
      claimId,
      canonicalJson(input.support.anchors),
      input.support.source_key,
      input.support.grant_revision,
      canonicalJson(admission),
      input.support.admitted_at,
    );
    if (written.changes !== 1) {
      throw new ClaimError(
        "schema_invalid",
        "claim/v2 support row was refused by the ledger",
      );
    }
    const insertEvent = db.query(
      "INSERT INTO claim_v2_support_events (support_key, event_id, event_content_hash) VALUES (?,?,?)",
    );
    for (const event of input.support.events) {
      insertEvent.run(
        supportKeyValue,
        event.event_id,
        event.event_content_hash,
      );
    }
  }
  raiseClaimSensitivity(
    db,
    claimId,
    parent.sensitivity,
    input.support.events.map((event) => event.event_id),
  );

  return {
    semantic_key: row.semantic_key,
    support_key: supportKeyValue,
    duplicate_support: duplicateSupport,
  };
}

export function readClaimV2Semantic(
  db: Database,
  claimId: string,
): ClaimV2Semantic | null {
  const row = db
    .query<{ payload: string }, [string]>(
      "SELECT payload FROM claim_v2_semantics WHERE claim_id = ?",
    )
    .get(claimId);
  if (row === null) return null;
  const parsed = fromClaimV2SemanticRow(row);
  if (!parsed.ok) {
    throw new ClaimError("schema_invalid", "invalid claim/v2 payload");
  }
  return parsed.value;
}

export function readClaimRecord(
  db: Database,
  claimId: string,
): ClaimRecord | null {
  const claim = getClaim(db, claimId);
  if (claim === null) return null;
  const semantic = readClaimV2Semantic(db, claimId);
  if (semantic === null) {
    return { schema: CLAIM_SCHEMA, claim };
  }
  return { schema: CLAIM_V2_SCHEMA, claim, semantic };
}
