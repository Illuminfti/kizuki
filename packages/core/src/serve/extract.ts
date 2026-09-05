import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import type {
  ClaimDraft,
  ModelUsage,
  ProducerPort,
  QuotedEvent,
} from "../contracts/producer";
import { predicateIds } from "../claims/predicates";
import { listClaims } from "../claims/store";
import { readCheckpoint, writeCheckpoint } from "../ledger/checkpoints";
import { readSince } from "../ledger/ledger";
import type { LedgerCursor } from "../ledger/ledger";
import { EXTRACT_BATCH, MODEL_PRODUCER_ID } from "../producer";

const EXTRACT_SOURCE_KEY = "extract";
const NO_USAGE: ModelUsage = { calls: 0, input_tokens: 0, output_tokens: 0 };

/** Unavailable is not empty. Only empty or a successful mine advances the cursor. */
export type ExtractMine =
  | { status: "ok"; count: number }
  | { status: "empty" }
  | { status: "unavailable"; reason: string }
  | { status: "rejected"; reason: string };

export function shouldAdvanceExtractCursor(result: ExtractMine): boolean {
  switch (result.status) {
    case "ok":
    case "empty":
      return true;
    case "unavailable":
    case "rejected":
      return false;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export interface MineResult {
  readonly mined: ExtractMine;
  readonly drafts: readonly ClaimDraft[];
  /** The model's own usage for this pass; zero when it was never reached. */
  readonly usage: ModelUsage;
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

function persistCursor(db: Database, cursor: LedgerCursor): void {
  writeCheckpoint(
    db,
    MODEL_PRODUCER_ID,
    EXTRACT_SOURCE_KEY,
    `${cursor.accepted_at}\t${cursor.event_id}`,
  );
}

export function readExtractCursor(db: Database): string | null {
  return readCheckpoint(db, MODEL_PRODUCER_ID, EXTRACT_SOURCE_KEY);
}

/**
 * Session/outcome mine. Unavailable or rejected never advances the cursor
 * (None ≠ []). Empty and ok do.
 */
export async function mineLiveDrafts(
  db: Database,
  producer: ProducerPort,
): Promise<MineResult> {
  const cursor = parseCursor(readExtractCursor(db));
  const batch = readSince(db, cursor, EXTRACT_BATCH);
  if (batch.events.length === 0 || batch.cursor === null) {
    return { mined: { status: "empty" }, drafts: [], usage: NO_USAGE };
  }

  // Packet text that later lands in the ledger is history, not extract input.
  const usable = batch.events.filter(
    (event) => !event.deleted && !event.text.includes("KIZUKI CONTEXT v1"),
  );
  if (usable.length === 0) {
    persistCursor(db, batch.cursor);
    return { mined: { status: "empty" }, drafts: [], usage: NO_USAGE };
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
  let usage: ModelUsage = NO_USAGE;
  switch (produced.status) {
    case "unavailable":
      mined = { status: "unavailable", reason: produced.reason };
      break;
    case "rejected":
      mined = { status: "rejected", reason: produced.reason };
      usage = produced.usage;
      break;
    case "ok":
      drafts = produced.claims;
      usage = produced.usage;
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

  if (shouldAdvanceExtractCursor(mined)) persistCursor(db, batch.cursor);
  return { mined, drafts, usage };
}
