import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { OWNER, type Grant } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import * as ledger from "../../src/ledger/ledger";
import * as sourceGrants from "../../src/ledger/source-grants";
import { registerConnection } from "../../src/ledger/connections";
import { bindSourceEvent, revokeSourceGrant, setSourceGrant, sourceCaptureAdmission } from "../../src/ledger/source-grants";
import { indexDocument, pageDocument } from "../../src/search/indexer";
import { CanonAccessPhase } from "../../src/serving/canon-access";
import { canonChunk, loadCanon, pageDecision } from "../../src/serving/canon";
import { visibleIndexDegraded } from "../../src/serving/index-health";
import type { ServeContext } from "../../src/serving/types";
import { ulid } from "../../src/util/ulid";
import { seedLivePages } from "../helpers/bulk-pages";
import { tempVault } from "../helpers/vault";

function fixture(count = 2, disk = false) {
  const vault = tempVault();
  const path = disk ? join(vault.path, ".kizuki", "access.sqlite") : ":memory:";
  const db = openLedger(path);
  const seeded = seedLivePages(db, vault.path, count);
  const ctx: ServeContext = { db, vaultPath: vault.path, principal: OWNER };
  const index = loadCanon(ctx);
  const grant = structuredClone(OWNER.grant);
  return { db, path, seeded, ctx, index, grant, access: new CanonAccessPhase(index, grant),
    dispose() { db.close(); vault.dispose(); } };
}

for (const count of [401, 801]) test(`search admission and visible health validate ${count} distinct events once`, () => {
  const f = fixture(count);
  const read = spyOn(ledger, "readLiveEvent");
  const query = spyOn(f.db, "query");
  try {
    for (const page of f.index.pages) expect(f.access.decision(page).allow).toBe(true);
    expect(read).toHaveBeenCalledTimes(count);
    const histories = () => query.mock.calls.filter(([sql]) => sql.includes("row_number() OVER(PARTITION BY page_path")).length;
    expect(histories()).toBe(Math.ceil(count / 400));
    // The fixture has no search projection, but health still traverses the
    // whole derivable corpus before reporting the first missing document.
    expect(visibleIndexDegraded(f.index, f.grant, "search", f.index.pages, f.access)).toBe(true);
    expect(read).toHaveBeenCalledTimes(count);
    expect(histories()).toBe(Math.ceil(count / 400));
  } finally { query.mockRestore(); read.mockRestore(); f.dispose(); }
});

test("local writes, external commits, schema changes and rollback invalidate reused evidence", () => {
  const f = fixture(1, true), page = f.index.pages[0]!;
  const peer = new Database(f.path);
  const read = spyOn(ledger, "readLiveEvent");
  try {
    expect(f.access.decision(page).allow).toBe(true);
    const source = f.seeded[0]!.sourceId;
    const original = f.db.query<{text:string}, [string]>("SELECT text FROM events WHERE event_id=?").get(source)!.text;
    f.db.query("UPDATE events SET text=? WHERE event_id=?").run("changed without a valid event digest", source);
    expect(f.access.decision(page)).toEqual(pageDecision(f.index, f.grant, page));
    expect(f.access.decision(page).allow).toBe(false);
    f.db.query("UPDATE events SET text=? WHERE event_id=?").run(original, source);
    expect(f.access.decision(page).allow).toBe(true);
    peer.query("DELETE FROM events WHERE event_id=?").run(source);
    expect(f.access.decision(page).allow).toBe(false);
    const beforeSchema = read.mock.calls.length;
    f.db.exec("CREATE TABLE access_fixture_schema(value TEXT)");
    expect(f.access.decision(page).allow).toBe(false);
    expect(read.mock.calls.length).toBeGreaterThan(beforeSchema);
  } finally { read.mockRestore(); peer.close(); f.dispose(); }

  const g = fixture(1), current = g.index.pages[0]!;
  try {
    expect(g.access.decision(current).allow).toBe(true);
    g.db.exec("BEGIN; SAVEPOINT access_fixture");
    g.db.query("DELETE FROM events WHERE event_id=?").run(g.seeded[0]!.sourceId);
    expect(g.access.decision(current).allow).toBe(false);
    g.db.exec("ROLLBACK TO access_fixture");
    expect(g.access.decision(current).allow).toBe(true);
    g.db.exec("COMMIT");
    expect(g.access.decision(current).allow).toBe(true);
  } finally { g.dispose(); }
});

