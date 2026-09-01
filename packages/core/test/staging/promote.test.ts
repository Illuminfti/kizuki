import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PromoteError,
  RECEIPTS_PATH,
  ownerPromote,
  pageRelPath,
  promote,
  readPromotion,
  readReceiptsLog,
  renderPage,
} from "../../src/staging/promote";
import type { PromoteOptions } from "../../src/staging/promote";
import { fileProposal, getProposal } from "../../src/staging/proposals";
import type { StagedProposal } from "../../src/staging/proposals";
import { memoryDb, proposalInput, tempVault } from "./helpers";

let db: Database;
let vault: { path: string; dispose: () => void };

beforeEach(() => {
  db = memoryDb();
  vault = tempVault();
});

afterEach(() => {
  vault.dispose();
});

function stage(overrides: Parameters<typeof proposalInput>[0] = {}): string {
  const result = fileProposal(db, proposalInput(overrides));
  if (result.outcome !== "stored") throw new Error("expected stored");
  return result.proposal.proposal_id;
}

function staged(overrides: Parameters<typeof proposalInput>[0] = {}) {
  const result = fileProposal(db, proposalInput(overrides));
  if (result.outcome !== "stored") throw new Error("expected stored");
  return result.proposal;
}

describe("the owner gate", () => {
  test("promote throws for any caller that is not the owner", () => {
    const id = stage();
    const impostors = ["agent:scribe", "llm", "deterministic", "", "Owner"];
    for (const caller of impostors) {
      const opts = {
        sensitivity: "private",
        invokedBy: caller,
      } as unknown as PromoteOptions;
      expect(() => promote(db, vault.path, id, opts)).toThrow(PromoteError);
    }
    expect(getProposal(db, id)?.status).toBe("pending");
    expect(existsSync(join(vault.path, RECEIPTS_PATH))).toBe(false);
  });

  test("promote throws when the gate field is missing entirely", () => {
    const id = stage();
    const opts = { sensitivity: "private" } as unknown as PromoteOptions;
    expect(() => promote(db, vault.path, id, opts)).toThrow(PromoteError);
  });

  test("ownerPromote is the entry that supplies the owner stamp", () => {
    const id = stage();
    const receipt = ownerPromote(db, vault.path, id, {
      sensitivity: "private",
    });
    expect(receipt.proposal_id).toBe(id);
    expect(getProposal(db, id)?.status).toBe("promoted");
  });
});

describe("sensitivity", () => {
  test("refuses a missing or unknown sensitivity", () => {
    const id = stage();
    for (const sensitivity of [undefined, "secret", "", null]) {
      const opts = { sensitivity } as unknown as Parameters<
        typeof ownerPromote
      >[3];
      expect(() => ownerPromote(db, vault.path, id, opts)).toThrow(
        PromoteError,
      );
    }
    expect(getProposal(db, id)?.status).toBe("pending");
  });

  test("the label the owner chose lands in the page and the receipt", () => {
    const id = stage();
    const receipt = ownerPromote(db, vault.path, id, {
      sensitivity: "personal",
    });
    const page = readFileSync(join(vault.path, receipt.page_path), "utf8");
    expect(page).toContain('sensitivity: "personal"');
    expect(receipt.sensitivity).toBe("personal");
  });
});

