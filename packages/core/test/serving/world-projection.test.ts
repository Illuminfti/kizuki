import { expect, test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { WORLD_TABLES } from "../../src/world/schema";

test("fresh ledger installs the persistent world identity and typed ref lifecycle", () => {
  const db = openLedger(":memory:");
  try {
    for (const table of WORLD_TABLES) {
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(table),
      ).not.toBeNull();
    }
  } finally {
    db.close();
  }
});

import {
  OWNER,
  OWNER_AGENT_GRANT,
  addAgent,
  authenticate,
  setGrant,
} from "../../src/agents";
import { readWorldView, serveWorldView } from "../../src/serving/world-view";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { worldFixture } from "./world-fixture";
import { assertWorldState } from "../../src/world/integrity";

const lookup = (
  ref: { kind: "object"; token: string },
  kind = "concept",
  valid: unknown = { kind: "all" },
) => ({ operation: kind, [kind]: ref, valid, knownAt: { kind: "current" } });
test("an admitted supported concept is discoverable and returns evidence-qualified definitions", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db);
    const result = serveWorldView(f.ctx, lookup(f.ref));
    expect(result.schema).toBe("kizuki.envelope/v2");
    expect(result).not.toHaveProperty("source_policy");
    expect(result).not.toHaveProperty("denied");
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("Revise beliefs using evidence");
    expect(serialized).toContain('"independence":"unknown"');
    expect(serialized).not.toContain(f.sourceKey);
    expect(serialized).not.toContain(f.eventId);
    for (const id of f.claims) expect(serialized).not.toContain(id);
    expect(
      readWorldView(
        f.ctx,
        lookup(f.ref, "concept", {
          kind: "at",
          at: "2025-01-01T00:00:00.000Z",
        }),
      ),
    ).toEqual({ status: "not_found" });
    assertWorldState(db);
  } finally {
    db.close();
  }
});
test("Situation uses admitted labels and objective; unknown slots remain explicit", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db, {
      kind: "situation",
      subject: "project:launch",
      label: "Launch",
    });
    const result = readWorldView(f.ctx, lookup(f.ref, "situation"));
    expect(JSON.stringify(result)).toContain(
      '"objective":{"schema":"kizuki.relation/v1"',
    );
    expect(JSON.stringify(result)).toContain('"blocker":null');
  } finally {
    db.close();
  }
});
test("tokens are principal-bound and source revocation is indistinguishable from absence", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db);
    const agent = addAgent(db, "world-reader", { ...OWNER_AGENT_GRANT });
    const principal = authenticate(db, agent.token)!;
    const ctx = { ...f.ctx, principal };
    expect(readWorldView(ctx, lookup(f.ref))).toEqual({ status: "not_found" });
    const discovery = readWorldView(ctx, {
      operation: "find_concepts",
      label: "Bayesian",
      valid: { kind: "all" },
      knownAt: { kind: "current" },
    });
    if (
      "status" in discovery ||
      discovery.result.status === "unavailable" ||
      !("matches" in discovery.result.data)
    )
      throw new Error("missing discovery");
    const ref = discovery.result.data.matches[0]!.ref;
    expect(ref.token).not.toBe(f.ref.token);
    expect(JSON.stringify(readWorldView(ctx, lookup(ref)))).toContain(
      "Revise beliefs",
    );
    revokeSourceGrant(db, {
      source_key: f.sourceKey,
      expected_revision: 1,
      operation_id: "revoke-world",
    });
    expect(readWorldView(ctx, lookup(ref))).toEqual({ status: "not_found" });
    expect(readWorldView(f.ctx, lookup(f.ref))).toEqual({
      status: "not_found",
    });
  } finally {
    db.close();
  }
});

import { tempVault } from "../helpers/vault";
import { join } from "node:path";
import { exportVault, restoreVault } from "../../src/export";
import { rebuildDerived } from "../../src/derived";
import { initSearch } from "../../src/search/schema";
import { initGraph } from "../../src/graph/schema";
import { purgeEvents } from "../../src/ledger/purge";

