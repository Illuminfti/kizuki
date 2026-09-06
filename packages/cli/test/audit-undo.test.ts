import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accept, applyCanonWrite, createBudgetTracker, insertClaim, resolveTarget } from "@kizuki/core";
import type { CaptureEventInput, Claim, InsertClaimInput } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli, tempVault } = createHelpers();
afterEach(cleanup);

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

interface Written {
  pagePath: string;
  createdId: string;
  createdAfter: string;
  editedId: string;
  editedBefore: string;
  editedAfter: string;
}

async function writeGracePage(vault: string): Promise<Written> {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const accepted = accept(db, fixtureEvent());
    if (accepted.status !== "stored") {
      throw new Error(`failed to store event: ${JSON.stringify(accepted)}`);
    }
    const eventId = accepted.event.event_id;
    const io = { db, vault_path: vault };
    const createClaim = await storeClaim(db, eventId);
    const created = applyCanonWrite(io, createClaim, resolveTarget(io, createClaim), {
      writer: "loop",
      budget: createBudgetTracker({ canon_writes_per_run: 4 }),
    });
    const editClaim = await storeClaim(db, eventId, {
      kind: "edit",
      predicate: null,
      object: null,
      body: "Grace leads partnerships at Acme.",
      frontmatter: { title: "Grace (Acme)" },
    });
    const edited = applyCanonWrite(io, editClaim, resolveTarget(io, editClaim), {
      writer: "loop",
      budget: createBudgetTracker({ canon_writes_per_run: 4 }),
    });
    return {
      pagePath: created.page_path,
      createdId: created.receipt_id,
      createdAfter: created.after_hash,
      editedId: edited.receipt_id,
      editedBefore: edited.before_hash ?? "",
      editedAfter: edited.after_hash,
    };
  } finally {
    db.close();
  }
}

function sha256File(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

function parseAuditReceipts(stdout: string): Record<string, unknown>[] {
  const envelope = JSON.parse(stdout) as { data: { receipts: Record<string, unknown>[] } };
  return envelope.data.receipts;
}

describe("kizuki audit and undo", () => {
  test("audit lists a real write and undo restores the prior bytes", async () => {
    const setup = tempVault();
    const written = await writeGracePage(setup.vault);
    const page = join(setup.vault, written.pagePath);
    expect(existsSync(page)).toBe(true);
    expect(sha256File(page)).toBe(written.editedAfter);
    expect(written.editedBefore).toBe(written.createdAfter);

    const listed = runCli(setup.env, "audit", "--json");
    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toBe("");
    const rows = parseAuditReceipts(listed.stdout);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const edited = rows.find((row) => row.receipt_id === written.editedId);
    const created = rows.find((row) => row.receipt_id === written.createdId);
    expect(edited).toMatchObject({
      receipt_id: written.editedId,
      writer: "loop",
      page_action: "edit",
      before_hash: written.editedBefore,
      after_hash: written.editedAfter,
      reverted_by: null,
    });
    expect(created).toMatchObject({
      receipt_id: written.createdId,
      writer: "loop",
      page_action: "create",
      after_hash: written.createdAfter,
    });
    expect(rows[0]?.receipt_id).toBe(written.editedId);

    const tableOut = runCli(setup.env, "audit");
    expect(tableOut.exitCode).toBe(0);
    expect(tableOut.stdout).toContain(written.editedId);
    expect(tableOut.stdout).toContain("loop");
    expect(tableOut.stdout).toContain(written.editedAfter);

    const undone = runCli(setup.env, "undo", written.editedId);
    expect(undone.exitCode).toBe(0);
    expect(undone.stderr).toBe("");
    expect(undone.stdout).toContain(`reverts=${written.editedId}`);
    expect(existsSync(page)).toBe(true);
    expect(sha256File(page)).toBe(written.editedBefore);
    expect(sha256File(page)).toBe(written.createdAfter);

    const afterUndo = parseAuditReceipts(runCli(setup.env, "audit", "--json").stdout);
    const original = afterUndo.find((row) => row.receipt_id === written.editedId);
    expect(typeof original?.reverted_by).toBe("string");
    expect(original?.reverted_by).not.toBe("");

    const deleted = runCli(setup.env, "undo", written.createdId);
    expect(deleted.exitCode).toBe(0);
    expect(existsSync(page)).toBe(false);
  });

  test("undo refuses an unknown or already-reverted receipt", async () => {
    const setup = tempVault();
    const written = await writeGracePage(setup.vault);

    const unknown = runCli(setup.env, "undo", "01JCUNKNOWNRECEIPT0000000000");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("unknown");

    const first = runCli(setup.env, "undo", written.editedId);
    expect(first.exitCode).toBe(0);
    const again = runCli(setup.env, "undo", written.editedId);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("already reverted");
  });

  test("help lists audit and undo with their usage", () => {
    const env = isolatedEnv();
    for (const verb of ["audit", "undo"] as const) {
      const result = runCli(env, "help", verb);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`usage: kizuki ${verb}`);
    }
  });
});
