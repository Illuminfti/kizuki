import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECEIPTS_PATH, getCanonReceipt, readReceiptsLog } from "../../src/canon/receipts";
import { getClaim } from "../../src/claims/store";
import { accept } from "../../src/ledger/ledger";
import { cascadeTombstone } from "../../src/staging/producers";
import {
  PromoteError,
  ownerPromote,
  readPromotion,
} from "../../src/staging/promote";
import { fileProposal, getProposal } from "../../src/staging/proposals";
import { validEvent } from "../fixtures";
import { memoryDb, proposalInput, tempVault } from "./helpers";

const vaults: { dispose: () => void }[] = [];

function vault(): string {
  const created = tempVault("kizuki-promote-shim-");
  vaults.push(created);
  return created.path;
}

afterEach(() => {
  for (const item of vaults.splice(0)) item.dispose();
});

/**
 * The leftover Wave 1 promote verb is a shim over the receipted writer. These
 * tests hold it to the same receipt discipline until its own lanes delete it.
 */
describe("promote shim", () => {
  test("writes through the receipted writer with the import stamp", () => {
    const db = memoryDb();
    const root = vault();
    const stored = accept(db, validEvent());
    if (stored.status !== "stored") throw new Error("fixture event");
    const filed = fileProposal(
      db,
      proposalInput({
        kind: "entity",
        target: "person:ada",
        frontmatter: { type: "person", title: "Ada" },
        provenance: [stored.event.event_id],
      }),
    );
    if (filed.outcome !== "stored") throw new Error("fixture proposal");
    const id = filed.proposal.proposal_id;

    const receipt = ownerPromote(db, root, id, { sensitivity: "personal" });

    expect(receipt.proposal_id).toBe(id);
    expect(receipt.page_path).toBe("person/ada.md");
    expect(receipt.kind).toBe("entity");
    expect(receipt.before_hash).toBeNull();
    expect(existsSync(join(root, receipt.page_path))).toBe(true);
    const page = readFileSync(join(root, receipt.page_path), "utf8");
    expect(page).toContain('sensitivity: "personal"');
    expect(page).toContain('taint: "quoted"');

    const canon = getCanonReceipt(db, receipt.receipt_id);
    expect(canon?.writer).toBe("import");
    expect(canon?.claim_ids).toEqual([id]);
    expect(canon?.after_hash).toBe(receipt.after_hash);
    expect(readReceiptsLog(root).map((line) => line.receipt_id)).toEqual([receipt.receipt_id]);
    expect(readFileSync(join(root, RECEIPTS_PATH), "utf8")).toContain('"writer":"import"');
    expect(getProposal(db, id)?.status).toBe("promoted");
    expect(getClaim(db, id)?.status).toBe("live");
    expect(getClaim(db, id)?.receipt_id).toBe(receipt.receipt_id);
    expect(readPromotion(db, id)).toEqual(receipt);

    expect(() => ownerPromote(db, root, id, {})).toThrow(/not pending/);

    // A tombstone for the cited record files a retraction against the page.
    const tombstone = accept(db, { ...validEvent(), deleted: true, text: "" });
    if (tombstone.status !== "stored") throw new Error("fixture tombstone");
    const cascade = cascadeTombstone(db, tombstone.event);
    expect(cascade.retractions_filed).toHaveLength(1);
    db.close();
  });

  test("promotes while a stray note sits in the vault", () => {
    const db = memoryDb();
    const root = vault();
    // One hand-written note without frontmatter used to abort every vault
    // reader, and the writer scans the vault to resolve its target.
    writeFileSync(join(root, "facts", "stray.md"), "just a note\n", "utf8");
    const stored = accept(db, validEvent());
    if (stored.status !== "stored") throw new Error("fixture event");
    const filed = fileProposal(
      db,
      proposalInput({
        kind: "entity",
        target: "person:ada",
        frontmatter: { type: "person", title: "Ada" },
        provenance: [stored.event.event_id],
      }),
    );
    if (filed.outcome !== "stored") throw new Error("fixture proposal");

    const receipt = ownerPromote(db, root, filed.proposal.proposal_id, {
      sensitivity: "personal",
    });

    expect(receipt.page_path).toBe("person/ada.md");
    expect(existsSync(join(root, receipt.page_path))).toBe(true);
    db.close();
  });

  test("refuses caller-edited prose and leaves the proposal pending", () => {
    const db = memoryDb();
    const root = vault();
    const stored = accept(db, validEvent());
    if (stored.status !== "stored") throw new Error("fixture event");
    const filed = fileProposal(
      db,
      proposalInput({
        kind: "claim",
        target: "facts/kettle",
        provenance: [stored.event.event_id],
      }),
    );
    if (filed.outcome !== "stored") throw new Error("fixture proposal");
    const id = filed.proposal.proposal_id;

    expect(() => ownerPromote(db, root, id, { editBody: "The owner typed this." })).toThrow(
      PromoteError,
    );
    expect(() => ownerPromote(db, root, id, { sensitivity: "secret" as never })).toThrow(
      /sensitivity/,
    );
    expect(() => ownerPromote(db, root, "missing", {})).toThrow(/does not exist/);
    expect(getProposal(db, id)?.status).toBe("pending");
    expect(existsSync(join(root, "facts", "kettle.md"))).toBe(false);
    expect(readReceiptsLog(root)).toEqual([]);

    // A refused write inside the writer also returns the proposal to pending.
    const orphan = fileProposal(
      db,
      proposalInput({
        kind: "edit",
        target: "facts/nowhere",
        body: "Edit of a page that does not exist.",
        frontmatter: {},
        provenance: [stored.event.event_id],
      }),
    );
    if (orphan.outcome !== "stored") throw new Error("fixture proposal");
    expect(() => ownerPromote(db, root, orphan.proposal.proposal_id, {})).toThrow(PromoteError);
    expect(getProposal(db, orphan.proposal.proposal_id)?.status).toBe("pending");
    expect(getClaim(db, orphan.proposal.proposal_id)?.status).toBe("skipped");
    db.close();
  });
});