test("issued references survive reopen, rebuild and mandatory ledger32 backup/restore", async () => {
  const vault = tempVault(),
    out = tempVault(),
    target = tempVault();
  let db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const f = await worldFixture(db),
      input = lookup(f.ref);
    const before = readWorldView({ ...f.ctx, vaultPath: vault.path }, input);
    initSearch(db);
    initGraph(db);
    rebuildDerived(db, vault.path);
    expect(readWorldView({ ...f.ctx, vaultPath: vault.path }, input)).toEqual(
      before,
    );
    db.close();
    db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
    expect(
      readWorldView({ db, vaultPath: vault.path, principal: OWNER }, input),
    ).toEqual(before);
    const backup = join(out.path, "world-backup");
    const manifest = exportVault(db, vault.path, backup);
    expect(manifest.schema_versions.ledger).toBe(32);
    for (const table of WORLD_TABLES)
      expect(manifest.files[`world/${table}.jsonl`]).toBeDefined();
    const destination = join(target.path, "restored");
    restoreVault(backup, destination);
    const restored = openLedger(join(destination, ".kizuki/kizuki.db"));
    try {
      expect(
        readWorldView(
          { db: restored, vaultPath: destination, principal: OWNER },
          input,
        ),
      ).toEqual(before);
      assertWorldState(restored);
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    vault.dispose();
    out.dispose();
    target.dispose();
  }
});

test("physical event purge erases admissions, allocated handles and all dependent wire targets", async () => {
  const vault = tempVault(),
    db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const f = await worldFixture(db);
    initSearch(db);
    initGraph(db);
    readWorldView(f.ctx, lookup(f.ref));
    purgeEvents(
      db,
      vault.path,
      { event_id: f.eventId },
      "synthetic-world-purge",
    );
    expect(readWorldView(f.ctx, lookup(f.ref))).toEqual({
      status: "not_found",
    });
    for (const table of [
      "semantic_handles",
      "semantic_bindings",
      "semantic_allocations",
      "world_wire_object_targets",
      "world_wire_admission_targets",
      "world_wire_event_version_targets",
      "world_wire_claim_targets",
    ])
      expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({
        n: 0,
      });
    expect(
      db.query("SELECT count(*) AS n FROM claim_v2_support").get(),
    ).toEqual({ n: 0 });
    assertWorldState(db);
  } finally {
    db.close();
    vault.dispose();
  }
});

import { revokeAgent } from "../../src/agents";
import { correct } from "../../src/correction/correct";
import { serveCorrect } from "../../src/serving/correct";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { bindLocalSourcePort } from "../../src/ledger/source-grants";
import { pendingRetrievalOps, retryRetrievalOps } from "../../src/claims/store";
import type { RetrievalDoc } from "../../src/contracts/retrieval";
import {
  DIRECT_RETRIEVAL_DESCRIPTOR,
  ReferenceRetrievalPort,
} from "../contracts/reference-retrieval";
import { temporaryPortContext } from "../contracts/fixtures";

const find = (label = "") => ({
  operation: "find_concepts",
  label,
  valid: { kind: "all" },
  knownAt: { kind: "current" },
});
function matches(ctx: Parameters<typeof readWorldView>[0], label = "") {
  const result = readWorldView(ctx, find(label));
  if (
    "status" in result ||
    result.result.status === "unavailable" ||
    !("matches" in result.result.data)
  )
    throw new Error("discovery failed");
  return result.result.data.matches;
}

test("discovery issues only returned object refs and grant changes erase namespaces", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db, { label: "École" });
    expect(matches(f.ctx, "Éco")).toHaveLength(1);
    expect(matches(f.ctx, "éco")).toHaveLength(0);
    expect(
      db
        .query(
          "SELECT ref_kind,count(*) AS n FROM world_wire_refs GROUP BY ref_kind",
        )
        .all(),
    ).toEqual([{ ref_kind: "object", n: 1 }]);
    const added = addAgent(db, "grant-change", { ...OWNER_AGENT_GRANT });
    const ctx = { ...f.ctx, principal: authenticate(db, added.token)! };
    const old = matches(ctx)[0]!.ref;
    setGrant(db, "grant-change", {
      ...OWNER_AGENT_GRANT,
      subjects: ["topic:bayes"],
    });
    expect(
      db.query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?").get(old.token),
    ).toBeNull();
    expect(
      readWorldView(
        { ...ctx, principal: authenticate(db, added.token)! },
        lookup(old),
      ),
    ).toEqual({ status: "not_found" });
    const next = matches({
      ...ctx,
      principal: authenticate(db, added.token)!,
    })[0]!.ref;
    revokeAgent(db, "grant-change");
    expect(
      db
        .query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?")
        .get(next.token),
    ).toBeNull();
    assertWorldState(db);
  } finally {
    db.close();
  }
});

