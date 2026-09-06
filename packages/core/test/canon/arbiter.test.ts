import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chooseCandidate, pageRelPath, resolveTarget } from "../../src/canon/arbiter";
import { targetProblem, targetRefusal } from "../../src/contracts/page-candidate";
import { CanonWriteError } from "../../src/canon/errors";
import { rebuildPageIndex } from "../../src/canon/store";
import { getClaim } from "../../src/claims/store";
import type { Claim } from "../../src/contracts/proposal";
import { serializePage } from "../../src/vault/frontmatter";
import { corroboratedFacts } from "../claims/helpers";
import { canonFixture, putEvent, storeClaim, write } from "./helpers";
import type { CanonFixture } from "./helpers";

const fixtures: CanonFixture[] = [];

function fixture(): CanonFixture {
  const created = canonFixture();
  fixtures.push(created);
  return created;
}

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});

/** Two connectors corroborate, so claims-core does not clamp the tier. */
function twoSources(db: CanonFixture["db"]): { ids: string[]; events: ReturnType<typeof corroboratedFacts> } {
  const first = putEvent(db, { connector_id: "fixture" });
  const second = putEvent(db, { connector_id: "other-fixture" });
  return { ids: [first, second], events: corroboratedFacts(first, second) };
}

describe("pageRelPath", () => {
  test("derives the path from the target and falls back to captures", () => {
    expect(pageRelPath({ claim_id: "01A", target: "people:grace" })).toBe("people/grace.md");
    expect(pageRelPath({ claim_id: "01A", target: "people/grace" })).toBe("people/grace.md");
    expect(pageRelPath({ claim_id: "01A", target: null })).toBe("captures/01A.md");
    expect(() => pageRelPath({ claim_id: "01A", target: "a/../b" })).toThrow(CanonWriteError);
    expect(() => pageRelPath({ claim_id: "01A", target: "a/b/c/d/e/f/g/h/i" })).toThrow(
      /segments/,
    );
    expect(() => pageRelPath({ claim_id: "01A", target: `x/${"y".repeat(65)}` })).toThrow(
      CanonWriteError,
    );
  });

  // A producer that mints a target checks it with `targetProblem` before it
  // files anything. If the two rules ever drift, the producer promises a page
  // the writer will refuse, so pin them to each other rather than to a copy.
  test("accepts exactly the targets targetRefusal calls usable", () => {
    const targets = [
      "people/grace",
      "people:grace",
      "a/b/c/d/e/f/g/h",
      "a/b/c/d/e/f/g/h/i",
      "a/../b",
      "a//b",
      "a/ b",
      `x/${"y".repeat(64)}`,
      `x/${"y".repeat(65)}`,
      "-leading",
      ".hidden",
    ];
    for (const target of targets) {
      const refusal = targetRefusal(target);
      expect(refusal === null).toBe(targetProblem(target) === null);
      if (refusal === null) {
        expect(pageRelPath({ claim_id: "01A", target })).toBe(
          `${target.split(/[:/]/).join("/")}.md`,
        );
        continue;
      }
      expect(() => pageRelPath({ claim_id: "01A", target })).toThrow(refusal);
    }
  });

  test("the refusal quotes nothing from the target it refused", () => {
    // A claim target is derived from captured text, so the writer's error is
    // the rule alone; the producer-side check may name the segment.
    const target = `people/${"my private diary entry ".repeat(20)}`;
    let message = "";
    try {
      pageRelPath({ claim_id: "01A", target });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("target: unusable path segment");
    expect(targetProblem(target)).toContain("my private diary");
    expect((targetProblem(target) as string).length).toBeLessThan(120);
  });
});

describe("resolveTarget", () => {
  test("rule 5: no candidate creates at the derived path", async () => {
    const { db, io } = fixture();
    const claim = await storeClaim(db, putEvent(db));
    expect(resolveTarget(io, claim)).toEqual({ action: "create", rel_path: "people/grace.md" });
  });

  test("rule 1: a bound conflict key edits the bound page before anything else", async () => {
    const { db, io } = fixture();
    const eventId = putEvent(db);
    const first = await storeClaim(db, eventId, {
      predicate: "contact.email",
      object: "grace@acme.test",
      body: "Reach Grace at grace@acme.test.",
    });
    const created = write(io, first);
    // A second subject page makes rule 4 ambiguous; rule 1 still wins.
    write(
      io,
      await storeClaim(db, eventId, {
        target: "people/grace-2",
        predicate: "project.works_on",
        object: "partnerships",
        body: "Grace works on partnerships.",
      }),
    );
    const again = await storeClaim(db, eventId, {
      predicate: "contact.email",
      object: "grace@initech.test",
      body: "Reach Grace at grace@initech.test.",
      target: "people/elsewhere",
    });
    expect(again.claim_key).toBe(first.claim_key);

    const decision = resolveTarget(io, again);
    expect(decision).toEqual({
      action: "edit",
      page_id: expect.any(String),
      rel_path: created.page_path,
      reason: "bound",
    });
  });

  test("rule 2: an explicit target that names an existing page edits it", async () => {
    const { db, io } = fixture();
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    const pageId = getClaim(db, created.claim_ids[0] as string);
    expect(pageId).not.toBeNull();

    const deletion = await storeClaim(db, eventId, {
      kind: "deletion",
      predicate: null,
      object: null,
      subject: null,
      subjects: [],
      body: "Source gone.",
      frontmatter: {},
    });
    expect(resolveTarget(io, deletion)).toEqual({
      action: "edit",
      page_id: expect.any(String),
      rel_path: "people/grace.md",
      reason: "explicit",
    });

    const byId = readFileSync(join(io.vault_path, "people", "grace.md"), "utf8");
    const id = /id: "([^"]+)"/.exec(byId)?.[1] as string;
    const byPageId = await storeClaim(db, eventId, {
      kind: "merge",
      target: id,
      predicate: null,
      object: null,
      body: "Appended prose.",
      frontmatter: {},
    });
    expect(resolveTarget(io, byPageId)).toEqual({
      action: "edit",
      page_id: id,
      rel_path: "people/grace.md",
      reason: "explicit",
    });
  });

  test("rule 3: a claim that won a conflict supersedes on the loser's page", async () => {
    const { db, io } = fixture();
    const sources = twoSources(db);
    const live = await storeClaim(db, sources.ids[0] as string, {
      provenance: sources.ids,
      events: sources.events,
      confidence: 0.6,
      valid_from: "2026-01-01T00:00:00Z",
    });
    expect(live.authority).toBe("connector_evidence");
    const created = write(io, live);

    const incoming = await storeClaim(db, sources.ids[0] as string, {
      provenance: sources.ids,
      events: sources.events,
      object: "initech",
      body: "Grace moved to partnerships lead at Initech.",
      confidence: 0.9,
      valid_from: "2026-07-01T00:00:00Z",
    });
    expect(getClaim(db, live.claim_id)?.status).toBe("superseded");

    const decision = resolveTarget(io, incoming);
    expect(decision).toEqual({
      action: "supersede",
      page_id: expect.any(String),
      rel_path: created.page_path,
      superseded: [live.claim_id],
    });

    const receipt = write(io, incoming, { decision });
    expect(receipt.superseded).toEqual([
      { claim_id: live.claim_id, claim_key: live.claim_key as string },
    ]);
    const page = readFileSync(join(io.vault_path, receipt.page_path), "utf8");
    expect(page).toContain("Initech");
    expect(page).not.toContain("runs partnerships at Acme");
    expect(
      db
        .query<{ receipt_id: string }, [string]>(
          "SELECT receipt_id FROM claim_supersessions WHERE winner = ?",
        )
        .get(incoming.claim_id)?.receipt_id,
    ).toBe(receipt.receipt_id);
  });

  test("rule 4: a single subject page is edited even without a target", async () => {
    const { db, io } = fixture();
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    const untargeted = await storeClaim(db, eventId, {
      target: null,
      predicate: "location.based_in",
      object: "lisbon",
      body: "Grace is based in Lisbon.",
    });
    expect(resolveTarget(io, untargeted)).toEqual({
      action: "edit",
      page_id: expect.any(String),
      rel_path: created.page_path,
      reason: "subject",
    });
  });

  test("rule 6: several subject pages resolve deterministically and never open a queue", async () => {
    const { db, io } = fixture();
    const eventId = putEvent(db);
    const first = write(io, await storeClaim(db, eventId, { target: "people/grace-a" }));
    // A second page starts under another subject key, then a write with an
    // explicit page id re-keys it to grace: two pages now share one subject.
    const second = write(
      io,
      await storeClaim(db, eventId, {
        target: "people/grace-b",
        subject: "person:grace-alt",
        subjects: ["person:grace-alt"],
        body: "Grace, also known under another handle.",
      }),
    );
    const secondId = /id: "([^"]+)"/.exec(
      readFileSync(join(io.vault_path, second.page_path), "utf8"),
    )?.[1] as string;
    write(
      io,
      await storeClaim(db, eventId, {
        target: secondId,
        predicate: "project.works_on",
        object: "partnerships",
        body: "Grace works on partnerships.",
      }),
    );
    const third = await storeClaim(db, eventId, {
      target: null,
      predicate: "location.based_in",
      object: "lisbon",
      body: "Grace is based in Lisbon.",
    });

    const decision = resolveTarget(io, third);
    expect(decision.action).toBe("conflict");
    if (decision.action !== "conflict") throw new Error("unreachable");
    expect(decision.candidates.map((candidate) => candidate.rel_path).sort()).toEqual([
      first.page_path,
      second.page_path,
    ]);
    expect(decision.chosen.rel_path).toBe(first.page_path);

    const receipt = write(io, third, { decision });
    expect(receipt.candidates).toEqual(decision.candidates);
    expect(receipt.page_path).toBe(first.page_path);
    expect(readFileSync(join(io.vault_path, receipt.page_path), "utf8")).toContain(
      "x-ambiguous: true",
    );
  });

  test("chooseCandidate orders by authority, then age, then page id", () => {
    const chosen = chooseCandidate([
      { page_id: "b", rel_path: "b.md", authority: "connector_evidence", created_at: "2026-01-02" },
      { page_id: "a", rel_path: "a.md", authority: "connector_evidence", created_at: "2026-01-02" },
      { page_id: "c", rel_path: "c.md", authority: "owner_authored", created_at: "2026-01-09" },
      { page_id: "d", rel_path: "d.md", authority: "connector_evidence", created_at: "2026-01-01" },
    ]);
    expect(chosen.page_id).toBe("c");
    expect(
      chooseCandidate([
        { page_id: "b", rel_path: "b.md", authority: "model_inference", created_at: "2026-01-02" },
        { page_id: "a", rel_path: "a.md", authority: "model_inference", created_at: "2026-01-02" },
        { page_id: "d", rel_path: "d.md", authority: "model_inference", created_at: "2026-01-03" },
      ]).page_id,
    ).toBe("a");
  });

  test("rule 7: a hand-edited body is never replaced", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    const path = join(vault, created.page_path);
    const page = readFileSync(path, "utf8");
    writeFileSync(path, page.replace("Grace runs partnerships at Acme.", "The owner wrote this."));

    const prose = await storeClaim(db, eventId, {
      predicate: "location.based_in",
      object: "lisbon",
      body: "Grace is based in Lisbon.",
    });
    expect(resolveTarget(io, prose)).toEqual({ action: "skip", reason: "owner_edited_body" });

    const deletion = await storeClaim(db, eventId, {
      kind: "deletion",
      predicate: null,
      object: null,
      body: "Archive it.",
      frontmatter: {},
    });
    expect(resolveTarget(io, deletion)).toMatchObject({ action: "edit", reason: "explicit" });
    expect(readFileSync(path, "utf8")).toContain("The owner wrote this.");
  });

  test("a page without any receipt counts as owner-authored", async () => {
    const { db, io, vault } = fixture();
    const eventId = putEvent(db);
    mkdirSync(join(vault, "people"));
    writeFileSync(
      join(vault, "people", "grace.md"),
      serializePage({
        data: {
          id: "hand:grace",
          title: "Grace",
          type: "person",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
          "x-subject-id": "person:grace",
        },
        body: "Hand-written page.\n",
      }),
    );
    rebuildPageIndex(io);
    const claim = await storeClaim(db, eventId);
    expect(resolveTarget(io, claim)).toEqual({ action: "skip", reason: "owner_edited_body" });
  });

  test("skips and refusals: written, skipped, non-live and page-requiring claims", async () => {
    const { db, io } = fixture();
    const eventId = putEvent(db);
    const claim = await storeClaim(db, eventId);
    write(io, claim);
    expect(resolveTarget(io, getClaim(db, claim.claim_id) as Claim)).toEqual({
      action: "skip",
      reason: "duplicate",
    });

    const skipped: Claim = { ...claim, claim_id: "skipped", receipt_id: null, status: "skipped" };
    expect(resolveTarget(io, skipped)).toEqual({ action: "skip", reason: "below_floor" });
    const zero: Claim = { ...claim, claim_id: "zero", receipt_id: null, confidence: 0 };
    expect(resolveTarget(io, zero)).toEqual({ action: "skip", reason: "below_floor" });

    const superseded: Claim = { ...claim, claim_id: "gone", receipt_id: null, status: "superseded" };
    expect(() => resolveTarget(io, superseded)).toThrow(/superseded/);

    const orphanEdit = await storeClaim(db, eventId, {
      kind: "edit",
      target: "people/nobody",
      subject: "person:nobody",
      subjects: ["person:nobody"],
      predicate: null,
      object: null,
      body: "Edit of a page that does not exist.",
      frontmatter: {},
    });
    expect(() => resolveTarget(io, orphanEdit)).toThrow(/does not exist/);
  });
});
