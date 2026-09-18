import type { ClaimV2Semantic } from "../contracts/claim-v2";
import { validateClaimV2Semantic } from "../contracts/claim-v2";
import { canonicalJson } from "../util/hash";
import { semanticKey } from "./claim-v2-keys";

/**
 * The I/O-free mapper between a validated `kizuki.claim/v2` semantic and its
 * `claim_v2_semantics` row. Shape validation is delegated to
 * `validateClaimV2Semantic`; this module never adds a second parser for the
 * schema, and it refuses anything that validator rejects rather than writing it.
 */

export interface ClaimV2SemanticRow {
  readonly claim_id: string;
  readonly semantic_key: string;
  readonly schema: string;
  readonly discriminator: string;
  readonly subject_kind: string | null;
  readonly subject_id: string | null;
  readonly predicate: string | null;
  readonly object_kind: string | null;
  readonly polarity: string | null;
  readonly temporal_basis: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly payload: string;
}

export type ClaimV2RowResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ["invalid claim/v2 payload"];
    };

const INVALID: ClaimV2RowResult<never> = Object.freeze({
  ok: false,
  errors: Object.freeze(["invalid claim/v2 payload"] as const),
});

/**
 * Canonical JSON is the stored form, so a row read back and re-encoded is
 * byte-identical to what was written regardless of key order on the way in.
 */
export function toClaimV2SemanticRow(
  claimId: string,
  semantic: unknown,
): ClaimV2RowResult<ClaimV2SemanticRow> {
  const validated = validateClaimV2Semantic(semantic);
  if (!validated.ok) return INVALID;
  const value = validated.value;
  const common = {
    claim_id: claimId,
    semantic_key: semanticKey(value),
    schema: value.schema,
    discriminator: value.discriminator,
    payload: canonicalJson(value),
  };
  if (value.discriminator === "identity_control") {
    return {
      ok: true,
      value: {
        ...common,
        subject_kind: null,
        subject_id: null,
        predicate: null,
        object_kind: null,
        polarity: null,
        temporal_basis: null,
        valid_from: null,
        valid_to: null,
      },
    };
  }
  return {
    ok: true,
    value: {
      ...common,
      subject_kind: value.subject.kind,
      subject_id: value.subject.id,
      predicate: value.predicate,
      object_kind: value.object.kind,
      polarity: value.polarity,
      temporal_basis: value.temporal_basis,
      valid_from: value.valid_from,
      valid_to: value.valid_to,
    },
  };
}

/**
 * Stored bytes are re-validated on the way out: a row hand-edited or corrupted
 * in the database is refused, never returned as a typed semantic.
 */
export function fromClaimV2SemanticRow(
  row: Pick<ClaimV2SemanticRow, "payload">,
): ClaimV2RowResult<ClaimV2Semantic> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return INVALID;
  }
  const validated = validateClaimV2Semantic(parsed);
  if (!validated.ok) return INVALID;
  return { ok: true, value: validated.value };
}
