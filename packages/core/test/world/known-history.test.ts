import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLAIM_V2_SCHEMA, type ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { mintOccurrenceId } from "../../src/claims/occurrences";
import { getClaim, insertClaim, markClaimReverted, reinstateClaim, resupersedeClaim, reviveUncontestedSkipped, markClaimsAfterPurge } from "../../src/claims/store";
import { registerConnection } from "../../src/ledger/connections";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { runPurge } from "../../src/ledger/purge";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { ulid } from "../../src/util/ulid";
import { exportVault, restoreVault } from "../../src/export";
import { initVault } from "../../src/vault/init";
import { rebuildWorldLayer } from "../../src/derived";
import { applyClaimHistorySchema, assertClaimHistory, beginClaimHistoryRestore, finishClaimHistoryRestore } from "../../src/world/tables/known";
import { WORLD_MIGRATION_VERSIONS } from "../../src/world/tables/versions";
import { canonFixture, budget } from "../canon/helpers";
import { worldFixture } from "../serving/world-fixture";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldClaimHandle, worldCanonPath } from "../../src/canon/world-materialization";
import { correct } from "../../src/correction/correct";
import { undoReceipt } from "../../src/canon/undo";
import { skipCaptureFanoutClaims } from "../../src/claims/capture-fanout";
import { removeWorldSchema } from "../helpers/world-schema";
import { validEvent } from "../fixtures";
setDefaultTimeout(120000);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse())
    cleanup(); });