test("mutable page, grant, selection and returned evidence cannot revive a cached permission", () => {
  const f = fixture(), page = f.index.pages[0]!;
  try {
    const first = f.access.decision(page);
    expect(first.allow).toBe(true);
    if (first.allow) { first.evidence.sourceIds.length = 0; first.evidence.revision.authority = "owner_authored"; }
    expect(f.access.decision(page)).toEqual(pageDecision(f.index, f.grant, page));
    page.data.sensitivity = "invalid";
    expect(f.access.decision(page).allow).toBe(false);
    page.data.sensitivity = "personal";
    f.grant.types = ["person"];
    expect(f.access.decision(page).allow).toBe(false);
    f.grant.types = null;
    f.ctx.selection = { source: { sourceKey: null, captureEventId: "not-this-source" } };
    expect(f.access.decision(page).allow).toBe(false);
    delete f.ctx.selection;
    f.index.holds.add(page.relPath);
    expect(f.access.decision(page).allow).toBe(false);
    f.index.holds.delete(page.relPath);
    f.grant.deny_classes = ["credential"];
    expect(f.access.decision(page).allow).toBe(true);
    const body = page.body;
    page.body = `${"pass" + "word"}=${["synthetic", "fixture", "only"].join("-")}`;
    expect(f.access.decision(page)).toEqual({ allow: false, reason: "class_denied" });
    page.body = body;
    expect(f.access.decision(page).allow).toBe(true);
    const metadata = { note: "plain" };
    page.data.extra = metadata;
    expect(f.access.decision(page).allow).toBe(true);
    metadata.note = `${"pass" + "word"}=${["synthetic", "fixture", "only"].join("-")}`;
    expect(f.access.decision(page)).toEqual({ allow: false, reason: "class_denied" });
    delete page.data.extra;
    // Source metadata is observed even if contentHash is unchanged.
    page.data.sources = [];
    expect(f.access.decision(page).allow).toBe(false);
  } finally { f.dispose(); }
});

test("newly permitted or renamed in-memory pages fall back to independent authority", () => {
  const f = fixture(), [a, b] = f.index.pages;
  try {
    b!.data.type = "person";
    f.grant.types = ["fact"];
    expect(f.access.decision(a!).allow).toBe(true);
    expect(f.access.decision(b!).allow).toBe(false);
    b!.data.type = "fact";
    expect(f.access.decision(b!)).toEqual(pageDecision(f.index, f.grant, b!));
    expect(f.access.decision(b!).allow).toBe(true);
    b!.relPath = "facts/absent.md";
    expect(f.access.decision(b!)).toEqual(pageDecision(f.index, f.grant, b!));
    expect(f.access.decision(b!).allow).toBe(false);
    const added = { ...a!, data: structuredClone(a!.data) };
    f.index.pages.push(added);
    expect(f.access.decision(added)).toEqual(pageDecision(f.index, f.grant, added));
  } finally { f.dispose(); }
});