test("denied-only source additions and revocation do not affect narrow payload or issue hidden refs", async () => {
  const db = openLedger(":memory:");
  try {
    const visible = await worldFixture(db);
    const added = addAgent(db, "narrow-world", {
      ...OWNER_AGENT_GRANT,
      ceiling: "public",
      subjects: ["topic:bayes"],
    });
    const ctx = { ...visible.ctx, principal: authenticate(db, added.token)! };
    const ref = matches(ctx)[0]!.ref,
      before = serveWorldView(ctx, lookup(ref));
    const beforeRefs = db
      .query<
        { n: number },
        [string]
      >("SELECT count(*) AS n FROM world_wire_refs WHERE namespace_id=(SELECT namespace_id FROM world_authorization_namespaces WHERE principal_id=?)")
      .get(added.agent.agent_id)!.n;
    let hidden;
    for (let i = 0; i < 40; i++)
      hidden = await worldFixture(db, {
        subject: `topic:hidden-${i}`,
        label: `hidden ${i}`,
        floor: "private",
      });
    revokeSourceGrant(db, {
      source_key: hidden!.sourceKey,
      expected_revision: 1,
      operation_id: "denied-only-revoke",
    });
    const after = serveWorldView(ctx, lookup(ref));
    expect({ ...after, at: before.at }).toEqual(before);
    expect(matches(ctx, "missing-label")).toHaveLength(0);
    expect(
      db
        .query<
          { n: number },
          [string]
        >("SELECT count(*) AS n FROM world_wire_refs WHERE namespace_id=(SELECT namespace_id FROM world_authorization_namespaces WHERE principal_id=?)")
        .get(added.agent.agent_id)!.n,
    ).toBe(beforeRefs);
  } finally {
    db.close();
  }
});

test("actual native owner correction replaces the definition and honors relay consent", async () => {
  const vault = tempVault(),
    db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const f = await worldFixture(db);
    initSearch(db);
    initGraph(db);
    const yes = addAgent(db, "relay-yes", {
      ...OWNER_AGENT_GRANT,
      relay_owner_corrections: true,
    });
    const no = addAgent(db, "relay-no", {
      ...OWNER_AGENT_GRANT,
      relay_owner_corrections: false,
    });
    const yesCtx = { ...f.ctx, principal: authenticate(db, yes.token)! },
      noCtx = { ...f.ctx, principal: authenticate(db, no.token)! };
    const yesRef = matches(yesCtx)[0]!.ref,
      noRef = matches(noCtx)[0]!.ref;
    const changed = await correct(
      { db, vault_path: vault.path },
      {
        statement: "Use prior odds and the likelihood ratio.",
        target: { claim_id: f.claims[2]! },
      },
    );
    expect(changed.claim_ids.length).toBeGreaterThan(0);
    const owner = JSON.stringify(readWorldView(f.ctx, lookup(f.ref)));
    expect(owner).toContain("Use prior odds and the likelihood ratio.");
    expect(owner).not.toContain("Revise beliefs using evidence");
    expect(JSON.stringify(readWorldView(yesCtx, lookup(yesRef)))).toContain(
      "Use prior odds",
    );
    expect(JSON.stringify(readWorldView(noCtx, lookup(noRef)))).not.toContain(
      "Use prior odds",
    );
    assertWorldState(db);
  } finally {
    db.close();
    vault.dispose();
  }
});

test("a public opaque claim ref corrects its current principal-scoped world claim", async () => {
  const vault = tempVault(), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const f = await worldFixture(db);
    const before = readWorldView(f.ctx, lookup(f.ref));
    if ("status" in before || before.result.status !== "current" || !("definitions" in before.result.data)) throw new Error("missing world definition");
    const claim = before.result.data.definitions[0]!.claim;
    const result = await dispatchServeTool(
      { ...f.ctx, vaultPath: vault.path },
      "correct",
      {
        statement: "Use posterior odds after new evidence.",
        object: "Use posterior odds after new evidence.",
        target: { world_claim: claim },
      },
    );
    expect(JSON.stringify(result)).toContain('"claim_id"');
    expect(JSON.stringify(readWorldView(f.ctx, lookup(f.ref)))).toContain("Use posterior odds after new evidence.");
  } finally { db.close(); vault.dispose(); }
});

