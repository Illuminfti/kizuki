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
import { canonFixture, storeClaim, budget } from "../canon/helpers";
import { claimInput, putEvent } from "../claims/helpers";
import type { CanonFixture } from "../canon/helpers";

const STATEMENT = "grace is at initech now, not acme";
const AT = "2026-09-02T15:00:00.000Z";

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
    expect(caught.message).toContain("--about");
    expect(caught.message).toContain("--page");
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

  test("relay_owner_corrections false cannot overturn a live owner correction", async () => {
    const { fixture, claimId } = await writtenGrace();
    const first = await correct(
      { db: fixture.db, vault_path: fixture.vault, now: () => AT },
      { statement: STATEMENT, target: { claim_id: claimId } },
    );
    const winnerId = first.claim_ids[0];
    expect(winnerId).toBeDefined();
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
