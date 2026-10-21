import { afterEach, expect, test } from "bun:test";
import { OWNER } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { worldDependencies } from "../../src/world/dependencies";
import { issueKnownSnapshot, lookupKnownSnapshot } from "../../src/world/known/snapshots";
import type { WorldValidQuery } from "../../src/world/ops/types";
import { worldNamespace } from "../../src/world/references";
import { wireDigest } from "../../src/world/views/store";
import { worldFixture } from "../serving/world-fixture";

const databases: ReturnType<typeof openLedger>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const VALID: WorldValidQuery = { kind: "all" };
const NOW = "2026-10-21T10:00:00.000Z";

async function fixture() {
  const db = openLedger(":memory:");
  databases.push(db);
  const world = await worldFixture(db);
  const ns = db.transaction(() => worldNamespace(db, OWNER))();
  const dependencies = worldDependencies();
  dependencies.claims.add(world.claims[0]!);
  const support = db.query<{ support_key: string }, [string]>("SELECT support_key FROM claim_v2_support WHERE claim_id=?").get(world.claims[0]!);
  if (support === null) throw new Error("fixture claim has no support");
  dependencies.supports.add(support.support_key);
  return { db, world, ns, dependencies };
}

test("a known snapshot retains a private cutoff and rejects a broader or different scope", async () => {
  const { db, world, ns, dependencies } = await fixture();
  const ref = issueKnownSnapshot(
    world.ctx,
    ns,
    { handle: "semantic:bayes", valid: VALID, cutoff: { at: NOW, sequence: 7 } },
    dependencies,
    NOW,
  );
  expect(ref).not.toBeNull();
  if (ref === null) throw new Error("snapshot was not issued");
  expect(lookupKnownSnapshot(world.ctx, ns, ref, "semantic:bayes", VALID, NOW)).toEqual({ at: NOW, sequence: 7 });
  expect(lookupKnownSnapshot(world.ctx, ns, ref, "semantic:other", VALID, NOW)).toBeNull();
  expect(lookupKnownSnapshot(world.ctx, ns, ref, "semantic:bayes", { kind: "at", at: NOW }, NOW)).toEqual({ at: NOW, sequence: 7 });
  expect(lookupKnownSnapshot({ ...world.ctx, sourcePurpose: "export" }, ns, ref, "semantic:bayes", VALID, NOW)).toBeNull();

  const at = { kind: "at" as const, at: NOW };
  const narrow = issueKnownSnapshot(
    world.ctx,
    ns,
    { handle: "semantic:bayes", valid: at, cutoff: { at: NOW, sequence: 8 } },
    dependencies,
    NOW,
  );
  if (narrow === null) throw new Error("narrow snapshot was not issued");
  expect(lookupKnownSnapshot(world.ctx, ns, narrow, "semantic:bayes", VALID, NOW)).toBeNull();

  // A snapshot token is not a view token: its stored digest has a distinct domain.
  expect(db.query("SELECT 1 FROM world_view_tokens WHERE token_hash=?").get(wireDigest(ref.token))).toBeNull();
});

test("snapshot expiry and current source-policy withdrawal are uniform misses", async () => {
  const { db, world, ns, dependencies } = await fixture();
  const ref = issueKnownSnapshot(
    world.ctx,
    ns,
    { handle: "semantic:bayes", valid: VALID, cutoff: { at: NOW, sequence: 0 } },
    dependencies,
    NOW,
  );
  expect(ref).not.toBeNull();
  if (ref === null) throw new Error("snapshot was not issued");
  expect(lookupKnownSnapshot(world.ctx, ns, ref, "semantic:bayes", VALID, "2026-10-21T10:15:00.000Z")).toBeNull();

  const fresh = issueKnownSnapshot(
    world.ctx,
    ns,
    { handle: "semantic:bayes", valid: VALID, cutoff: { at: NOW, sequence: 0 } },
    dependencies,
    NOW,
  );
  if (fresh === null) throw new Error("snapshot was not issued");
  setSourceGrant(db, {
    source_key: world.sourceKey,
    expected_revision: 1,
    operation_id: "snapshot-withdraw-recall",
    policy: {
      purposes: ["capture", "derive"],
      allowed_fields: ["text", "subjects", "metadata", "attachments"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "public",
    },
  });
  expect(lookupKnownSnapshot(world.ctx, ns, fresh, "semantic:bayes", VALID, NOW)).toBeNull();
});

test("dependency erasure and namespace replacement are uniform misses", async () => {
  const { db, world, ns, dependencies } = await fixture();
  const ref = issueKnownSnapshot(
    world.ctx,
    ns,
    { handle: "semantic:bayes", valid: VALID, cutoff: { at: NOW, sequence: 0 } },
    dependencies,
    NOW,
  );
  if (ref === null) throw new Error("snapshot was not issued");
  const dependency = db.query<{ wire_ref: string }, [string, string]>(
    "SELECT wire_ref FROM world_wire_claim_targets WHERE namespace_id=? AND claim_id=?",
  ).get(ns.id, world.claims[0]!);
  if (dependency === null) throw new Error("claim dependency was not issued");
  db.query("DELETE FROM world_wire_refs WHERE namespace_id=? AND wire_ref=?").run(ns.id, dependency.wire_ref);
  expect(lookupKnownSnapshot(world.ctx, ns, ref, "semantic:bayes", VALID, NOW)).toBeNull();

  const unbound = { id: "no-longer-current", principalId: ns.principalId };
  expect(lookupKnownSnapshot(world.ctx, unbound, ref, "semantic:bayes", VALID, NOW)).toBeNull();
});