class WorldCorrectionRetrieval extends ReferenceRetrievalPort {
  failing = false;
  semanticLookups = 0;

  hasClaim(claimId: string): boolean {
    return this.docs.has(`claim:${claimId}`);
  }

  override async search(query: Parameters<ReferenceRetrievalPort["search"]>[0]) {
    this.semanticLookups += 1;
    return super.search(query);
  }

  override async upsert(docs: readonly RetrievalDoc[]) {
    if (this.failing) throw new Error("synthetic retrieval unavailable");
    return super.upsert(docs);
  }

  override async remove(ids: readonly string[]) {
    if (this.failing) throw new Error("synthetic retrieval unavailable");
    return super.remove(ids);
  }
}

async function worldCorrectionFixture() {
  const vault = tempVault();
  let db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
  const retrieval = bindLocalSourcePort(
    new WorldCorrectionRetrieval(temporary.ctx),
    { store_id: "local:world-correction" },
  );
  const world = await worldFixture(db, { retrieval });
  const before = readWorldView(world.ctx, lookup(world.ref));
  if (
    "status" in before ||
    before.result.status !== "current" ||
    !("definitions" in before.result.data)
  ) throw new Error("missing world definition");
  return {
    vault,
    temporary,
    retrieval,
    world,
    claim: before.result.data.definitions[0]!.claim,
    oldClaimId: world.claims[2]!,
    db: () => db,
    reopen: () => {
      db.close();
      db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
      return db;
    },
    dispose: () => {
      db.close();
      temporary.cleanup();
      vault.dispose();
    },
  };
}

test("world claim correction withdraws the old retrieval doc and publishes the owner correction", async () => {
  const f = await worldCorrectionFixture();
  try {
    expect(f.retrieval.hasClaim(f.oldClaimId)).toBe(true);
    const result = await serveCorrect(
      {
        ...f.world.ctx,
        vaultPath: f.vault.path,
        retrieval: f.retrieval,
      },
      {
        statement: "Use posterior odds after new evidence.",
        target: { world_claim: f.claim },
      },
    );
    const correctionId = result.data?.claim_id;
    expect(correctionId).toBeString();
    expect(f.retrieval.hasClaim(f.oldClaimId)).toBe(false);
    expect(f.retrieval.hasClaim(correctionId!)).toBe(true);
    expect(pendingRetrievalOps(f.db())).toEqual([]);
    expect(f.retrieval.semanticLookups).toBe(0);
  } finally {
    f.dispose();
  }
});

test("world claim correction leaves a durable retrieval retry after publication failure", async () => {
  const f = await worldCorrectionFixture();
  try {
    f.retrieval.failing = true;
    const result = await serveCorrect(
      {
        ...f.world.ctx,
        vaultPath: f.vault.path,
        retrieval: f.retrieval,
      },
      {
        statement: "Use posterior odds after new evidence.",
        target: { world_claim: f.claim },
      },
    );
    const correctionId = result.data?.claim_id;
    expect(correctionId).toBeString();
    expect(pendingRetrievalOps(f.db()).map((op) => op.doc_id).sort()).toEqual(
      [f.oldClaimId, correctionId!].sort(),
    );

    const reopened = f.reopen();
    f.retrieval.failing = false;
    expect(await retryRetrievalOps({ db: reopened, retrieval: f.retrieval })).toEqual({
      retried: 2,
      pending: 0,
    });
    expect(f.retrieval.hasClaim(f.oldClaimId)).toBe(false);
    expect(f.retrieval.hasClaim(correctionId!)).toBe(true);
    expect(f.retrieval.semanticLookups).toBe(0);
  } finally {
    f.dispose();
  }
});

