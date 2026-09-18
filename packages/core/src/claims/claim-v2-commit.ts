import type { Database } from "bun:sqlite";
import { CLAIM_V2_SCHEMA, type ClaimV2Semantic } from "../contracts/claim-v2";
import type { TextAnchor } from "../contracts/producer-v2";
import { CLAIM_SCHEMA, type Claim } from "../contracts/proposal";
import { canonicalJson } from "../util/hash";
import { isRfc3339 } from "../util/time";
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

function requireSupport(input: ClaimV2SupportAdmission): void {
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
    .query<{ claim_id: string }, [string]>(
      "SELECT claim_id FROM claims WHERE claim_id = ?",
    )
    .get(claimId);
  if (parent === null) {
    throw new ClaimError(
      "schema_invalid",
      "claim/v2 commit needs an existing claims row",
    );
  }

  requireSupport(input.support);
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
  const written = db.query(
    `INSERT OR IGNORE INTO claim_v2_support
       (support_key, claim_id, anchors, source_key, grant_revision, admission, admitted_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    supportKeyValue,
    claimId,
    canonicalJson(input.support.anchors),
    input.support.source_key,
    input.support.grant_revision,
    canonicalJson(input.support.admission),
    input.support.admitted_at,
  );
  const duplicateSupport = written.changes === 0;
  if (!duplicateSupport) {
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
