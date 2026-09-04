import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PAGE_CANDIDATE_KEY,
  PAGE_CANDIDATE_SCHEMA,
} from "../../src/contracts/page-candidate";
import { getCanonReceipt } from "../../src/canon/receipts";
import { insertClaim } from "../../src/claims/store";
import type { Claim } from "../../src/contracts/proposal";
import { accept } from "../../src/ledger/ledger";
import { proposalsForEvent } from "../../src/staging/producers";
import { fileProposal } from "../../src/staging/proposals";
import { validatePage } from "../../src/vault/schema";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import type { CaptureEvent } from "../../src/contracts/event";
import type { ProposalInput } from "../../src/staging/proposals";
import { write } from "../canon/helpers";
import { validEvent } from "../fixtures";
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

/**
 * The grant a connector's manifest carries. Every call here supplies it
 * explicitly, because the seam is shut for a source that does not.
 */
const GRANTED = { page_candidates: true };

function granted(event: CaptureEvent): ProposalInput[] {
  return proposalsForEvent(event, GRANTED);
}

describe("a page candidate on an event", () => {
  test("a source with no page-candidate grant gets the capture note", () => {
    for (const grants of [undefined, { page_candidates: false }]) {
      const proposals =
        grants === undefined
          ? proposalsForEvent(
              event({ text: "line one", metadata: candidateMetadata() }),
            )
          : proposalsForEvent(
              event({ text: "line one", metadata: candidateMetadata() }),
              grants,
            );
      const note = proposals[1];
      expect(note?.kind).toBe("claim");
      expect(note?.target).toBeNull();
      expect(note?.frontmatter["type"]).toBe("source");
      expect(note?.frontmatter["title"]).toContain("Capture from");
      expect(note?.body).toContain("> line one");
    }
  });

  test("replaces the capture note with one typed entity proposal", () => {
    const proposals = granted(
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
    const proposals = granted(
      event({
        subjects: [],
        metadata: candidateMetadata({ type: "fact", target: "facts/steam" }),
      }),
    );
    expect(proposals.map((p) => p.kind)).toEqual(["claim"]);
    expect(proposals[0]?.target).toBe("facts/steam");
  });

  test("frontmatter carries the mapped fields and the floor's provenance", () => {
    const [, page] = granted(
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
    const [, page] = granted(
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
    const proposals = granted(
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
      granted(
        event({ deleted: true, metadata: candidateMetadata() }),
      ),
    ).toEqual([]);
  });

  test("refiling the same page is a duplicate, not a second staged item", () => {
    const db = memoryDb();
    const [, first] = granted(
      event({ metadata: candidateMetadata() }),
    );
    const [, second] = granted(
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
    db.close();
  });
});

/**
 * The receipted writer is the only door into canon. Nothing here supplies a
 * label: a migrated page carries the lattice bottom (RFC 0002 section 8.1),
 * never an owner keystroke.
 */
describe("a migrated page through the receipted writer", () => {
  async function staged(
    db: ReturnType<typeof memoryDb>,
    overrides: Record<string, unknown> = {},
    text = "Met at the fair.",
  ): Promise<Claim> {
    const stored = accept(db, { ...validEvent(), text, metadata: candidateMetadata(overrides) });
    if (stored.status !== "stored") throw new Error("expected a stored event");
    const [, input] = granted(stored.event);
    if (input === undefined) throw new Error("expected a candidate proposal");
    const filed = await insertClaim({ db }, input);
    if (filed.outcome !== "stored") throw new Error(`expected a stored claim, got ${filed.outcome}`);
    return filed.claim;
  }

  test("writes the target path with the mapped frontmatter and provenance", async () => {
    const db = memoryDb();
    const vault = tempVault();
    try {
      const claim = await staged(db);
      const receipt = write({ db, vault_path: vault.path }, claim, { writer: "import" });

      expect(receipt.page_path).toBe("entities/ada.md");
      expect(receipt.sensitivity).toBe("private");
      expect(getCanonReceipt(db, receipt.receipt_id)?.writer).toBe("import");
      const page = parseFrontmatter(
        readFileSync(join(vault.path, receipt.page_path), "utf8"),
      );
      expect(validatePage(page.data)).toEqual([]);
      expect(page.data["type"]).toBe("person");
      expect(page.data["title"]).toBe("Ada");
      expect(page.data["sensitivity"]).toBe("private");
      expect(page.data["x-born"]).toBe(1815);
      expect(page.body).toContain("Met at the fair.");
    } finally {
      db.close();
      vault.dispose();
    }
  });

  test("every page type the floor stages passes validatePage", async () => {
    for (const type of ["person", "fact", "rollup"]) {
      const db = memoryDb();
      const vault = tempVault();
      try {
        const claim = await staged(db, {
          type,
          target: `pages/${type}`,
          title: `A ${type}`,
        });
        const receipt = write({ db, vault_path: vault.path }, claim, { writer: "import" });
        const page = parseFrontmatter(
          readFileSync(join(vault.path, receipt.page_path), "utf8"),
        );
        expect(validatePage(page.data)).toEqual([]);
      } finally {
        db.close();
        vault.dispose();
      }
    }
  });

  test("a re-imported page edits the page it already wrote", async () => {
    const db = memoryDb();
    const vault = tempVault();
    try {
      const first = await staged(db, {}, "first body");
      const written = write({ db, vault_path: vault.path }, first, { writer: "import" });
      expect(written.before_hash).toBeNull();

      const second = await staged(db, { title: "Ada L." }, "an edited body");
      const revised = write({ db, vault_path: vault.path }, second, { writer: "import" });

      expect(revised.page_path).toBe(written.page_path);
      expect(revised.before_hash).toBe(written.after_hash);
      const page = readFileSync(join(vault.path, revised.page_path), "utf8");
      expect(page).toContain("an edited body");
    } finally {
      db.close();
      vault.dispose();
    }
  });
});
