import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accept, applyCanonWrite, backupVault, bindLocalSourcePort, createBudgetTracker, createFts5RetrievalPort, exportVault, FTS5_RETRIEVAL_ID,
  getCanonReceiptRecord, getClaim, hardenLedgerFile, initVault, insertClaim, listCanonPagesReport, registerConnection,
  readRetrievalDocuments, rebuildRetrieval, resolveTarget, retryCanonProjectionObligations, setSourceGrant, ulid,
} from "../../packages/core/src";
import type { CaptureEventInput, Claim, ProducerPort } from "../../packages/core/src";
import type { ClaimV2Assertion } from "../../packages/core/src/contracts/claim-v2";
import { worldCanonTarget } from "../../packages/core/src/canon/world-materialization";
import { indexEvent, openLedger, rebuildDerived } from "../../packages/core/src/internal";
import type { Operation } from "./harness";
import { retrievalProjection } from "./invariants";

export const MODEL = "kizuki.llm.chaos:synthetic@local";
export const RECORDS = 8;
export const AT = "2026-01-01T00:00:00.000Z";

export interface Fixture {
  operation: Operation;
  eventIds: string[];
  claimIds: string[];
  receiptIds: string[];
  activeTargets?: { claims: string[]; receipts: string[] };
  sentinelPath: string;
  sentinelBytes: string;
  retrievalProjection?: string;
  baseline: {
    events: Record<string, unknown>[];
    claims: Record<string, unknown>[];
    receipts: Record<string, unknown>[];
    files: { path: string; bytes: string }[];
    typed: { table: string; key: string; rows: Record<string, unknown>[] }[];
  };
}

export function ledger(vault: string): Database {
  return openLedger(join(vault, ".kizuki", "kizuki.db"));
}

export function retrieval(vault: string) {
  return bindLocalSourcePort(createFts5RetrievalPort({
    vault_path: vault, data_dir: join(vault, ".kizuki", "retrieval", FTS5_RETRIEVAL_ID), config: {},
    clock: () => new Date().toISOString(), logger: () => {}, secrets: async () => { throw new Error("fixture_has_no_secrets"); },
  }), { store_id: `local:${FTS5_RETRIEVAL_ID}` });
}

export function usesRetrieval(operation: Operation): boolean {
  return ["canon", "correction", "undo", "purge", "retrieval-rebuild"].includes(operation.replace(/^typed-/, ""));
}

export function event(record: number, sentinel = false): CaptureEventInput {
  return {
    schema: "kizuki.event/v1", connector_id: sentinel ? "chaos.sentinel" : "chaos.target",
    source_record_id: String(record), kind: "message", occurred_at: AT, observed_at: AT,
    text: sentinel ? "The independent lighthouse uses a blue lamp." : `Researcher ${record} studies astronomy at Acme.`,
    subjects: [{ subject_id: sentinel ? "person:sentinel" : `person:researcher-${record}`, role: "from" }],
    sensitivity_hint: "private", deleted: false, attachments: [], metadata: {},
  };
}

export function capture(db: Database, record: number, sentinel = false, source?: string): string {
  const result = accept(db, event(record, sentinel), source === undefined ? {} : { source: { source_key: source, expected_revision: 1 } });
  if (result.status !== "stored") throw new Error("fixture_capture_refused");
  indexEvent(db, result.event);
  return result.event.event_id;
}

export async function claim(db: Database, id: string, record: number, sentinel = false): Promise<Claim> {
  const evidence = event(record, sentinel);
  const result = await insertClaim({ db }, {
    kind: "claim", target: sentinel ? "facts/sentinel" : `facts/researcher-${record}`,
    subject: evidence.subjects[0]!.subject_id, predicate: "employment.works_at", object: "Acme",
    body: evidence.text, frontmatter: { type: "fact", title: sentinel ? "Lighthouse" : `Researcher ${record}` },
    provenance: [id], subjects: [evidence.subjects[0]!.subject_id], producer: "model", model_ref: MODEL,
    confidence: 0.5, sensitivity: "private", taint: "clean",
    events: [{ event_id: id, connector_id: evidence.connector_id, taint: "untrusted", text: evidence.text }],
  });
  if (result.outcome !== "stored") throw new Error("fixture_claim_refused");
  return result.claim;
}

async function typedClaim(db: Database, source: string, record: number): Promise<{ eventId: string; claim: Claim }> {
  const evidence = { ...event(record), text: `Astronomy ${record} studies celestial objects.`,
    subjects: [{ subject_id: `topic:astronomy-${record}`, role: "about" as const }] };
  const accepted = accept(db, evidence, { source: { source_key: source, expected_revision: 1 } });
  if (accepted.status !== "stored") throw new Error("fixture_typed_capture_refused");
  indexEvent(db, accepted.event);
  const id = accepted.event.event_id;
  const semantic: ClaimV2Assertion = {
    schema: "kizuki.claim/v2", discriminator: "assertion",
    subject: { kind: "supplied", id: evidence.subjects[0]!.subject_id, namespace: { connector_id: evidence.connector_id, source_key: source } },
    predicate: "concept.definition", object: { kind: "literal", value: "Study celestial objects." },
    perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
    context: [], polarity: "positive", valid_from: AT, valid_to: null, temporal_basis: "explicit",
    anchors: [{ event_id: id, start_utf16: 0, end_utf16: evidence.text.length }],
  };
  const stored = await insertClaim({ db }, {
    kind: "claim", body: "Study celestial objects.", provenance: [id], subjects: [semantic.subject.id],
    producer: "model", model_ref: MODEL, confidence: 0.5, sensitivity: "private", semantic,
    world_admission: { schema: "kizuki.world-admission/v1", semantic,
      rendering: { body: "Study celestial objects.", frontmatter: {} },
      authority: "model_inference", confidence: 0.5, epistemicKind: "model_inference" },
  });
  if (stored.outcome !== "stored") throw new Error("fixture_typed_claim_refused");
  return { eventId: id, claim: stored.claim };
}

