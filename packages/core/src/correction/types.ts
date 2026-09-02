import type { Database } from "bun:sqlite";
import type { Grant } from "../agents/types";
import type { BudgetTracker } from "../canon/budget";
import type { RetrievalPort } from "../contracts/retrieval";
import type { Producer } from "../contracts/proposal";

export const CORRECTION_MATCH_MIN = 0.72;
export const CORRECTION_MAX_PAGES = 25;
export const OWNER_CONNECTOR_ID = "kizuki.owner";

export interface CorrectTarget {
  claim_id?: string;
  page_id?: string;
  subject?: string;
  claim_key?: string;
}

export interface CorrectInput {
  /** 1..2000 chars; the owner's words, stored verbatim. */
  statement: string;
  target?: CorrectTarget;
  scope?: { since?: string; until?: string };
  dry_run?: boolean;
}

export interface CorrectResult {
  receipt_id: string | null;
  event_id: string;
  claim_ids: string[];
  superseded: {
    claim_id: string;
    claim_key: string;
    was: string;
    page_path: string | null;
  }[];
  rewritten: {
    page_path: string;
    before_hash: string;
    after_hash: string;
    diff: string;
  }[];
  ambiguous: { claim_key: string; claim_ids: string[]; score: number }[];
  answer: string;
}

export interface CorrectIo {
  readonly db: Database;
  readonly vault_path: string;
  readonly now?: () => string;
  readonly ids?: () => string;
  readonly retrieval?: RetrievalPort;
  readonly retrieval_store?: string;
  readonly budget?: BudgetTracker;
  /** Default `owner`. An `agent:<id>` relay records `x-relayed-by`. */
  readonly producer?: Producer;
  /**
   * RFC 0002 §6.4. False downgrades the insert to `owner_authored`.
   * Default true.
   */
  readonly relay_owner_corrections?: boolean;
  /** When set, `correct` must be in `grant.tools`. */
  readonly grant?: Grant;
}
