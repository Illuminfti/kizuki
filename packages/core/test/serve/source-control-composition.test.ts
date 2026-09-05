import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { sourceTombstoneProposal } from "../../src/canon/source-tombstone";
import { getClaim, insertClaim, type InsertClaimInput } from "../../src/claims/store";
import type { ProducerPort } from "../../src/contracts/producer";
import { accept } from "../../src/ledger/ledger";
import { commitExtractCursor } from "../../src/serve/extract";
import { commitMachineByteIntent } from "../../src/ledger/event-origin";
import { runWritePass } from "../../src/serve/write-pass";
import { fileProposal } from "../../src/staging/proposals";
import { proposalsForEvent } from "../../src/staging/producers";
import { sha256Hex } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { validEvent } from "../fixtures";
import { canonFixture, write } from "../canon/helpers";

function fixture(self: boolean) {
  const f = canonFixture();
  const original = accept(f.db, validEvent());
  if (original.status !== "stored") throw new Error("source fixture failed");
  const proposal = fileProposal(f.db, proposalsForEvent(original.event).find(row => row.kind === "claim")!).proposal;
  const receipt = write(f.io, getClaim(f.db, proposal.proposal_id)!);
  const text = `Source deletion fixture (${self})`;
  if (self) commitMachineByteIntent(f.db, { receipt_id: ulid(), before_hash: null, after_hash: sha256Hex(text) }, () => {});
  const deleted = accept(f.db, { ...validEvent(), deleted: true, text });
  if (deleted.status !== "stored") throw new Error("deletion fixture failed");
  const control = sourceTombstoneProposal(f.db, deleted.event, receipt.page_path, f.io);
  if (control === null) throw new Error("control fixture failed");
  return { ...f, receipt, control };
}

