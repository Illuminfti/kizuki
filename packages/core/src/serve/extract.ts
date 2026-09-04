import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import type { ClaimDraft, ProducerPort, QuotedEvent } from "../contracts/producer";
import { predicateIds } from "../claims/predicates";
import { listClaims } from "../claims/store";
import { getCheckpoint, saveCheckpoint } from "../ledger/connections";
import { readSince } from "../ledger/ledger";
import type { LedgerCursor } from "../ledger/ledger";
import { shouldAdvanceExtractCursor, type ExtractMine } from "./tri-state";

export const EXTRACT_CONNECTOR_ID = "kizuki.producer.model";
export const EXTRACT_SOURCE_KEY = "extract";
const EXTRACT_BATCH = 8;

export interface MineResult {
  readonly mined: ExtractMine;
  readonly drafts: readonly ClaimDraft[];
}

function parseCursor(raw: string | null): LedgerCursor | null {
  if (raw === null || raw.length === 0) return null;
  const split = raw.indexOf("\t");
  if (split <= 0 || split === raw.length - 1) return null;
  return {
    accepted_at: raw.slice(0, split),
    event_id: raw.slice(split + 1),
  };
}

function formatCursor(cursor: LedgerCursor | null): string | null {
  if (cursor === null) return null;
  return `${cursor.accepted_at}\t${cursor.event_id}`;
}

function quoted(event: CaptureEvent): QuotedEvent {
  return {
    event_id: event.event_id,
    connector_id: event.connector_id,
    occurred_at: event.occurred_at,
    observed_at: event.observed_at,
    text: event.text,
    subjects: event.subjects,
    taint: "untrusted",
  };
}

function persistCursor(db: Database, cursor: LedgerCursor | null, stored: number): void {
  saveCheckpoint(
    db,
    EXTRACT_CONNECTOR_ID,
    EXTRACT_SOURCE_KEY,
    formatCursor(cursor),
    "sync",
    {
      stored,
      duplicates: 0,
      errors: [],
      proposals_created: stored,
      withdrawn: 0,
      retractions_filed: 0,
      cursor: formatCursor(cursor),
    },
  );
}

export function readExtractCursor(db: Database): string | null {
  return getCheckpoint(db, EXTRACT_CONNECTOR_ID, EXTRACT_SOURCE_KEY)?.cursor ?? null;
}

/**
 * Session/outcome mine. Unavailable or rejected never advances the cursor
 * (None ≠ []). Empty and ok do.
 */
export async function mineLiveDrafts(
  db: Database,
  producer: ProducerPort,
): Promise<MineResult> {
  const held = getCheckpoint(db, EXTRACT_CONNECTOR_ID, EXTRACT_SOURCE_KEY);
  const cursor = parseCursor(held?.cursor ?? null);
  const batch = readSince(db, cursor, EXTRACT_BATCH);
  if (batch.events.length === 0) {
    return { mined: { status: "empty" }, drafts: [] };
  }

  // E8: a packet that later lands in the ledger is history, not extract input.
  const usable = batch.events.filter(
    (event) => !event.deleted && !event.text.includes("KIZUKI CONTEXT v1"),
  );
  if (usable.length === 0) {
    persistCursor(db, batch.cursor, 0);
    return { mined: { status: "empty" }, drafts: [] };
  }

  const known = listClaims(db, { status: "live", keyed: true, limit: 32 });
  const produced = await producer.produce({
    events: usable.map(quoted),
    context: {
      subjects: batch.events.flatMap((event) => event.subjects),
      known_claims: known.map((claim) => ({
        claim_id: claim.claim_id,
        subject: claim.subject,
        predicate: claim.predicate,
        object: claim.object,
        polarity: claim.polarity,
        confidence: claim.confidence,
      })),
      predicates: [...predicateIds()],
    },
    budget: {
      max_calls: 2,
      max_input_tokens: 8_000,
      max_output_tokens: 2_000,
    },
  });

  let mined: ExtractMine;
  let drafts: readonly ClaimDraft[] = [];
  switch (produced.status) {
    case "unavailable":
      mined = { status: "unavailable", reason: produced.reason };
      break;
    case "rejected":
      mined = { status: "rejected", reason: produced.reason };
      break;
    case "ok":
      drafts = produced.claims;
      mined =
        produced.claims.length === 0
          ? { status: "empty" }
          : { status: "ok", count: produced.claims.length };
      break;
    default: {
      const _exhaustive: never = produced;
      return _exhaustive;
    }
  }

  if (shouldAdvanceExtractCursor(mined)) {
    persistCursor(db, batch.cursor, mined.status === "ok" ? mined.count : 0);
  }
  return { mined, drafts };
}
