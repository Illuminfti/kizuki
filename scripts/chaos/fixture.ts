import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accept, applyCanonWrite, backupVault, createBudgetTracker, exportVault,
  getClaim, initVault, insertClaim, resolveTarget,
} from "../../packages/core/src";
import type { CaptureEventInput, Claim, ProducerPort } from "../../packages/core/src";
import { indexEvent, openLedger, rebuildDerived } from "../../packages/core/src/internal";
import type { Operation } from "./harness";

export const MODEL = "kizuki.llm.chaos:synthetic@local";
export const RECORDS = 8;
export const AT = "2026-01-01T00:00:00.000Z";

export interface Fixture {
  operation: Operation;
  eventIds: string[];
  claimIds: string[];
  receiptIds: string[];
  sentinelEvent: unknown;
  sentinelClaim: unknown;
  sentinelReceipt: unknown;
  sentinelPath: string;
  sentinelBytes: string;
}

export function ledger(vault: string): Database {
  return openLedger(join(vault, ".kizuki", "kizuki.db"));
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

export function capture(db: Database, record: number, sentinel = false): string {
  const result = accept(db, event(record, sentinel));
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

export async function prepare(root: string, operation: Operation): Promise<Fixture> {
  const vault = join(root, "vault");
  initVault(vault);
  const db = ledger(vault);
  try {
    const io = { db, vault_path: vault };
    const sentinelId = capture(db, 0, true);
    const sentinel = await claim(db, sentinelId, 0, true);
    const receipt = applyCanonWrite(io, sentinel, resolveTarget(io, sentinel), { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 32 }) });
    const fixture: Fixture = {
      operation, eventIds: [], claimIds: [], receiptIds: [],
      sentinelEvent: db.query("SELECT * FROM events WHERE event_id=?").get(sentinelId),
      sentinelClaim: db.query("SELECT * FROM claims WHERE claim_id=?").get(sentinel.claim_id),
      sentinelReceipt: receipt, sentinelPath: receipt.page_path, sentinelBytes: readFileSync(join(vault, receipt.page_path), "utf8"),
    };
    if (operation !== "capture") {
      for (let record = 0; record < RECORDS; record++) {
        const id = capture(db, record);
        fixture.eventIds.push(id);
        if (operation === "extraction") continue;
        const stored = await claim(db, id, record);
        fixture.claimIds.push(stored.claim_id);
        if (operation === "canon") continue;
        const written = applyCanonWrite(io, stored, resolveTarget(io, stored), { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 32 }) });
        fixture.receiptIds.push(written.receipt_id);
      }
    }
    rebuildDerived(db, vault);
    if (operation === "restore") exportVault(db, vault, join(root, "artifact"));
    if (operation === "restore-snapshot") await backupVault(db, vault, join(root, "artifact"));
    writeFileSync(join(root, "fixture.json"), JSON.stringify(fixture), { mode: 0o600 });
    return fixture;
  } finally { db.close(); }
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
