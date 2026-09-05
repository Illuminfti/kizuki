/** Bounded semantic dry-run only. This is neither a backup nor an apply grant. */
export const ESTATE_IMPORT_LIMITS = Object.freeze({ sourceBytes: 1_048_576, authorizationBytes: 65_536, sources: 32, records: 256 });

export type EstateIssueCode =
  | "authorization_revoked" | "retention_incompatible" | "egress_unsupported"
  | "field_not_allowed" | "unknown_event_time" | "foreign_authority_not_applied"
  | "historical_claim_times_metadata_only" | "alias_ambiguous" | "aliases_not_applied"
  | "relationship_unresolved" | "relationships_not_applied"
  | "attachment_bytes_not_transferred" | "domain_not_owned";

export interface EstateImportIssue {
  /** Indices only: untrusted IDs and source content never enter diagnostics. */
  source: number | null;
  record: number | null;
  code: EstateIssueCode;
  disposition: "blocked" | "preserved_as_source_metadata";
}

export interface EstateImportMapping {
  source: number;
  record: number;
  /** Domain-separated hash of original source and record IDs, not an event ID. */
  target_source_record_id: string;
  disposition: "event_template" | "blocked";
}

export interface EstateImportReport {
  schema: "kizuki.estate-plan/v1";
  source_sha256: string;
  authorization_sha256: string;
  plan_sha256: string;
  status: "compatible" | "blocked";
  records: number;
  mappings: EstateImportMapping[];
  issues: EstateImportIssue[];
  limitations: string[];
}

/** All keys are required; unknown keys, including credential fields, are refused. */
export interface EstateSlice {
  schema: "kizuki.estate-slice/v1";
  sources: Array<{
    source_id: string;
    consent_generation: number;
    records: EstateRecord[];
  }>;
}

export interface EstateRecord {
  record_id: string;
  domain: "memory" | "goals" | "projects" | "commitments" | "habits" | "metrics" | "insights" | "conversation";
  text: string;
  occurred_at: string | null;
  observed_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  asserted_at: string | null;
  authority: "connector_evidence" | "owner_authored" | "owner_correction" | "model_inference";
  sensitivity: "public" | "personal" | "private";
  subjects: string[];
  aliases: Array<{ subject_id: string; display_name: string }>;
  correction_of: string | null;
  supersedes: string[];
  attachments: Array<{ attachment_id: string; media_type: string }>;
  /** SHA-256 of exact UTF-8 text, with its original source line span. */
  provenance: { sha256: string; line_start: number; line_end: number };
  state: string | null;
  value: number | null;
}

/**
 * A planning declaration, NOT a durable grant or proof of owner identity.
 * The digest binds exact UTF-8 source JSON bytes. All sources must match its
 * generation and source_ids set. Every present field group requires allowance.
 * Only persistent_owned_copy and local_only are compatible; other strings
 * yield explicit blockers. No network or storage enforcement is installed.
 */
export interface EstateAuthorization {
  schema: "kizuki.estate-authorization/v1";
  source_sha256: string;
  source_ids: string[];
  generation: number;
  revoked: boolean;
  purpose: "estate-import";
  retention: string;
  egress: string;
  sensitivity_floor: "public" | "personal" | "private";
  allowed_fields: Array<"text" | "times" | "authority" | "provenance" | "subjects" | "aliases" | "relationships" | "attachments" | "domain_state">;
}
