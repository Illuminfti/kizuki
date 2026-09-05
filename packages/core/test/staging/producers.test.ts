import { describe, expect, test } from "bun:test";
import {
  proposalsForEvent,
  withdrawForTombstone,
} from "../../src/staging/producers";
import { fileProposal, getProposal } from "../../src/staging/proposals";
import { event, memoryDb } from "./helpers";

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
      "person:ada",
      "person:bob",
      null,
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
      title: "Ada",
      "x-handle": "ada",
      "x-subject-id": "person:ada",
      "x-connector": "fixture",
    });
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
    const db = memoryDb();
    const first = proposalsForEvent(event())[0];
    const second = proposalsForEvent(
      event({ event_id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", text: "later" }),
    )[0];
    if (first === undefined || second === undefined) {
      throw new Error("expected entity proposals");
    }

    expect(fileProposal(db, first).outcome).toBe("stored");
    expect(fileProposal(db, second).outcome).toBe("duplicate");
  });

  test("the capture note quotes the event text verbatim inside a blockquote", () => {
    const note = proposalsForEvent(
      event({ text: "line one\n\nline two" }),
    ).find((p) => p.kind === "claim");

    expect(note?.body).toBe(
      "Captured from `fixture` (message) at 2026-02-28T10:30:00Z.\n\n> line one\n>\n> line two",
    );
    expect(note?.frontmatter["type"]).toBe("source");
    expect(note?.subjects).toEqual(["person:ada"]);
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
    const db = memoryDb();
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
  ["person:grace","person"], ["org:acme","org"], ["project:atlas","project"],
  ["email:team@example.test","topic"], ["calendar:work","topic"],
  ["screenpipe:app:browser","topic"], ["screenpipe:site:example.test","topic"],
  ["screenpipe:speaker:1","topic"], ["screenpipe:audio-device:mic","topic"],
  ["markdown-folder:document-digest","topic"], ["unknown:item","topic"],
])("source subject %s has grounded or generic page type %s",(subject,type)=>{
 const [entity]=proposalsForEvent(event({subjects:[{subject_id:subject!,role:"about"}]}));
 expect(entity?.frontmatter["type"]).toBe(type);
 expect(entity?.target).toBe(subject);
});
