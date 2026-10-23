import { modelQuoteWire } from "../producer/quote-wire-helper";
import { join } from "node:path";
import type { LlmPort } from "../../src/contracts/llm";
import { openLedger } from "../../src/ledger/db";
import { readEvent } from "../../src/ledger/ledger";
import { bindSourceModelPort, inspectSourceGrant, sourcePolicyEpoch, sourcePortBindingDigest } from "../../src/ledger/source-grants";
import { createModelProducerV2Port } from "../../src/producer/model-v2";
import { modelProducerFingerprint } from "../../src/producer/fingerprint";
import { readExtractCursor } from "../../src/serve/extract";
import type { EmptySegmentReplayPlan } from "../../src/serve/extract-replay";
import { ensureVaultId } from "../../src/serve/vault-id";
import { emptyRunTotals } from "../../src/serve/types";
import { sha256Hex } from "../../src/util/hash";
import { anchoredResponse, ENDPOINT, MODEL, paragraphRecord, recordText, throughputVault, writeServeToml } from "./throughput-fixture";

export function replayFixture(reply: "empty" | "nonempty" | "rejected" = "empty", onCall: () => void = () => {}, records = 1) {
  const f = throughputVault(records, index => index === 0 ? paragraphRecord(60_000) : recordText(index));
  const db = openLedger(f.ledger), eventId = f.eventIds[0]!;
  const event = readEvent(db, eventId)!;
  const sourceKey = "01J00000000000000000000SRC";
  const calls: string[] = [];
  const llm: LlmPort = {
    descriptor: { id: "kizuki.llm.replay-fixture", kind: "llm", contract: "kizuki.llm/v1", contract_minor: 0,
      supports: ["chat"], requires_lease: false, optional_package: null },
    model_ref: MODEL, health: async () => { throw new Error("health must not run"); }, close: async () => {},
    complete: async request => {
      const text = request.messages.map(message => message.content).join("\n");
      const match = /<<<KZ-QUOTE ([0-9a-f]{32}) event:([0-9A-HJKMNP-TV-Z]{26})>>>\n([\s\S]*?)\n<<<KZ-END \1>>>/.exec(text)!;
      calls.push(match[3]!); onCall();
      const response = reply === "nonempty" ? anchoredResponse([{ event_id: match[2]!, start: 0, end: 7, label: match[3]!.slice(0, 7) }])
        : { schema: "kizuki.producer-response/v2", mentions: [], claims: [] };
      return { text: reply === "rejected" ? "malformed" : JSON.stringify(modelQuoteWire(response, [{ event_id: match[2]!, text: match[3]! }])), model: MODEL, usage: { input_tokens: 10, output_tokens: 20 } };
    },
  };
  const producer = bindSourceModelPort(createModelProducerV2Port({ vault_path: f.vault, data_dir: join(f.vault, ".kizuki"), config: {},
    clock: () => new Date().toISOString(), secrets: async () => { throw new Error("no secrets in replay fixture"); }, logger: () => {} }, { llm }), { model_endpoint: ENDPOINT, model: MODEL });
  const at = "2026-10-22T08:00:00.000Z", runId = "synthetic-old-empty-run";
  // Preserve the historical prefix while leaving prompt headroom in each replay request.
  const end = event.text.indexOf("\n\n", 14_000) + 2;
  if (end < 14_000) throw new Error("fixture boundary missing");
  db.query("INSERT INTO extract_oversized_records(event_id,status,chars,done_utf16,pending_end_utf16,updated_at) VALUES(?,?,?,?,NULL,?)").run(eventId, "segmenting", event.text.length, end, at);
  const totals = emptyRunTotals();
  const report = JSON.stringify({ ...totals, run_id: runId, rail: "sync", started_at: at, finished_at: at, status: "ok", stopped: null,
    claims_written_extracted: 0, records_skipped: 0, has_more: true,
    model: { ...totals.model, calls: 1, answered: 1, last_request: "answered" }, oversized: { segments: 1, skipped: 0 } });
  db.query("INSERT INTO run_receipts VALUES(?,?,?,?,?,?,?)").run(runId, "sync", at, at, "ok", null, report);
  writeServeToml(f.vault, '[extraction]\nmax_calls_per_pass=8\nmax_input_tokens=6000\n');
  const grant = inspectSourceGrant(db, sourceKey)!;
  const plan: EmptySegmentReplayPlan = {
    schema: "kizuki.extract-empty-replay/v1", operation_id: "synthetic-replay-1", vault_id: ensureVaultId(f.vault),
    event_id: eventId, connector_id: event.connector_id, source_key: sourceKey, content_hash: event.content_hash, text_hash: event.text_hash,
    source_revision: grant.revision, source_policy_digest: grant.policy_digest, source_epoch: sourcePolicyEpoch(db),
    model_binding_digest: sourcePortBindingDigest(producer), expected_cursor: readExtractCursor(db),
    segment: { status: "segmenting", chars: event.text.length, done_utf16: end, pending_end_utf16: null, updated_at: at },
    old_run_id: runId, old_run_receipt_sha256: sha256Hex(report), old_producer_fingerprint: sha256Hex("synthetic historical producer"),
    new_producer_fingerprint: modelProducerFingerprint(producer)!, new_qualification_sha256: sha256Hex("synthetic qualification"),
    new_review_sha256: sha256Hex("synthetic review"), historical_evidence: { kind: "owner_attested_legacy_empty",
      old_source_commit: "d".repeat(40), old_prompt_sha256: sha256Hex("old prompt"), old_gate_sha256: sha256Hex("old gate"),
      old_input_plan_sha256: sha256Hex("old plan"), independent_review_sha256: sha256Hex("independent historical review"),
      legacy_metadata_sha256: sha256Hex("synthetic closed metadata"), allowed_errors_sha256: null, capture_denial_proof_sha256: null },
    reason: "producer_false_negative_repair",
  };
  return { ...f, db, event, plan, producer, calls,
    dispose() { db.close(); f.dispose(); } };
}