export function producer(): ProducerPort {
  return {
    descriptor: { id: "kizuki.producer.chaos", kind: "producer", contract: "kizuki.producer/v1",
      contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready", detail: {} }), close: async () => {},
    produce: async input => ({ status: "ok", usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
      claims: input.events.filter(value => value.connector_id === "chaos.target").map(value => ({
        kind: "claim", subject: value.subjects[0]!.subject_id, predicate: "employment.works_at", object: "Acme",
        polarity: "positive", body: value.text, valid_from: null, valid_to: null, confidence: 0.5,
        sensitivity: "private", event_ids: [value.event_id],
      })) }),
  };
}

function fixtureSource(db: Database, connector: string): string {
  const source = ulid();
  registerConnection(db, connector, source);
  setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: `synthetic-grant-${connector}`, policy: {
    purposes: ["capture", "derive", "recall", "correction", "export"],
    allowed_fields: ["text", "subjects", "metadata", "attachments"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
  } });
  return source;
}

export async function prepare(root: string, operation: Operation): Promise<Fixture> {
  const vault = join(root, "vault");
  initVault(vault);
  const db = ledger(vault);
  hardenLedgerFile(join(vault, ".kizuki", "kizuki.db"));
  const port = usesRetrieval(operation) ? retrieval(vault) : undefined;
  try {
    const io = { db, vault_path: vault, ...(port === undefined ? {} : { retrieval: port, retrieval_store: port.descriptor.id }) };
    const typed = operation.startsWith("typed-");
    const source = typed ? fixtureSource(db, "chaos.target") : null;
    const sentinelSource = typed ? fixtureSource(db, "chaos.sentinel") : undefined;
    const sentinelId = capture(db, 0, true, sentinelSource);
    const sentinel = await claim(db, sentinelId, 0, true);
    const receipt = applyCanonWrite(io, sentinel, resolveTarget(io, sentinel), { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 32 }) });
    await retryCanonProjectionObligations(io);
    const fixture: Fixture = {
      operation, eventIds: [], claimIds: [], receiptIds: [],
      sentinelPath: receipt.page_path, sentinelBytes: readFileSync(join(vault, receipt.page_path), "utf8"),
      baseline: { events: [], claims: [], receipts: [], files: [], typed: [] },
    };
    if (operation !== "capture") {
      for (let record = 0; record < RECORDS; record++) {
        const admitted = source === null ? null : await typedClaim(db, source, record);
        const id = admitted?.eventId ?? capture(db, record);
        fixture.eventIds.push(id);
        if (operation === "extraction") continue;
        const stored = admitted?.claim ?? await claim(db, id, record);
        fixture.claimIds.push(stored.claim_id);
        if (operation === "canon" || operation === "typed-canon") continue;
        const written = applyCanonWrite(io, stored, typed ? worldCanonTarget(db, stored.claim_id) : resolveTarget(io, stored), { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 32 }) });
        await retryCanonProjectionObligations(io);
        fixture.receiptIds.push(written.receipt_id);
      }
    }
    rebuildDerived(db, vault);
    fixture.baseline.events = db.query("SELECT * FROM events ORDER BY event_id").all() as Record<string, unknown>[];
    fixture.baseline.claims = db.query("SELECT * FROM claims ORDER BY claim_id").all() as Record<string, unknown>[];
    fixture.baseline.receipts = db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM canon_receipts ORDER BY receipt_id")
      .all().map(row => getCanonReceiptRecord(db, row.receipt_id) as unknown as Record<string, unknown>);
    const paths = new Set(listCanonPagesReport(vault).pages.map(page => page.relPath));
    for (const row of fixture.baseline.receipts) if (typeof row.archive_path === "string") paths.add(row.archive_path);
    fixture.baseline.files = [...paths].sort().map(path => ({ path, bytes: readFileSync(join(vault, path), "utf8") }));
    for (const [table, key] of [["claim_v2_semantics", "claim_id"], ["claim_v2_support", "support_key"], ["claim_v2_support_events", "support_key"]] as const) {
      fixture.baseline.typed.push({ table, key, rows: db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[] });
    }
    if (operation === "restore") exportVault(db, vault, join(root, "artifact"));
    if (operation === "restore-snapshot") await backupVault(db, vault, join(root, "artifact"));
    if (port !== undefined) {
      await rebuildRetrieval(db, vault, port);
      if (operation === "retrieval-rebuild") fixture.retrievalProjection = await retrievalProjection(port, readRetrievalDocuments(db, vault));
    }
    writeFileSync(join(root, "fixture.json"), JSON.stringify(fixture), { mode: 0o600 });
    return fixture;
  } finally { await port?.close(); db.close(); }
}

export function readFixture(root: string): Fixture {
  return JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as Fixture;
}

export function fixtureClaims(db: Database, fixture: Fixture): Claim[] {
  return fixture.claimIds.map(id => {
    const value = getClaim(db, id);
    if (value === null) throw new Error("fixture_claim_missing");
    return value;
  });
}
