import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OWNER,
  applyCanonWrite,
  createBudgetTracker,
  filterServable,
  getCanonReceipt,
  resolveTarget,
  undoReceipt,
} from "../src";
import { canonFixture, putEvent, storeClaim } from "./canon/helpers";

describe("RFC 0002 autonomous canon contract", () => {
  test("autonomous canon write succeeds through the receipted writer", async () => {
    const fixture = canonFixture();
    try {
      const claim = await storeClaim(fixture.db, putEvent(fixture.db));

      // No owner, no queue, no approval: the loop writes and leaves a receipt.
      const receipt = applyCanonWrite(fixture.io, claim, resolveTarget(fixture.io, claim), {
        writer: "loop",
        budget: createBudgetTracker({ canon_writes_per_run: 1 }),
      });

      expect(receipt.writer).toBe("loop");
      expect(existsSync(join(fixture.vault, receipt.page_path))).toBe(true);
      expect(readFileSync(join(fixture.vault, receipt.page_path), "utf8")).toContain(
        "Grace runs partnerships at Acme.",
      );
      expect(getCanonReceipt(fixture.db, receipt.receipt_id)).toEqual(receipt);
      expect(receipt.provenance).toEqual(claim.provenance);
      expect(receipt.before_hash).toBeNull();
      expect(receipt.after_hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fixture.dispose();
    }
  });

  test("a receipted write is reversible from its receipt", async () => {
    const fixture = canonFixture();
    try {
      const claim = await storeClaim(fixture.db, putEvent(fixture.db));
      const receipt = applyCanonWrite(fixture.io, claim, resolveTarget(fixture.io, claim), {
        writer: "loop",
        budget: createBudgetTracker({ canon_writes_per_run: 1 }),
      });
      const path = join(fixture.vault, receipt.page_path);
      expect(existsSync(path)).toBe(true);

      const revert = await undoReceipt(fixture.io, receipt.receipt_id);
      expect(existsSync(path)).toBe(false);
      expect(revert.reverts).toBe(receipt.receipt_id);
      expect(getCanonReceipt(fixture.db, receipt.receipt_id)?.reverted_by).toBe(
        revert.receipt_id,
      );
    } finally {
      fixture.dispose();
    }
  });

  test("unlabeled sensitivity is not served, including to the owner", () => {
    const item = { id: "fact:unlabeled", sensitivity: undefined };

    expect(filterServable(OWNER.grant, [item])).toEqual({
      served: [],
      denied: [{ id: item.id, reason: "missing_sensitivity" }],
    });
  });

  test("source scanning confines canon mutation to the receipted capability", () => {
    // The structural proof lives in canon/write-capability.test.ts (§15); this
    // pins that the suite exists and carries every required test name.
    const suite = readFileSync(
      join(import.meta.dir, "canon", "write-capability.test.ts"),
      "utf8",
    );
    for (const name of [
      "the source tree is actually being scanned",
      "grantCanonWrite is defined in vault/write.ts and called in exactly one module",
      "writePage has no call site outside canon/apply.ts and its tests",
      "CanonWriteCapability cannot be constructed outside vault/write.ts",
      "every writePage call site passes a capability minted in the same function",
      "the public core surface exports applyCanonWrite and not writePage",
      "no module outside canon/ imports the canon store adapter",
    ]) {
      expect(suite).toContain(`test("${name}"`);
    }
  });
});
