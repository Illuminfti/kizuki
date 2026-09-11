import type { Database } from "bun:sqlite";
import type { DenyReason, Principal, Sensitivity, Tool } from "../agents";
import type { AuthorityTier } from "../contracts/proposal";
import type { RetrievalPort } from "../contracts/retrieval";
import type { PageTaint } from "../vault/schema";

export const ENVELOPE_SCHEMA = "kizuki.envelope/v1" as const;

export interface ServeContext {
  /**
   * Authoritative ledger and agent schemas are already initialized. Missing
   * optional indexes are degradation, never repaired by reads. Rate and audit
   * key on agent_audit; query-only contexts have a separate bound audit capability.
   */
  db: Database;
  vaultPath: string;
  principal: Principal;
  sourcePurpose?: import("../ledger/source-grants").SourcePurpose;
  /** One host-owned engine nominates IDs; core rechecks current evidence and grants. */
  retrieval?: RetrievalPort;
  /** A configured optional engine could not bind; reads use the deterministic floor. */
  retrievalUnavailable?: true | "configured-engine-unavailable";
}

export interface CanonChunk {
  page_id: string;
  path: string;
  title: string;
  type: string;
  sensitivity: Sensitivity;
  /** `quoted` means the body or attached identity includes quoted capture. */
  taint: PageTaint;
  /** Effective authority of the page snapshot, resolved against its byte hash. */
  authority: AuthorityTier | null;
  subjects: string[];
  sources: string[];
  excerpt: string;
  truncated: boolean;
  subject_labels?: SubjectLabel[];
}

/** Current, separately admitted identity beliefs; never captured display metadata. */
export interface SubjectLabel {
  subject: string;
  display_name: string | null;
  handles: string[];
  evidence: { claim_id: string; authority: AuthorityTier; sources: string[] }[];
}

export type SubjectLabelDegradation = "subject-labels-ambiguous" | "subject-labels-overflow" | "subject-labels-unavailable";

export interface QuotedChunk {
  event_id: string;
  connector_id: string;
  kind: string;
  occurred_at: string;
  sensitivity: Sensitivity;
  subjects: string[];
  text: string;
  tainted: true;
  subject_labels?: SubjectLabel[];
}

/** Counts per reason on owner envelopes. Agent envelopes omit counts. Ids of withheld items reach only the owner's audit row. */
export interface Denied {
  reason: DenyReason;
  count: number;
}

// `type`, not `interface`: the MCP layer hands the envelope to the SDK as
// `structuredContent: Record<string, unknown>`, which an interface cannot
// satisfy without a cast.
export type Envelope<T = undefined> = {
  schema: typeof ENVELOPE_SCHEMA;
  tool: Tool;
  principal: string;
  at: string;
  canon: CanonChunk[];
  quoted: QuotedChunk[];
  denied: Denied[];
  /** Owner envelopes only. True when at least one match was withheld. */
  has_withheld?: true;
  source_policy?: { mode: "enforced"; epoch: number; legacy_unbound: "owner_only" };
  data?: T;
};

/**
 * `message` is stable and generic: no captured text, no path, and no
 * caller-supplied id. The original failure rides on `cause` for the owner's
 * own tooling and is never forwarded to an agent.
 */
export class ServeError extends Error {
  override name = "ServeError";
  readonly code: DenyReason;
  readonly retry_after_seconds: number | null;

  constructor(
    code: DenyReason,
    message: string,
    opts: { retry_after_seconds?: number; cause?: unknown } = {},
  ) {
    super(message, "cause" in opts ? { cause: opts.cause } : {});
    this.code = code;
    this.retry_after_seconds = opts.retry_after_seconds ?? null;
  }
}
