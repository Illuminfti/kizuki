import { afterEach, expect, test } from "bun:test";
import { accept, correct, CorrectError, getClaim, registerConnection, revokeSourceGrant, setSourceGrant, ulid } from "../../src/index";
import { sourceRecordId } from "../../src/correction/parse";
import { canonFixture, storeClaim, write } from "../canon/helpers";
import type { CanonFixture } from "../canon/helpers";
import { validEvent } from "../fixtures";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectCorrectionConsent } from "../../src/correction/correct";
import type { SourceGrantPolicy } from "../../src/ledger/source-grants";

const fixtures: CanonFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); });

async function seeded() {
  const f = canonFixture(); fixtures.push(f);
  const source = ulid();
  registerConnection(f.db, "fixture", source);
  setSourceGrant(f.db, { source_key: source, expected_revision: 0, operation_id: "fixture-grant",
    policy: { purposes: ["capture", "correction", "derive", "recall", "session"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" } });
  const accepted = accept(f.db, { ...validEvent(), connector_id: "fixture" }, { source: { source_key: source, expected_revision: 1 } });
  if (accepted.status !== "stored") throw new Error("synthetic source setup refused");
  const claim = await storeClaim(f.db, accepted.event.event_id, { producer: "model", model_ref: "fixture:model" });
  write(f.io, claim);
  return { ...f, source, claim, evidence: accepted.event.event_id };
}

test("native tell retains source provenance and cannot reauthorize a revoked belief", async () => {
  const f = await seeded();
  const result = await correct(f.io, { statement: "Grace works at Northwind.", target: { claim_id: f.claim.claim_id } });
  const winner = getClaim(f.db, result.claim_ids[0]!);
  expect(winner?.authority).toBe("owner_correction");
  expect(winner?.provenance).toContain(f.evidence);
  expect(winner?.provenance).toContain(result.event_id);
  revokeSourceGrant(f.db, { source_key: f.source, expected_revision: 1, operation_id: "fixture-revoke" });
  const before = f.db.query("SELECT count(*) AS n FROM native_owner_evidence").get();
  await expect(correct(f.io, { statement: "Grace works at Contoso.", target: { claim_id: winner!.claim_id } })).rejects.toThrow();
  expect(f.db.query("SELECT count(*) AS n FROM native_owner_evidence").get()).toEqual(before);
});

test("a captured owner-label collision cannot become native correction authority", async () => {
  const f = await seeded();
  const statement = "Grace works at Northwind.";
  const target = { claim_id: f.claim.claim_id };
  expect(accept(f.db, { ...validEvent(), connector_id: "kizuki.owner", source_record_id: sourceRecordId(statement, target), text: statement }).status).toBe("stored");
  await expect(correct(f.io, { statement, target })).rejects.toThrow("conflicts with existing evidence");
  expect(getClaim(f.db, f.claim.claim_id)?.status).toBe("live");
  expect(f.db.query("SELECT count(*) AS n FROM native_owner_evidence").get()).toEqual({ n: 0 });
});

test("withdrawn derive consent refuses native correction before any effects", async () => {
  const f = await seeded();
  const before = readFileSync(join(f.vault, "people/grace.md"), "utf8");
  setSourceGrant(f.db, { source_key: f.source, expected_revision: 1, operation_id: "withdraw-derive",
    policy: { purposes: ["capture", "correction", "recall", "session"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" } });
  const state = () => ["events", "claims", "claim_supersessions", "canon_receipts", "native_owner_evidence"]
    .map(table => f.db.query(`SELECT count(*) AS n FROM ${table}`).get());
  const prior = state();
  for (const dry_run of [false, true]) {
    const error = await correct(f.io, { statement: "Grace works at Northwind.", target: { claim_id: f.claim.claim_id }, dry_run }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CorrectError);
    if (!(error instanceof CorrectError)) throw error;
    expect(error.code).toBe("source_access_denied");
    expect(error.message).toContain(`source ${f.source} does not permit derive`);
    expect(error.message).toContain(`kizuki connect grant --source ${f.source} --policy POLICY.json --expected-revision 2 --operation-id OPERATION`);
    expect(state()).toEqual(prior);
    expect(getClaim(f.db, f.claim.claim_id)?.status).toBe("live");
    expect(readFileSync(join(f.vault, "people/grace.md"), "utf8")).toBe(before);
  }
});

test("a grant narrowed after preflight keeps the writer refusal actionable", async () => {
  const f = await seeded();
  const before = readFileSync(join(f.vault, "people/grace.md"), "utf8");
  expect(inspectCorrectionConsent(f.io, f.claim)).toEqual({ allowed: true });
  // The correction clock runs after consent preflight and before filing.
  const io = { ...f.io, now: () => {
    setSourceGrant(f.db, { source_key: f.source, expected_revision: 1, operation_id: "narrow-after-preflight",
      policy: { purposes: ["capture", "correction", "recall", "session"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" } });
    return "2026-03-01T00:00:00Z";
  } };
  const error = await correct(io, { statement: "Grace works at Northwind.", target: { claim_id: f.claim.claim_id } })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CorrectError);
  if (!(error instanceof CorrectError)) throw error;
  expect(error.code).toBe("source_access_denied");
  expect(error.message).toContain(`source ${f.source} does not permit derive`);
  expect(error.message).toContain(`kizuki connect grant --source ${f.source} --policy POLICY.json --expected-revision 2 --operation-id OPERATION`);
  expect(readFileSync(join(f.vault, "people/grace.md"), "utf8")).toBe(before);
});

test("retained page evidence needs derive consent even when the corrected claim has it", async () => {
  const f = await seeded();
  const source = ulid();
  registerConnection(f.db, "fixture", source);
  const policy: SourceGrantPolicy = {
    purposes: ["capture", "correction", "derive", "recall", "session"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked",
    egress: "local_only", sensitivity_floor: "private",
  };
  setSourceGrant(f.db, { source_key: source, expected_revision: 0, operation_id: "page-source", policy });
  const accepted = accept(f.db, { ...validEvent(), connector_id: "fixture", source_record_id: "retained-note",
    text: "Grace maintains the compiler." }, { source: { source_key: source, expected_revision: 1 } });
  if (accepted.status !== "stored") throw new Error("synthetic page source refused");
  const retained = await storeClaim(f.db, accepted.event.event_id, {
    predicate: null, object: null, body: accepted.event.text, producer: "model", model_ref: "fixture:model",
  });
  write(f.io, retained);
  const before = readFileSync(join(f.vault, "people/grace.md"), "utf8");
  expect(before).toContain(retained.body);
  setSourceGrant(f.db, { source_key: source, expected_revision: 1, operation_id: "withdraw-page-derive",
    policy: { ...policy, purposes: ["capture", "correction", "recall", "session"] } });
  const inspection = inspectCorrectionConsent(f.io, f.claim);
  expect(inspection.allowed).toBe(false);
  if (inspection.allowed) throw new Error("synthetic page must refuse");
  expect(inspection.denial?.source_key).toBe(source);
  expect(inspection.denial?.purpose).toBe("derive");
  const state = () => ["events", "claims", "claim_supersessions", "canon_receipts", "native_owner_evidence"]
    .map(table => f.db.query(`SELECT count(*) AS n FROM ${table}`).get());
  const prior = state();
  await expect(correct(f.io, { statement: "Grace works at Northwind.", target: { claim_id: f.claim.claim_id } }))
    .rejects.toThrow(`source ${source} does not permit derive`);
  expect(state()).toEqual(prior);
  expect(getClaim(f.db, f.claim.claim_id)?.status).toBe("live");
  expect(getClaim(f.db, retained.claim_id)?.status).toBe("live");
  expect(readFileSync(join(f.vault, "people/grace.md"), "utf8")).toBe(before);
});
