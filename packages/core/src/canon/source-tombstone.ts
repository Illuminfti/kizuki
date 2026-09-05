import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import { assertPageRelPath } from "./arbiter";
import { pageIndexByPath, readPage } from "./store";
import { readEvent } from "../ledger/ledger";
import { requireSourceEvents } from "../ledger/source-grants";
import { isUlid } from "../util/ulid";
import type { ProposalInput } from "../staging/proposals";

/** Supplied by the host that opened the vault, never by connector evidence. */
export interface SourceTombstoneContext {
  readonly vault_path: string;
}

export class SourceTombstoneError extends Error {
  constructor(readonly code: "source_tombstone_stale" | "source_tombstone_vault_required") {
    super(code);
  }
}

const BINDING_KEYS = ["x-page-id", "x-page-hash", "x-page-receipt", "x-source-event", "x-page-proposal"];

// The same control crosses proposal, claim and final canon boundaries. It may
// never carry a structural assertion or a positive-belief binding key.
type SourceTombstoneInput = ProposalInput & {
  readonly subject?: string | null;
  readonly predicate?: string | null;
  readonly object?: string | null;
  readonly claim_key?: string | null;
  readonly authority?: string;
  readonly polarity?: "positive" | "negative";
  readonly intent?: "propose" | "correct";
};

/** A deleted source or retained control metadata cannot fall back to ordinary origin admission. */
export function requiresSourceTombstoneBinding(db: Database, input: ProposalInput): boolean {
  return BINDING_KEYS.some(key => key in input.frontmatter) ||
    (input.kind === "deletion" && input.provenance.some(id => readEvent(db, id)?.deleted === true));
}

/**
 * Historical paths are discovery hints only. Authority comes from the current
 * receipted bytes, their page identity, and a still-present member of this source.
 */
export function sourceTombstoneProposal(
  db: Database,
  tombstone: CaptureEvent,
  pagePath: string,
  context: SourceTombstoneContext,
): ProposalInput | null {
  assertPageRelPath(pagePath);
  if (!tombstone.deleted) return null;
  requireSourceEvents(db, [tombstone.event_id], { owner: true, purpose: "derive" });
  const indexed = pageIndexByPath(db, pagePath);
  if (indexed === null || !isUlid(indexed.page_id) || indexed.last_receipt === null) return null;
  const receipt = db.query<{ receipt_id: string; page_path: string; after_hash: string }, [string]>(
    "SELECT receipt_id,page_path,after_hash FROM canon_receipts WHERE receipt_id=?",
  ).get(indexed.last_receipt);
  if (receipt === null || receipt.page_path !== pagePath || receipt.after_hash !== indexed.last_hash) return null;
  const current = readPage({ db, vault_path: context.vault_path }, pagePath);
  if (current === null || current.page.data["id"] !== indexed.page_id ||
      current.hash !== indexed.last_hash || current.page.data["status"] !== "active") return null;
  const sources = current.page.data["sources"];
  if (!Array.isArray(sources) || sources.length > 4096 || !sources.every(isUlid)) return null;
  const binding = db.query<{ source_key: string }, [string]>("SELECT source_key FROM source_event_bindings WHERE event_id=?");
  const sourceKey = binding.get(tombstone.event_id)?.source_key ?? null;
  const sourceEvent = [...sources].sort().find(id => {
    const event = readEvent(db, id);
    return event !== null && !event.deleted && event.connector_id === tombstone.connector_id &&
      event.source_record_id === tombstone.source_record_id &&
      (binding.get(id)?.source_key ?? null) === sourceKey;
  });
  if (sourceEvent === undefined) return null;
  requireSourceEvents(db, [sourceEvent], { owner: true, purpose: "derive" });
  return {
    kind: "deletion",
    target: pagePath.replace(/\.md$/, ""),
    body: `Source record \`${tombstone.source_record_id}\` was deleted at ` +
      `\`${tombstone.connector_id}\`; canon page \`${pagePath}\` cites it. ` +
      `Page revision: \`${receipt.receipt_id}\`.`,
    frontmatter: {
      "x-connector": tombstone.connector_id,
      "x-source-record-id": tombstone.source_record_id,
      "x-page-id": indexed.page_id,
      "x-page-hash": current.hash,
      "x-page-receipt": receipt.receipt_id,
      "x-source-event": sourceEvent,
    },
    provenance: [tombstone.event_id],
    producer: "deterministic",
    confidence: 1,
  };
}

/** Recompute the Core tuple; callers cannot select an origin exemption with a label. */
export function isSourceTombstoneProposal(
  db: Database,
  input: SourceTombstoneInput,
  context?: SourceTombstoneContext,
): boolean {
  if (context === undefined || input.kind !== "deletion" || input.producer !== "deterministic" ||
      input.provenance.length !== 1 || typeof input.target !== "string" ||
      input.confidence !== 1 || (input.subjects?.length ?? 0) !== 0 ||
      (input.authority !== undefined && input.authority !== "connector_evidence") ||
      input.subject != null || input.predicate != null || input.object != null || input.claim_key != null ||
      (input.polarity !== undefined && input.polarity !== "positive") ||
      (input.intent !== undefined && input.intent !== "propose")) return false;
  const tombstone = readEvent(db, input.provenance[0]!);
  if (tombstone === null || !tombstone.deleted) return false;
  const expected = sourceTombstoneProposal(db, tombstone, `${input.target}.md`, context);
  return expected !== null && input.body === expected.body &&
    Object.keys(input.frontmatter).length === Object.keys(expected.frontmatter).length &&
    Object.entries(expected.frontmatter).every(([key, value]) => input.frontmatter[key] === value);
}

export function requireSourceTombstoneProposal(
  db: Database,
  input: SourceTombstoneInput,
  context?: SourceTombstoneContext,
): void {
  if (context === undefined) throw new SourceTombstoneError("source_tombstone_vault_required");
  if (!isSourceTombstoneProposal(db, input, context)) throw new SourceTombstoneError("source_tombstone_stale");
}
