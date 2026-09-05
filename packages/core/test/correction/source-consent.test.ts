import { afterEach, expect, test } from "bun:test";
import { accept, correct, getClaim, registerConnection, revokeSourceGrant, setSourceGrant, ulid } from "../../src/index";
import { sourceRecordId } from "../../src/correction/parse";
import { canonFixture, storeClaim, write } from "../canon/helpers";
import type { CanonFixture } from "../canon/helpers";
import { validEvent } from "../fixtures";

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
