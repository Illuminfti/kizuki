import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTHORITY_TIERS, CLAIM_TAINTS } from "../../src/contracts/proposal";
import { getCanonReceipt, RECEIPTS_PATH, readReceiptsLog } from "../../src/canon/receipts";
import { getClaim } from "../../src/claims/store";
import { SENSITIVITY_ORDER } from "../../src/agents/types";
import { WRITERS } from "../../src/vault/write";
import {
  canonFixture,
  putEvent,
  readBytes,
  sha256,
  storeClaim,
  write,
} from "./helpers";
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

describe("receipt totality", () => {
  test("every canon write produces a receipt row, a JSONL line and a matching file hash", async () => {
    const { db, vault, io } = fixture();
    const eventId = putEvent(db);
    const claim = await storeClaim(db, eventId);

    const receipt = write(io, claim);

    const row = getCanonReceipt(db, receipt.receipt_id);
    expect(row).toEqual(receipt);
    const log = readReceiptsLog(vault);
    expect(log).toEqual([receipt]);
    expect(readFileSync(join(vault, RECEIPTS_PATH), "utf8")).toBe(
      `${JSON.stringify(receipt)}\n`,
    );
    expect(sha256(readBytes(vault, receipt.page_path))).toBe(receipt.after_hash);
    expect(getClaim(db, claim.claim_id)?.receipt_id).toBe(receipt.receipt_id);

    const second = await storeClaim(db, eventId, {
      predicate: "contact.email",
      object: "grace@acme.test",
      body: "Grace can be reached at grace@acme.test.",
    });
    const edit = write(io, second);
    expect(getCanonReceipt(db, edit.receipt_id)).toEqual(edit);
    expect(readReceiptsLog(vault)).toEqual([receipt, edit]);
    expect(sha256(readBytes(vault, edit.page_path))).toBe(edit.after_hash);
    expect(edit.before_hash).toBe(receipt.after_hash);
  });

  test("a receipt names non-empty provenance that resolves in the ledger", async () => {
    const { db, vault, io } = fixture();
    const eventId = putEvent(db);
    const claim = await storeClaim(db, eventId);

    const receipt = write(io, claim);

    expect(receipt.provenance.length).toBeGreaterThan(0);
    expect(receipt.provenance).toEqual(claim.provenance);
    const placeholders = receipt.provenance.map(() => "?").join(", ");
    const resolved = db
      .query<{ n: number }, string[]>(
        `SELECT count(*) AS n FROM events WHERE event_id IN (${placeholders})`,
      )
      .get(...receipt.provenance);
    expect(resolved?.n).toBe(receipt.provenance.length);

    // A claim whose evidence is gone is refused before any byte is written.
    const doomed = await storeClaim(db, eventId, {
      target: "people/linus",
      subject: "person:linus",
      subjects: ["person:linus"],
      body: "Linus maintains the kernel notes.",
      frontmatter: { type: "person", title: "Linus" },
    });
    db.query("DELETE FROM events WHERE event_id = ?").run(eventId);
    expect(() => write(io, doomed)).toThrow(/provenance/);
    expect(existsSync(join(vault, "people", "linus.md"))).toBe(false);
    expect(readReceiptsLog(vault)).toHaveLength(1);
  });

  test("a receipt carries writer, producer, authority, confidence, sensitivity and taint", async () => {
    const { db, io } = fixture();
    const eventId = putEvent(db);
    const claim = await storeClaim(db, eventId, {
      producer: "model",
      model_ref: "kizuki.llm.openai-compatible:synthetic@127.0.0.1",
      confidence: 0.9,
      sensitivity: "private",
      taint: "quoted",
      body: "> Grace runs partnerships at Acme.",
    });

    const receipt = write(io, claim, { writer: "loop" });

    expect(WRITERS).toContain(receipt.writer);
    expect(receipt.writer).toBe("loop");
    expect(receipt.producer).toBe("model");
    expect(receipt.model_ref).toBe("kizuki.llm.openai-compatible:synthetic@127.0.0.1");
    expect(Object.keys(AUTHORITY_TIERS)).toContain(receipt.authority);
    expect(receipt.authority).toBe(claim.authority);
    expect(receipt.confidence).toBe(claim.confidence);
    expect(receipt.confidence).toBeGreaterThan(0);
    expect(receipt.confidence).toBeLessThanOrEqual(1);
    expect(Object.keys(SENSITIVITY_ORDER)).toContain(receipt.sensitivity);
    expect(receipt.sensitivity).toBe("private");
    expect(CLAIM_TAINTS).toContain(receipt.taint);
    expect(receipt.taint).toBe("quoted");
    expect(receipt.kind).toBe("write");
    expect(receipt.claim_ids).toEqual([claim.claim_id]);
    expect(receipt.reverts).toBeNull();
    expect(receipt.reverted_by).toBeNull();

    const stored = getCanonReceipt(db, receipt.receipt_id);
    expect(stored).toEqual(receipt);
  });

  test("before_hash is null exactly when the page was created", async () => {
    const { db, vault, io } = fixture();
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    expect(created.page_action).toBe("create");
    expect(created.before_hash).toBeNull();

    const priorBytes = sha256(readBytes(vault, created.page_path));
    const edited = write(
      io,
      await storeClaim(db, eventId, {
        predicate: "location.based_in",
        object: "lisbon",
        body: "Grace is based in Lisbon.",
      }),
    );
    expect(edited.page_action).toBe("edit");
    expect(edited.before_hash).toBe(priorBytes);
    expect(edited.before_hash).toBe(created.after_hash);
    expect(edited.after_hash).not.toBe(edited.before_hash);

    for (const receipt of readReceiptsLog(vault)) {
      expect(receipt.before_hash === null).toBe(receipt.page_action === "create");
    }
  });

  test("archive_path exists for every edit and every archive", async () => {
    const { db, vault, io } = fixture();
    const eventId = putEvent(db);
    const created = write(io, await storeClaim(db, eventId));
    expect(created.archive_path).toBeNull();
    const createdBytes = readBytes(vault, created.page_path);

    const edited = write(
      io,
      await storeClaim(db, eventId, {
        predicate: "location.based_in",
        object: "lisbon",
        body: "Grace is based in Lisbon.",
      }),
    );
    expect(edited.archive_path).toMatch(/^archive\/grace\.prev-\d+\.md$/);
    expect(existsSync(join(vault, edited.archive_path as string))).toBe(true);
    expect(readBytes(vault, edited.archive_path as string)).toEqual(createdBytes);
    const editedBytes = readBytes(vault, edited.page_path);

    const archived = write(
      io,
      await storeClaim(db, eventId, {
        kind: "deletion",
        predicate: null,
        object: null,
        body: "Source record deleted; archive the page.",
        frontmatter: {},
      }),
    );
    expect(archived.page_action).toBe("archive");
    expect(archived.archive_path).toMatch(/^archive\/grace\.prev-\d+\.md$/);
    expect(archived.archive_path).not.toBe(edited.archive_path);
    expect(readBytes(vault, archived.archive_path as string)).toEqual(editedBytes);
    expect(readFileSync(join(vault, archived.page_path), "utf8")).toContain('status: "archived"');

    for (const receipt of readReceiptsLog(vault)) {
      if (receipt.page_action === "create") continue;
      expect(receipt.archive_path).not.toBeNull();
      expect(existsSync(join(vault, receipt.archive_path as string))).toBe(true);
    }
  });
});
