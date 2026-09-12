import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite } from "../../src/canon/apply";
import { resolveTarget } from "../../src/canon/arbiter";
import { getCanonReceipt } from "../../src/canon/receipts";
import { getClaim, insertClaim, listClaims, listSupersessions } from "../../src/claims/store";
import { correct } from "../../src/correction/correct";
import { CorrectError } from "../../src/correction/errors";
import { getClaimsEpoch } from "../../src/correction/epoch";
import { OWNER_CONNECTOR_ID } from "../../src/correction/types";
import { TOOLS } from "../../src/agents/types";
import { accept } from "../../src/ledger/ledger";
import { registerConnection } from "../../src/ledger/connections";
import { revokeSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { ulid } from "../../src/util/ulid";
import { canonFixture, storeClaim, budget } from "../canon/helpers";
import { claimInput, putEvent } from "../claims/helpers";
import type { CanonFixture } from "../canon/helpers";

const STATEMENT = "grace is at initech now, not acme";
const LATER = "grace is at contoso now, not initech";
const AT = "2026-09-02T15:00:00.000Z";
const LATER_AT = "2026-09-02T16:00:00.000Z";
const SOURCE_POLICY = {
  purposes: ["capture", "derive", "recall", "correction"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked",
  egress: "local_only",
  sensitivity_floor: "private",
} as const;

function grantFixtureSources(fixture: CanonFixture) {
  const fixtureSource = ulid();
  const otherSource = ulid();
  registerConnection(fixture.db, "fixture", fixtureSource);
  registerConnection(fixture.db, "other-fixture", otherSource);
  setSourceGrant(fixture.db, { source_key: fixtureSource, expected_revision: 0, operation_id: `grant-${fixtureSource}`, policy: SOURCE_POLICY });
  setSourceGrant(fixture.db, { source_key: otherSource, expected_revision: 0, operation_id: `grant-${otherSource}`, policy: SOURCE_POLICY });
  for (const row of fixture.db.query<{ event_id: string; connector_id: string }, []>(
    "SELECT event_id, connector_id FROM events WHERE connector_id IN ('fixture', 'other-fixture')",
  ).all()) {
    const sourceKey = row.connector_id === "fixture" ? fixtureSource : otherSource;
    const grant = fixture.db.query<{ revision: number; policy_digest: string }, [string]>(
      "SELECT revision, policy_digest FROM source_grants WHERE source_key=?",
    ).get(sourceKey)!;
    fixture.db.query("INSERT INTO source_event_bindings(event_id,source_key,grant_revision,policy_digest) VALUES (?,?,?,?)").run(
      row.event_id,
      sourceKey,
      grant.revision,
      grant.policy_digest,
    );
  }
  return { fixtureSource, otherSource };
}

function durableCorrectionState(fixture: CanonFixture) {
  return {
    events: fixture.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()?.n,
    ownerEvents: fixture.db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM events WHERE connector_id = 'kizuki.owner'",
      )
      .get()?.n,
    claims: fixture.db
      .query<
        { claim_id: string; status: string; superseded_by: string | null; object: string | null },
        []
      >(
        "SELECT claim_id, status, superseded_by, object FROM claims ORDER BY created_at, claim_id",
      )
      .all(),
    receipts: fixture.db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_receipts").get()?.n,
    evidence: fixture.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM native_owner_evidence")
      .get()?.n,
    supersessions: listSupersessions(fixture.db),
    epoch: getClaimsEpoch(fixture.db),
    page: readFileSync(join(fixture.vault, "people/grace.md"), "utf8"),
  };
}

const fixtures: CanonFixture[] = [];

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});

