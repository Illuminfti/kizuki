import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
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

export function isTruncatedReceipt(receipt: RunReceipt): boolean {
  const diagnostic = receipt.model.diagnostic;
  return (
    receipt.model.last_request !== "answered" &&
    diagnostic?.stage === "response" &&
    diagnostic.rule === "response_truncated"
  );
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
 * cursor for a granted source, counted up to a bound. The caller supplies
 * the consecutive truncation count from its bounded receipt window.
 */
export function extractionDoctor(
  db: Database,
  rejections: number,
  modelOn: boolean,
): ExtractionDoctor {
  const counted = extractBacklog(db, EXTRACT_BACKLOG_CAP);
  const capped = counted >= EXTRACT_BACKLOG_CAP;
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
    let local = false;
    try {
      const policy: unknown = JSON.parse(row.policy);
      const target = isPlainObject(policy) ? policy["egress"] : undefined;
      if (target === "local_only") local = true;
      else if (
        isPlainObject(target) &&
        typeof target["model_endpoint"] === "string" &&
        typeof target["model"] === "string" &&
        target["external_retention"] === "provider_managed"
      ) {
        host = new URL(target["model_endpoint"]).host;
        model = target["model"];
      }
    } catch {
      /* reported below */
    }
    if (local) continue;
    if (host === null || model === null) {
      failures.push(`source ${row.source_key} policy unreadable`);
      continue;
    }
    egress.push({
      source_key: row.source_key,
      connector_id: row.connector_id,
      endpoint_host: host,
      model,
      retention: "provider_managed",
    });
  }
  return { egress, failures };
}
