/** Fixed, bounded fixture child. Process exit releases every Bun/SQLite statement. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "../packages/core/src/index";
import { mineLiveDrafts, journalExtractBatch } from "../packages/core/src/serve/extract";
import { absolute, exact, hash, reject } from "./native-proof-evidence";
import { RETRIEVAL_CASES, SOURCE_TITLES, ORIGINAL_BODY, ORIGINAL_MODEL_REF, MODEL_NAME, JOURNAL_FIELDS } from "./recovery-proof-recipe";

type Ledger = ReturnType<typeof core.openLedger>;
export interface FixtureClaim { title: string; claim: string; event: string; identity: string; path?: string; beforeHash?: string; source?: string; originalHash?: string }
export type JournalRow = Record<typeof JOURNAL_FIELDS[number], string>;
export interface PendingFixture { journal: JournalRow; allowed_id: string; denied_id: string; queued_id: string; constructor: { model_calls: number; allowed_inputs: number; denied_inputs: number; preexisting_queue: number } }
export function requireFact(value: unknown): asserts value { if (!value) reject("recovery-fixture-invalid"); }
function event(connector: string, title: string, text: string): core.CaptureEventInput {
  return { schema: "kizuki.event/v1", connector_id: connector, source_record_id: title, kind: "note", occurred_at: "2026-01-02T03:04:05Z", observed_at: "2026-01-03T03:04:05Z", text,
    subjects: [{ subject_id: `person:${title.toLowerCase()}`, role: "about" }], sensitivity_hint: "private", deleted: false, attachments: [], metadata: {} };
}
function policy(egress: core.SourceGrantPolicy["egress"] = "local_only"): core.SourceGrantPolicy { return { purposes: ["capture", "recall", "session", "correction", "audit", "derive", "extract", "export"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", sensitivity_floor: "private", egress }; }
async function seedClaim(db: Ledger, vault: string, title: string, provenance: string[], taint: "clean" | "quoted" = "clean") {
  const evidence = `${title} works with the synthetic library.`, subject = `person:${title.toLowerCase()}`;
  const inserted = await core.insertClaim({ db }, { kind: "claim", target: `people/${title.toLowerCase()}`, subject, predicate: "employment.works_at", object: "synthetic-library", polarity: "positive",
    body: taint === "quoted" ? `> ${evidence}` : `${title} supports the synthetic library.`, frontmatter: { type: "person", title }, provenance, subjects: [subject], producer: "model", model_ref: "fixture:synthetic-model", confidence: 0.7, sensitivity: "private", taint });
  requireFact(inserted.outcome === "stored"); const io = { db, vault_path: vault };
  const receipt = core.applyCanonWrite(io, inserted.claim, core.resolveTarget(io, inserted.claim), { writer: "loop", budget: core.createBudgetTracker({ canon_writes_per_run: 8 }) });
  const page = core.listCanonPages(vault).find(page => page.relPath === receipt.page_path); requireFact(page !== undefined);
  return { claim: inserted.claim.claim_id, path: receipt.page_path, page: page.id, beforeHash: hash(readFileSync(join(vault, receipt.page_path))) };
}
async function constructPending(db: Ledger, vault: string, endpoint: string): Promise<PendingFixture> {
  requireFact(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1\/chat\/completions$/.test(endpoint));
  let calls = 0, allowedId = "";
  const allowedSource = core.ulid(), heldSource = core.ulid(), allowedConnector = "fixture.source-model-egress.allowed", heldConnector = "fixture.source-model-egress.held";
  core.registerConnection(db, allowedConnector, allowedSource); core.registerConnection(db, heldConnector, heldSource);
  const allowedGrant = core.setSourceGrant(db, { source_key: allowedSource, expected_revision: 0, operation_id: "fixture-egress-allowed", policy: policy({ model_endpoint: endpoint, model: MODEL_NAME, external_retention: "provider_managed" }) });
  const heldGrant = core.setSourceGrant(db, { source_key: heldSource, expected_revision: 0, operation_id: "fixture-egress-held", policy: policy() });
  const queued = core.accept(db, event(heldConnector, "artifact-held-queued", "Synthetic preexisting deferred source evidence."), { source: { source_key: heldSource, expected_revision: heldGrant.revision } }); requireFact(queued.status === "stored");
  const fixturePort: core.ProducerPort = { descriptor: core.MODEL_PRODUCER_DESCRIPTOR, health: async () => ({ status: "ready", detail: {} }), close: async () => {}, produce: async input => {
    calls++; requireFact(input.events.length === 1 && input.events[0]?.event_id === allowedId);
    return { status: "ok", claims: [{ kind: "claim", subject: "person:artifact-allowed", predicate: "employment.role", object: "restored fixture role", polarity: "positive", body: ORIGINAL_BODY, valid_from: null, valid_to: null, confidence: 0.7, sensitivity: "private", event_ids: [allowedId] }], usage: { calls: 1, input_tokens: 8, output_tokens: 8 } };
  } };
  const producer = core.bindSourceModelPort(fixturePort, { model_endpoint: endpoint, model: MODEL_NAME });
  const seeded = await core.runWritePass(db, vault, { budget: core.createBudgetTracker({ canon_writes_per_run: 8 }), model_ref: ORIGINAL_MODEL_REF, claims: { db }, producer });
  requireFact(seeded.errors.length === 0 && seeded.model.calls === 0 && db.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(queued.event.event_id));
  const allowed = core.accept(db, event(allowedConnector, "artifact-allowed", "Synthetic allowed source evidence."), { source: { source_key: allowedSource, expected_revision: allowedGrant.revision } });
  const denied = core.accept(db, event(heldConnector, "artifact-held", "Synthetic held source evidence."), { source: { source_key: heldSource, expected_revision: heldGrant.revision } }); requireFact(allowed.status === "stored" && denied.status === "stored"); allowedId = allowed.event.event_id;
  const mined = await mineLiveDrafts(db, producer); requireFact(mined.mined.status === "ok"); journalExtractBatch(db, mined, ORIGINAL_MODEL_REF, producer);
  const journal = db.query("SELECT model_ref,drafts,model_inputs,deferred_inputs,integrity FROM extract_batches").get() as JournalRow | null; requireFact(journal !== null);
  const result = { journal, allowed_id: allowedId, denied_id: denied.event.event_id, queued_id: queued.event.event_id, constructor: { model_calls: calls, allowed_inputs: mined.model_inputs?.length ?? -1, denied_inputs: mined.deferred_inputs?.length ?? -1, preexisting_queue: (db.query("SELECT count(*) AS n FROM extract_deferred_inputs").get() as { n: number }).n } };
  core.disconnect(db, allowedConnector, allowedSource); core.disconnect(db, heldConnector, heldSource); return result;
}
function inspectReplay(db: Ledger, input: Record<string, unknown>) {
  exact(input, "allowed_id,denied_id,queued_id"); for (const value of Object.values(input)) requireFact(typeof value === "string" && /^[0-9A-HJKMNPQRSTVWXYZ]{26}$/.test(value));
  const claims = core.listClaims(db, { status: "live", limit: 20 }).filter(claim => claim.producer === "model");
  const receipts = core.listCanonReceipts(db, { limit: 20 }).filter(receipt => receipt.writer === "loop"); const claim = claims[0], receipt = receipts[0]; requireFact(claim && receipt);
  const deferred = db.query("SELECT event_id FROM extract_deferred_inputs ORDER BY event_id").all() as { event_id: string }[];
  return { model_claims: claims.length, loop_receipts: receipts.length, pending_journals: (db.query("SELECT count(*) AS n FROM extract_batches").get() as { n: number }).n,
    deferred_ids_sha256: deferred.map(row => hash(row.event_id)).sort(), expected_deferred_ids_sha256: [hash(input.queued_id as string), hash(input.denied_id as string)].sort(), body_sha256: hash(claim.body),
    model_ref_sha256: hash(claim.model_ref ?? ""), receipt_model_ref_sha256: hash(receipt.model_ref ?? ""), provenance_sha256: hash(JSON.stringify(claim.provenance)), expected_provenance_sha256: hash(JSON.stringify([input.allowed_id])), receipt_provenance_sha256: hash(JSON.stringify(receipt.provenance)),
    claim_sha256: hash(claim.claim_id), receipt_claim_sha256: receipt.claim_ids.length === 1 ? hash(receipt.claim_ids[0]!) : hash("invalid-claim-set"), receipt_sha256: hash(receipt.receipt_id) };
}
export type ReplayState = ReturnType<typeof inspectReplay>;
async function fixture(action: string, vault: string, input: Record<string, unknown>) {
  const db = core.openLedger(join(vault, ".kizuki/kizuki.db"));
  try {
    if (action === "seed-retrieval") {
      exact(input, ""); const rows: FixtureClaim[] = [];
      for (const item of RETRIEVAL_CASES) {
        const accepted = core.accept(db, event("fixture.estate", item.title, `${item.title} works with the synthetic library.`)); requireFact(accepted.status === "stored");
        const corroboration = item.taint === "quoted" ? core.accept(db, event("fixture.independent", item.title, accepted.event.text)) : null; requireFact(corroboration === null || corroboration.status === "stored");
        const seeded = await seedClaim(db, vault, item.title, [accepted.event.event_id, ...(corroboration?.status === "stored" ? [corroboration.event.event_id] : [])], item.taint);
        rows.push({ title: item.title, event: accepted.event.event_id, claim: seeded.claim, identity: seeded.page, path: seeded.path, beforeHash: seeded.beforeHash });
      }
      return rows;
    }
    if (action === "grant-source" || action === "seed-source-claim") {
      exact(input, "title,source_key"); requireFact(SOURCE_TITLES.some(title => title === input.title) && typeof input.source_key === "string" && /^[0-9A-HJKMNPQRSTVWXYZ]{26}$/.test(input.source_key));
      const title = input.title as string, key = input.source_key;
      const events = [...core.replayLive(db)].filter(event => event.text.includes(title));
      if (action === "grant-source") { core.setSourceGrant(db, { source_key: key, expected_revision: 0, operation_id: `fixture-grant-${title}`, policy: policy() }); return { captured: events.length }; }
      requireFact(events.length === 1); const seeded = await seedClaim(db, vault, title, [events[0]!.event_id]);
      return { captured: events.length, row: { title, event: events[0]!.event_id, claim: seeded.claim, identity: key } satisfies FixtureClaim };
    }
    if (action === "seed-historical-fts") {
      exact(input, "rows"); requireFact(Array.isArray(input.rows) && input.rows.length === 2);
      const rows = input.rows as FixtureClaim[], fts = core.bindLocalSourcePort(core.createVaultFts5Port(vault), { store_id: "local:kizuki.retrieval.fts5" });
      try {
        const docs = core.readRetrievalDocuments(db, vault);
        for (const [index, row] of rows.entries()) { requireFact(row.title === SOURCE_TITLES[index]); requireFact(docs.some(doc => doc.doc_id === `claim:${row.claim}` && doc.provenance.includes(row.event) && doc.text.includes(row.title))); }
        const built = await core.rebuildRetrieval(db, vault, fts); requireFact(built.backend === "retrieval-port" && built.store === "kizuki.retrieval.fts5");
        const positive = [];
        for (const row of rows) { const result = await fts.search({ text: row.title, mode: "lexical", scope: {}, ceiling: "private", limit: 20, deadline_ms: 1000 }); positive.push(result.hits.filter(hit => hit.doc_id === `claim:${row.claim}` && hit.snippet.includes(row.title)).length); }
        return positive;
      } finally { await fts.close(); }
    }
    if (action === "inspect-purge") {
      exact(input, "claim_id"); requireFact(typeof input.claim_id === "string");
      return { revoked_events: [...core.replay(db, {})].filter(event => event.text.includes(SOURCE_TITLES[0])).length, independent_events: [...core.replayLive(db)].filter(event => event.text.includes(SOURCE_TITLES[1])).length,
        revoked_claim_mentions: (JSON.stringify(core.getClaim(db, input.claim_id)).match(new RegExp(SOURCE_TITLES[0], "g")) ?? []).length };
    }
    if (action === "construct-pending") { exact(input, "endpoint"); requireFact(typeof input.endpoint === "string"); return await constructPending(db, vault, input.endpoint); }
    if (action === "inspect-journal") {
      exact(input, "queued_id"); requireFact(typeof input.queued_id === "string");
      return { journal: db.query("SELECT model_ref,drafts,model_inputs,deferred_inputs,integrity FROM extract_batches").get() as JournalRow | null, queued: db.query("SELECT 1 FROM extract_deferred_inputs WHERE event_id=?").get(input.queued_id) ? 1 : 0 };
    }
    if (action === "inspect-replay") return inspectReplay(db, input);
    reject("unregistered-recovery-fixture");
  } finally { db.close(); }
}
if (import.meta.main) {
  try {
    const [action, vault, encoded, ...rest] = Bun.argv.slice(2); requireFact(action && vault && encoded && !rest.length && encoded.length <= 65536);
    const input = JSON.parse(encoded) as Record<string, unknown>; requireFact(input !== null && typeof input === "object" && !Array.isArray(input));
    process.stdout.write(JSON.stringify(await fixture(action, absolute(vault), input)) + "\n");
  } catch { process.stderr.write("recovery-fixture-failed\n"); process.exitCode = 1; }
}
