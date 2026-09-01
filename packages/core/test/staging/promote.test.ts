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
import { fileProposal, getProposal } from "../../src/staging/proposals";
import type { StagedProposal } from "../../src/staging/proposals";
import { memoryDb, proposalInput, tempVault } from "./helpers";

let db: Database;
let vault: { path: string; dispose: () => void };

beforeEach(() => {
  db = memoryDb();
  vault = tempVault();
});
afterEach(() => vault.dispose());

function staged(overrides: Parameters<typeof proposalInput>[0] = {}) {
  const result = fileProposal(db, proposalInput(overrides));
  if (result.outcome !== "stored") throw new Error("expected stored");
  return result.proposal;
}

function stage(overrides: Parameters<typeof proposalInput>[0] = {}): string {
  return staged(overrides).proposal_id;
}

describe("the owner gate", () => {
  test("promote throws for any caller that is not the owner", () => {
    const id = stage();
    for (const caller of ["agent:scribe", "llm", "deterministic", "", "Owner"]) {
      expect(() => Reflect.apply(promote, undefined, [
        db,
        vault.path,
        id,
        { sensitivity: "private", invokedBy: caller },
      ])).toThrow(PromoteError);
    }
    expect(getProposal(db, id)?.status).toBe("pending");
    expect(existsSync(join(vault.path, RECEIPTS_PATH))).toBe(false);
  });

  test("promote throws when the gate field is missing entirely", () => {
    const id = stage();
    expect(() => Reflect.apply(promote, undefined, [
      db,
      vault.path,
      id,
      { sensitivity: "private" },
    ])).toThrow(PromoteError);
  });

  test("ownerPromote supplies the owner stamp", () => {
    const id = stage();
    const receipt = ownerPromote(db, vault.path, id, { sensitivity: "private" });
    expect(receipt.proposal_id).toBe(id);
    expect(getProposal(db, id)?.status).toBe("promoted");
  });
});

describe("sensitivity", () => {
  test("new pages refuse a missing or unknown sensitivity", () => {
    const id = stage();
    for (const sensitivity of [undefined, "secret", "", null]) {
      expect(() => Reflect.apply(ownerPromote, undefined, [
        db,
        vault.path,
        id,
        { sensitivity },
      ])).toThrow(PromoteError);
    }
    expect(getProposal(db, id)?.status).toBe("pending");
  });

  test("the owner's label lands in the page and receipt", () => {
    const id = stage();
    const receipt = ownerPromote(db, vault.path, id, {
      sensitivity: "personal",
    });
    expect(readFileSync(join(vault.path, receipt.page_path), "utf8")).toContain(
      'sensitivity: "personal"',
    );
    expect(receipt.sensitivity).toBe("personal");
  });
});

