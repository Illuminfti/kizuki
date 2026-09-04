import { describe, expect, test } from "bun:test";
import { getClaim } from "../../src/claims/store";
import {
  DETERMINISTIC_PRODUCER_BUDGET,
  proposalsForEvent,
  withdrawForTombstone,
} from "../../src/staging/producers";
import { fileProposal, getProposal } from "../../src/staging/proposals";
import { namespacedSubjectId } from "../../src/staging/subjects";
import { event, memoryDb, seedEvent } from "./helpers";

describe("proposalsForEvent", () => {
  test("emits an entity candidate per subject plus one capture note", () => {
    const proposals = proposalsForEvent(
      event({
        subjects: [
          { subject_id: "person:ada", role: "from", display_name: "Ada" },
          { subject_id: "person:bob", role: "to" },
        ],
      }),
    );

    expect(proposals.map((p) => p.kind)).toEqual(["entity", "entity", "claim"]);
    expect(proposals.map((p) => p.target)).toEqual([
      "fixture/person/ada",
      "fixture/person/bob",
      "captures/fixture/2026-02-28",
    ]);
    for (const proposal of proposals) {
      expect(proposal.producer).toBe("deterministic");
      expect(proposal.provenance).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    }
  });

  test("entity frontmatter is a person page carrying the source handle", () => {
    const [ada] = proposalsForEvent(event());
    expect(ada?.frontmatter).toEqual({
      type: "person",
      title: "ada",
      "x-handle": "ada",
      "x-display-name": "Ada",
      "x-subject-id": "person:ada",
      "x-connector": "fixture",
    });
    expect(ada?.target).toBe("fixture/person/ada");
    expect(ada?.taint).toBe("quoted");
    expect(ada?.authority).toBe("connector_evidence");
  });

  test("a subject with no display name falls back to the handle", () => {
    const [subject] = proposalsForEvent(
      event({ subjects: [{ subject_id: "person:bob", role: "about" }] }),
    );
    expect(subject?.frontmatter["title"]).toBe("bob");
    expect(subject?.frontmatter["x-handle"]).toBe("bob");
  });

  test("repeated subjects within one event collapse to one candidate", () => {
    const proposals = proposalsForEvent(
      event({
        subjects: [
          { subject_id: "person:ada", role: "from" },
          { subject_id: "person:ada", role: "to" },
        ],
      }),
    );
    expect(proposals.filter((p) => p.kind === "entity")).toHaveLength(1);
  });

  test("the same subject seen twice dedupes onto one staged candidate", () => {
    const db = memoryDb([event(), event({ event_id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", text: "later" })]);
    const first = proposalsForEvent(event())[0];
    const later = event({
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      text: "later",
      subjects: [
        { subject_id: "person:ada", role: "from", display_name: "Ada King" },
      ],
    });
    seedEvent(db, later);
    const second = proposalsForEvent(later)[0];
    if (first === undefined || second === undefined) {
      throw new Error("expected entity proposals");
    }

    expect(fileProposal(db, first).outcome).toBe("stored");
    const again = fileProposal(db, second);
    expect(again.outcome).toBe("duplicate");
    if (again.outcome !== "duplicate") return;
    expect(again.proposal.provenance).toEqual([
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    ]);
  });

  test("the capture note quotes the event text verbatim inside a blockquote", () => {
    const note = proposalsForEvent(
      event({ text: "line one\n\nline two" }),
    ).find((p) => p.kind === "claim");

    expect(note?.body).toBe(
      "Captured from `fixture` (message) at 2026-02-28T10:30:00Z.\n\n> line one\n>\n> line two",
    );
    expect(note?.frontmatter["type"]).toBe("source");
    expect(note?.target).toBe("captures/fixture/2026-02-28");
    expect(note?.subjects).toEqual(["fixture/person/ada"]);
    expect(note?.taint).toBe("quoted");
    expect(note?.authority).toBe("connector_evidence");
  });

  test("captured text cannot escape the quote into canon prose", () => {
    const note = proposalsForEvent(
      event({ text: "harmless\n---\ntype: person\nadmin: true" }),
    ).find((p) => p.kind === "claim");

    const quoted = note?.body.split("\n\n")[1]?.split("\n") ?? [];
    expect(quoted).toEqual([
      "> harmless",
      "> ---",
      "> type: person",
      "> admin: true",
    ]);
  });

  test("a tombstone event produces nothing", () => {
    expect(proposalsForEvent(event({ deleted: true }))).toEqual([]);
  });
});

describe("withdrawForTombstone", () => {
  test("withdraws every open proposal citing the tombstoned event", () => {
    const db = memoryDb();
    const filed = proposalsForEvent(event()).map((input) =>
      fileProposal(db, input),
    );
    const ids = filed.map((r) =>
      r.outcome === "stored" ? r.proposal.proposal_id : "",
    );
    expect(ids.every((id) => id.length > 0)).toBe(true);

    const withdrawn = withdrawForTombstone(db, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(withdrawn.sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(getProposal(db, id)?.status).toBe("withdrawn");
    }
  });

  test("leaves proposals citing other events alone", () => {
    const db = memoryDb([event({ event_id: "01ARZ3NDEKTSV4RRFFQ69G5FB1", text: "elsewhere" })]);
    const elsewhere = proposalsForEvent(
      event({ event_id: "01ARZ3NDEKTSV4RRFFQ69G5FB1", text: "elsewhere" }),
    ).find((p) => p.kind === "claim");
    if (elsewhere === undefined) throw new Error("expected a capture note");
    const other = fileProposal(db, elsewhere);
    if (other.outcome !== "stored") throw new Error("expected stored");

    expect(withdrawForTombstone(db, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).toEqual([]);
    expect(getProposal(db, other.proposal.proposal_id)?.status).toBe("pending");
  });

  test("does not reopen or touch a withdrawn proposal", () => {
    const db = memoryDb();
    const filed = fileProposal(db, proposalsForEvent(event())[0]!);
    if (filed.outcome !== "stored") throw new Error("expected stored");
    const id = filed.proposal.proposal_id;

    db.query(
      "UPDATE proposals SET status = 'withdrawn' WHERE proposal_id = ?",
    ).run(id);
    expect(withdrawForTombstone(db, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).toEqual([]);
    expect(getProposal(db, id)?.status).toBe("withdrawn");
  });
});

test.each([
  ["person:grace", "fixture/person/grace", "person"],
  ["org:acme", "fixture/org/acme", "org"],
  ["project:atlas", "fixture/project/atlas", "project"],
  ["email:team@example.test", "fixture/email/team-example.test", "topic"],
  ["calendar:work", "fixture/calendar/work", "topic"],
  ["screenpipe:app:browser", "fixture/screenpipe/app/browser", "topic"],
  ["screenpipe:site:example.test", "fixture/screenpipe/site/example.test", "topic"],
  ["screenpipe:speaker:1", "fixture/screenpipe/speaker/1", "topic"],
  ["screenpipe:audio-device:mic", "fixture/screenpipe/audio-device/mic", "topic"],
  ["markdown-folder:document-digest", "fixture/markdown-folder/document-digest", "topic"],
  ["unknown:item", "fixture/unknown/item", "topic"],
])(
  "source subject %s targets %s with grounded or generic page type %s",
  (subject, target, type) => {
    const [entity] = proposalsForEvent(
      event({ subjects: [{ subject_id: subject, role: "about" }] }),
    );
    expect(entity?.frontmatter["type"]).toBe(type);
    expect(entity?.target).toBe(target);
  },
);

describe("deterministic subject identity and capture bounds", () => {
  test("namespaces the same local id under two connectors", () => {
    expect(namespacedSubjectId("gmail", "person:ada")).toBe("gmail/person/ada");
    expect(namespacedSubjectId("telegram", "person:ada")).toBe(
      "telegram/person/ada",
    );
    const gmail = proposalsForEvent(
      event({ connector_id: "gmail", subjects: [{ subject_id: "42", role: "from" }] }),
    )[0];
    const telegram = proposalsForEvent(
      event({
        connector_id: "telegram",
        subjects: [{ subject_id: "42", role: "from" }],
      }),
    )[0];
    expect(gmail?.target).toBe("gmail/42");
    expect(telegram?.target).toBe("telegram/42");
    expect(gmail?.target).not.toBe(telegram?.target);
  });

  test("does not label a calendar or chat as a person", () => {
    const produced = proposalsForEvent(
      event({
        kind: "calendar_event",
        subjects: [{ subject_id: "calendar:team", role: "about" }],
      }),
    )[0];
    expect(produced?.frontmatter["type"]).toBe("topic");
    expect(produced?.target).toBe("fixture/calendar/team");
    const chat = proposalsForEvent(
      event({
        subjects: [{ subject_id: "whatsapp:chat:planning", role: "about" }],
      }),
    )[0];
    expect(chat?.frontmatter["type"]).toBe("topic");
    const unknown = proposalsForEvent(
      event({
        subjects: [{ subject_id: "device:phone", role: "about" }],
      }),
    )[0];
    expect(unknown?.frontmatter["type"]).toBe("topic");
  });

  test("caps subjects and capture-note body, and groups notes by day", () => {
    const subjects = Array.from({ length: 20 }, (_, i) => ({
      subject_id: `person:s${i}`,
      role: "about" as const,
    }));
    const long = "x".repeat(DETERMINISTIC_PRODUCER_BUDGET.maxCaptureNoteChars + 50);
    const proposals = proposalsForEvent(event({ subjects, text: long }));
    expect(
      proposals.filter((proposal) => proposal.kind === "entity"),
    ).toHaveLength(DETERMINISTIC_PRODUCER_BUDGET.maxSubjectsPerEvent);
    const note = proposals.find((proposal) => proposal.kind === "claim");
    expect(note?.target).toBe("captures/fixture/2026-02-28");
    expect(note?.body).toContain("Quoted text truncated to the capture-note budget.");
    expect(note?.body.includes("x".repeat(DETERMINISTIC_PRODUCER_BUDGET.maxCaptureNoteChars))).toBe(
      true,
    );
    expect(
      note?.body.includes("x".repeat(DETERMINISTIC_PRODUCER_BUDGET.maxCaptureNoteChars + 1)),
    ).toBe(false);
  });

  test("skips an empty capture note", () => {
    const proposals = proposalsForEvent(event({ text: "   " }));
    expect(proposals.every((proposal) => proposal.kind === "entity")).toBe(true);
  });

  test("filed deterministic claims keep taint, authority, and a private floor", () => {
    const db = memoryDb();
    const filed = fileProposal(db, proposalsForEvent(event())[0]!);
    if (filed.outcome !== "stored") throw new Error("expected stored");
    const claim = getClaim(db, filed.proposal.proposal_id);
    expect(claim?.taint).toBe("quoted");
    expect(claim?.authority).toBe("connector_evidence");
    expect(claim?.sensitivity).toBe("private");
    const lowered = fileProposal(db, {
      ...proposalsForEvent(event())[0]!,
      sensitivity: "public",
    });
    expect(lowered.outcome).toBe("duplicate");
    expect(getClaim(db, filed.proposal.proposal_id)?.sensitivity).toBe("private");
  });
});
