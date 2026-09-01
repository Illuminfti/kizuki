import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PromoteError, ownerPromote } from "../../src/staging/promote";
import { fileProposal, getProposal } from "../../src/staging/proposals";
import { parseFrontmatter, serializePage } from "../../src/vault/frontmatter";
import { memoryDb, proposalInput, tempVault } from "./helpers";

let db: Database;
let vault: { path: string; dispose: () => void };

beforeEach(() => {
  db = memoryDb();
  vault = tempVault();
});

afterEach(() => vault.dispose());

function stage(overrides: Parameters<typeof proposalInput>[0] = {}): string {
  const result = fileProposal(db, proposalInput(overrides));
  if (result.outcome !== "stored") throw new Error("expected stored");
  return result.proposal.proposal_id;
}

function basePage(
  overrides: Parameters<typeof proposalInput>[0] = {},
): { id: string; path: string } {
  const id = stage({
    kind: "entity",
    target: "person:ada",
    body: "Original body.",
    frontmatter: { type: "person", title: "Ada" },
    provenance: ["event-old"],
    ...overrides,
  });
  const receipt = ownerPromote(db, vault.path, id, { sensitivity: "personal" });
  return { id, path: join(vault.path, receipt.page_path) };
}

describe("existing-page proposal kinds", () => {
  test("edit replaces body, overlays frontmatter, preserves id, and unions sources", () => {
    const base = basePage();
    const before = readFileSync(base.path, "utf8");
    const edit = stage({
      kind: "edit",
      target: base.id,
      body: "Replacement body.",
      frontmatter: { title: "Ada Updated", "x-reviewed": true },
      provenance: ["event-new", "event-old"],
    });
    const receipt = ownerPromote(db, vault.path, edit, {});
    const after = readFileSync(base.path, "utf8");
    const page = parseFrontmatter(after);
    expect(page.data["id"]).toBe(base.id);
    expect(page.data["title"]).toBe("Ada Updated");
    expect(page.data["x-reviewed"]).toBe(true);
    expect(page.data["sources"]).toEqual(["event-new", "event-old"]);
    expect(page.body).toBe("\nReplacement body.\n");
    expect(receipt.kind).toBe("edit");
    expect(receipt.sensitivity).toBe("personal");
    expect(receipt.before_hash).toBe(
      new Bun.CryptoHasher("sha256").update(before).digest("hex"),
    );
    expect(receipt.after_hash).toBe(
      new Bun.CryptoHasher("sha256").update(after).digest("hex"),
    );
    expect(readdirSync(join(vault.path, "archive")).filter(
      (name) => name.startsWith("ada.prev-"),
    )).toHaveLength(1);
  });

  test("merge appends the proposal body without changing existing whitespace", () => {
    const base = basePage();
    const merge = stage({
      kind: "merge",
      target: base.id,
      body: "Appended body.",
      frontmatter: {},
      provenance: ["event-merge"],
    });
    const receipt = ownerPromote(db, vault.path, merge, {});
    const page = parseFrontmatter(readFileSync(base.path, "utf8"));
    expect(page.body).toBe("\nOriginal body.\n\n\nAppended body.");
    expect(page.data["sources"]).toEqual(["event-merge", "event-old"]);
    expect(receipt.kind).toBe("merge");
  });

  test("deletion archives canon in place and preserves the prior revision", () => {
    const base = basePage();
    const before = readFileSync(base.path, "utf8");
    const deletion = stage({
      kind: "deletion",
      target: base.id,
      body: "Owner approved deletion.",
      frontmatter: {},
      provenance: ["event-delete"],
    });
    const receipt = ownerPromote(db, vault.path, deletion, {});
    // Reconciliation rule 4 keeps the archived page at its canon path.
    expect(existsSync(base.path)).toBe(true);
    const archivedPage = readFileSync(base.path, "utf8");
    expect(parseFrontmatter(archivedPage).data["status"]).toBe("archived");
    const revisions = readdirSync(join(vault.path, "archive")).filter(
      (name) => /^ada\.prev-\d+\.md$/.test(name),
    );
    expect(revisions).toHaveLength(1);
    expect(readFileSync(
      join(vault.path, "archive", revisions[0] as string),
      "utf8",
    )).toBe(before);
    expect(receipt.kind).toBe("deletion");
    expect(receipt.before_hash).toBe(
      new Bun.CryptoHasher("sha256").update(before).digest("hex"),
    );
    expect(receipt.after_hash).toBe(
      new Bun.CryptoHasher("sha256").update(archivedPage).digest("hex"),
    );
    expect(receipt.page_path).toBe("person/ada.md");
  });

  test("purge review removes purged sources and lifts its hold", () => {
    const base = basePage({ provenance: ["event-keep", "event-purge"] });
    const review = stage({
      kind: "purge_review",
      target: base.id,
      body: "Original body.",
      frontmatter: {},
      provenance: ["event-purge"],
    });
    db.query(
      `INSERT INTO canon_holds (page_path, proposal_id, reason, held_at)
       VALUES (?, ?, ?, ?)`,
    ).run("person/ada.md", review, "source purge", "2026-01-01T00:00:00Z");
    const receipt = ownerPromote(db, vault.path, review, {});
    const page = parseFrontmatter(readFileSync(base.path, "utf8"));
    expect(page.data["sources"]).toEqual(["event-keep"]);
    expect(page.body).toBe("\nOriginal body.\n");
    expect(receipt.kind).toBe("purge_review");
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM canon_holds").get(),
    ).toEqual({ count: 0 });
  });

  test("all existing-page kinds refuse a missing target", () => {
    for (const kind of ["edit", "merge", "deletion", "purge_review"] as const) {
      const id = stage({
        kind,
        target: `fact:missing-${kind}`,
        body: `missing ${kind}`,
        frontmatter: {},
      });
      expect(() => ownerPromote(db, vault.path, id, {})).toThrow(PromoteError);
      expect(getProposal(db, id)?.status).toBe("pending");
    }
  });

  test("existing pages inherit sensitivity when the owner omits it", () => {
    const base = basePage();
    const edit = stage({
      kind: "edit",
      target: base.id,
      body: "Inherited.",
      frontmatter: {},
    });
    expect(ownerPromote(db, vault.path, edit, {}).sensitivity).toBe("personal");
    expect(parseFrontmatter(readFileSync(base.path, "utf8")).data["sensitivity"])
      .toBe("personal");
  });

  test("an unlabeled page fails closed unless sensitivity is supplied", () => {
    const path = join(vault.path, "facts", "unlabeled.md");
    writeFileSync(path, serializePage({
      data: {
        id: "fact:unlabeled",
        type: "fact",
        title: "Unlabeled",
        status: "active",
        sources: ["event-old"],
      },
      body: "Unlabeled body.\n",
    }));
    const refused = stage({
      kind: "edit",
      target: "fact:unlabeled",
      body: "Refused.",
      frontmatter: {},
    });
    expect(() => ownerPromote(db, vault.path, refused, {})).toThrow(PromoteError);
    const repaired = stage({
      kind: "edit",
      target: "fact:unlabeled",
      body: "Repaired.",
      frontmatter: {},
    });
    expect(ownerPromote(db, vault.path, repaired, {
      sensitivity: "private",
    }).sensitivity).toBe("private");
    expect(parseFrontmatter(readFileSync(path, "utf8")).data["sensitivity"])
      .toBe("private");
  });

  test("deletion can label an unlabeled page before archiving it", () => {
    const path = join(vault.path, "facts", "unlabeled-delete.md");
    writeFileSync(path, serializePage({
      data: {
        id: "fact:unlabeled-delete",
        type: "fact",
        title: "Unlabeled deletion",
        status: "active",
        sources: ["event-old"],
      },
      body: "Delete me.\n",
    }));
    const deletion = stage({
      kind: "deletion",
      target: "fact:unlabeled-delete",
      body: "Delete.",
      frontmatter: {},
    });
    ownerPromote(db, vault.path, deletion, { sensitivity: "private" });
    expect(existsSync(path)).toBe(true);
    const page = parseFrontmatter(readFileSync(path, "utf8"));
    expect(page.data["sensitivity"]).toBe("private");
    expect(page.data["status"]).toBe("archived");
    expect(readdirSync(join(vault.path, "archive")).some(
      (name) => /^unlabeled-delete\.prev-\d+\.md$/.test(name),
    )).toBe(true);
  });
});
