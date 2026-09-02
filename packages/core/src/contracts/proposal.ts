import type { Sensitivity } from "../agents/types";
import { isRfc3339 } from "../util/time";
import { isNonEmptyString, isPlainObject } from "../util/validate";
import type { ValidationResult } from "../util/validate";

/**
 * `kizuki.claim/v1` replaces the unused `kizuki.proposal/v1` shape (RFC 0002
 * §4.3). There is one claim vocabulary in the tree.
 */
export const CLAIM_SCHEMA = "kizuki.claim/v1" as const;
/** @deprecated RFC 0002 retires the unused proposal envelope; prefer CLAIM_SCHEMA. */
export const PROPOSAL_SCHEMA = CLAIM_SCHEMA;

export const CLAIM_KINDS = [
  "entity",
  "claim",
  "edit",
  "merge",
  "deletion",
  "purge_review",
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const PROPOSAL_KINDS = CLAIM_KINDS;
export type ProposalKind = ClaimKind;

export const AUTHORITY_TIERS = {
  owner_correction: 4,
  owner_authored: 3,
  connector_evidence: 2,
  model_inference: 1,
} as const;
export type AuthorityTier = keyof typeof AUTHORITY_TIERS;

export const CLAIM_STATUSES = [
  "live",
  "superseded",
  "reverted",
  "purged",
  "skipped",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * Canonical producers are `deterministic | model | owner | agent:<id>`.
 * `llm` is accepted at the seam and stored as `model` (RFC 0002 §4.3).
 */
export type Producer = "deterministic" | "llm" | "model" | "owner" | `agent:${string}`;
export type CanonicalProducer = Exclude<Producer, "llm">;

export type FrontmatterScalar = string | number | boolean;
export type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[];

export const CLAIM_POLARITIES = ["positive", "negative"] as const;
export type ClaimPolarity = (typeof CLAIM_POLARITIES)[number];

export const CLAIM_TAINTS = ["clean", "quoted"] as const;
export type ClaimTaint = (typeof CLAIM_TAINTS)[number];

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SENSITIVITIES = ["public", "personal", "private"] as const;

export interface Claim {
  schema: typeof CLAIM_SCHEMA;
  claim_id: string;
  kind: ClaimKind;
  target: string | null;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  polarity: ClaimPolarity;
  claim_key: string | null;
  body: string;
  frontmatter: Record<string, FrontmatterValue>;
  provenance: string[];
  subjects: string[];
  producer: CanonicalProducer;
  model_ref: string | null;
  authority: AuthorityTier;
  confidence: number;
  sensitivity: Sensitivity;
  taint: ClaimTaint;
  valid_from: string;
  valid_to: string | null;
  asserted_at: string;
  retracted_at: string | null;
  status: ClaimStatus;
  superseded_by: string | null;
  receipt_id: string | null;
  body_hash: string;
  created_at: string;
  corroboration: number;
  last_confirmed_at: string | null;
}

/** @deprecated Unused proposal envelope; prefer {@link Claim}. */
export type Proposal = Claim;
export type ProposalStatus = ClaimStatus;
export const PROPOSAL_STATUSES = CLAIM_STATUSES;

export function isProducer(v: unknown): v is Producer {
  if (typeof v !== "string") return false;
  if (
    v === "deterministic" ||
    v === "llm" ||
    v === "model" ||
    v === "owner"
  ) {
    return true;
  }
  if (!v.startsWith("agent:")) return false;
  return AGENT_ID.test(v.slice("agent:".length));
}

export function canonicalizeProducer(v: Producer): CanonicalProducer {
  return v === "llm" ? "model" : v;
}

export function isAuthorityTier(v: unknown): v is AuthorityTier {
  return typeof v === "string" && v in AUTHORITY_TIERS;
}

export function isClaimKind(v: unknown): v is ClaimKind {
  return typeof v === "string" && (CLAIM_KINDS as readonly string[]).includes(v);
}

export function isClaimStatus(v: unknown): v is ClaimStatus {
  return (
    typeof v === "string" && (CLAIM_STATUSES as readonly string[]).includes(v)
  );
}

function isFrontmatterValue(v: unknown): v is FrontmatterValue {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return true;
  }
  return (
    Array.isArray(v) &&
    v.every(
      (item) =>
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean",
    )
  );
}

export function validateClaim(input: unknown): ValidationResult<Claim> {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ["claim: must be a plain object"] };
  }

  if (input["schema"] !== CLAIM_SCHEMA) {
    errors.push(`schema: must be "${CLAIM_SCHEMA}"`);
  }
  if (!isNonEmptyString(input["claim_id"])) {
    errors.push("claim_id: must be a non-empty string");
  }
  if (!isClaimKind(input["kind"])) {
    errors.push(`kind: must be one of ${CLAIM_KINDS.join(" | ")}`);
  }

  const target = input["target"];
  if (target !== null && !isNonEmptyString(target)) {
    errors.push("target: must be null or a non-empty string");
  }
  const subject = input["subject"];
  if (subject !== null && !isNonEmptyString(subject)) {
    errors.push("subject: must be null or a non-empty string");
  }
  const predicate = input["predicate"];
  if (predicate !== null && !isNonEmptyString(predicate)) {
    errors.push("predicate: must be null or a non-empty string");
  }
  const object = input["object"];
  if (object !== null && typeof object !== "string") {
    errors.push("object: must be null or a string");
  }

  const polarity = input["polarity"];
  if (
    polarity !== "positive" &&
    polarity !== "negative"
  ) {
    errors.push('polarity: must be "positive" or "negative"');
  }

  const claimKey = input["claim_key"];
  if (claimKey !== null && (typeof claimKey !== "string" || !SHA256_HEX.test(claimKey))) {
    errors.push("claim_key: must be null or 64 lowercase hex characters");
  }

  if (typeof input["body"] !== "string") {
    errors.push("body: must be a string");
  }

  const frontmatter = input["frontmatter"];
  if (!isPlainObject(frontmatter)) {
    errors.push("frontmatter: must be a plain object");
  } else if (!Object.values(frontmatter).every(isFrontmatterValue)) {
    errors.push("frontmatter: values must be scalars or scalar arrays");
  }

  const provenance = input["provenance"];
  if (!Array.isArray(provenance)) {
    errors.push("provenance: must be an array of event_ids");
  } else if (provenance.length === 0) {
    errors.push("provenance: must name at least one event_id");
  } else if (!provenance.every(isNonEmptyString)) {
    errors.push("provenance: every entry must be a non-empty string");
  }

  const subjects = input["subjects"];
  if (!Array.isArray(subjects) || !subjects.every((item) => typeof item === "string")) {
    errors.push("subjects: must be a string array");
  }

  if (!isProducer(input["producer"]) || input["producer"] === "llm") {
    errors.push('producer: must be "deterministic", "model", "owner", or "agent:<id>"');
  }

  const modelRef = input["model_ref"];
  if (modelRef !== null && !isNonEmptyString(modelRef)) {
    errors.push("model_ref: must be null or a non-empty string");
  }

  if (!isAuthorityTier(input["authority"])) {
    errors.push(
      `authority: must be one of ${Object.keys(AUTHORITY_TIERS).join(" | ")}`,
    );
  }

  const confidence = input["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    errors.push("confidence: must be a number in [0, 1]");
  }

  const sensitivity = input["sensitivity"];
  if (
    typeof sensitivity !== "string" ||
    !(SENSITIVITIES as readonly string[]).includes(sensitivity)
  ) {
    errors.push('sensitivity: must be "public", "personal", or "private"');
  }

  if (input["taint"] !== "clean" && input["taint"] !== "quoted") {
    errors.push('taint: must be "clean" or "quoted"');
  }

  if (!isRfc3339(input["valid_from"])) {
    errors.push("valid_from: must be an RFC3339 timestamp");
  }
  const validTo = input["valid_to"];
  if (validTo !== null && !isRfc3339(validTo)) {
    errors.push("valid_to: must be null or an RFC3339 timestamp");
  }
  if (!isRfc3339(input["asserted_at"])) {
    errors.push("asserted_at: must be an RFC3339 timestamp");
  }
  const retractedAt = input["retracted_at"];
  if (retractedAt !== null && !isRfc3339(retractedAt)) {
    errors.push("retracted_at: must be null or an RFC3339 timestamp");
  }

  if (!isClaimStatus(input["status"])) {
    errors.push(`status: must be one of ${CLAIM_STATUSES.join(" | ")}`);
  }

  const supersededBy = input["superseded_by"];
  if (supersededBy !== null && !isNonEmptyString(supersededBy)) {
    errors.push("superseded_by: must be null or a non-empty string");
  }
  const receiptId = input["receipt_id"];
  if (receiptId !== null && !isNonEmptyString(receiptId)) {
    errors.push("receipt_id: must be null or a non-empty string");
  }

  const bodyHash = input["body_hash"];
  if (typeof bodyHash !== "string" || !SHA256_HEX.test(bodyHash)) {
    errors.push("body_hash: must be 64 lowercase hex characters");
  }
  if (!isRfc3339(input["created_at"])) {
    errors.push("created_at: must be an RFC3339 timestamp");
  }

  const corroboration = input["corroboration"];
  if (
    typeof corroboration !== "number" ||
    !Number.isSafeInteger(corroboration) ||
    corroboration < 1
  ) {
    errors.push("corroboration: must be an integer >= 1");
  }
  const lastConfirmed = input["last_confirmed_at"];
  if (lastConfirmed !== null && !isRfc3339(lastConfirmed)) {
    errors.push("last_confirmed_at: must be null or an RFC3339 timestamp");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      schema: CLAIM_SCHEMA,
      claim_id: input["claim_id"] as string,
      kind: input["kind"] as ClaimKind,
      target: target as string | null,
      subject: subject as string | null,
      predicate: predicate as string | null,
      object: object as string | null,
      polarity: polarity as ClaimPolarity,
      claim_key: claimKey as string | null,
      body: input["body"] as string,
      frontmatter: { ...(frontmatter as Record<string, FrontmatterValue>) },
      provenance: [...(provenance as string[])],
      subjects: [...(subjects as string[])],
      producer: input["producer"] as CanonicalProducer,
      model_ref: modelRef as string | null,
      authority: input["authority"] as AuthorityTier,
      confidence: confidence as number,
      sensitivity: sensitivity as Sensitivity,
      taint: input["taint"] as ClaimTaint,
      valid_from: input["valid_from"] as string,
      valid_to: validTo as string | null,
      asserted_at: input["asserted_at"] as string,
      retracted_at: retractedAt as string | null,
      status: input["status"] as ClaimStatus,
      superseded_by: supersededBy as string | null,
      receipt_id: receiptId as string | null,
      body_hash: bodyHash as string,
      created_at: input["created_at"] as string,
      corroboration: corroboration as number,
      last_confirmed_at: lastConfirmed as string | null,
    },
  };
}

/** @deprecated Prefer {@link validateClaim}. */
export function validateProposal(input: unknown): ValidationResult<Claim> {
  return validateClaim(input);
}
