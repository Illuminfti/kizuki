import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import { EXTERNAL_RETENTION_CLASSES, type ExternalRetention } from "../ledger/source-grants";
import { isPlainObject } from "../util/validate";
import { extractBacklog } from "./doctor-rails";
import {
  EXTRACT_BACKLOG_CAP,
  type EgressDoctor,
  type ExtractionDoctor,
  type RunReceipt,
} from "./types";

/** Truncated answers in a row before doctor says what to change, not merely that one happened. */
const TRUNCATION_HINT_AFTER = 3;
const TRUNCATION_HINT =
  'responses keep being truncated: set [ports.llm] reasoning_effort (for example "low") or raise [extraction] max_output_tokens in serve.toml';

function truncated(receipt: RunReceipt): boolean {
  const diagnostic = receipt.model.diagnostic;
  return (
    receipt.model.last_request !== "answered" &&
    diagnostic?.stage === "response" &&
    diagnostic.rule === "response_truncated"
  );
}

/**
 * Newest-first passes whose request came back truncated. A pass that made no
 * request neither extends nor ends the run; any other outcome ends it.
 */
function consecutiveTruncations(syncReceipts: readonly RunReceipt[]): number {
  let count = 0;
  for (let index = syncReceipts.length - 1; index >= 0; index -= 1) {
    const receipt = syncReceipts[index];
    if (receipt === undefined) continue;
    if (truncated(receipt)) count += 1;
    else if (receipt.model.calls > 0 || receipt.model.diagnostic !== undefined)
      break;
  }
  return count;
}

function lastExtractedAt(db: Database): string | null {
  if (!tableExists(db, "claims")) return null;
  return (
    db
      .query<{ created_at: string }, []>(
        "SELECT created_at FROM claims WHERE producer = 'model' ORDER BY created_at DESC LIMIT 1",
      )
      .get()?.created_at ?? null
  );
}

/**
 * How far extraction has got. The backlog is what waits past the extract
 * cursor for a granted source, counted up to a bound; `syncReceipts` is
 * oldest first and only reads the fields every receipt has, so older receipts
 * simply count nothing.
 */
export function extractionDoctor(
  db: Database,
  syncReceipts: readonly RunReceipt[],
  modelOn: boolean,
): ExtractionDoctor {
  const counted = extractBacklog(db, EXTRACT_BACKLOG_CAP);
  const capped = counted >= EXTRACT_BACKLOG_CAP;
  const rejections = consecutiveTruncations(syncReceipts);
  const hint = rejections >= TRUNCATION_HINT_AFTER ? TRUNCATION_HINT : null;
  const last = lastExtractedAt(db);
  return {
    backlog_events: counted,
    backlog_capped: capped,
    last_extracted_at: last,
    consecutive_rejections: rejections,
    hint,
    detail:
      `extraction backlog=${counted}${capped ? "+" : ""} last_extracted_at=${last ?? "never"}` +
      (modelOn ? "" : " (no model: nothing extracts)") +
      (hint === null ? "" : `; ${hint}`),
  };
}

const EGRESS_SOURCE_CAP = 256;

/**
 * Where each consenting source's text may go: the model endpoint's host, the
 * model, and who holds the text afterwards. Only the host is shown, never the
 * endpoint path. A source whose policy cannot be read is a failure, not a gap.
 */
export function egressDoctor(db: Database): {
  readonly egress: EgressDoctor[];
  readonly failures: string[];
} {
  const egress: EgressDoctor[] = [];
  const failures: string[] = [];
  if (!tableExists(db, "source_grants")) return { egress, failures };
  const rows = db
    .query<
      { source_key: string; connector_id: string; policy: string },
      [number]
    >(
      "SELECT source_key, connector_id, policy FROM source_grants WHERE status = 'active' ORDER BY source_key LIMIT ?",
    )
    .all(EGRESS_SOURCE_CAP);
  for (const row of rows) {
    let host: string | null = null;
    let model: string | null = null;
    let retention: ExternalRetention | null = null;
    let local = false;
    try {
      const policy: unknown = JSON.parse(row.policy);
      const target = isPlainObject(policy) ? policy["egress"] : undefined;
      if (target === "local_only") local = true;
      else if (
        isPlainObject(target) &&
        typeof target["model_endpoint"] === "string" &&
        typeof target["model"] === "string" &&
        (EXTERNAL_RETENTION_CLASSES as readonly unknown[]).includes(target["external_retention"])
      ) {
        host = new URL(target["model_endpoint"]).host;
        model = target["model"];
        retention = target["external_retention"] as ExternalRetention;
      }
    } catch {
      /* reported below */
    }
    if (local) continue;
    if (host === null || model === null || retention === null) {
      failures.push(`source ${row.source_key} policy unreadable`);
      continue;
    }
    egress.push({
      source_key: row.source_key,
      connector_id: row.connector_id,
      endpoint_host: host,
      model,
      retention,
    });
  }
  return { egress, failures };
}