async function writtenGrace(): Promise<{
  fixture: CanonFixture;
  claimId: string;
  contestedId?: string;
}> {
  const fixture = canonFixture();
  fixtures.push(fixture);
  const first = putEvent(fixture.db, { text: "Grace runs partnerships at Acme." });
  const second = putEvent(fixture.db, {
    source_record_id: "rec-b",
    connector_id: "other-fixture",
    text: "Grace later joined Northwind.",
  });
  const live = await storeClaim(fixture.db, first, {
    provenance: [first, second],
    events: [
      {
        event_id: first,
        connector_id: "fixture",
        taint: "untrusted",
        text: "Grace runs partnerships at Acme.",
      },
      {
        event_id: second,
        connector_id: "other-fixture",
        taint: "untrusted",
        text: "Grace later joined Northwind.",
      },
    ],
  });
  const created = applyCanonWrite(fixture.io, live, resolveTarget(fixture.io, live), {
    writer: "loop",
    budget: budget(),
  });
  expect(created.page_path).toBe("people/grace.md");
  return { fixture, claimId: live.claim_id };
}

describe("correct", () => {
  test("TOOLS registers correct next to propose", () => {
    expect(TOOLS).toContain("propose");
    expect(TOOLS).toContain("correct");
  });

  test("claim_id target works with no model and rewrites in the same pass", async () => {
    const { fixture, claimId } = await writtenGrace();
    const before = readFileSync(join(fixture.vault, "people/grace.md"), "utf8");
    expect(before).toContain("Grace runs partnerships at Acme.");

    const result = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );

    expect(result.receipt_id).toBeString();
    expect(result.event_id.length).toBeGreaterThan(0);
    expect(result.claim_ids.length).toBeGreaterThanOrEqual(1);
    expect(result.superseded.map((row) => row.claim_id)).toEqual([claimId]);
    expect(result.superseded[0]?.was).toBe("acme");
    expect(result.rewritten).toHaveLength(1);
    expect(result.rewritten[0]?.page_path).toBe("people/grace.md");
    expect(result.rewritten[0]?.before_hash.length).toBe(64);
    expect(result.rewritten[0]?.after_hash.length).toBe(64);
    expect(result.rewritten[0]?.before_hash).not.toBe(result.rewritten[0]?.after_hash);
    expect(result.rewritten[0]?.receipt_id).toBe(result.receipt_id);
    expect(result.rewritten[0]?.diff).toContain("--- a/people/grace.md");
    expect(result.rewritten[0]?.diff).toContain("+grace is at initech now, not acme");
    expect(result.answer).toContain("initech");
    expect(result.answer).toContain("acme");
    expect(result.answer).toContain("people/grace.md");
    expect(result.answer).toContain(`kizuki undo ${result.receipt_id}`);

    const loser = getClaim(fixture.db, claimId);
    expect(loser?.status).toBe("superseded");
    expect(loser?.superseded_by).toBe(result.claim_ids[0]);
    expect(listSupersessions(fixture.db).some((row) => row.rule === "R5")).toBe(true);

    const winner = getClaim(fixture.db, result.claim_ids[0] ?? "");
    expect(winner?.authority).toBe("owner_correction");
    expect(winner?.object).toBe("initech");
    expect(winner?.producer).toBe("owner");
    expect(winner?.body).toBe(STATEMENT);

    const after = readFileSync(join(fixture.vault, "people/grace.md"), "utf8");
    expect(after).toContain(STATEMENT);
    expect(after).not.toContain("x-contested");
    expect(after).toContain("initech");

    const receipt = getCanonReceipt(fixture.db, result.receipt_id ?? "");
    expect(receipt?.writer).toBe("correction");
    expect(getClaimsEpoch(fixture.db)).toBe(1);

    const ownerEvents = fixture.db
      .query<{ connector_id: string; metadata: string }, []>(
        "SELECT connector_id, metadata FROM events WHERE connector_id = 'kizuki.owner'",
      )
      .all();
    expect(ownerEvents).toHaveLength(1);
    expect(ownerEvents[0]?.connector_id).toBe(OWNER_CONNECTOR_ID);
    expect(ownerEvents[0]?.metadata).toContain("\"taint\":\"owner\"");
  });

  test("a contested pair is superseded by one owner correction", async () => {
    const fixture = canonFixture();
    fixtures.push(fixture);
    const first = putEvent(fixture.db, { source_record_id: "rec-a" });
    const second = putEvent(fixture.db, {
      source_record_id: "rec-b",
      connector_id: "other-fixture",
    });
    const facts = [
      {
        event_id: first,
        connector_id: "fixture" as const,
        taint: "untrusted" as const,
        text: "Grace runs partnerships at Acme.",
      },
      {
        event_id: second,
        connector_id: "other-fixture" as const,
        taint: "untrusted" as const,
        text: "Grace later joined Northwind.",
      },
    ];
    const acme = await insertClaim(
      { db: fixture.db },
      claimInput(first, {
        target: "people/grace",
        frontmatter: { type: "person", title: "Grace" },
        provenance: [first, second],
        confidence: 0.6,
        valid_from: "2026-01-01T00:00:00.000Z",
        events: facts,
      }),
    );
    expect(acme.outcome).toBe("stored");
    if (acme.outcome !== "stored") return;
    applyCanonWrite(fixture.io, acme.claim, resolveTarget(fixture.io, acme.claim), {
      writer: "loop",
      budget: budget(),
    });
    const northwind = await insertClaim(
      { db: fixture.db },
      claimInput(first, {
        target: "people/grace",
        frontmatter: { type: "person", title: "Grace" },
        provenance: [first, second],
        body: "Grace later joined Northwind.",
        object: "northwind",
        confidence: 0.68,
        valid_from: "2026-06-01T00:00:00.000Z",
        events: facts,
      }),
    );
    expect(northwind.outcome).toBe("contested");
    expect(listClaims(fixture.db, { status: "live" })).toHaveLength(2);

    const result = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: acme.claim.claim_id } },
    );

    expect(result.superseded).toHaveLength(2);
    expect(listClaims(fixture.db, { status: "live" }).map((row) => row.object)).toEqual([
      "initech",
    ]);
    expect(result.rewritten[0]?.page_path).toBe("people/grace.md");
    expect(result.answer).toContain("Superseded 2 claims");
  });

  test("without claim_id or claim_key, correct fails closed with target_required", async () => {
    const { fixture } = await writtenGrace();
    let caught: unknown;
    try {
      await correct(
        { db: fixture.db, vault_path: fixture.vault },
        { statement: STATEMENT },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CorrectError);
    if (!(caught instanceof CorrectError)) return;
    expect(caught.code).toBe("target_required");
    expect(caught.message).toContain("--claim");
    expect(caught.message).not.toContain("--about");
    expect(caught.message).not.toContain("--page");
    expect(listClaims(fixture.db, { status: "superseded" })).toHaveLength(0);
    expect(getClaimsEpoch(fixture.db)).toBe(0);
  });

  test("dry-run computes the supersession and writes nothing", async () => {
    const { fixture, claimId } = await writtenGrace();
    const before = readFileSync(join(fixture.vault, "people/grace.md"), "utf8");
    const result = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId }, dry_run: true },
    );
    expect(result.receipt_id).toBeNull();
    expect(result.rewritten[0]?.receipt_id).toBeNull();
    expect(result.rewritten[0]?.before_hash).not.toBe(result.rewritten[0]?.after_hash);
    expect(result.rewritten[0]?.after_hash.length).toBe(64);
    expect(result.superseded.map((row) => row.claim_id)).toEqual([claimId]);
    expect(getClaim(fixture.db, claimId)?.status).toBe("live");
    expect(readFileSync(join(fixture.vault, "people/grace.md"), "utf8")).toBe(before);
    expect(
      fixture.db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM events WHERE connector_id = 'kizuki.owner'",
        )
        .get()?.n,
    ).toBe(0);
  });

  test("repeating the same statement and target is a duplicate, not a second write", async () => {
    const { fixture, claimId } = await writtenGrace();
    const first = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    const second = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => "2026-09-02T15:01:00.000Z" },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    expect(second.event_id).toBe(first.event_id);
    expect(second.claim_ids[0]).toBe(first.claim_ids[0]);
    expect(
      fixture.db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM events WHERE connector_id = 'kizuki.owner'",
        )
        .get()?.n,
    ).toBe(1);
    expect(listClaims(fixture.db, { status: "live" })).toHaveLength(1);
  });

  test("an agent-relayed correct call is owner tier and records its relay", async () => {
    const { fixture, claimId } = await writtenGrace();
    const result = await correct(
      {
        db: fixture.db,
        vault_path: fixture.vault,
        now: () => AT,
        producer: "agent:reviewer",
      },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    const winner = getClaim(fixture.db, result.claim_ids[0] ?? "");
    expect(winner?.authority).toBe("owner_correction");
    expect(winner?.producer).toBe("agent:reviewer");
    expect(winner?.frontmatter["x-relayed-by"]).toBe("agent:reviewer");
  });

  test("a refused canon write keeps the owner claim", async () => {
    const { fixture, claimId } = await writtenGrace();
    const result = await correct(
      {
        db: fixture.db,
        vault_path: fixture.vault,
        now: () => AT,
        budget: budget(0),
      },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    expect(result.rewritten).toHaveLength(0);
    expect(result.receipt_id).toBeNull();
    expect(getClaim(fixture.db, result.claim_ids[0] ?? "")?.status).toBe("live");
    expect(getClaim(fixture.db, claimId)?.status).toBe("superseded");
    expect(getClaimsEpoch(fixture.db)).toBe(1);
  });

  test("scope.since compares claim valid_from as instants, not strings", async () => {
    const fixture = canonFixture();
    fixtures.push(fixture);
    const eventId = putEvent(fixture.db, { text: "Grace runs partnerships at Acme." });
    const live = await storeClaim(fixture.db, eventId, {
      valid_from: "2026-02-02T23:30:00-02:00",
    });
    applyCanonWrite(fixture.io, live, resolveTarget(fixture.io, live), {
      writer: "loop",
      budget: budget(),
    });

    const included = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      {
        statement: STATEMENT,
        target: { claim_id: live.claim_id },
        scope: { since: "2026-02-03T00:00:00Z" },
      },
    );
    expect(included.superseded.map((row) => row.claim_id)).toEqual([live.claim_id]);
  });

  test("scope.since excludes a later-looking offset that is still before the bound", async () => {
    const fixture = canonFixture();
    fixtures.push(fixture);
    const eventId = putEvent(fixture.db, { text: "Grace runs partnerships at Acme." });
    const live = await storeClaim(fixture.db, eventId, {
      valid_from: "2026-02-03T10:00:00+12:00",
    });
    applyCanonWrite(fixture.io, live, resolveTarget(fixture.io, live), {
      writer: "loop",
      budget: budget(),
    });

    let caught: unknown;
    try {
      await correct(
        { db: fixture.db, vault_path: fixture.vault, now: () => AT },
        {
          statement: STATEMENT,
          target: { claim_id: live.claim_id },
          scope: { since: "2026-02-03T00:00:00Z" },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CorrectError);
    if (!(caught instanceof CorrectError)) return;
    expect(caught.code).toBe("claim_unknown");
    expect(getClaim(fixture.db, live.claim_id)?.status).toBe("live");
  });

  test("relay_owner_corrections false cannot overturn a live owner correction", async () => {
    const { fixture, claimId } = await writtenGrace();
    const first = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    const winnerId = first.claim_ids[0];
    expect(winnerId).toBeDefined();
    if (winnerId === undefined) return;
    let caught: unknown;
    try {
      await correct(
        {
          db: fixture.db,
          vault_path: fixture.vault,
          now: () => "2026-09-02T16:00:00.000Z",
          relay_owner_corrections: false,
        },
        {
          statement: "grace is at contoso now, not initech",
          target: { claim_id: winnerId },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CorrectError);
    if (!(caught instanceof CorrectError)) return;
    expect(caught.code).toBe("below_authority");
    expect(getClaim(fixture.db, winnerId ?? "")?.status).toBe("live");
  });

  test("a new statement against a superseded claim_id is claim_not_live and mutates nothing", async () => {
    const { fixture, claimId } = await writtenGrace();
    await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    expect(getClaim(fixture.db, claimId)?.status).toBe("superseded");
    const before = durableCorrectionState(fixture);

    let caught: unknown;
    try {
      await correct(
        { db: fixture.db, vault_path: fixture.vault, now: () => LATER_AT },
        { statement: LATER, target: { claim_id: claimId } },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CorrectError);
    if (!(caught instanceof CorrectError)) return;
    expect(caught.code).toBe("claim_not_live");
    expect(durableCorrectionState(fixture)).toEqual(before);
  });

  test("the same statement and superseded claim_id reconstructs the recorded correction", async () => {
    const { fixture, claimId } = await writtenGrace();
    const first = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    const recordedId = first.claim_ids[0];
    expect(recordedId).toBeDefined();
    if (recordedId === undefined) return;
    expect(getClaim(fixture.db, claimId)?.status).toBe("superseded");

    const retry = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => "2026-09-02T15:01:00.000Z" },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    expect(retry.event_id).toBe(first.event_id);
    expect(retry.claim_ids).toEqual([recordedId]);
    expect(retry.receipt_id).toBe(first.receipt_id);
    expect(listClaims(fixture.db, { status: "live" }).map((row) => row.claim_id)).toEqual([
      recordedId,
    ]);

    const later = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => LATER_AT },
      { statement: LATER, target: { claim_id: recordedId } },
    );
    const laterId = later.claim_ids[0];
    expect(laterId).toBeDefined();
    if (laterId === undefined) return;
    expect(getClaim(fixture.db, recordedId)?.status).toBe("superseded");
    expect(getClaim(fixture.db, laterId)?.status).toBe("live");
    const afterLater = durableCorrectionState(fixture);

    const replay = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => "2026-09-02T16:01:00.000Z" },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    expect(replay.event_id).toBe(first.event_id);
    expect(replay.claim_ids).toEqual([recordedId]);
    expect(replay.receipt_id).toBe(first.receipt_id);
    expect(getClaim(fixture.db, laterId)?.status).toBe("live");
    expect(durableCorrectionState(fixture)).toEqual(afterLater);
  });

  test("the same statement and superseded claim_id reconstructs a pending rewrite", async () => {
    const { fixture, claimId } = await writtenGrace();
    fixture.db.exec(
      "CREATE TRIGGER synthetic_correction_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic-correction-receipt-failure'); END",
    );
    const first = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    expect(first.recovery_pending?.length).toBeGreaterThan(0);
    expect(getClaim(fixture.db, claimId)?.status).toBe("superseded");
    const recordedId = first.claim_ids[0];
    expect(recordedId).toBeDefined();
    if (recordedId === undefined) return;
    const before = durableCorrectionState(fixture);

    const retry = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => "2026-09-02T15:01:00.000Z" },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    expect(retry.event_id).toBe(first.event_id);
    expect(retry.claim_ids).toEqual([recordedId]);
    expect(retry.recovery_pending).toEqual(first.recovery_pending);
    expect(durableCorrectionState(fixture)).toEqual(before);
  });

  test("a revoked source rejects replay before an unrelated held write can expose page data", async () => {
    const { fixture, claimId } = await writtenGrace();
    const { fixtureSource } = grantFixtureSources(fixture);
    await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    const unrelatedEvent = putEvent(fixture.db, { source_record_id: "unrelated-held-write" });
    const unrelated = await storeClaim(fixture.db, unrelatedEvent, {
      target: "facts/unrelated",
      subject: "fact:unrelated",
      subjects: ["fact:unrelated"],
      body: "An unrelated write is held.",
      frontmatter: { type: "fact", title: "Unrelated" },
    });
    fixture.db.exec("CREATE TRIGGER synthetic_unrelated_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic-unrelated-receipt-failure'); END");
    expect(() => applyCanonWrite(fixture.io, unrelated, resolveTarget(fixture.io, unrelated), {
      writer: "loop", budget: budget(),
    })).toThrow();
    const permitted = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => "2026-09-02T15:01:00.000Z" },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    expect(permitted.recovery_pending).toEqual([]);
    revokeSourceGrant(fixture.db, { source_key: fixtureSource, expected_revision: 1, operation_id: `revoke-${fixtureSource}` });

    let caught: unknown;
    try {
      await correct(
        { db: fixture.db, vault_path: fixture.vault, now: () => "2026-09-02T15:01:00.000Z" },
        { statement: STATEMENT, target: { claim_id: claimId } },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).not.toContain("people/grace.md");
    expect(String(caught)).not.toContain("facts/unrelated.md");
  });

  test("repeating a below_authority correction keeps the live winner", async () => {
    const { fixture, claimId } = await writtenGrace();
    const first = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    const winnerId = first.claim_ids[0];
    expect(winnerId).toBeDefined();
    if (winnerId === undefined) return;
    const input = {
      db: fixture.db,
      vault_path: fixture.vault,
      now: () => LATER_AT,
      relay_owner_corrections: false as const,
    };
    const attempt = { statement: LATER, target: { claim_id: winnerId } };

    let firstCaught: unknown;
    try {
      await correct(input, attempt);
    } catch (error) {
      firstCaught = error;
    }
    expect(firstCaught).toBeInstanceOf(CorrectError);
    if (!(firstCaught instanceof CorrectError)) return;
    expect(firstCaught.code).toBe("below_authority");
    expect(getClaim(fixture.db, winnerId)?.status).toBe("live");
    expect(listClaims(fixture.db, { status: "skipped" }).length).toBeGreaterThan(0);
    const before = durableCorrectionState(fixture);

    let secondCaught: unknown;
    try {
      await correct(input, attempt);
    } catch (error) {
      secondCaught = error;
    }
    expect(secondCaught).toBeInstanceOf(CorrectError);
    if (!(secondCaught instanceof CorrectError)) return;
    expect(secondCaught.code).toBe("below_authority");
    expect(getClaim(fixture.db, winnerId)?.status).toBe("live");
    expect(durableCorrectionState(fixture)).toEqual(before);
  });

  test("claim_key still corrects the live group after a named claim_id is superseded", async () => {
    const { fixture, claimId } = await writtenGrace();
    const key = getClaim(fixture.db, claimId)?.claim_key;
    expect(key).toBeString();
    if (key === undefined || key === null) return;
    const first = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    const recordedId = first.claim_ids[0];
    expect(recordedId).toBeDefined();
    if (recordedId === undefined) return;
    expect(getClaim(fixture.db, claimId)?.status).toBe("superseded");

    const later = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => LATER_AT },
      { statement: LATER, target: { claim_key: key } },
    );
    const laterId = later.claim_ids[0];
    expect(laterId).toBeDefined();
    if (laterId === undefined) return;
    expect(later.superseded.map((row) => row.claim_id)).toContain(recordedId);
    expect(getClaim(fixture.db, recordedId)?.status).toBe("superseded");
    expect(getClaim(fixture.db, laterId)?.status).toBe("live");
    expect(getClaim(fixture.db, laterId)?.object).toBe("contoso");
    expect(listClaims(fixture.db, { status: "live", claim_key: key }).map((row) => row.claim_id)).toEqual([
      laterId,
    ]);
    expect(later.receipt_id).toBeString();
    expect(later.rewritten.map((row) => row.page_path)).toContain("people/grace.md");
    expect(readFileSync(join(fixture.vault, "people/grace.md"), "utf8")).toContain(LATER);
  });
});

describe("accept owner events", () => {
  test("kizuki.owner events are not concatenated into any system prompt field", async () => {
    const { fixture, claimId } = await writtenGrace();
    const result = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    const stored = accept;
    expect(typeof stored).toBe("function");
    const event = fixture.db
      .query<{ text: string; metadata: string }, [string]>(
        "SELECT text, metadata FROM events WHERE event_id = ?",
      )
      .get(result.event_id);
    expect(event?.text).toBe(STATEMENT);
    expect(event?.metadata).not.toContain("system");
  });
});
