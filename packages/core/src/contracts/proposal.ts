import { isRfc3339 } from "../util/time";
import { isNonEmptyString, isPlainObject } from "../util/validate";
import type { ValidationResult } from "../util/validate";

export const PROPOSAL_SCHEMA = "kizuki.proposal/v1" as const;

export const PROPOSAL_KINDS = [
  "entity",
  "claim",
  "edit",
  "merge",
  "deletion",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "superseded",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** `agent:<id>` names the harness that filed the proposal through the MCP `propose` tool. */
export type Producer = "deterministic" | "llm" | `agent:${string}`;

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface Proposal {
  schema: typeof PROPOSAL_SCHEMA;
  proposal_id: string; // ULID, spine-generated
  kind: ProposalKind;
  provenance: string[]; // event_ids this was derived from; never empty
  producer: Producer;
  status: ProposalStatus;
  payload: Record<string, unknown>; // kind-specific body, persisted verbatim
  content_hash: string; // sha256 hex; idempotency key for re-filed proposals
  created_at: string; // RFC3339
}

export function isProducer(v: unknown): v is Producer {
  if (typeof v !== "string") return false;
  if (v === "deterministic" || v === "llm") return true;
  if (!v.startsWith("agent:")) return false;
  return AGENT_ID.test(v.slice("agent:".length));
}

export function validateProposal(input: unknown): ValidationResult<Proposal> {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ["proposal: must be a plain object"] };
  }

  if (input["schema"] !== PROPOSAL_SCHEMA) {
    errors.push(`schema: must be "${PROPOSAL_SCHEMA}"`);
  }
  if (!isNonEmptyString(input["proposal_id"])) {
    errors.push("proposal_id: must be a non-empty string");
  }

  const kind = input["kind"];
  if (
    typeof kind !== "string" ||
    !(PROPOSAL_KINDS as readonly string[]).includes(kind)
  ) {
    errors.push(`kind: must be one of ${PROPOSAL_KINDS.join(" | ")}`);
  }

  const provenance = input["provenance"];
  if (!Array.isArray(provenance)) {
    errors.push("provenance: must be an array of event_ids");
  } else if (provenance.length === 0) {
    errors.push("provenance: must name at least one event_id");
  } else if (!provenance.every(isNonEmptyString)) {
    errors.push("provenance: every entry must be a non-empty string");
  }

  if (!isProducer(input["producer"])) {
    errors.push('producer: must be "deterministic", "llm", or "agent:<id>"');
  }

  const status = input["status"];
  if (
    typeof status !== "string" ||
    !(PROPOSAL_STATUSES as readonly string[]).includes(status)
  ) {
    errors.push(`status: must be one of ${PROPOSAL_STATUSES.join(" | ")}`);
  }

  if (!isPlainObject(input["payload"])) {
    errors.push("payload: must be a plain object");
  }

  const contentHash = input["content_hash"];
  if (typeof contentHash !== "string" || !SHA256_HEX.test(contentHash)) {
    errors.push("content_hash: must be 64 lowercase hex characters");
  }

  if (!isRfc3339(input["created_at"])) {
    errors.push("created_at: must be an RFC3339 timestamp");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      schema: PROPOSAL_SCHEMA,
      proposal_id: input["proposal_id"] as string,
      kind: kind as ProposalKind,
      provenance: [...(provenance as string[])],
      producer: input["producer"] as Producer,
      status: status as ProposalStatus,
      payload: input["payload"] as Record<string, unknown>,
      content_hash: contentHash as string,
      created_at: input["created_at"] as string,
    },
  };
}
