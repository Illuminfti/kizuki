import type { Database } from "bun:sqlite";
import type { DenyReason, Principal, Sensitivity, Tool } from "../agents";
import type { AuthorityTier } from "../contracts/proposal";
import type { RetrievalPort } from "../contracts/retrieval";
import type { PageTaint } from "../vault/schema";

export const ENVELOPE_SCHEMA = "kizuki.envelope/v1" as const;

export interface ServeContext {
  /**
   * Ledger, staging, search, graph and agent schemas already initialized.
   * Rate accounting and audit both key on `agent_audit`, so `initAgents` in
   * particular must have run before the first served call.
   */
  db: Database;
  vaultPath: string;
  principal: Principal;
  /**
   * One `kizuki.retrieval/v1` connection, bound by the host for the life of
   * the process and handed to the claim store, which uses it to nominate
   * near-duplicates and to index what it writes. Reads still go to the
   * lexical index in this database: no implementation of the port ships in
   * this tree, and routing reads through a port nobody has registered would
   * answer nothing where the deterministic floor answers (invariant 5).
   */
  retrieval?: RetrievalPort;
}

export interface CanonChunk {
  page_id: string;
  path: string;
  title: string;
  type: string;
  sensitivity: Sensitivity;
  /** `quoted` means the body carries verbatim capture inside blockquotes. */
  taint: PageTaint;
  /** The tier of the receipt that last wrote the page; null when unwritten. */
  authority: AuthorityTier | null;
  subjects: string[];
  sources: string[];
  excerpt: string;
  truncated: boolean;
}

export interface QuotedChunk {
  event_id: string;
  connector_id: string;
  kind: string;
  occurred_at: string;
  sensitivity: Sensitivity;
  subjects: string[];
  text: string;
  tainted: true;
}

/** Counts per reason. Ids of withheld items reach only the owner's audit row. */
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
