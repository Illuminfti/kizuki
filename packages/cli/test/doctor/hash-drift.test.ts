import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCanonPagesReport } from "@kizuki/core";
import { serializePage } from "../../../core/src/vault/frontmatter";
import { openLedger } from "../../../core/src/ledger/db";
import { putEvent } from "../../../core/test/claims/helpers";
import { createHelpers } from "../helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

const HASH_DRIFT_LIMIT = 64;

function pageBytes(id: string, sources: string[], body = "Synthetic canon body is never a doctor diagnostic.\n"): Buffer {
  return Buffer.from(
    serializePage({
      data: {
        id,
        title: "Synthetic hash-drift note",
        type: "fact",
        status: "active",
        sensitivity: "private",
        taint: "clean",
        sources,
      },
      body,
    }),
  );
}

function seedPages(
  vault: string,
  count: number,
  eventId: string,
  receipted: boolean,
): string[] {
  mkdirSync(join(vault, "facts"), { recursive: true });
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const paths: string[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const name = `page-${String(index).padStart(2, "0")}`;
      const relPath = `facts/${name}.md`;
      const bytes = pageBytes(name, [eventId]);
      writeFileSync(join(vault, relPath), bytes);
      paths.push(relPath);
      if (!receipted) continue;
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const receiptId = `01HDRIFT${String(index).padStart(18, "0")}`;
      db.query(
        `INSERT INTO canon_receipts (
           receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
           after_hash, at, receipt_kind, page_action, writer, producer,
           authority, confidence, taint, candidates, superseded, retrieval_ops
         ) VALUES (?, '[]', '[]', 'private', ?, 'claim',
           ?, '2026-09-01T00:00:00Z', 'write', 'create', 'import',
           'deterministic', 'connector_evidence', 1.0, 'quoted', '[]', '[]', '[]')`,
      ).run(receiptId, relPath, hash);
      db.query(
        `INSERT INTO page_index (page_id, rel_path, last_receipt, last_hash)
         VALUES (?, ?, ?, ?)`,
      ).run(name, relPath, receiptId, hash);
    }
  } finally {
    db.close();
  }
  return paths;
}

function doctorJson(env: Record<string, string | undefined>, integrity = false) {
  const args = integrity ? ["doctor", "--json", "--integrity"] : ["doctor", "--json"];
  const result = runCli(env, ...args);
  const body = JSON.parse(result.stdout) as {
    status: string;
    degraded: string[];
    data: {
      ok: boolean;
      problems: { page: string; error: string }[];
      hash_drift: {
        complete: boolean;
        sampled: boolean;
        truncated: boolean;
        limit: number;
        enumerated: number;
        selected: number;
        checked: number;
        unreceipted: number;
      };
    };
  };
  return { result, body };
}

test("doctor discloses a 64-page hash-drift sample and still reports selected drift", () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const eventId = putEvent(db);
  db.close();
  seedPages(setup.vault, 65, eventId, true);
  const ordered = listCanonPagesReport(setup.vault).pages.map((page) => page.relPath);
  expect(ordered.length).toBe(65);
  const outside = ordered[64]!;
  const selected = ordered[0]!;

  writeFileSync(
    join(setup.vault, outside),
    pageBytes(outside.slice("facts/".length, -".md".length), [eventId], "tampered outside body\n"),
  );
  const sampled = doctorJson(setup.env);
  expect(sampled.body.data.hash_drift).toEqual({
    complete: false,
    sampled: true,
    truncated: false,
    limit: HASH_DRIFT_LIMIT,
    enumerated: 65,
    selected: HASH_DRIFT_LIMIT,
    checked: HASH_DRIFT_LIMIT,
    unreceipted: 0,
  });
  expect(sampled.body.degraded).toContain(
    "hash-drift coverage=sampled selected=64 enumerated=65 limit=64",
  );
  expect(sampled.body.data.problems.some((item) => item.error.includes("hash drift"))).toBe(false);
  const human = runCli(setup.env, "doctor");
  expect(human.stdout).toContain("hash-drift coverage=sampled selected=64 enumerated=65 limit=64");

  const integrity = doctorJson(setup.env, true);
  expect(integrity.body.data.hash_drift.sampled).toBe(true);
  expect(integrity.body.data.hash_drift.selected).toBe(HASH_DRIFT_LIMIT);

  writeFileSync(
    join(setup.vault, selected),
    pageBytes(selected.slice("facts/".length, -".md".length), [eventId], "tampered selected body\n"),
  );
  const drifted = doctorJson(setup.env);
  expect(drifted.result.exitCode).toBe(1);
  expect(drifted.body.status).toBe("error");
  expect(drifted.body.data.ok).toBe(false);
  expect(drifted.body.data.problems.some((item) => (
    item.page === selected && item.error.includes("hash drift: file disagrees with receipt")
  ))).toBe(true);
  expect(drifted.body.data.hash_drift.sampled).toBe(true);
});

test("doctor hash-drift coverage is complete at the 64-page bound and empty vault", () => {
  const empty = tempVault();
  const emptyReport = doctorJson(empty.env);
  expect(emptyReport.body.data.hash_drift).toMatchObject({
    complete: true,
    sampled: false,
    truncated: false,
    limit: HASH_DRIFT_LIMIT,
    enumerated: 0,
    selected: 0,
    checked: 0,
    unreceipted: 0,
  });
  expect(emptyReport.body.degraded.some((item) => item.startsWith("hash-drift coverage="))).toBe(false);

  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const eventId = putEvent(db);
  db.close();
  seedPages(setup.vault, 64, eventId, true);
  const bound = doctorJson(setup.env);
  expect(bound.body.data.hash_drift).toMatchObject({
    complete: true,
    sampled: false,
    truncated: false,
    limit: HASH_DRIFT_LIMIT,
    enumerated: 64,
    selected: 64,
    checked: 64,
    unreceipted: 0,
  });
});

test("doctor counts unreceipted selected pages without inventing hash drift", () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const eventId = putEvent(db);
  db.close();
  seedPages(setup.vault, 1, eventId, false);
  const report = doctorJson(setup.env);
  expect(report.body.data.hash_drift).toMatchObject({
    complete: true,
    sampled: false,
    enumerated: 1,
    selected: 1,
    checked: 0,
    unreceipted: 1,
  });
  expect(report.body.data.problems.some((item) => item.error.includes("hash drift"))).toBe(false);
});