function effects(f: ReturnType<typeof fixture>) {
  return ["claims", "proposals", "claim_supersessions", "canon_receipts", "canon_machine_byte_intents", "page_index", "retrieval_ops"]
    .map(table => f.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

for (const self of [false, true]) {
  test(`direct control insertion, duplicate and pending writer preserve its bound deletion (self=${self})`, async () => {
    const f = fixture(self);
    try {
      const input = { ...f.control, subject: null, predicate: null, object: null,
        polarity: "positive" as const, intent: "propose" as const };
      const first = await insertClaim(f.io, input);
      expect(first.outcome).toBe("stored");
      if (first.outcome !== "stored") throw new Error("expected stored control");
      expect(first.claim.confidence).toBe(1);
      expect(first.claim.authority).toBe("connector_evidence");
      expect(first.claim.claim_key).toBeNull();
      const before = effects(f);
      const again = await insertClaim(f.io, input);
      expect(again.outcome).toBe("duplicate");
      if (again.outcome !== "duplicate") throw new Error("expected duplicate control");
      expect(again.claim.claim_id).toBe(first.claim.claim_id);
      expect(effects(f)).toEqual(before);

      // Keep this consumer test about an already-filed control. All capture has
      // reached the extraction frontier, so the producer must never be called.
      const last = f.db.query<{ accepted_at: string; event_id: string }, []>(
        "SELECT accepted_at,event_id FROM events ORDER BY accepted_at DESC,event_id DESC LIMIT 1",
      ).get()!;
      expect(commitExtractCursor(f.db, {
        mined: { status: "empty" }, drafts: [], previous_cursor: null, cursor: last,
      })).toBe(true);
      let produced = 0;
      const producer: ProducerPort = {
        descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1",
          contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
        health: async () => ({ status: "ready", detail: {} }), close: async () => {},
        produce: async () => { produced++; throw new Error("unexpected producer call"); },
      };
      const result = await runWritePass(f.db, f.vault, {
        budget: createBudgetTracker({ canon_writes_per_run: 10 }), model_ref: "fixture:configured",
        producer, claims: { db: f.db },
      });
      expect(produced).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.canon_writes).toBe(1);
      const page = parseFrontmatter(readFileSync(join(f.vault, f.receipt.page_path), "utf8"));
      expect(page.data["status"]).toBe("archived");
      expect(f.db.query("SELECT 1 FROM canon_receipts WHERE receipt_id!=? AND page_path=?")
        .get(f.receipt.receipt_id, f.receipt.page_path)).not.toBeNull();
    } finally { f.dispose(); }
  });

  test(`direct control rejects missing context and stale exact collision (self=${self})`, async () => {
    const f = fixture(self);
    try {
      const before = effects(f);
      await expect(insertClaim({ db: f.db }, f.control)).rejects.toThrow("source_tombstone_vault_required");
      expect(effects(f)).toEqual(before);
      const stored = fileProposal(f.db, f.control, f.io).proposal;
      f.db.query("UPDATE claims SET frontmatter='{}' WHERE claim_id=?").run(stored.proposal_id);
      const stale = effects(f);
      await expect(insertClaim(f.io, f.control)).rejects.toThrow("source_tombstone_stale");
      expect(effects(f)).toEqual(stale);
    } finally { f.dispose(); }
  });

  test(`direct control rechecks current page after its clock callback (self=${self})`, async () => {
    const f = fixture(self);
    try {
      const path = join(f.vault, f.receipt.page_path);
      const replacement = `${readFileSync(path, "utf8")}\nReplacement made during preparation.\n`;
      const before = effects(f);
      await expect(insertClaim({ ...f.io, now: () => {
        writeFileSync(path, replacement);
        return "2026-09-05T20:00:00Z";
      } }, f.control)).rejects.toThrow("source_tombstone_stale");
      expect(effects(f)).toEqual(before);
      expect(readFileSync(path, "utf8")).toBe(replacement);
    } finally { f.dispose(); }
  });
}

test.each([
  { subject: "person:other" }, { predicate: "employment.works_at" }, { object: "Elsewhere" },
  { polarity: "negative" as const }, { intent: "correct" as const },
])("a source control cannot acquire positive-claim fields: %j", async extra => {
  const f = fixture(false);
  try {
    const before = effects(f);
    await expect(insertClaim(f.io, { ...f.control, ...extra } as InsertClaimInput)).rejects.toThrow("source_tombstone_stale");
    expect(effects(f)).toEqual(before);
  } finally { f.dispose(); }
});

test("final canon admission rejects a persisted control with a positive claim key", () => {
  const f = fixture(false);
  try {
    const stored = fileProposal(f.db, f.control, f.io).proposal;
    f.db.query("UPDATE claims SET claim_key=? WHERE claim_id=?").run("a".repeat(64), stored.proposal_id);
    const before = effects(f);
    const bytes = readFileSync(join(f.vault, f.receipt.page_path));
    expect(() => write(f.io, getClaim(f.db, stored.proposal_id)!)).toThrow("source_tombstone_stale");
    expect(effects(f)).toEqual(before);
    expect(readFileSync(join(f.vault, f.receipt.page_path))).toEqual(bytes);
  } finally { f.dispose(); }
});

test("a persisted control cannot acquire owner authority at retry or final canon admission", async () => {
  const f = fixture(false);
  try {
    const stored = fileProposal(f.db, f.control, f.io).proposal;
    f.db.query("UPDATE claims SET authority='owner_authored' WHERE claim_id=?").run(stored.proposal_id);
    const before = effects(f);
    const bytes = readFileSync(join(f.vault, f.receipt.page_path));
    await expect(insertClaim(f.io, f.control)).rejects.toThrow("source_tombstone_stale");
    expect(() => write(f.io, getClaim(f.db, stored.proposal_id)!)).toThrow("source_tombstone_stale");
    expect(effects(f)).toEqual(before);
    expect(readFileSync(join(f.vault, f.receipt.page_path))).toEqual(bytes);
  } finally { f.dispose(); }
});

test("ordinary external insertion still accepts omitted frontmatter without vault context", async () => {
  const f = canonFixture();
  try {
    const event = accept(f.db, validEvent());
    if (event.status !== "stored") throw new Error("ordinary fixture failed");
    const result = await insertClaim({ db: f.db }, { kind: "claim", body: "Ordinary external fact",
      provenance: [event.event.event_id], producer: "deterministic", confidence: 0.8 });
    expect(result.outcome).toBe("stored");
  } finally { f.dispose(); }
});
