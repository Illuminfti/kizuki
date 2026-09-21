import { expect, test } from "bun:test";
import { join } from "node:path";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { validateWorldEndpointProofs } from "../../src/claims/occurrences";
import { getClaim } from "../../src/claims/store";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { exportVault, restoreVault } from "../../src/export";
import { initGraph } from "../../src/graph/schema";
import { openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { initSearch } from "../../src/search/schema";
import { serveCorrect } from "../../src/serving/correct";
import { readWorldView } from "../../src/serving/world-view";
import { assertWorldState } from "../../src/world/integrity";
import { tempVault } from "../helpers/vault";
import { worldFixture } from "./world-fixture";

function definition(f: Awaited<ReturnType<typeof worldFixture>>) {
  const card = readWorldView(f.ctx, {
    operation: "concept", concept: f.ref,
    valid: { kind: "all" }, knownAt: { kind: "current" },
  });
  if ("status" in card || card.result.status !== "current" || !("definitions" in card.result.data))
    throw new Error("missing definition");
  return card.result.data.definitions[0]!.claim;
}

test("opaque occurrence correction preserves its attested subject through source purge and restore", async () => {
  const vault = tempVault(), out = tempVault(), destination = tempVault();
  const db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    initSearch(db); initGraph(db);
    const f = await worldFixture(db, { occurrence: true });
    const other = await worldFixture(db, { occurrence: true, label: "Independent concept" });
    const prior = readClaimV2Semantic(db, f.claims[2]!)!;
    if (prior.discriminator !== "assertion") throw new Error("missing assertion");
    expect(prior.subject.kind).toBe("occurrence");
    const changed = await serveCorrect({ ...f.ctx, vaultPath: vault.path }, {
      statement: "Use posterior odds after new evidence.", target: { world_claim: definition(f) },
    });
    const id = changed.data?.claim_id;
    expect(id).toBeString();
    expect(getClaim(db, f.claims[2]!)?.status).toBe("superseded");
    const meaning = readClaimV2Semantic(db, id!)!;
    expect(meaning).toMatchObject({ subject: prior.subject, object: { kind: "literal", value: "Use posterior odds after new evidence." } });
    expect(getClaim(db, id!)?.provenance).toEqual([changed.data!.event_id!]);
    const support = JSON.parse(db.query<{ admission: string }, [string]>(
      "SELECT admission FROM claim_v2_support WHERE claim_id=?",
    ).get(id!)!.admission).semantic as ClaimV2Assertion;
    expect(validateWorldEndpointProofs(db, support, null, { restore: true })).toEqual([]);
    // The native statement attests exactly the old endpoint; it cannot mint a
    // foreign occurrence or borrow a second endpoint from the old source.
    expect(() => validateWorldEndpointProofs(db, {
      ...support, subject: { kind: "occurrence", id: "f".repeat(64) },
    }, null, { restore: true })).toThrow("immutable correction target");
    expect(() => validateWorldEndpointProofs(db, {
      ...support, context: [{ kind: "occurrence", id: "f".repeat(64) }],
    }, null, { restore: true })).toThrow("immutable correction target");
    assertWorldState(db);

    purgeEvents(db, vault.path, { event_id: f.eventId }, "occurrence-correction-source-erased");
    expect(getClaim(db, f.claims[2]!)?.status).not.toBe("live");
    expect(db.query("SELECT 1 FROM events WHERE event_id=?").get(f.eventId)).toBeNull();
    expect(getClaim(db, id!)?.status).toBe("live");
    expect(db.query("SELECT 1 FROM claim_occurrences WHERE event_id=?").get(f.eventId)).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM claim_occurrences WHERE event_id=?").get(other.eventId)).toEqual({ n: 1 });
    expect(getClaim(db, other.claims[2]!)?.status).toBe("live");
    assertWorldState(db);
    const backup = join(out.path, "backup"), restoredPath = join(destination.path, "restored");
    await exportVault(db, vault.path, backup);
    restoreVault(backup, restoredPath);
    const restored = openLedger(join(restoredPath, ".kizuki/kizuki.db"));
    try {
      expect(readClaimV2Semantic(restored, id!)).toEqual(meaning);
      assertWorldState(restored);
      const again = await serveCorrect({ ...f.ctx, db: restored, vaultPath: restoredPath }, {
        statement: "Update odds only with independent evidence.", target: { claim_id: id! },
      });
      expect(readClaimV2Semantic(restored, again.data!.claim_id!)!).toMatchObject({
        subject: prior.subject, object: { kind: "literal", value: "Update odds only with independent evidence." },
      });
      assertWorldState(restored);
    } finally { restored.close(); }
  } finally { db.close(); vault.dispose(); out.dispose(); destination.dispose(); }
});

test("revoked occurrence targets refuse before recording native evidence", async () => {
  const vault = tempVault(), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const f = await worldFixture(db, { occurrence: true });
    const target = { world_claim: definition(f) };
    revokeSourceGrant(db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "occurrence-correction-revoke" });
    await expect(serveCorrect({ ...f.ctx, vaultPath: vault.path }, {
      statement: "Must not become an owner statement.", target,
    })).rejects.toThrow("source authorization does not permit this correction");
    expect(db.query("SELECT count(*) AS n FROM native_owner_evidence").get()).toEqual({ n: 0 });
  } finally { db.close(); vault.dispose(); }
});