test("derive consent stays distinct from recall and revocation defeats final publication", () => {
  const f = fixture(1), page = f.index.pages[0]!, sourceKey = ulid();
  try {
    registerConnection(f.db, "fixture", sourceKey);
    setSourceGrant(f.db, { source_key: sourceKey, expected_revision: 0, operation_id: "access-source",
      policy: { purposes: ["capture", "recall"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public" } });
    bindSourceEvent(f.db, f.seeded[0]!.sourceId, sourceCaptureAdmission(f.db, "fixture", sourceKey)!);
    indexDocument(f.db, pageDocument(page, "model_inference"));
    const decision = f.access.decision(page);
    expect(decision.allow).toBe(true);
    expect(f.access.projectable(page)).toBe(false);
    f.ctx.sourcePurpose = "derive";
    expect(f.access.decision(page).allow).toBe(false);
    delete f.ctx.sourcePurpose;
    expect(f.access.decision(page).allow).toBe(true);
    expect(visibleIndexDegraded(f.index, f.grant, "search", f.index.pages, f.access)).toBe(visibleIndexDegraded(f.index, f.grant, "search"));
    revokeSourceGrant(f.db, { source_key: sourceKey, expected_revision: 1, operation_id: "access-revoke" });
    expect(f.access.decision(page).allow).toBe(false);
    expect(pageDecision(f.index, f.grant, page).allow).toBe(false);
    if (decision.allow) expect(() => canonChunk(f.index, page, decision, "fixture", false)).toThrow();
  } finally { f.dispose(); }
});

test("non-owner unavailable-source health and mismatched phase bindings retain uncached behavior", () => {
  const f = fixture(1), page = f.index.pages[0]!, sourceKey = ulid();
  try {
    registerConnection(f.db, "fixture", sourceKey);
    setSourceGrant(f.db, { source_key: sourceKey, expected_revision: 0, operation_id: "access-agent-source",
      policy: { purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public" } });
    bindSourceEvent(f.db, f.seeded[0]!.sourceId, sourceCaptureAdmission(f.db, "fixture", sourceKey)!);
    indexDocument(f.db, pageDocument(page, "model_inference"));
    f.ctx.principal = { kind: "agent", grant: f.grant, grant_epoch: 0,
      agent: { agent_id: "fixture", name: "fixture", created_at: "2026-01-01T00:00:00Z", revoked_at: null } };
    expect(f.access.decision(page).allow).toBe(true);
    f.db.query("UPDATE events SET text=? WHERE event_id=?").run("invalid synthetic event identity", f.seeded[0]!.sourceId);
    expect(f.access.decision(page).allow).toBe(false);
    expect(visibleIndexDegraded(f.index, f.grant, "search", f.index.pages, f.access)).toBe(false);
    expect(visibleIndexDegraded(f.index, f.grant, "search", f.index.pages, f.access)).toBe(visibleIndexDegraded(f.index, f.grant, "search"));
    const otherGrant = { ...f.grant, ceiling: "public" as const };
    expect(visibleIndexDegraded(f.index, otherGrant, "search", f.index.pages, f.access)).toBe(visibleIndexDegraded(f.index, otherGrant, "search"));
  } finally { f.dispose(); }
});

test("hidden and corrupt pages keep the same reader-visible health", () => {
  const f = fixture(), [a, b] = f.index.pages;
  try {
    for (const page of f.index.pages) indexDocument(f.db, pageDocument(page, "model_inference"));
    const grant: Grant = { ...f.grant, ceiling: "personal" };
    b!.data.sensitivity = "private";
    const access = new CanonAccessPhase(f.index, grant);
    expect(access.decision(a!).allow).toBe(true);
    expect(visibleIndexDegraded(f.index, grant, "search", f.index.pages, access)).toBe(false);
    f.db.query("UPDATE canon_receipts SET after_hash=? WHERE page_path=?").run("0".repeat(64), b!.relPath);
    expect(visibleIndexDegraded(f.index, grant, "search", f.index.pages, access)).toBe(visibleIndexDegraded(f.index, grant, "search"));
    expect(visibleIndexDegraded(f.index, grant, "search", f.index.pages, access)).toBe(false);
    // A visible corruption still degrades, and another page's proof stays valid.
    b!.data.sensitivity = "personal";
    expect(access.decision(a!).allow).toBe(true);
    expect(visibleIndexDegraded(f.index, grant, "search", f.index.pages, access)).toBe(true);
  } finally { f.dispose(); }
});

function consented(count = 2, disk = false) {
  const f = fixture(count, disk), sourceKey = ulid();
  registerConnection(f.db, "fixture", sourceKey);
  const policy = { purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "public" };
  setSourceGrant(f.db, { source_key: sourceKey, expected_revision: 0, operation_id: "access-shared-source", policy });
  const admission = sourceCaptureAdmission(f.db, "fixture", sourceKey)!;
  f.db.transaction(() => { for (const page of f.seeded) bindSourceEvent(f.db, page.sourceId, admission); }).immediate();
  return { ...f, sourceKey, policy };
}

for (const count of [41, 81]) test(`all ${count} bound pages share one complete source inspection across admission and health`, () => {
  const f = consented(count), inspect = spyOn(sourceGrants, "inspectSourceGrant");
  try {
    for (const page of f.index.pages) expect(f.access.decision(page).allow).toBe(true);
    expect(visibleIndexDegraded(f.index, f.grant, "search", f.index.pages, f.access)).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(1);
    const next = new CanonAccessPhase(f.index, f.grant);
    expect(next.decision(f.index.pages[0]!).allow).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(2);
  } finally { inspect.mockRestore(); f.dispose(); }
});

test("reused grants remain private copies and current floors, revocation and external edits remain live", () => {
  const f = consented(1, true), page = f.index.pages[0]!, peer = new Database(f.path);
  try {
    const first = f.access.grantOf(f.sourceKey)!;
    first.policy.purposes.length = 0;
    first.owned_retrieval.push({ store_id: "local:fixture", status: "pending" });
    const second = f.access.grantOf(f.sourceKey)!;
    expect(second.policy.purposes).toContain("recall");
    expect(second.owned_retrieval).toEqual([]);
    second.policy.sensitivity_floor = "private";
    expect(f.access.grantOf(f.sourceKey)!.policy.sensitivity_floor).toBe("public");
    f.grant.ceiling = "personal";
    expect(f.access.decision(page).allow).toBe(true);
    setSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "access-floor-up",
      policy: { ...f.policy, sensitivity_floor: "private" } });
    expect(f.access.decision(page)).toEqual(pageDecision(f.index, f.grant, page));
    expect(f.access.decision(page).allow).toBe(false);
    setSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 2, operation_id: "access-floor-down", policy: f.policy });
    expect(f.access.decision(page).allow).toBe(true);
    peer.query("UPDATE source_grants SET policy_digest=? WHERE source_key=?").run("0".repeat(64), f.sourceKey);
    expect(() => f.access.decision(page)).toThrow("source_policy_corrupt");
    peer.query("UPDATE source_grants SET policy_digest=? WHERE source_key=?").run(first.policy_digest, f.sourceKey);
    expect(f.access.decision(page).allow).toBe(true);
    revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 3, operation_id: "access-shared-revoke" });
    expect(f.access.decision(page).allow).toBe(false);
  } finally { peer.close(); f.dispose(); }
});

test("cached source inspection preserves corrupt-erasure failures and savepoint rollback behavior", () => {
  const f = consented(1), page = f.index.pages[0]!;
  try {
    expect(f.access.decision(page).allow).toBe(true);
    f.db.query("INSERT INTO source_store_inventory(source_key,checked,erasure_report) VALUES (?,0,?) ON CONFLICT(source_key) DO UPDATE SET erasure_report=excluded.erasure_report")
      .run(f.sourceKey, "{}");
    expect(() => f.access.decision(page)).toThrow("source erasure report corrupt");
    expect(() => pageDecision(f.index, f.grant, page)).toThrow("source erasure report corrupt");
    f.db.query("UPDATE source_store_inventory SET erasure_report=NULL WHERE source_key=?").run(f.sourceKey);
    expect(f.access.decision(page).allow).toBe(true);
    f.db.exec("BEGIN; SAVEPOINT source_fixture");
    f.db.query("UPDATE source_grants SET policy_digest=? WHERE source_key=?").run("0".repeat(64), f.sourceKey);
    expect(() => f.access.grantOf(f.sourceKey)).toThrow("source_policy_corrupt");
    f.db.exec("ROLLBACK TO source_fixture");
    expect(f.access.decision(page).allow).toBe(true);
    f.db.exec("COMMIT");
    expect(f.access.decision(page).allow).toBe(true);
  } finally { f.dispose(); }
});

test("source lookup admission remains bounded and oversized inspections use the ordinary reader", () => {
  const f = consented(1), inspect = spyOn(sourceGrants, "inspectSourceGrant");
  try {
    for (let i = 0; i < 129; i++) expect(f.access.grantOf(`absent-${i}`)).toBeNull();
    expect(inspect).toHaveBeenCalledTimes(129);
    expect(f.access.grantOf("absent-0")).toBeNull();
    expect(inspect).toHaveBeenCalledTimes(129);
    expect(f.access.grantOf("absent-128")).toBeNull();
    expect(inspect).toHaveBeenCalledTimes(130);
    const report = { logical_absence: false, owned_file_maintenance: "pending", external_copies: "out_of_scope",
      affected_claim_ids: ["x".repeat(1_048_577)], affected_proposal_ids: [], affected_receipt_ids: [], affected_identity_hashes: [], retained_reasons: [] };
    f.db.query("INSERT INTO source_store_inventory(source_key,checked,erasure_report) VALUES (?,0,?) ON CONFLICT(source_key) DO UPDATE SET erasure_report=excluded.erasure_report")
      .run(f.sourceKey, JSON.stringify(report));
    inspect.mockClear();
    expect(f.access.grantOf(f.sourceKey)!.policy).toEqual(sourceGrants.inspectSourceGrant(f.db, f.sourceKey)!.policy);
    expect(f.access.grantOf(f.sourceKey)!.erasure?.affected_claim_ids[0]?.length).toBe(1_048_577);
    expect(inspect).toHaveBeenCalledTimes(3);
  } finally { inspect.mockRestore(); f.dispose(); }
});

test("raw lookups avoid authorization-input walks while evidence keeps its full boundary checks", () => {
  const f = consented(1), page = f.index.pages[0]!;
  const descriptors = spyOn(Object, "getOwnPropertyDescriptors");
  try {
    const contextWalks = () => descriptors.mock.calls.filter(([value]) => value === f.ctx.principal).length;
    expect(f.access.grantOf(f.sourceKey)!.policy.purposes).toContain("recall");
    for (let i = 0; i < 20; i++) expect(f.access.grantOf(f.sourceKey)!.policy.purposes).toContain("recall");
    expect(contextWalks()).toBe(0);
    // One context check before and after evidence evaluation. Its raw event
    // lookup must not recursively walk that same authorization context again.
    expect(f.access.evidence(page).admitted).toBe(true);
    expect(contextWalks()).toBe(2);
  } finally { descriptors.mockRestore(); f.dispose(); }
});

test("reader context changes reuse raw facts but never an earlier authorization decision", () => {
  const f = consented(1), page = f.index.pages[0]!;
  setSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "access-recall-only",
    policy: { ...f.policy, purposes: ["capture", "recall"] } });
  const read = spyOn(ledger, "readLiveEvent"), inspect = spyOn(sourceGrants, "inspectSourceGrant");
  try {
    expect(f.access.decision(page).allow).toBe(true);
    const parity = (allowed: boolean) => {
      const reads = read.mock.calls.length, inspections = inspect.mock.calls.length;
      const decision = f.access.decision(page);
      expect(decision.allow).toBe(allowed);
      expect(read.mock.calls.length).toBe(reads);
      expect(inspect.mock.calls.length).toBe(inspections);
      expect(decision).toEqual(pageDecision(f.index, f.grant, page));
    };
    f.grant.types = ["person"]; parity(false);
    f.grant.types = null; parity(true);
    f.ctx.sourcePurpose = "derive"; parity(false);
    delete f.ctx.sourcePurpose; parity(true);
    f.ctx.selection = { source: { sourceKey: null, captureEventId: "other-source" } }; parity(false);
    delete f.ctx.selection; parity(true);
    f.ctx.principal = { kind: "agent", grant: f.grant, grant_epoch: 1,
      agent: { agent_id: "fixture", name: "fixture", created_at: "2026-01-01T00:00:00Z", revoked_at: null } };
    parity(true);
    f.ctx.principal.grant_epoch = 2; parity(true);
  } finally { inspect.mockRestore(); read.mockRestore(); f.dispose(); }
});

