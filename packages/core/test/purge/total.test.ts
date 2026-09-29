import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  applyCanonWrite,
  createBudgetTracker,
  resolveTarget,
} from "../../src/canon";
import { getClaim, insertClaim } from "../../src/claims/store";
import { undoReceipt } from "../../src/canon/undo";
import { correct } from "../../src/correction/correct";
import { initGraph } from "../../src/graph/schema";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { MAX_ARCHIVE_FILE_BYTES, PURGE_STORE_NAMES } from "../../src/ledger/purge-stores";
import {
  createVaultFts5Port,
  resumePurge,
  runPurge,
  verifyPurge,
} from "../../src/ledger/purge";
import { indexEvent } from "../../src/search/indexer";
import { initSearch } from "../../src/search/schema";
import { fileProposal, initStaging } from "../../src/staging/proposals";
import { initVault } from "../../src/vault/init";
import { validEvent } from "../fixtures";

const MARKER = "zqxmarkerpurgeproof7731";
const AT = "2026-09-02T12:00:00.000Z";
const roots: string[] = [];
const ports: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const port of ports.splice(0)) await port.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Every text column of every table and every byte of every file under the vault that holds the marker. */
function locations(db: Database, vault: string, marker: string): string[] {
  const found: string[] = [];
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  for (const { name } of tables) {
    let columns: string[];
    try {
      columns = db
        .query<{ name: string }, []>(
          `SELECT name FROM pragma_table_info('${name}')`,
        )
        .all()
        .map((c) => c.name);
    } catch {
      continue;
    }
    for (const column of columns) {
      try {
        if (
          db
            .query(
              `SELECT 1 FROM "${name}" WHERE CAST("${column}" AS TEXT) LIKE ? LIMIT 1`,
            )
            .get(`%${marker}%`) !== null
        ) {
          found.push(`table:${name}.${column}`);
        }
      } catch {
        /* virtual table without a plain column */
      }
    }
  }
  for (const path of walk(vault)) {
    if (readFileSync(path).includes(marker))
      found.push(`file:${path.slice(vault.length + 1)}`);
  }
  return found;
}

async function seed(marker: string) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-purge-total-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const text = `Grace runs partnerships at Acme. ${marker}`;
  const stored = accept(db, {
    ...validEvent(),
    source_record_id: "page-1.md",
    text,
  });
  if (stored.status !== "stored") throw new Error("event not stored");
  const event = stored.event;
  initSearch(db);
  indexEvent(db, event);
  initGraph(db);
  db.query(
    `INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
     VALUES ('person:grace', ?, 'source', 'public', 'quoted', 'connector_evidence', ?)`,
  ).run(`event:${event.event_id}`, JSON.stringify([event.event_id]));
  initStaging(db);
  const proposal = fileProposal(db, {
    kind: "claim",
    body: `Proposal: ${text}`,
    frontmatter: { type: "fact", title: `Grace ${marker}` },
    provenance: [event.event_id],
    producer: "deterministic",
    confidence: 1,
  });
  if (proposal.outcome !== "stored") throw new Error("proposal not stored");
  const inserted = await insertClaim(
    { db },
    {
      kind: "claim",
      target: "people/grace",
      subject: "person:grace",
      predicate: "employment.works_at",
      object: `acme ${marker}`,
      polarity: "positive",
      body: text,
      frontmatter: { type: "person", title: "Grace" },
      provenance: [event.event_id],
      subjects: ["person:grace"],
      producer: "deterministic",
      confidence: 0.8,
      sensitivity: "personal",
      taint: "clean",
      events: [
        {
          event_id: event.event_id,
          connector_id: event.connector_id,
          taint: "untrusted",
          text,
        },
      ],
    },
  );
  if (inserted.outcome !== "stored") throw new Error("claim not stored");
  const claim = inserted.claim;
  const io = { db, vault_path: vault };
  applyCanonWrite(io, claim, resolveTarget(io, claim), {
    writer: "loop",
    budget: createBudgetTracker({ canon_writes_per_run: 4 }),
  });
  await correct(io, {
    statement: "grace is at initech now",
    target: { claim_id: claim.claim_id },
  });
  const port = createVaultFts5Port(vault, () => AT);
  ports.push(port);
  await port.upsert([
    {
      doc_id: `page:external-${event.event_id}`,
      kind: "page",
      title: "Grace",
      text,
      sensitivity: "personal",
      taint: "clean",
      authority: "connector_evidence",
      subjects: [],
      provenance: [event.event_id],
      occurred_at: AT,
      updated_at: AT,
    },
  ]);
  return { vault, db, event, claim, proposal: proposal.proposal, port };
}

