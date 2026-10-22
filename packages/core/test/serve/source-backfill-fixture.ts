import { expect } from "bun:test";
import { validEvent } from "../fixtures";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { accept, readEvent } from "../../src/ledger/ledger";
import { bindSourceModelPort, inspectSourceGrant, sourcePolicyEpoch, sourcePortBindingDigest } from "../../src/ledger/source-grants";
import type { LlmPort } from "../../src/contracts/llm";
import { createModelProducerV2Port } from "../../src/producer/model-v2";
import { modelProducerFingerprint } from "../../src/producer/fingerprint";
import { invokeProducerV2 } from "../../src/producer/result";
import { groundedWorldInput } from "../../src/serve/world-grounding";
import { journalWorldDrafts } from "../../src/serve/extract";
import { prepareClaimInsert } from "../../src/claims/store";
import { sourceBackfillSnapshot, type SourceBackfillPlan } from "../../src/serve/source-backfill";
import { ensureVaultId } from "../../src/serve/vault-id";
import { canonicalJson, sha256Hex } from "../../src/util/hash";
import { modelQuoteWire } from "../producer/quote-wire-helper";
import { ENDPOINT, MODEL, throughputVault } from "./throughput-fixture";
import { runRail } from "../../src/serve/rails";

const LABEL = "Indigo Relay";
const SHORT = "turn the spindle";
const FULL = "turn the spindle so that the latch can open";
const HEAD = `${LABEL} is a Situation. Its objective is to ${FULL}.`;
export const AT = "2026-10-22T08:00:00.000Z";
export const SOURCE = "01J00000000000000000000SRC";
export function response(id: string, text: string, full: boolean, supplied = false) {
  const anchor = { event_id: id, start_utf16: text.indexOf(LABEL), end_utf16: text.indexOf(LABEL) + LABEL.length };
  const common = { subject: supplied ? { kind: "supplied", id: "s0" } : { kind: "mention", id: "m1" }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
    context: [], polarity: "positive", body: HEAD, valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: full ? 0.6 : 0.8, sensitivity: "public",
    anchors: [{ event_id: id, start_utf16: text.indexOf(LABEL), end_utf16: text.indexOf(LABEL) + HEAD.length }, anchor] };
  return { schema: "kizuki.producer-response/v2", mentions: [{ id: "m1", label: LABEL, anchor, candidate_refs: [] }], claims: [
    { ...common, id: "c1", predicate: "world.kind", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } } },
    { ...common, id: "c2", predicate: "situation.label", object: { kind: "literal", value: LABEL } },
    { ...common, id: "c3", predicate: "situation.objective", object: { kind: "literal", value: full ? FULL : SHORT } },
  ] };
}
export async function sourceBackfillFixture(start = 0, supplied = false) {
  const f = throughputVault(1, () => " ".repeat(start) + HEAD + " Neutral archive material.".repeat(260));
  const db = openLedger(f.ledger);
  let event = readEvent(db, f.eventIds[0]!)!;
  if (supplied) {
    const captured = accept(db, { ...validEvent(), connector_id: event.connector_id, source_record_id: "supplied-source-record", text: event.text,
      subjects: [{ subject_id: "fixture:indigo", role: "from", display_name: LABEL }] }, { source: { source_key: SOURCE, expected_revision: 1 } });
    if (captured.status !== "stored") throw new Error("synthetic supplied capture failed");
    event = captured.event;
  }
  let seed = true, onCall = () => {}, malformed = false, usage = { input_tokens: 200, output_tokens: 100 };
  const calls: string[] = [];
  const llm: LlmPort = { descriptor: { id: "kizuki.llm.backfill-test", kind: "llm", contract: "kizuki.llm/v1", contract_minor: 0, supports: ["chat"], requires_lease: false, optional_package: null },
    model_ref: MODEL, close: async () => {}, health: async () => ({ status: "ready", detail: {} }), async complete(request) {
      const prompt = request.messages.map(m => m.content).join("\n");
      const matches = [...prompt.matchAll(/<<<KZ-QUOTE ([0-9a-f]{32}) event:([0-9A-HJKMNP-TV-Z]{26})>>>\n([\s\S]*?)\n<<<KZ-END \1>>>/g)];
      expect(matches).toHaveLength(1);
      const text = matches[0]![3]!, id = matches[0]![2]!;
      if (!seed) { calls.push(text); onCall(); }
      return { text: malformed ? "malformed" : JSON.stringify(modelQuoteWire(response(id, text, !seed, supplied), [{ event_id: id, text }])), model: MODEL, usage };
    } };
  const producer = bindSourceModelPort(createModelProducerV2Port({ vault_path: f.vault, data_dir: join(f.vault, ".kizuki"), config: {}, clock: () => AT,
    secrets: async () => { throw new Error("synthetic: no secret access"); }, logger: () => {} }, { llm }), { model_endpoint: ENDPOINT, model: MODEL });
  const input = groundedWorldInput(db, [{ ...event, text: event.text.slice(start, start + 256) }], { max_input_tokens: 8000, max_output_tokens: 8192 }).input;
  const produced = await invokeProducerV2(producer, input);
  expect(produced.result.status).toBe("ok");
  if (produced.result.status !== "ok") throw new Error("synthetic seed refused");
  const mapped = journalWorldDrafts(db, { previous_cursor: null, cursor: null, drafts: [], mined: { status: "ok", count: 3 },
    segment: { event_id: event.event_id, start, end: start + 256, chars: event.text.length }, world: { input, response: produced.result.response } }, [event], MODEL, producer);
  expect(mapped.dropped).toEqual([]);
  expect(mapped.drafts).toHaveLength(3);
  for (const draft of mapped.drafts) { const prepared = await prepareClaimInsert({ db, vault_path: f.vault }, draft); db.transaction(() => prepared.apply()).immediate(); }
  const seededCanon = await runRail(db, f.vault, "sync", { syncMode: "canon-only", hooks: { producer, claims: { db, vault_path: f.vault }, model_ref: MODEL } });
  expect(seededCanon.status).toBe("ok");
  const cap = 512 + start;
  db.query("INSERT INTO extract_oversized_records(event_id,status,chars,done_utf16,pending_end_utf16,updated_at) VALUES(?,'segmenting',?,?,NULL,?)").run(event.event_id, event.text.length, cap, AT);
  const report = canonicalJson({ synthetic: "prior completed extraction" });
  db.query("INSERT INTO run_receipts VALUES('synthetic-run','sync',?,?,'ok',NULL,?)").run(AT, AT, report);
  const grant = inspectSourceGrant(db, SOURCE)!;
  const plan: SourceBackfillPlan = { schema: "kizuki.source-prefix-backfill/v1", operation_id: "synthetic-backfill-1", vault_id: ensureVaultId(f.vault), event_id: event.event_id,
    connector_id: event.connector_id, source_key: SOURCE, content_hash: event.content_hash, text_hash: event.text_hash, source_revision: grant.revision,
    source_policy_digest: grant.policy_digest, source_epoch: sourcePolicyEpoch(db), producer_fingerprint: modelProducerFingerprint(producer)!, model_binding_digest: sourcePortBindingDigest(producer),
    window: { start_utf16: start, end_utf16: start + 256, cap_utf16: cap }, ...sourceBackfillSnapshot(db, event.event_id),
    run_receipts: [{ run_id: "synthetic-run", sha256: sha256Hex(report) }], review: { compatible_prior_claims_sha256: sha256Hex("synthetic review"), qualification_sha256: sha256Hex("synthetic qualification"), producer_review_sha256: sha256Hex("synthetic producer review") },
    budget: { max_input_tokens: 8000, max_output_tokens: 8192, input_token_overhead: 0 }, predecessor: null };
  seed = false;
  const result = { ...f, db, event, producer, calls, plan, onCall: (fn: () => void) => { onCall = fn; }, usage: (value: typeof usage) => { usage = value; }, malformed: () => { malformed = true; } };
  return result;
}