test("opaque world claim refs never mint native corrections after access is withdrawn", async () => {
  const vault = tempVault(), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const f = await worldFixture(db);
    const card = readWorldView(f.ctx, lookup(f.ref));
    if ("status" in card || card.result.status !== "current" || !("definitions" in card.result.data))
      throw new Error("missing world definition");
    const claim = card.result.data.definitions[0]!.claim;
    const evidenceCount = () =>
      (db.query<{ n: number }, []>("SELECT count(*) AS n FROM native_owner_evidence").get()!).n;
    const refuseWithoutEvidence = async (ctx: typeof f.ctx, message: string) => {
      const before = evidenceCount();
      await expect(
        serveCorrect({ ...ctx, vaultPath: vault.path }, {
          statement: "This must never create native evidence.",
          target: { world_claim: claim },
        }),
      ).rejects.toThrow(message);
      expect(evidenceCount()).toBe(before);
    };

    const agent = addAgent(db, "opaque-other-principal", { ...OWNER_AGENT_GRANT });
    await refuseWithoutEvidence(
      { ...f.ctx, principal: authenticate(db, agent.token)! },
      "names no live claim",
    );

    const agentCtx = { ...f.ctx, principal: authenticate(db, agent.token)! };
    const agentRef = matches(agentCtx)[0]!.ref;
    const agentCard = readWorldView(agentCtx, lookup(agentRef));
    if ("status" in agentCard || agentCard.result.status !== "current" || !("definitions" in agentCard.result.data))
      throw new Error("missing agent world definition");
    const agentClaim = agentCard.result.data.definitions[0]!.claim;
    const stalePrincipal = agentCtx.principal;
    setGrant(db, "opaque-other-principal", { ...OWNER_AGENT_GRANT, subjects: ["topic:elsewhere"] });
    const beforeNarrowed = evidenceCount();
    await expect(
      serveCorrect(
        { ...f.ctx, vaultPath: vault.path, principal: stalePrincipal },
        { statement: "This must never create native evidence.", target: { world_claim: agentClaim } },
      ),
    ).rejects.toThrow("names no live claim");
    expect(evidenceCount()).toBe(beforeNarrowed);

    revokeSourceGrant(db, {
      source_key: f.sourceKey,
      expected_revision: 1,
      operation_id: "opaque-correction-revoke",
    });
    await refuseWithoutEvidence(f.ctx, "source authorization does not permit this correction");

    purgeEvents(db, vault.path, { event_id: f.eventId }, "opaque-correction-erased");
    await refuseWithoutEvidence(f.ctx, "names no live claim");
  } finally { db.close(); vault.dispose(); }
});

test("raw serving rejects non-exact opaque claim selectors before native evidence", async () => {
  const vault = tempVault(), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const f = await worldFixture(db);
    const card = readWorldView(f.ctx, lookup(f.ref));
    if ("status" in card || card.result.status !== "current" || !("definitions" in card.result.data))
      throw new Error("missing world definition");
    const claim = card.result.data.definitions[0]!.claim;
    const evidenceCount = () =>
      (db.query<{ n: number }, []>("SELECT count(*) AS n FROM native_owner_evidence").get()!).n;
    for (const target of [
      { world_claim: { ...claim }, extra: true },
      { world_claim: { ...claim, extra: true } },
    ]) {
      const before = evidenceCount();
      await expect(
        serveCorrect(
          { ...f.ctx, vaultPath: vault.path },
          { statement: "This must never create native evidence.", target } as never,
        ),
      ).rejects.toThrow("names no live claim");
      expect(evidenceCount()).toBe(before);
    }
  } finally { db.close(); vault.dispose(); }
});

import { resumeSourceRevocation } from "../../src/ledger/source-grants";

test("source revocation physically erases one contribution while independent meaning survives", async () => {
  const vault = tempVault(),
    db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const first = await worldFixture(db);
    const nativeEvents = await addNativeSupport(db, first.claims);
    const second = first;
    initSearch(db);
    initGraph(db);
    readWorldView(first.ctx, lookup(first.ref));
    revokeSourceGrant(db, {
      source_key: first.sourceKey,
      expected_revision: 1,
      operation_id: "erase-independent-source",
    });
    const revoked = await resumeSourceRevocation(
      db,
      vault.path,
      "erase-independent-source",
      {
        ownedRetrieval: {
          stores: async () => ({ stores: [], absent_store_ids: [] }),
        },
      },
    );
    expect({
      status: revoked.status,
      blockers: revoked.purge_blockers,
    }).toMatchObject({ status: "purged", blockers: [] });
    const result = readWorldView(second.ctx, lookup(second.ref));
    expect(JSON.stringify(result)).toContain("Revise beliefs using evidence");
    expect(
      db.query("SELECT 1 FROM events WHERE event_id=?").get(first.eventId),
    ).toBeNull();
    for (const table of [
      "claim_v2_semantics",
      "claim_v2_support",
      "claim_v2_support_events",
      ...WORLD_TABLES,
    ])
      expect(
        JSON.stringify(db.query(`SELECT * FROM ${table}`).all()),
      ).not.toContain(first.eventId);
    for (const id of second.claims)
      expect(
        db
          .query("SELECT status,provenance FROM claims WHERE claim_id=?")
          .get(id),
      ).toEqual({
        status: "live",
        provenance: JSON.stringify([nativeEvents[second.claims.indexOf(id)]!]),
      });
    assertWorldState(db);
  } finally {
    db.close();
    vault.dispose();
  }
});