describe("purge is physically total", () => {
  test("the marker reaches claims, proposals, search, archive and the retrieval store before purge", async () => {
    const f = await seed(MARKER);
    const before = locations(f.db, f.vault, MARKER);
    for (const expected of [
      "table:events.text",
      "table:claims.body",
      "table:claims.object",
      "table:proposals.body",
    ]) {
      expect(before).toContain(expected);
    }
    expect(before.some((entry) => entry.startsWith("file:archive/"))).toBe(
      true,
    );
    f.db.close();
  });

  test("after purge the marker is in no table column, no vault file, no database or log bytes", async () => {
    const f = await seed(MARKER);
    const outcome = await runPurge(
      f.db,
      f.vault,
      { event_id: f.event.event_id },
      "retire",
      { now: () => AT, retrieval: f.port },
    );
    expect(locations(f.db, f.vault, MARKER)).toEqual([]);
    expect(outcome.erased.claims).toBeGreaterThan(0);
    expect(outcome.erased.proposals).toBe(1);
    expect(outcome.erased.archive_copies.length).toBeGreaterThan(0);
    expect(outcome.erased.database_sealed).toBe(true);
    expect(
      f.db.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()!
        .secure_delete,
    ).toBe(0);
    for (const name of ["kizuki.db-wal", "kizuki.db-shm"]) {
      const path = join(f.vault, ".kizuki", name);
      if (existsSync(path))
        expect(readFileSync(path).includes(MARKER)).toBe(false);
    }
    f.db.close();
  });

  test("claims and proposals keep ids and provenance but lose their payload", async () => {
    const f = await seed(MARKER);
    await runPurge(f.db, f.vault, { event_id: f.event.event_id }, "retire", {
      now: () => AT,
      retrieval: f.port,
    });
    const claim = getClaim(f.db, f.claim.claim_id)!;
    expect(claim.provenance).toEqual([f.event.event_id]);
    expect(claim.body_hash).toBe(f.claim.body_hash);
    expect(claim.body).toBe("");
    expect(claim.object).toBeNull();
    expect(claim.frontmatter).toEqual({});
    const proposal = f.db
      .query<
        {
          body: string;
          frontmatter: string;
          provenance: string;
          status: string;
        },
        [string]
      >(
        "SELECT body, frontmatter, provenance, status FROM proposals WHERE proposal_id = ?",
      )
      .get(f.proposal.proposal_id)!;
    expect(proposal).toEqual({
      body: "",
      frontmatter: "{}",
      provenance: JSON.stringify([f.event.event_id]),
      status: "withdrawn",
    });
    f.db.close();
  });

  test("a claim that another event still supports keeps its payload", async () => {
    const f = await seed(MARKER);
    const other = accept(f.db, { ...validEvent(), source_record_id: "page-2.md", text: "Grace also runs partnerships elsewhere." });
    if (other.status !== "stored") throw new Error("event not stored");
    const shared = await insertClaim(
      { db: f.db },
      {
        kind: "claim", target: "people/ada", subject: "person:ada", predicate: "employment.works_at",
        object: "partner", polarity: "positive", body: "Ada is a partner at Acme, per two records.",
        frontmatter: { type: "person", title: "Ada" }, provenance: [f.event.event_id, other.event.event_id],
        subjects: ["person:ada"], producer: "deterministic", confidence: 0.8, sensitivity: "personal", taint: "clean",
        events: [
          { event_id: f.event.event_id, connector_id: f.event.connector_id, taint: "untrusted", text: "a" },
          { event_id: other.event.event_id, connector_id: other.event.connector_id, taint: "untrusted", text: "b" },
        ],
      },
    );
    if (shared.outcome !== "stored") throw new Error("claim not stored");
    await runPurge(f.db, f.vault, { event_id: f.event.event_id }, "retire", { now: () => AT, retrieval: f.port });
    const kept = getClaim(f.db, shared.claim.claim_id)!;
    expect(kept.body).toBe("Ada is a partner at Acme, per two records.");
    expect(kept.status).toBe("provenance_reduced");
    f.db.close();
  });

  test("undo of a write whose archive copy purge deleted refuses instead of restoring the text", async () => {
    const f = await seed(MARKER);
    const archived = f.db.query<{ receipt_id: string; archive_path: string }, []>(
      "SELECT receipt_id, archive_path FROM canon_receipts WHERE archive_path IS NOT NULL",
    ).get()!;
    expect(existsSync(join(f.vault, archived.archive_path))).toBe(true);
    await runPurge(f.db, f.vault, { event_id: f.event.event_id }, "retire", { now: () => AT, retrieval: f.port });
    expect(existsSync(join(f.vault, archived.archive_path))).toBe(false);
    await expect(undoReceipt({ db: f.db, vault_path: f.vault }, archived.receipt_id)).rejects.toMatchObject({ name: "UndoError" });
    expect(locations(f.db, f.vault, MARKER)).toEqual([]);
    f.db.close();
  });

  test("verify emits one proof per store and every proof is clean", async () => {
    const f = await seed(MARKER);
    const outcome = await runPurge(
      f.db,
      f.vault,
      { event_id: f.event.event_id },
      "retire",
      { now: () => AT, retrieval: f.port },
    );
    const report = await verifyPurge(
      f.db,
      f.vault,
      outcome.receipts[0]!.receipt_id,
      { retrieval: f.port },
    );
    expect(report.stores.map((proof) => proof.store)).toEqual([
      ...PURGE_STORE_NAMES,
    ]);
    for (const proof of report.stores) expect(proof.found).toEqual([]);
    expect(report.ok).toBe(true);
    f.db.close();
  });

  test("verify fails and names the store when a copy is left behind", async () => {
    const f = await seed(MARKER);
    const outcome = await runPurge(
      f.db,
      f.vault,
      { event_id: f.event.event_id },
      "retire",
      { now: () => AT, retrieval: f.port },
    );
    const receipt = outcome.receipts[0]!.receipt_id;

    writeFileSync(
      join(f.vault, "archive", "left-copy.md"),
      `---\nid: left\nsources:\n  - ${f.event.event_id}\n---\n${MARKER}\n`,
      { mode: 0o600 },
    );
    f.db
      .query("UPDATE claims SET body = ? WHERE claim_id = ?")
      .run(MARKER, f.claim.claim_id);
    f.db
      .query("UPDATE proposals SET body = ? WHERE proposal_id = ?")
      .run(MARKER, f.proposal.proposal_id);
    const dirty = await verifyPurge(f.db, f.vault, receipt, {
      retrieval: f.port,
    });
    expect(dirty.ok).toBe(false);
    const found = Object.fromEntries(
      dirty.stores.map((proof) => [proof.store, proof.found]),
    );
    expect(found["archive"]).toEqual(["archive/left-copy.md"]);
    expect(found["claims"]).toEqual([f.claim.claim_id]);
    expect(found["proposals"]).toEqual([f.proposal.proposal_id]);
    expect(found["events"]).toEqual([]);

    // Finishing the purge again removes what was left and the proof turns clean.
    const resumed = await resumePurge(f.db, f.vault, receipt, {
      retrieval: f.port,
      now: () => AT,
    });
    expect(resumed.ok).toBe(true);
    expect(locations(f.db, f.vault, MARKER)).toEqual([]);
    f.db.close();
  });

  test("a quarantined stage image of a receipt citing the event fails the receipt_images store", async () => {
    const f = await seed(MARKER);
    const outcome = await runPurge(f.db, f.vault, { event_id: f.event.event_id }, "retire", { now: () => AT, retrieval: f.port });
    const cited = f.db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM canon_receipts WHERE receipt_kind = 'write' LIMIT 1").get()!.receipt_id;
    const directory = join(f.vault, ".kizuki", "quarantine", "canon-stage", cited);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "live.stage"), `${MARKER}\n`, { mode: 0o600 });
    const dirty = await verifyPurge(f.db, f.vault, outcome.receipts[0]!.receipt_id, { retrieval: f.port });
    expect(dirty.stores.find((proof) => proof.store === "receipt_images")!.found).toEqual([cited]);
    expect(dirty.ok).toBe(false);
    const resumed = await resumePurge(f.db, f.vault, outcome.receipts[0]!.receipt_id, { retrieval: f.port, now: () => AT });
    expect(resumed.ok).toBe(true);
    expect(existsSync(join(directory, "live.stage"))).toBe(false);
    f.db.close();
  });

  test("a leftover search row, graph edge or canon page citing the event fails its store", async () => {
    const f = await seed(MARKER);
    const outcome = await runPurge(
      f.db,
      f.vault,
      { event_id: f.event.event_id },
      "retire",
      { now: () => AT, retrieval: f.port },
    );
    const receipt = outcome.receipts[0]!.receipt_id;
    f.db
      .query(
        `INSERT INTO graph_edges (src, dst, kind, sensitivity, taint, authority, provenance)
       VALUES ('a', 'b', 'source', 'public', 'quoted', 'connector_evidence', ?)`,
      )
      .run(JSON.stringify([f.event.event_id]));
    writeFileSync(
      join(f.vault, "people", "left.md"),
      `---\nid: \"left-page\"\ntitle: \"Left\"\ntype: \"person\"\nstatus: \"active\"\nsensitivity: \"personal\"\ntaint: \"clean\"\nsources: [\"${f.event.event_id}\"]\n---\nLeft.\n`,
      { mode: 0o600 },
    );
    const dirty = await verifyPurge(f.db, f.vault, receipt, {
      retrieval: f.port,
    });
    const found = Object.fromEntries(
      dirty.stores.map((proof) => [proof.store, proof.found]),
    );
    expect(found["graph"]).toEqual(["a -> b"]);
    expect(found["canon"]).toEqual(["people/left.md"]);
    expect(dirty.ok).toBe(false);
    f.db.close();
  });

  test("the erasure is receipted with the archive files removed, and survives an unsealed retry", async () => {
    const f = await seed(MARKER);
    const outcome = await runPurge(f.db, f.vault, { event_id: f.event.event_id }, "retire", { now: () => AT, retrieval: f.port });
    const row = f.db
      .query<{ sealed: number; archive_paths: string; claims: number; proposals: number }, []>(
        "SELECT sealed, archive_paths, claims, proposals FROM purge_erasures",
      )
      .get()!;
    expect(row.sealed).toBe(1);
    expect(JSON.parse(row.archive_paths)).toEqual([...outcome.erased.archive_copies].sort());
    expect(row.claims).toBe(outcome.erased.claims);
    expect(row.proposals).toBe(1);

    // Finishing again finds nothing to delete and keeps what the first run receipted.
    await resumePurge(f.db, f.vault, outcome.receipts[0]!.receipt_id, { retrieval: f.port, now: () => AT });
    const again = f.db.query<{ archive_paths: string; claims: number }, []>("SELECT archive_paths, claims FROM purge_erasures").get()!;
    expect(JSON.parse(again.archive_paths)).toEqual(JSON.parse(row.archive_paths));
    expect(again.claims).toBe(row.claims);
    f.db.close();
  });

  test("a page or archive file the proof cannot read is unverifiable, not evidence, and fails the proof", async () => {
    const f = await seed(MARKER);
    const outcome = await runPurge(f.db, f.vault, { event_id: f.event.event_id }, "retire", { now: () => AT, retrieval: f.port });
    const receipt = outcome.receipts[0]!.receipt_id;
    mkdirSync(join(f.vault, "people"), { recursive: true });
    writeFileSync(join(f.vault, "people", "broken.md"), "---\nid: [unclosed\n---\nBroken.\n", { mode: 0o600 });
    writeFileSync(join(f.vault, "archive", "huge.bin"), Buffer.alloc(MAX_ARCHIVE_FILE_BYTES + 1), { mode: 0o600 });
    const report = await verifyPurge(f.db, f.vault, receipt, { retrieval: f.port });
    const byStore = Object.fromEntries(report.stores.map((proof) => [proof.store, proof]));
    expect(byStore["canon"]!.found).toEqual([]);
    expect(byStore["canon"]!.unverifiable).toEqual(["people/broken.md (parse)"]);
    expect(byStore["archive"]!.found).toEqual([]);
    expect(byStore["archive"]!.unverifiable).toEqual([`archive/huge.bin (over ${MAX_ARCHIVE_FILE_BYTES} bytes)`]);
    expect(report.ok).toBe(false);
    rmSync(join(f.vault, "people", "broken.md"));
    rmSync(join(f.vault, "archive", "huge.bin"));
    expect((await verifyPurge(f.db, f.vault, receipt, { retrieval: f.port })).ok).toBe(true);
    f.db.close();
  });
});
