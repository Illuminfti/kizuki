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

interface AuditPage {
  receipts: Record<string, unknown>[];
  truncated: boolean;
  next_offset: number | null;
}

function parseAuditPage(stdout: string): AuditPage {
  const envelope = JSON.parse(stdout) as { data: AuditPage };
  return envelope.data;
}

function parseAuditReceipts(stdout: string): Record<string, unknown>[] {
  return parseAuditPage(stdout).receipts;
}

function receiptIds(page: AuditPage): string[] {
  return page.receipts.map((row) => {
    const id = row.receipt_id;
    if (typeof id !== "string") throw new Error("audit receipt is missing receipt_id");
    return id;
  });
}

async function writePersonPages(
  vault: string,
  people: readonly { name: string; writer: "loop" | "correction" }[],
): Promise<{ name: string; writer: "loop" | "correction"; pagePath: string; receiptId: string }[]> {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const io = { db, vault_path: vault };
    const written: { name: string; writer: "loop" | "correction"; pagePath: string; receiptId: string }[] =
      [];
    for (const person of people) {
      const accepted = accept(db, {
        ...fixtureEvent(),
        text: `${person.name} works at Acme.`,
        subjects: [
          { subject_id: `person:${person.name}`, role: "from", display_name: person.name },
        ],
      });
      if (accepted.status !== "stored") {
        throw new Error(`failed to store event: ${JSON.stringify(accepted)}`);
      }
      const claim = await storeClaim(db, accepted.event.event_id, {
        target: `people/${person.name}`,
        subject: `person:${person.name}`,
        subjects: [`person:${person.name}`],
        body: `${person.name} works at Acme.`,
        frontmatter: { type: "person", title: person.name },
      });
      const created = applyCanonWrite(io, claim, resolveTarget(io, claim), {
        writer: person.writer,
        budget: createBudgetTracker({ canon_writes_per_run: 4 }),
      });
      written.push({
        name: person.name,
        writer: person.writer,
        pagePath: created.page_path,
        receiptId: created.receipt_id,
      });
    }
    return written;
  } finally {
    db.close();
  }
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
    const listedEnvelope = JSON.parse(listed.stdout) as {
      schema: string;
      status: string;
      data: AuditPage;
    };
    expect(listedEnvelope.schema).toBe("kizuki.cli.audit/v1");
    expect(listedEnvelope.status).toBe("ok");
    expect(listedEnvelope.data.truncated).toBe(false);
    expect(listedEnvelope.data.next_offset).toBe(null);
    const rows = listedEnvelope.data.receipts;
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
    const auditHelp = runCli(env, "help", "audit");
    expect(auditHelp.stdout).toContain("--limit");
    expect(auditHelp.stdout).toContain("--offset");
  });
});

