import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accept,
  applyCanonWrite,
  createBudgetTracker,
  initVault,
  insertClaim,
  listAuditReceipts,
  openLedger,
  resolveTarget,
  undoReceipt,
} from "@kizuki/core";
import type { CaptureEventInput, Claim, InsertClaimInput } from "@kizuki/core";
import { toAuditItem } from "../src/app";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureEvent(): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: "fixture",
    source_record_id: `rec-${crypto.randomUUID()}`,
    kind: "message",
    occurred_at: "2026-02-28T10:30:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text: "Grace runs partnerships at Acme.",
    subjects: [{ subject_id: "person:grace", role: "from", display_name: "Grace" }],
    sensitivity_hint: "personal",
    deleted: false,
    attachments: [],
    metadata: {},
  };
}

async function storeClaim(
  db: ReturnType<typeof openLedger>,
  eventId: string,
  overrides: Partial<InsertClaimInput> = {},
): Promise<Claim> {
  const input: InsertClaimInput = {
    kind: "claim",
    target: "people/grace",
    subject: "person:grace",
    predicate: "employment.works_at",
    object: "acme",
    polarity: "positive",
    body: "Grace runs partnerships at Acme.",
    frontmatter: { type: "person", title: "Grace" },
    provenance: [eventId],
    subjects: ["person:grace"],
    producer: "deterministic",
    confidence: 0.8,
    sensitivity: "personal",
    taint: "clean",
    events: [
      {
        event_id: eventId,
        connector_id: "fixture",
        taint: "untrusted",
        text: "Grace runs partnerships at Acme.",
      },
    ],
    ...overrides,
  };
  const result = await insertClaim({ db }, input);
  if (result.outcome === "stored") return result.claim;
  if (result.outcome === "contested") return result.incoming;
  throw new Error(`fixture claim was ${result.outcome}`);
}

describe("toAuditItem", () => {
  test("the detail after-bytes are this receipt, not a later edit", async () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-item-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    const accepted = accept(db, fixtureEvent());
    if (accepted.status !== "stored") throw new Error("event");
    const eventId = accepted.event.event_id;
    const createdClaim = await storeClaim(db, eventId);
    const io = { db, vault_path: vault };
    const created = applyCanonWrite(io, createdClaim, resolveTarget(io, createdClaim), {
      writer: "loop",
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
    });
    const editedClaim = await storeClaim(db, eventId, {
      kind: "edit",
      predicate: null,
      object: null,
      body: "Grace leads partnerships at Acme.",
      frontmatter: { title: "Grace (Acme)" },
    });
    applyCanonWrite(io, editedClaim, resolveTarget(io, editedClaim), {
      writer: "loop",
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
    });

    const listed = listAuditReceipts(db);
    const createdRow = listed.find((row) => row.receipt_id === created.receipt_id);
    if (createdRow === undefined) throw new Error("missing create receipt");
    const item = toAuditItem(vault, createdRow, db);
    expect(item.currentBody).toContain("runs partnerships");
    expect(item.currentBody).not.toContain("leads partnerships");
    expect(item.priorBody).toBeNull();
    db.close();
  });

  test("a reverted later write is still used to recover this receipt's after-bytes", async () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-reverted-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    const accepted = accept(db, fixtureEvent());
    if (accepted.status !== "stored") throw new Error("event");
    const eventId = accepted.event.event_id;
    const createdClaim = await storeClaim(db, eventId);
    const io = { db, vault_path: vault };
    const created = applyCanonWrite(io, createdClaim, resolveTarget(io, createdClaim), {
      writer: "loop",
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
    });
    const editedClaim = await storeClaim(db, eventId, {
      kind: "edit",
      predicate: null,
      object: null,
      body: "Grace leads partnerships at Acme.",
      frontmatter: { title: "Grace (Acme)" },
    });
    const edited = applyCanonWrite(io, editedClaim, resolveTarget(io, editedClaim), {
      writer: "loop",
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
    });
    await undoReceipt(io, edited.receipt_id);
    const againClaim = await storeClaim(db, eventId, {
      kind: "edit",
      predicate: null,
      object: null,
      body: "Grace left Acme for Initech.",
      frontmatter: { title: "Grace" },
    });
    applyCanonWrite(io, againClaim, resolveTarget(io, againClaim), {
      writer: "loop",
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
    });

    const listed = listAuditReceipts(db);
    const createdRow = listed.find((row) => row.receipt_id === created.receipt_id);
    if (createdRow === undefined) throw new Error("missing create receipt");
    const item = toAuditItem(vault, createdRow, db);
    expect(item.currentBody).toContain("runs partnerships");
    expect(item.currentBody).not.toContain("leads partnerships");
    expect(item.currentBody).not.toContain("Initech");
    db.close();
  });

  test("listAuditReceipts offset pages newest-first without silently dropping the tail", async () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-page-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    const accepted = accept(db, fixtureEvent());
    if (accepted.status !== "stored") throw new Error("event");
    const eventId = accepted.event.event_id;
    const io = { db, vault_path: vault };
    const createdClaim = await storeClaim(db, eventId);
    applyCanonWrite(io, createdClaim, resolveTarget(io, createdClaim), {
      writer: "loop",
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
    });
    const editedClaim = await storeClaim(db, eventId, {
      kind: "edit",
      predicate: null,
      object: null,
      body: "Grace leads partnerships at Acme.",
      frontmatter: { title: "Grace (Acme)" },
    });
    applyCanonWrite(io, editedClaim, resolveTarget(io, editedClaim), {
      writer: "loop",
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
    });
    const all = listAuditReceipts(db);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const first = listAuditReceipts(db, { limit: 1, offset: 0 });
    const second = listAuditReceipts(db, { limit: 1, offset: 1 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.receipt_id).toBe(all[0]?.receipt_id);
    expect(second[0]?.receipt_id).toBe(all[1]?.receipt_id);
    expect(first[0]?.receipt_id).not.toBe(second[0]?.receipt_id);
    db.close();
  });
});
