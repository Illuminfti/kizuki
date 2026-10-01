import type { Database } from "bun:sqlite";
import type { Grant } from "../agents/types";
import type { ClaimV2Object } from "../contracts/claim-v2";
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

export const CORRECTION_MODES = ["replace_object", "retract", "reclassify_mode"] as const;
export type CorrectionMode = (typeof CORRECTION_MODES)[number];
/** The perspective modes a claim can be reclassified to: what the owner calls an idea rather than a fact. */
export const RECLASSIFIED_MODES = ["suggested", "hypothetical", "questioned"] as const;
export type ReclassifiedMode = (typeof RECLASSIFIED_MODES)[number];

/**
 * What a correction does to a typed world claim. Every mode files one new
 * owner-authority claim beside the old one and retires the old one; none is a
 * second write path. Without it the claim's object is replaced by the statement.
 */
export type WorldCorrection =
  | { readonly mode: "replace_object"; readonly object?: ClaimV2Object }
  | { readonly mode: "retract" }
  | { readonly mode: "reclassify_mode"; readonly to: ReclassifiedMode };

export interface CorrectInput {
  /** 1..2000 chars; the owner's words, stored verbatim. */
  statement: string;
  target?: CorrectTarget;
  scope?: { since?: string; until?: string };
  dry_run?: boolean;
  /** Typed world claims only; a legacy claim refuses it. */
  world?: WorldCorrection;
}

export interface CanonRecoveryPending {
  receipt_id: string;
  page_path: string;
  phase: 'write' | 'projection';
}

export interface CorrectResult {
  /** Present when completion is held. Entries name only known affected pages;
   * an empty array reports a blocking hold without disclosing unrelated metadata. */
  recovery_pending?: CanonRecoveryPending[];
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
    receipt_id: string | null;
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
  /** Default `owner`. An enrolled `agent:<id or name>` uses its stored grant and records `x-relayed-by`. */
  readonly producer?: Producer;
  /**
   * RFC 0002 §6.4. False downgrades the insert to `owner_authored`.
   * Default true.
   */
  readonly relay_owner_corrections?: boolean;
  /** Optional trusted owner restriction. Agents always use their current stored grant. */
  readonly grant?: Grant;
}