function fixture(withWorldTables = true) {
    const db = openLedger(":memory:");
    if (!withWorldTables) {
        removeWorldSchema(db);
        db.exec("UPDATE schema_version SET version=31");
    }
    const sourceKey = ulid();
    registerConnection(db, "fixture", sourceKey);
    seedConnectorSensitivity(db, { connector_id: "fixture", source_key: sourceKey }, { default_sensitivity: "personal", sensitivity_floor: "personal" });
    setSourceGrant(db, { source_key: sourceKey, expected_revision: 0, operation_id: `grant-${sourceKey}`, policy: {
            purposes: ["capture", "derive", "recall", "correction", "session", "export"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
            retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "personal",
        } });
    const accepted = accept(db, { ...validEvent(), connector_id: "fixture", source_record_id: `world-${crypto.randomUUID()}`, text: "Grace leads partnerships." }, { source: { source_key: sourceKey, expected_revision: 1 } });
    if (accepted.status !== "stored")
        throw new Error("fixture event refused");
    return { db, eventId: accepted.event.event_id, sourceKey };
}
function semantic(db: ReturnType<typeof fixture>["db"], sourceKey: string, eventId: string): ClaimV2Assertion {
    const event = db.query<{
        connector_id: string;
        source_record_id: string;
        content_hash_version: number;
        content_hash: string;
        text_hash: string;
        origin_binding: string;
        accepted_at: string;
    }, [
        string
    ]>("SELECT connector_id,source_record_id,content_hash_version,content_hash,text_hash,origin_binding,accepted_at FROM events WHERE event_id=?").get(eventId)!;
    const anchor = { event_id: eventId, start_utf16: 0, end_utf16: 5 };
    return { schema: CLAIM_V2_SCHEMA, discriminator: "assertion", predicate: "role.holds",
        object: { kind: "literal", value: "partnerships lead" }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
        context: [], polarity: "positive", valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, temporal_basis: "explicit", anchors: [anchor],
        subject: { kind: "occurrence", id: mintOccurrenceId({ ...event, event_id: eventId }, sourceKey, anchor) } };
}
function suppliedSemantic(db: ReturnType<typeof fixture>["db"], sourceKey: string, eventId: string): ClaimV2Assertion {
    const event = db.query<{
        connector_id: string;
    }, [
        string
    ]>("SELECT connector_id FROM events WHERE event_id=?").get(eventId)!;
    return { schema: CLAIM_V2_SCHEMA, discriminator: "assertion", predicate: "role.holds",
        object: { kind: "literal", value: "partnerships lead" }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
        context: [], polarity: "positive", valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, temporal_basis: "explicit", anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: 5 }],
        subject: { kind: "supplied", id: "person:ada", namespace: { connector_id: event.connector_id, source_key: sourceKey } } };
}
function input(db: ReturnType<typeof fixture>["db"], sourceKey: string, eventId: string) {
    const typed = semantic(db, sourceKey, eventId);
    return { kind: "claim" as const, body: "attacker supplied body", provenance: [eventId], producer: "deterministic" as const, confidence: 1,
        semantic: typed, world_admission: { schema: "kizuki.world-admission/v1" as const, semantic: typed,
            rendering: { body: "Grace leads partnerships.", frontmatter: { source: "fixture" } }, authority: "owner_authored" as const, confidence: 1, epistemicKind: "hypothesis" as const } };
}
function history(db: ReturnType<typeof openLedger>) { return db.query("SELECT * FROM claim_lifecycle_history ORDER BY sequence").all(); }
function clock(db: ReturnType<typeof openLedger>) { return db.query<{
    last_sequence: number;
    last_recorded_at: string;
}, [
]>("SELECT last_sequence,last_recorded_at FROM claim_history_clock").get()!; }
function coverage(db: ReturnType<typeof openLedger>) { return db.query("SELECT * FROM claim_history_coverage ORDER BY claim_id").all(); }
async function stored() {
    const f = fixture();
    cleanups.push(() => f.db.close());
    const result = await insertClaim({ db: f.db, now: () => "2020-01-01T00:00:00.000Z" }, input(f.db, f.sourceKey, f.eventId));
    if (result.outcome !== "stored")
        throw new Error("expected stored");
    return { ...f, claimId: result.claim.claim_id };
}
test("actual world admission has trusted recorded time; duplicate and transaction rollback leave clock unchanged", async () => {
    const f = await stored();
    expect(history(f.db)).toHaveLength(2);
    expect(history(f.db)[0]).toMatchObject({ before_status: null, after_status: "live", claim_id: f.claimId });
    expect(clock(f.db).last_recorded_at > "2020-01-01T00:00:00.000Z").toBe(true);
    const before = { history: history(f.db), clock: clock(f.db) };
    await insertClaim({ db: f.db }, input(f.db, f.sourceKey, f.eventId));
    expect({ history: history(f.db), clock: clock(f.db) }).toEqual(before);
    expect(() => f.db.transaction(() => { markClaimReverted(f.db, f.claimId, "2020-01-02T00:00:00.000Z"); throw new Error("rollback"); }).immediate()).toThrow("rollback");
    expect({ history: history(f.db), clock: clock(f.db) }).toEqual(before);
    assertClaimHistory(f.db);
});
test("supersede, undo, reinstate, raw status writes, relive and receipts all share a clamped ordered clock", async () => {
    const f = await stored();
    f.db.query("UPDATE claim_history_clock SET last_recorded_at=?").run("2099-01-01T00:00:00.000Z");
    resupersedeClaim(f.db, f.claimId, "winner", "2020-01-03T00:00:00.000Z", "2020-01-03T00:00:00.000Z");
    reinstateClaim(f.db, f.claimId, null);
    markClaimReverted(f.db, f.claimId, "2020-01-04T00:00:00.000Z");
    reinstateClaim(f.db, f.claimId, null);
    f.db.query("UPDATE claims SET status='skipped' WHERE claim_id=?").run(f.claimId);
    expect(reviveUncontestedSkipped(f.db)).toBe(1);
    f.db.query("UPDATE claims SET receipt_id='receipt-fixture' WHERE claim_id=?").run(f.claimId);
    const rows = f.db.query<{
        sequence: number;
        recorded_at: string;
        after_status: string;
    }, [
    ]>("SELECT sequence,recorded_at,after_status FROM claim_lifecycle_history ORDER BY sequence").all();
    expect(rows.map(x => x.after_status)).toEqual(["live", "live", "superseded", "live", "reverted", "live", "skipped", "live", "live"]);
    expect(rows.slice(2).every(x => x.recorded_at === "2099-01-01T00:00:00.000Z")).toBe(true);
    expect(rows.map(x => x.sequence)).toEqual(rows.map((_, i) => i + 1));
    expect(() => f.db.exec("UPDATE claim_lifecycle_history SET after_status='live'")).toThrow("append-only");
    expect(() => f.db.exec("DELETE FROM claim_lifecycle_history")).toThrow("coverage boundary");
    assertClaimHistory(f.db);
});
test("upgraded claims receive a present baseline and repeated schema application is idempotent", async () => {
    const f = await stored();
    f.db.transaction(() => { beginClaimHistoryRestore(f.db); f.db.exec("DELETE FROM claim_lifecycle_history; DELETE FROM claim_history_coverage"); }).immediate();
    applyClaimHistorySchema(f.db);
    expect(coverage(f.db)[0]).toMatchObject({ coverage: "baseline_only" });
    expect(history(f.db)[0]).toMatchObject({ before_status: null, after_status: "live" });
    const before = { history: history(f.db), clock: clock(f.db), coverage: coverage(f.db) };
    applyClaimHistorySchema(f.db);
    expect({ history: history(f.db), clock: clock(f.db), coverage: coverage(f.db) }).toEqual(before);
    assertClaimHistory(f.db);
});
test("evidence loss resets affected coverage and full purge erases history even when claim row remains", async () => {
    const f = await stored();
    const before = history(f.db);
    f.db.query("DELETE FROM events WHERE event_id=?").run(f.eventId);
    expect(coverage(f.db)[0]).toMatchObject({ coverage: "baseline_only" });
    expect(history(f.db)).not.toEqual(before);
    expect(history(f.db)[0]).toMatchObject({ receipt_id: null, superseded_by: null });
    markClaimsAfterPurge(f.db, new Date().toISOString());
    expect(f.db.query("SELECT status FROM claims WHERE claim_id=?").get(f.claimId)).toEqual({ status: "purged" });
    expect(history(f.db)).toEqual([]);
    expect(coverage(f.db)).toEqual([]);
    assertClaimHistory(f.db);
});
test("rebuild and real export/restore preserve every recorded position and resume after restored clock", async () => {
    const f = await stored();
    markClaimReverted(f.db, f.claimId, "2020-01-02T00:00:00.000Z");
    reinstateClaim(f.db, f.claimId, null);
    const snapshot = () => ({ history: history(f.db), clock: clock(f.db), coverage: coverage(f.db) });
    const before = snapshot();
    rebuildWorldLayer(f.db);
    expect(snapshot()).toEqual(before);
    const root = mkdtempSync(join(tmpdir(), "known-history-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const vault = join(root, "vault");
    mkdirSync(vault, { mode: 0o700 });
    initVault(vault);
    exportVault(f.db, vault, join(root, "backup"));
    restoreVault(join(root, "backup"), join(root, "restored"));
    const restored = openLedger(join(root, "restored/.kizuki/kizuki.db"));
    cleanups.push(() => restored.close());
    expect({ history: history(restored), clock: clock(restored), coverage: coverage(restored) }).toEqual(before);
    markClaimReverted(restored, f.claimId, "2020-01-02T00:00:00.000Z");
    expect(clock(restored).last_sequence).toBe(before.clock.last_sequence + 1);
    assertClaimHistory(restored);
});
test("restore validation fails closed for missing coverage and transactional DDL rollback restores recording", async () => {
    const f = await stored();
    const before = clock(f.db);
    expect(() => f.db.transaction(() => {
        beginClaimHistoryRestore(f.db);
        f.db.exec("DELETE FROM claim_history_coverage");
        finishClaimHistoryRestore(f.db, WORLD_MIGRATION_VERSIONS.known);
    }).immediate()).toThrow("invalid");
    markClaimReverted(f.db, f.claimId, new Date().toISOString());
    expect(clock(f.db).last_sequence).toBe(before.last_sequence + 1);
    assertClaimHistory(f.db);
});
function vaultFixture() {
    const root = mkdtempSync(join(tmpdir(), "known-purge-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const vault = join(root, "vault");
    mkdirSync(vault, { mode: 0o700 });
    initVault(vault);
    return vault;
}
test("physical purge removes a skipped claim's history while preserving an unrelated claim exactly", async () => {
    const f = await stored();
    const accepted = accept(f.db, { ...validEvent(), source_record_id: crypto.randomUUID() }, { source: { source_key: f.sourceKey, expected_revision: 1 } });
    if (accepted.status !== "stored")
        throw new Error("event missing");
    const other = await insertClaim({ db: f.db }, input(f.db, f.sourceKey, accepted.event.event_id));
    if (other.outcome !== "stored")
        throw new Error("second claim missing");
    const otherHistory = f.db.query("SELECT * FROM claim_lifecycle_history WHERE claim_id=?").all(other.claim.claim_id);
    const otherCoverage = f.db.query("SELECT * FROM claim_history_coverage WHERE claim_id=?").get(other.claim.claim_id);
    f.db.query("UPDATE claims SET status='skipped' WHERE claim_id=?").run(f.claimId);
    await runPurge(f.db, vaultFixture(), { event_id: f.eventId }, "synthetic history erasure");
    expect(f.db.query("SELECT * FROM claim_lifecycle_history WHERE claim_id=?").all(f.claimId)).toEqual([]);
    expect(f.db.query("SELECT * FROM claim_history_coverage WHERE claim_id=?").all(f.claimId)).toEqual([]);
    expect(f.db.query("SELECT * FROM claim_lifecycle_history WHERE claim_id=?").all(other.claim.claim_id)).toEqual(otherHistory);
    expect(f.db.query("SELECT * FROM claim_history_coverage WHERE claim_id=?").get(other.claim.claim_id)).toEqual(otherCoverage);
    assertClaimHistory(f.db);
});
test("purging one event advances a surviving claim's baseline without reconstructing its former provenance", async () => {
    const f = await stored();
    const accepted = accept(f.db, { ...validEvent(), source_record_id: crypto.randomUUID() }, { source: { source_key: f.sourceKey, expected_revision: 1 } });
    if (accepted.status !== "stored")
        throw new Error("event missing");
    f.db.query("UPDATE claims SET provenance=? WHERE claim_id=?").run(JSON.stringify([f.eventId, accepted.event.event_id]), f.claimId);
    const beforeSequence = clock(f.db).last_sequence;
    f.db.query("DELETE FROM events WHERE event_id=?").run(f.eventId);
    markClaimsAfterPurge(f.db, new Date().toISOString());
    const rows = history(f.db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ before_status: null, after_status: "live", receipt_id: null, superseded_by: null });
    expect(rows[1]).toMatchObject({ before_status: "live", after_status: "provenance_reduced" });
    const bound = f.db.query<{
        complete_from_sequence: number;
    }, [
    ]>("SELECT complete_from_sequence FROM claim_history_coverage").get()!;
    expect(bound.complete_from_sequence).toBeGreaterThan(beforeSequence);
    expect(f.db.query("SELECT 1 FROM claim_lifecycle_history WHERE sequence<=?").all(beforeSequence)).toEqual([]);
    assertClaimHistory(f.db);
});
test("clock exhaustion aborts the originating claim transition without partial history", async () => {
    const f = await stored();
    f.db.query("UPDATE claim_history_clock SET last_sequence=?").run(Number.MAX_SAFE_INTEGER);
    const before = history(f.db);
    expect(() => markClaimReverted(f.db, f.claimId, new Date().toISOString())).toThrow();
    expect(history(f.db)).toEqual(before);
    expect(f.db.query("SELECT status FROM claims WHERE claim_id=?").get(f.claimId)).toEqual({ status: "live" });
});
test("a later support admission has its own recorded position while exact retry creates none", async () => {
    const f = fixture();
    cleanups.push(() => f.db.close());
    const semantic1 = suppliedSemantic(f.db, f.sourceKey, f.eventId);
    const firstInput = input(f.db, f.sourceKey, f.eventId);
    const first = await insertClaim({ db: f.db }, { ...firstInput, semantic: semantic1, world_admission: { ...firstInput.world_admission, semantic: semantic1 } });
    if (first.outcome !== "stored")
        throw new Error("first admission missing");
    const boundary = clock(f.db);
    const accepted = accept(f.db, { ...validEvent(), source_record_id: crypto.randomUUID() }, { source: { source_key: f.sourceKey, expected_revision: 1 } });
    if (accepted.status !== "stored")
        throw new Error("second event missing");
    const semantic2 = suppliedSemantic(f.db, f.sourceKey, accepted.event.event_id);
    const secondInput = input(f.db, f.sourceKey, accepted.event.event_id);
    const draft = { ...secondInput, semantic: semantic2, world_admission: { ...secondInput.world_admission, semantic: semantic2 } };
    const second = await insertClaim({ db: f.db }, draft);
    expect(second).toMatchObject({ outcome: "duplicate", claim: { claim_id: first.claim.claim_id } });
    const admissions = f.db.query<{
        support_key: string;
        sequence: number;
    }, [
    ]>("SELECT support_key,sequence FROM claim_lifecycle_history WHERE support_key IS NOT NULL ORDER BY sequence").all();
    expect(admissions).toHaveLength(2);
    expect(admissions[0]!.sequence).toBeLessThanOrEqual(boundary.last_sequence);
    expect(admissions[1]!.sequence).toBeGreaterThan(boundary.last_sequence);
    const after = { clock: clock(f.db), history: history(f.db) };
    await insertClaim({ db: f.db }, draft);
    expect({ clock: clock(f.db), history: history(f.db) }).toEqual(after);
    assertClaimHistory(f.db);
});
test("real correction, undo and redo record the causing receipt rather than the claim's old receipt", async () => {
    const f = canonFixture();
    cleanups.push(() => f.dispose());
    const world = await worldFixture(f.db);
    const claims = world.claims.map(id => getClaim(f.db, id)!);
    const path = worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!);
    const original = applyCanonWrite(f.io, claims, { action: "create", rel_path: path }, { writer: "loop", budget: budget() });
    expect(skipCaptureFanoutClaims(f.db, new Date().toISOString())).toBe(0);
    const changed = await correct(f.io, { statement: "Use prior odds and the likelihood ratio.", target: { claim_id: world.claims[2]! } });
    expect(changed.receipt_id).not.toBeNull();
    const correctedHistory = f.db.query("SELECT * FROM claim_lifecycle_history WHERE claim_id=? ORDER BY sequence DESC LIMIT 1").get(world.claims[2]!);
    expect(correctedHistory).toMatchObject({ after_status: "superseded", receipt_id: changed.receipt_id });
    const undone = await undoReceipt(f.io, changed.receipt_id!);
    expect(f.db.query("SELECT * FROM claim_lifecycle_history WHERE claim_id=? ORDER BY sequence DESC LIMIT 1").get(world.claims[2]!)).toMatchObject({ after_status: "live", receipt_id: undone.receipt_id });
    expect(undone.receipt_id).not.toBe(original.receipt_id);
    const redone = await undoReceipt(f.io, undone.receipt_id);
    expect(f.db.query("SELECT * FROM claim_lifecycle_history WHERE claim_id=? ORDER BY sequence DESC LIMIT 1").get(world.claims[2]!)).toMatchObject({ after_status: "superseded", receipt_id: redone.receipt_id });
    assertClaimHistory(f.db);
});
test("legacy baseline allocation handles multiple claims deterministically without inventing prior time", async () => {
    const f = canonFixture();
    cleanups.push(() => f.dispose());
    const world = await worldFixture(f.db);
    const before = clock(f.db).last_sequence;
    f.db.transaction(() => {
        beginClaimHistoryRestore(f.db);
        f.db.exec("DELETE FROM claim_lifecycle_history; DELETE FROM claim_history_coverage");
        finishClaimHistoryRestore(f.db, WORLD_MIGRATION_VERSIONS.known - 1);
    }).immediate();
    const rows = f.db.query<{
        claim_id: string;
        sequence: number;
        before_status: null;
    }, [
    ]>("SELECT claim_id,sequence,before_status FROM claim_lifecycle_history ORDER BY sequence").all();
    expect(rows).toHaveLength(world.claims.length);
    expect(rows.map(row => row.claim_id)).toEqual([...world.claims].sort());
    expect(rows.map(row => row.sequence)).toEqual(rows.map((_, index) => before + index + 1));
    expect(rows.every(row => row.before_status === null)).toBe(true);
    expect(coverage(f.db).every(row => (row as {
        coverage: string;
    }).coverage === "baseline_only")).toBe(true);
    assertClaimHistory(f.db);
});
test("restore rejects clock rollback, impossible state and missing admission dependencies atomically", async () => {
    const f = await stored();
    const corruptions = [
        "UPDATE claim_history_clock SET last_sequence=0",
        "UPDATE claim_lifecycle_history SET after_status='superseded' WHERE sequence=(SELECT max(sequence) FROM claim_lifecycle_history)",
        "UPDATE claim_lifecycle_history SET support_key='missing-support' WHERE support_key IS NOT NULL",
        "DELETE FROM claim_history_clock",
        "UPDATE claim_lifecycle_history SET receipt_id='missing-receipt'",
        "UPDATE claim_lifecycle_history SET superseded_by='missing-claim'",
    ];
    const before = { history: history(f.db), clock: clock(f.db), coverage: coverage(f.db) };
    for (const corruption of corruptions) {
        expect(() => f.db.transaction(() => {
            beginClaimHistoryRestore(f.db);
            f.db.exec(corruption);
            finishClaimHistoryRestore(f.db, WORLD_MIGRATION_VERSIONS.known);
        }).immediate()).toThrow("invalid");
        expect({ history: history(f.db), clock: clock(f.db), coverage: coverage(f.db) }).toEqual(before);
    }
});

test("erasing a superseding claim advances independently sourced survivor history", async () => {
    const f = await stored();
    const accepted = accept(f.db, { ...validEvent(), source_record_id: crypto.randomUUID() }, { source: { source_key: f.sourceKey, expected_revision: 1 } });
    if (accepted.status !== "stored") throw new Error("event missing");
    const winner = await insertClaim({ db: f.db }, input(f.db, f.sourceKey, accepted.event.event_id));
    if (winner.outcome !== "stored") throw new Error("winner missing");
    resupersedeClaim(f.db, f.claimId, winner.claim.claim_id, new Date().toISOString(), null);
    expect(f.db.query("SELECT 1 FROM claim_lifecycle_history WHERE superseded_by=?").all(winner.claim.claim_id).length).toBeGreaterThan(0);
    const before = f.db.query<{complete_from_sequence:number},[string]>("SELECT complete_from_sequence FROM claim_history_coverage WHERE claim_id=?").get(f.claimId)!;
    await runPurge(f.db, vaultFixture(), { event_id: accepted.event.event_id }, "synthetic supersession erasure");
    expect(f.db.query("SELECT 1 FROM claim_lifecycle_history WHERE superseded_by=?").all(winner.claim.claim_id)).toEqual([]);
    const after = f.db.query<{complete_from_sequence:number},[string]>("SELECT complete_from_sequence FROM claim_history_coverage WHERE claim_id=?").get(f.claimId)!;
    expect(after.complete_from_sequence).toBeGreaterThan(before.complete_from_sequence);
    markClaimReverted(f.db, f.claimId, new Date().toISOString());
    expect(f.db.query("SELECT 1 FROM claim_lifecycle_history WHERE superseded_by=?").all(winner.claim.claim_id)).toEqual([]);
    assertClaimHistory(f.db);
});