test("equal database stamps never alias connections and transactions bypass raw policy reuse", () => {
  const f = consented(1, true), a = new Database(f.path), b = new Database(f.path);
  const inspect = spyOn(sourceGrants, "inspectSourceGrant");
  const stamp = (db: Database) => db.query("SELECT total_changes(), (SELECT data_version FROM pragma_data_version), (SELECT schema_version FROM pragma_schema_version)").get();
  try {
    expect(stamp(a)).toEqual(stamp(b));
    f.ctx.db = a;
    expect(f.access.grantOf(f.sourceKey)!.status).toBe("active");
    expect(f.access.grantOf(f.sourceKey)!.status).toBe("active");
    expect(inspect).toHaveBeenCalledTimes(1);
    f.ctx.db = b;
    expect(f.access.grantOf(f.sourceKey)!.status).toBe("active");
    expect(inspect).toHaveBeenCalledTimes(2);
    b.exec("BEGIN");
    expect(f.access.grantOf(f.sourceKey)!.status).toBe("active");
    expect(f.access.grantOf(f.sourceKey)!.status).toBe("active");
    expect(inspect).toHaveBeenCalledTimes(4);
    b.exec("ROLLBACK");
    expect(f.access.grantOf(f.sourceKey)!.status).toBe("active");
    expect(f.access.grantOf(f.sourceKey)!.status).toBe("active");
    expect(inspect).toHaveBeenCalledTimes(5);
  } finally { inspect.mockRestore(); f.ctx.db = f.db; a.close(); b.close(); f.dispose(); }
});