import { Database } from "bun:sqlite";
import { removeWorldSchema } from "../helpers/world-schema";

test("ledger31 migration is atomic on failure and preserves legacy rows", () => {
  const vault = tempVault(),
    path = join(vault.path, ".kizuki/kizuki.db");
  let db = openLedger(path);
  try {
    removeWorldSchema(db);
    db.exec("UPDATE schema_version SET version=31");
    db.exec("CREATE TABLE semantic_handles(blocker TEXT)");
    db.close();
    expect(() => openLedger(path)).toThrow();
    db = new Database(path);
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({
      version: 31,
    });
    expect(
      db
        .query(
          "SELECT name FROM pragma_table_info('claims') WHERE name='is_world_typed'",
        )
        .get(),
    ).toBeNull();
    db.exec("DROP TABLE semantic_handles");
    db.close();
    db = openLedger(path);
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({
      version: 33,
    });
    expect(
      db.query("SELECT count(*) AS n FROM semantic_handles").get(),
    ).toEqual({ n: 0 });
    assertWorldState(db);
  } finally {
    db.close();
    vault.dispose();
  }
});

import {
  countUnwrittenLiveClaims,
  listUnwrittenLiveClaims,
} from "../../src/claims/store";
test("typed parents remain neutral and never enter the legacy materialization queue", async () => {
  const db = openLedger(":memory:");
  try {
    await worldFixture(db);
    expect(db.query("SELECT body,frontmatter FROM claims").all()).toEqual(
      Array.from({ length: 3 }, () => ({ body: "", frontmatter: "{}" })),
    );
    expect(countUnwrittenLiveClaims(db)).toBe(0);
    expect(listUnwrittenLiveClaims(db)).toEqual([]);
  } finally {
    db.close();
  }
});

import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import { semanticKey } from "../../src/claims/claim-v2-keys";
import { insertClaim } from "../../src/claims/store";
import { recordNativeCorrection } from "../../src/correction/evidence";
import { validEvent } from "../fixtures";
import { ulid } from "../../src/util/ulid";
import { sha256Hex } from "../../src/util/hash";
async function addNativeSupport(
  db: Database,
  claims: readonly string[],
): Promise<string[]> {
  const events: string[] = [];
  for (const claimId of claims) {
    const prior = readClaimV2Semantic(db, claimId)!;
    if (prior.discriminator !== "assertion")
      throw new Error("missing assertion");
    const text = "Owner confirms the targeted assertion.";
    const proof = recordNativeCorrection(
      db,
      {
        ...validEvent(),
        connector_id: "kizuki.owner",
        source_record_id: ulid(),
        text,
        subjects: [{ subject_id: prior.subject.id, role: "about" }],
        metadata: {
          taint: "owner",
          origin: "external",
          world_target: {
            claim_id: claimId,
            semantic_key: semanticKey(prior),
            subject: prior.subject,
            predicate: prior.predicate,
          },
        },
      },
      sha256Hex(ulid()),
    );
    const semantic = {
      ...prior,
      schema: "kizuki.claim/v2" as const,
      perspective: { ...prior.perspective, anchors: [] },
      anchors: [
        { event_id: proof.event_id, start_utf16: 0, end_utf16: text.length },
      ],
    };
    await insertClaim(
      { db },
      {
        kind: "claim",
        body: text,
        provenance: [proof.event_id],
        producer: "owner",
        intent: "correct",
        confidence: 1,
        semantic,
        events: [
          {
            event_id: proof.event_id,
            connector_id: "kizuki.owner",
            taint: "owner",
            text,
          },
        ],
        world_admission: {
          schema: "kizuki.world-admission/v1",
          semantic,
          rendering: { body: text, frontmatter: {} },
          authority: "owner_correction",
          confidence: 1,
          epistemicKind: "owner_assertion",
        },
      },
    );
    events.push(proof.event_id);
  }
  return events;
}