describe("the canon page", () => {
  test("carries identity, policy, provenance, and producer frontmatter", () => {
    const proposal = staged({
      target: "person:ada",
      kind: "entity",
      frontmatter: { type: "person", title: "Ada", "x-handle": "ada" },
      body: "Stub entity page.",
      provenance: ["event-a", "event-b"],
    });
    const receipt = ownerPromote(db, vault.path, proposal.proposal_id, {
      sensitivity: "private",
    });
    expect(receipt.page_path).toBe("person/ada.md");
    expect(readFileSync(join(vault.path, receipt.page_path), "utf8")).toBe([
      "---",
      `id: "${proposal.proposal_id}"`,
      'type: "person"',
      'status: "active"',
      'sensitivity: "private"',
      'sources: ["event-a","event-b"]',
      'title: "Ada"',
      'x-handle: "ada"',
      "---",
      "",
      "Stub entity page.",
      "",
    ].join("\n"));
  });

  test("a targetless proposal lands under captures", () => {
    const proposal = staged();
    expect(pageRelPath(proposal)).toBe(`captures/${proposal.proposal_id}.md`);
  });

  test("an id lookup can resolve a differently named page", () => {
    const proposal = staged({ target: "fact:stable-id" });
    expect(pageRelPath(proposal, () => "facts/custom-name.md")).toBe(
      "facts/custom-name.md",
    );
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

  test("targets that walk out of the vault are refused", () => {
    for (const target of [
      "../../etc/passwd",
      "person:../ada",
      ".kizuki:receipts",
      "person:ada/../../bob",
      "person::ada",
      "person:ada name",
    ]) {
      const id = stage({ target, body: `body for ${target}` });
      expect(() => ownerPromote(db, vault.path, id, {
        sensitivity: "private",
      })).toThrow(PromoteError);
      expect(getProposal(db, id)?.status).toBe("pending");
    }
  });

  test("a producer cannot forge spine-owned frontmatter", () => {
    for (const key of ["id", "status", "sensitivity", "sources"]) {
      const proposal = staged({
        body: `body for ${key}`,
        frontmatter: { type: "fact", [key]: "forged" },
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

  test("frontmatter strings are escaped rather than interpolated", () => {
    const proposal: StagedProposal = {
      ...staged(),
      frontmatter: { type: "fact", title: 'a "quoted"\nline\\here' },
    };
    expect(renderPage(proposal, "private", "body")).toContain(
      'title: "a \\"quoted\\"\\nline\\\\here"',
    );
  });

  test("new-page promotion over an existing page is refused", () => {
    const first = stage({ target: "person:ada", body: "one" });
    ownerPromote(db, vault.path, first, { sensitivity: "private" });
    const second = stage({ target: "person:ada", body: "two" });
    expect(() => ownerPromote(db, vault.path, second, {
      sensitivity: "private",
    })).toThrow(
      "page person/ada.md already exists; supersede it with an edit proposal",
    );
  });
});

describe("receipts", () => {
  test("the JSONL line and promotions row agree with the page hash", () => {
    const proposal = staged({ provenance: ["event-a", "event-b"] });
    const receipt = ownerPromote(db, vault.path, proposal.proposal_id, {
      sensitivity: "personal",
    });
    expect(readReceiptsLog(vault.path)).toEqual([receipt]);
    expect(readPromotion(db, proposal.proposal_id)).toEqual(receipt);
    expect(receipt.provenance).toEqual(proposal.provenance);
    const page = readFileSync(join(vault.path, receipt.page_path), "utf8");
    expect(new Bun.CryptoHasher("sha256").update(page).digest("hex")).toBe(
      receipt.after_hash,
    );
    expect(receipt.kind).toBe("claim");
    expect(receipt.before_hash).toBeNull();
  });

  test("the log appends one line per promotion", () => {
    const first = stage({ target: "person:ada", body: "one" });
    const second = stage({ target: "person:bob", body: "two" });
    const a = ownerPromote(db, vault.path, first, { sensitivity: "private" });
    const b = ownerPromote(db, vault.path, second, { sensitivity: "public" });
    const raw = readFileSync(join(vault.path, RECEIPTS_PATH), "utf8");
    expect(raw.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
    expect(readReceiptsLog(vault.path).map(({ receipt_id }) => receipt_id)).toEqual([
      a.receipt_id,
      b.receipt_id,
    ]);
  });

  test("no receipt is written when promotion is refused", () => {
    const id = stage();
    expect(() => Reflect.apply(ownerPromote, undefined, [
      db,
      vault.path,
      id,
      { sensitivity: "nope" },
    ])).toThrow(PromoteError);
    expect(readReceiptsLog(vault.path)).toEqual([]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM promotions").get(),
    ).toEqual({ count: 0 });
  });
});

describe("proposal state", () => {
  test("only a pending proposal can be promoted", () => {
    const id = stage();
    ownerPromote(db, vault.path, id, { sensitivity: "private" });
    expect(() => ownerPromote(db, vault.path, id, {
      sensitivity: "private",
    })).toThrow(PromoteError);
  });

  test("an unknown proposal is refused", () => {
    expect(() => ownerPromote(db, vault.path, "missing", {
      sensitivity: "private",
    })).toThrow(PromoteError);
  });
});