describe("the canon page", () => {
  test("carries id, type, status, sensitivity, and sources", () => {
    const proposal = staged({
      target: "person:ada",
      kind: "entity",
      frontmatter: { type: "person", "x-handle": "ada" },
      body: "Stub entity page.",
      provenance: ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FB2"],
    });
    const receipt = ownerPromote(db, vault.path, proposal.proposal_id, {
      sensitivity: "private",
    });

    expect(receipt.page_path).toBe("person/ada.md");
    expect(readFileSync(join(vault.path, receipt.page_path), "utf8")).toBe(
      [
        "---",
        `id: "${proposal.proposal_id}"`,
        'type: "person"',
        'status: "active"',
        'sensitivity: "private"',
        "sources:",
        '  - "01ARZ3NDEKTSV4RRFFQ69G5FAV"',
        '  - "01ARZ3NDEKTSV4RRFFQ69G5FB2"',
        'x-handle: "ada"',
        "---",
        "",
        "Stub entity page.",
        "",
      ].join("\n"),
    );
  });

  test("a targetless proposal lands under captures/", () => {
    const proposal = staged();
    expect(pageRelPath(proposal)).toBe(`captures/${proposal.proposal_id}.md`);
  });

  test("the owner's edited body replaces the staged one", () => {
    const id = stage();
    const receipt = ownerPromote(db, vault.path, id, {
      sensitivity: "public",
      editBody: "the owner's own words",
    });
    expect(readFileSync(join(vault.path, receipt.page_path), "utf8")).toContain(
      "the owner's own words",
    );
  });

  test("a target that walks out of the vault is refused", () => {
    const escapes = [
      "../../etc/passwd",
      "person:../ada",
      ".kizuki:receipts",
      "person:ada/../../bob",
      "person::ada",
      "person:ada name",
    ];
    for (const target of escapes) {
      const id = stage({ target, body: `body for ${target}` });
      expect(() =>
        ownerPromote(db, vault.path, id, { sensitivity: "private" }),
      ).toThrow(PromoteError);
      expect(getProposal(db, id)?.status).toBe("pending");
    }
  });

  test("a producer cannot forge the spine-owned frontmatter", () => {
    for (const key of ["id", "status", "sensitivity", "sources"]) {
      const proposal = staged({
        body: `body for ${key}`,
        frontmatter: { type: "note", [key]: "forged" },
      });
      expect(() => renderPage(proposal, "private", proposal.body)).toThrow(
        PromoteError,
      );
    }
  });

  test("an unknown page type is refused", () => {
    const proposal = staged({ frontmatter: { type: "spaceship" } });
    expect(() => renderPage(proposal, "private", proposal.body)).toThrow(
      PromoteError,
    );
  });

  test("frontmatter strings are escaped, not interpolated", () => {
    const proposal: StagedProposal = {
      ...staged(),
      frontmatter: { type: "note", title: 'a "quoted"\nline\\here' },
    };
    expect(renderPage(proposal, "private", "body")).toContain(
      'title: "a \\"quoted\\"\\nline\\\\here"',
    );
  });

  test("promoting over an existing page is refused", () => {
    const first = stage({ target: "person:ada", body: "one" });
    ownerPromote(db, vault.path, first, { sensitivity: "private" });
    const second = stage({ target: "person:ada", body: "two" });
    expect(() =>
      ownerPromote(db, vault.path, second, { sensitivity: "private" }),
    ).toThrow(PromoteError);
  });
});

describe("receipts", () => {
  test("the JSONL line and the promotions row agree", () => {
    const proposal = staged({
      provenance: ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FB2"],
    });
    const receipt = ownerPromote(db, vault.path, proposal.proposal_id, {
      sensitivity: "personal",
    });

    const log = readReceiptsLog(vault.path);
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual(receipt);
    expect(readPromotion(db, proposal.proposal_id)).toEqual(receipt);

    expect(receipt.provenance).toEqual(proposal.provenance);
    const page = readFileSync(join(vault.path, receipt.page_path), "utf8");
    expect(new Bun.CryptoHasher("sha256").update(page).digest("hex")).toBe(
      receipt.page_hash,
    );
  });

  test("the log appends, one line per promotion", () => {
    const first = stage({ target: "person:ada", body: "one" });
    const second = stage({ target: "person:bob", body: "two" });
    const a = ownerPromote(db, vault.path, first, { sensitivity: "private" });
    const b = ownerPromote(db, vault.path, second, { sensitivity: "public" });

    const raw = readFileSync(join(vault.path, RECEIPTS_PATH), "utf8");
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
    expect(readReceiptsLog(vault.path).map((r) => r.receipt_id)).toEqual([
      a.receipt_id,
      b.receipt_id,
    ]);
  });

  test("no receipt is written when the promotion is refused", () => {
    const id = stage();
    expect(() =>
      ownerPromote(db, vault.path, id, {
        sensitivity: "nope" as unknown as "public",
      }),
    ).toThrow(PromoteError);
    expect(readReceiptsLog(vault.path)).toEqual([]);
    expect(
      db.query("SELECT count(*) AS n FROM promotions").get() as { n: number },
    ).toEqual({ n: 0 });
  });
});

describe("proposal state", () => {
  test("only a pending proposal can be promoted", () => {
    const id = stage();
    ownerPromote(db, vault.path, id, { sensitivity: "private" });
    expect(() =>
      ownerPromote(db, vault.path, id, { sensitivity: "private" }),
    ).toThrow(PromoteError);
  });

  test("an unknown proposal is refused", () => {
    expect(() =>
      ownerPromote(db, vault.path, "01ARZ3NDEKTSV4RRFFQ69G5FZZ", {
        sensitivity: "private",
      }),
    ).toThrow(PromoteError);
  });
});