test("same supplied IDs stay distinct across connector and source namespaces through restore and purge", async () => {
  const vault = tempVault(),
    out = tempVault(),
    destination = tempVault();
  const db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const first = await worldFixture(db, {
      subject: "alice",
      label: "Source A",
    });
    const second = await worldFixture(db, {
      subject: "alice",
      label: "Source B",
    });
    const third = await worldFixture(db, {
      subject: "alice",
      label: "Source C",
      connector: "another.fixture",
    });
    expect(
      new Set([first.ref.token, second.ref.token, third.ref.token]).size,
    ).toBe(3);
    expect(
      new Set([...first.claims, ...second.claims, ...third.claims]).size,
    ).toBe(9);
    for (const [current, foreign] of [
      [first, second],
      [second, third],
      [third, first],
    ] as const) {
      const card = JSON.stringify(
        readWorldView(current.ctx, lookup(current.ref)),
      );
      expect(card).toContain(current.label);
      expect(card).not.toContain(foreign.label);
    }
    initSearch(db);
    initGraph(db);
    const backup = join(out.path, "backup");
    await exportVault(db, vault.path, backup);
    const path = join(destination.path, "restored");
    restoreVault(backup, path);
    const restored = openLedger(join(path, ".kizuki/kizuki.db"));
    try {
      for (const f of [first, second, third])
        expect(
          JSON.stringify(
            readWorldView(
              { ...f.ctx, db: restored, vaultPath: path },
              lookup(f.ref),
            ),
          ),
        ).toContain(f.label);
      assertWorldState(restored);
    } finally {
      restored.close();
    }
    purgeEvents(db, vault.path, { event_id: first.eventId }, "namespace-purge");
    expect(readWorldView(first.ctx, lookup(first.ref))).toEqual({
      status: "not_found",
    });
    expect(
      JSON.stringify(readWorldView(second.ctx, lookup(second.ref))),
    ).toContain(second.label);
    expect(
      JSON.stringify(readWorldView(third.ctx, lookup(third.ref))),
    ).toContain(third.label);
    assertWorldState(db);
  } finally {
    db.close();
    vault.dispose();
    out.dispose();
    destination.dispose();
  }
});

test("erasing one event preserves independently supported meaning within the same supplied namespace", async () => {
  const vault = tempVault(),
    db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const first = await worldFixture(db),
      second = await worldFixture(db, { sourceKey: first.sourceKey });
    expect(first.claims).toEqual(second.claims);
    initSearch(db);
    initGraph(db);
    purgeEvents(db, vault.path, { event_id: first.eventId }, "one-event-purge");
    expect(
      JSON.stringify(readWorldView(second.ctx, lookup(second.ref))),
    ).toContain("Revise beliefs");
    for (const table of [
      "claim_v2_semantics",
      "claim_v2_support",
      "claim_v2_support_events",
      ...WORLD_TABLES,
    ])
      expect(
        JSON.stringify(db.query(`SELECT * FROM ${table}`).all()),
      ).not.toContain(first.eventId);
    assertWorldState(db);
  } finally {
    db.close();
    vault.dispose();
  }
});

test("projection validates the complete assertion and perspective evidence union", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db, { perspectiveEvidence: true });
    expect(JSON.stringify(readWorldView(f.ctx, lookup(f.ref)))).toContain(
      "Revise beliefs using evidence",
    );
    const anchors = JSON.parse(
      db
        .query<
          { anchors: string },
          []
        >("SELECT anchors FROM claim_v2_support LIMIT 1")
        .get()!.anchors,
    );
    expect(anchors).toHaveLength(2);
    assertWorldState(db);
  } finally {
    db.close();
  }
});

test("unsupported nonliteral correction fails before recording native evidence", async () => {
  const vault = tempVault(),
    db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const f = await worldFixture(db);
    const before = db
      .query("SELECT count(*) AS n FROM native_owner_evidence")
      .get();
    await expect(
      correct(
        { db, vault_path: vault.path },
        {
          statement: "Change classification",
          target: { claim_id: f.claims[0]! },
        },
      ),
    ).rejects.toThrow("plain supplied-subject literal");
    expect(
      db.query("SELECT count(*) AS n FROM native_owner_evidence").get(),
    ).toEqual(before);
  } finally {
    db.close();
    vault.dispose();
  }
});
