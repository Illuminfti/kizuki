import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PAGE_CANDIDATE_KEY,
  PAGE_CANDIDATE_SCHEMA,
} from "../../src/contracts/page-candidate";
import { proposalsForEvent } from "../../src/staging/producers";
import {
  PromoteError,
  ownerPromote,
  renderPage,
} from "../../src/staging/promote";
import { fileProposal } from "../../src/staging/proposals";
import type { StagedProposal } from "../../src/staging/proposals";
import { validatePage } from "../../src/vault/schema";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { event, memoryDb, tempVault } from "./helpers";

function candidateMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    relpath: "people/ada.md",
    [PAGE_CANDIDATE_KEY]: {
      schema: PAGE_CANDIDATE_SCHEMA,
      type: "person",
      title: "Ada",
      target: "entities/ada",
      extensions: { "x-born": 1815, "x-aliases": ["Ada L."] },
      confidence: 1,
      ...overrides,
    },
  };
}

describe("a page candidate on an event", () => {
  test("replaces the capture note with one typed entity proposal", () => {
    const proposals = proposalsForEvent(
      event({
        metadata: candidateMetadata(),
        text: "# Ada\n\nMet at the fair.",
      }),
    );

    expect(proposals.map((p) => p.kind)).toEqual(["entity", "entity"]);
    const page = proposals[1];
    expect(page?.target).toBe("entities/ada");
    expect(page?.body).toBe("# Ada\n\nMet at the fair.");
    expect(page?.producer).toBe("deterministic");
    expect(page?.confidence).toBe(1);
    expect(page?.subjects).toEqual(["person:ada"]);
  });

  test("a non-entity type files as a claim", () => {
    const proposals = proposalsForEvent(
      event({
        subjects: [],
        metadata: candidateMetadata({ type: "fact", target: "facts/steam" }),
      }),
    );
    expect(proposals.map((p) => p.kind)).toEqual(["claim"]);
    expect(proposals[0]?.target).toBe("facts/steam");
  });

  test("frontmatter carries the mapped fields and the floor's provenance", () => {
    const [, page] = proposalsForEvent(
      event({ metadata: candidateMetadata() }),
    );
    expect(page?.frontmatter).toEqual({
      type: "person",
      title: "Ada",
      "x-aliases": ["Ada L."],
      "x-born": 1815,
      "x-connector": "fixture",
      "x-capture-kind": "message",
      "x-source-record-id": "rec-1",
    });
    for (const reserved of ["id", "status", "sensitivity", "sources"]) {
      expect(page?.frontmatter[reserved]).toBeUndefined();
    }
  });

  test("a candidate cannot forge the connector stamp", () => {
    const [, page] = proposalsForEvent(
      event({
        metadata: candidateMetadata({
          extensions: {
            "x-connector": "kizuki.trustworthy",
            "x-source-record-id": "someone-elses-record",
          },
        }),
      }),
    );
    expect(page?.frontmatter["x-connector"]).toBe("fixture");
    expect(page?.frontmatter["x-source-record-id"]).toBe("rec-1");
  });

  test("an invalid candidate falls back to the blockquoted capture note", () => {
    const proposals = proposalsForEvent(
      event({
        text: "line one",
        metadata: candidateMetadata({ type: "template" }),
      }),
    );
    const note = proposals[1];
    expect(note?.kind).toBe("claim");
    expect(note?.target).toBeNull();
    expect(note?.frontmatter["type"]).toBe("source");
    expect(note?.body).toContain("> line one");
  });

  test("a tombstone carrying a candidate still produces nothing", () => {
    expect(
      proposalsForEvent(
        event({ deleted: true, metadata: candidateMetadata() }),
      ),
    ).toEqual([]);
  });

  test("every produced proposal renders a page validatePage accepts", () => {
    const db = memoryDb();
    for (const type of ["person", "fact", "rollup"]) {
      const [, input] = proposalsForEvent(
        event({
          metadata: candidateMetadata({
            type,
            target: `pages/${type}`,
            title: `A ${type}`,
          }),
        }),
      );
      if (input === undefined) throw new Error("expected a candidate proposal");
      const filed = fileProposal(db, input);
      if (filed.outcome !== "stored") throw new Error("expected stored");
      const staged: StagedProposal = filed.proposal;
      for (const sensitivity of ["public", "personal", "private"] as const) {
        const rendered = renderPage(staged, sensitivity, staged.body);
        expect(validatePage(parseFrontmatter(rendered).data)).toEqual([]);
      }
    }
  });

  test("refiling the same page is a duplicate, not a second review item", () => {
    const db = memoryDb();
    const [, first] = proposalsForEvent(
      event({ metadata: candidateMetadata() }),
    );
    const [, second] = proposalsForEvent(
      event({
        event_id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        metadata: candidateMetadata(),
      }),
    );
    if (first === undefined || second === undefined) {
      throw new Error("expected candidate proposals");
    }
    expect(fileProposal(db, first).outcome).toBe("stored");
    expect(fileProposal(db, second).outcome).toBe("duplicate");
  });
});

describe("promoting a migrated page", () => {
  test("writes the target path with the mapped frontmatter and provenance", () => {
    const db = memoryDb();
    const vault = tempVault();
    try {
      const [, input] = proposalsForEvent(
        event({ metadata: candidateMetadata(), text: "Met at the fair." }),
      );
      if (input === undefined) throw new Error("expected a candidate proposal");
      const filed = fileProposal(db, input);
      if (filed.outcome !== "stored") throw new Error("expected stored");

      const receipt = ownerPromote(db, vault.path, filed.proposal.proposal_id, {
        sensitivity: "personal",
      });
      expect(receipt.page_path).toBe("entities/ada.md");
      const page = parseFrontmatter(
        readFileSync(join(vault.path, receipt.page_path), "utf8"),
      );
      expect(page.data["type"]).toBe("person");
      expect(page.data["title"]).toBe("Ada");
      expect(page.data["sensitivity"]).toBe("personal");
      expect(page.data["x-born"]).toBe(1815);
      expect(page.data["sources"]).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
      expect(page.body.trim()).toBe("Met at the fair.");
    } finally {
      vault.dispose();
    }
  });

  test("an edited page re-imported after promotion is refused, not merged", () => {
    const db = memoryDb();
    const vault = tempVault();
    try {
      const [, first] = proposalsForEvent(
        event({ metadata: candidateMetadata(), text: "first body" }),
      );
      const [, second] = proposalsForEvent(
        event({
          event_id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
          metadata: candidateMetadata(),
          text: "an edited body",
        }),
      );
      if (first === undefined || second === undefined) {
        throw new Error("expected candidate proposals");
      }
      const filed = fileProposal(db, first);
      if (filed.outcome !== "stored") throw new Error("expected stored");
      ownerPromote(db, vault.path, filed.proposal.proposal_id, {
        sensitivity: "personal",
      });

      const refiled = fileProposal(db, second);
      if (refiled.outcome !== "stored") throw new Error("expected stored");
      expect(() =>
        ownerPromote(db, vault.path, refiled.proposal.proposal_id, {
          sensitivity: "personal",
        }),
      ).toThrow(PromoteError);
      expect(() =>
        ownerPromote(db, vault.path, refiled.proposal.proposal_id, {
          sensitivity: "personal",
        }),
      ).toThrow(/already exists/);
    } finally {
      vault.dispose();
    }
  });
});