describe("kizuki audit pagination", () => {
  test("pages a small receipt set with explicit truncation and next_offset", async () => {
    const setup = tempVault();
    await writePersonPages(
      setup.vault,
      ["ada", "grace", "linus", "mae", "nora"].map((name) => ({ name, writer: "loop" as const })),
    );

    const all = parseAuditPage(runCli(setup.env, "audit", "--json").stdout);
    expect(all.receipts.length).toBe(5);
    expect(all.truncated).toBe(false);
    expect(all.next_offset).toBe(null);
    const ids = receiptIds(all);

    const first = parseAuditPage(runCli(setup.env, "audit", "--json", "--limit", "2").stdout);
    expect(receiptIds(first)).toEqual(ids.slice(0, 2));
    expect(first.receipts).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(2);

    const next = parseAuditPage(
      runCli(setup.env, "audit", "--json", "--limit", "2", "--offset", String(first.next_offset)).stdout,
    );
    expect(receiptIds(next)).toEqual(ids.slice(2, 4));
    expect(next.receipts).toHaveLength(2);
    expect(next.truncated).toBe(true);
    expect(next.next_offset).toBe(4);

    const last = parseAuditPage(
      runCli(setup.env, "audit", "--json", "--limit", "2", "--offset", String(next.next_offset)).stdout,
    );
    expect(receiptIds(last)).toEqual(ids.slice(4));
    expect(last.receipts).toHaveLength(1);
    expect(last.truncated).toBe(false);
    expect(last.next_offset).toBe(null);

    const walked = [...receiptIds(first), ...receiptIds(next), ...receiptIds(last)];
    expect(walked).toEqual(ids);
    expect(new Set(walked).size).toBe(ids.length);

    const tableFirst = runCli(setup.env, "audit", "--limit", "2");
    expect(tableFirst.exitCode).toBe(0);
    expect(tableFirst.stderr).toBe("");
    expect(tableFirst.stdout).toContain(ids[0] ?? "");
    expect(tableFirst.stdout).toContain(ids[1] ?? "");
    expect(tableFirst.stdout).not.toContain(ids[2] ?? "missing-third");
    expect(tableFirst.stdout).toContain("truncated  next_offset=2");

    const tableLast = runCli(setup.env, "audit", "--limit", "2", "--offset", "4");
    expect(tableLast.exitCode).toBe(0);
    expect(tableLast.stderr).toBe("");
    expect(tableLast.stdout).toContain(ids[4] ?? "");
    expect(tableLast.stdout).not.toContain("truncated");
    expect(tableLast.stdout).not.toContain("next_offset=");
  });

  test("filtered pages stay newest-first and do not duplicate or omit matches", async () => {
    const setup = tempVault();
    await writePersonPages(setup.vault, [
      { name: "ada", writer: "loop" },
      { name: "grace", writer: "correction" },
      { name: "linus", writer: "loop" },
      { name: "mae", writer: "correction" },
      { name: "nora", writer: "loop" },
    ]);

    const all = parseAuditPage(runCli(setup.env, "audit", "--json").stdout);
    const filtered = parseAuditPage(runCli(setup.env, "audit", "--json", "--writer", "loop").stdout);
    expect(filtered.truncated).toBe(false);
    expect(filtered.next_offset).toBe(null);
    expect(filtered.receipts.length).toBe(3);
    expect(filtered.receipts.every((row) => row.writer === "loop")).toBe(true);
    expect(receiptIds(filtered)).toEqual(
      receiptIds(all).filter((_, index) => all.receipts[index]?.writer === "loop"),
    );

    const first = parseAuditPage(
      runCli(setup.env, "audit", "--json", "--writer", "loop", "--limit", "1").stdout,
    );
    expect(receiptIds(first)).toEqual(receiptIds(filtered).slice(0, 1));
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(1);

    const middle = parseAuditPage(
      runCli(setup.env, "audit", "--json", "--writer", "loop", "--limit", "1", "--offset", "1")
        .stdout,
    );
    expect(receiptIds(middle)).toEqual(receiptIds(filtered).slice(1, 2));
    expect(middle.truncated).toBe(true);
    expect(middle.next_offset).toBe(2);

    const last = parseAuditPage(
      runCli(setup.env, "audit", "--json", "--writer", "loop", "--limit", "1", "--offset", "2")
        .stdout,
    );
    expect(receiptIds(last)).toEqual(receiptIds(filtered).slice(2));
    expect(last.truncated).toBe(false);
    expect(last.next_offset).toBe(null);

    expect([...receiptIds(first), ...receiptIds(middle), ...receiptIds(last)]).toEqual(
      receiptIds(filtered),
    );
  });

  test("rejects missing, non-integer, zero, negative, and over-bound pagination", () => {
    const setup = tempVault();
    const cases: string[][] = [
      ["--limit"],
      ["--offset"],
      ["--limit", "0"],
      ["--limit", "-1"],
      ["--limit", "x"],
      ["--limit", "1.5"],
      ["--limit", "5001"],
      ["--offset", "-1"],
      ["--offset", "x"],
      ["--offset", "1.5"],
    ];
    for (const args of cases) {
      const result = runCli(setup.env, "audit", "--json", ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("usage: kizuki audit");
    }

    const ok = runCli(setup.env, "audit", "--json", "--limit", "5000", "--offset", "0");
    expect(ok.exitCode).toBe(0);
    const page = parseAuditPage(ok.stdout);
    expect(page.truncated).toBe(false);
    expect(page.next_offset).toBe(null);
    expect(page.receipts.length).toBeLessThanOrEqual(5000);
  });
});
