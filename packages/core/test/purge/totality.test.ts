import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listCanonReceipts } from "../../src/canon/receipts";
import { getClaim, insertClaim } from "../../src/claims/store";
import type { AbsenceProof, RetrievalDoc, RetrievalPort } from "../../src/contracts/retrieval";
import { accept } from "../../src/ledger/ledger";
import { openLedger } from "../../src/ledger/db";
import {
  PURGE_SLA_SECONDS,
  createVaultFts5Port,
  inspectPurgeHealth,
  isHeld,
  purgeEvents,
  readHolds,
  runPurge,
  setAfterCanonSnapshot,
  verifyPurge,
} from "../../src/ledger/purge";
import { tableExists } from "../../src/ledger/schema";
import { serializePage } from "../../src/vault/frontmatter";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";

const AT = "2026-09-02T12:00:00.000Z";
const LATER = "2026-09-02T13:01:00.000Z";

const fixtures: { dispose: () => void }[] = [];

afterEach(() => {
  setAfterCanonSnapshot();
  for (const item of fixtures.splice(0)) item.dispose();
});

function vault() {
  const db = openLedger(":memory:");
  const disk = tempVault("kizuki-purge-totality-");
  fixtures.push({
    dispose: () => {
      db.close();
      disk.dispose();
    },
  });
  return { db, vaultPath: disk.path };
}

function storeEvent(
  db: ReturnType<typeof openLedger>,
  overrides: Partial<ReturnType<typeof validEvent>> = {},
) {
  const result = accept(db, { ...validEvent(), ...overrides });
  if (result.status !== "stored") throw new Error("expected stored event");
  return result.event;
}

function writeCanonPage(
  vaultPath: string,
  relPath: string,
  data: Record<string, unknown>,
  body: string,
): void {
  const path = join(vaultPath, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializePage({ data, body }), "utf8");
}

function fts5(vaultPath: string): RetrievalPort {
  const port = createVaultFts5Port(vaultPath, () => AT);
  fixtures.push({
    dispose: () => {
      void port.close();
    },
  });
  return port;
}

function doc(
  docId: string,
  kind: RetrievalDoc["kind"],
  text: string,
  provenance: string[],
): RetrievalDoc {
  return {
    doc_id: docId,
    kind,
    title: docId,
    text,
    sensitivity: "personal",
    taint: "clean",
    authority: "connector_evidence",
    subjects: ["person:grace"],
    provenance,
    occurred_at: AT,
    updated_at: AT,
  };
}

describe("RFC 0002 purge totality", () => {
  test("purge holds every affected page before any store is touched", async () => {
    const { db, vaultPath } = vault();
    const event = storeEvent(db, { source_record_id: "acme.md" });
    writeCanonPage(
      vaultPath,
      "people/grace.md",
      {
        id: "page-grace",
        title: "grace",
        type: "person",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
        sources: [event.event_id],
      },
      "Grace runs partnerships at Acme.\n",
    );

    const inner = fts5(vaultPath);
    await inner.upsert([
      doc(`event:${event.event_id}`, "event", "note", [event.event_id]),
    ]);

    let holdsWhenStoreTouched = 0;
    const port: RetrievalPort = {
      descriptor: inner.descriptor,
      upsert: (docs) => inner.upsert(docs),
      search: (query) => inner.search(query),
      neighbors: (entity, options) => inner.neighbors(entity, options),
      health: () => inner.health(),
      close: () => inner.close(),
      verifyAbsent: (ids) => inner.verifyAbsent(ids),
      async remove(ids) {
        holdsWhenStoreTouched = readHolds(db).length;
        expect(isHeld(db, "people/grace.md")).toBe(true);
        return inner.remove(ids);
      },
    };

    const outcome = await runPurge(
      db,
      vaultPath,
      { source_record_id: "acme.md" },
      "source deleted",
      { retrieval: port, now: () => AT },
    );

    expect(outcome.canon_holds.map(({ page_path }) => page_path)).toEqual([
      "people/grace.md",
    ]);
    expect(holdsWhenStoreTouched).toBe(1);
    expect(outcome.purge_ops).toHaveLength(1);
    expect(outcome.purge_ops[0]?.store).toBe("kizuki.retrieval.fts5");
  });

  test("verifyAbsent proves the ids are gone from every configured store", async () => {
    const { db, vaultPath } = vault();
    const event = storeEvent(db, { source_record_id: "acme.md" });
    writeCanonPage(
      vaultPath,
      "people/grace.md",
      {
        id: "page-grace",
        title: "grace",
        type: "person",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
        sources: [event.event_id],
      },
      "Grace runs partnerships at Acme.\n",
    );
    const claim = await insertClaim(
      { db, now: () => AT },
      {
        kind: "claim",
        target: "people/grace",
        subject: "person:grace",
        predicate: "employment.works_at",
        object: "acme",
        polarity: "positive",
        body: "Grace runs partnerships at Acme.",
        frontmatter: { type: "person", title: "grace" },
        provenance: [event.event_id],
        subjects: ["person:grace"],
        producer: "deterministic",
        confidence: 0.8,
        sensitivity: "personal",
        taint: "clean",
      },
    );
    expect(claim.outcome).toBe("stored");
    if (claim.outcome !== "stored") return;

    const port = fts5(vaultPath);
    const ids = [
      `event:${event.event_id}`,
      "page:page-grace",
      `claim:${claim.claim.claim_id}`,
    ];
    await port.upsert([
      doc(ids[0]!, "event", "Grace note", [event.event_id]),
      doc(ids[1]!, "page", "Grace runs partnerships at Acme.", [event.event_id]),
      doc(ids[2]!, "claim", "Grace runs partnerships at Acme.", [event.event_id]),
    ]);

    const outcome = await runPurge(
      db,
      vaultPath,
      { event_id: event.event_id },
      "source deleted",
      { retrieval: port, now: () => AT },
    );
    expect(outcome.purge_ops[0]?.ids).toEqual(ids);

    const proof: AbsenceProof = await port.verifyAbsent(ids);
    expect(proof.checked).toBe(3);
    expect(proof.found).toEqual([]);
    expect(proof.store).toBe("kizuki.retrieval.fts5");

    const report = await verifyPurge(db, vaultPath, outcome.receipts[0]!.receipt_id, {
      retrieval: port,
      now: () => AT,
    });
    expect(report.proofs).toHaveLength(1);
    expect(report.proofs[0]?.found).toEqual([]);
    expect(report.proofs[0]?.checked).toBe(3);
    expect(report.ok).toBe(true);
  });

  test("catch-up adds late page ids to the retrieval purge op", async () => {
    const { db, vaultPath } = vault();
    const event = storeEvent(db, { source_record_id: "acme.md" });
    const port = fts5(vaultPath);
    await port.upsert([
      doc(`event:${event.event_id}`, "event", "note", [event.event_id]),
      doc("page:page-late", "page", "late citing page", [event.event_id]),
    ]);
    setAfterCanonSnapshot(() => {
      writeCanonPage(
        vaultPath,
        "facts/late.md",
        {
          id: "page-late",
          title: "late",
          type: "fact",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
          sources: [event.event_id],
        },
        "late citing page\n",
      );
    });

    const outcome = await runPurge(
      db,
      vaultPath,
      { event_id: event.event_id },
      "source deleted",
      { retrieval: port, now: () => AT },
    );

    expect(outcome.purge_ops[0]?.ids).toContain("page:page-late");
    const proof = await port.verifyAbsent(["page:page-late"]);
    expect(proof.found).toEqual([]);
    const report = await verifyPurge(db, vaultPath, outcome.receipts[0]!.receipt_id, {
      retrieval: port,
      now: () => AT,
    });
    expect(report.ok).toBe(true);
  });

  test("a pending purge op older than the SLA is a doctor failure", () => {
    const { db } = vault();
    expect(tableExists(db, "purge_ops")).toBe(true);
    db.query(
      `INSERT INTO purge_ops
         (op_id, receipt_id, store, ids, state, proof, created_at, done_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
    ).run(
      "op-stale",
      "receipt-stale",
      "kizuki.retrieval.fts5",
      JSON.stringify(["event:gone"]),
      "pending",
      "2026-09-02T12:00:00.000Z",
    );
    expect(inspectPurgeHealth(db, AT).ok).toBe(true);

    const stale = inspectPurgeHealth(db, LATER);
    expect(stale.ok).toBe(false);
    expect(stale.failures.some((item) => item.kind === "purge_op_stale")).toBe(true);
    const age = stale.failures.find((item) => item.kind === "purge_op_stale")?.age_s;
    expect(age).toBeGreaterThan(PURGE_SLA_SECONDS);
  });

  test("the canon rewrite lands in the same loop pass and lifts the hold", async () => {
    const { db, vaultPath } = vault();
    const kept = storeEvent(db, { source_record_id: "kept.md" });
    const purged = storeEvent(db, { source_record_id: "acme.md" });
    writeCanonPage(
      vaultPath,
      "people/grace.md",
      {
        id: "page-grace",
        title: "grace",
        type: "person",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
        sources: [purged.event_id, kept.event_id],
      },
      "Grace runs partnerships at Acme. Contact: grace@acme.test.\n",
    );
    const gone = await insertClaim(
      { db, now: () => AT },
      {
        kind: "claim",
        target: "people/grace",
        subject: "person:grace",
        predicate: "employment.works_at",
        object: "acme",
        polarity: "positive",
        body: "Grace runs partnerships at Acme.",
        frontmatter: { type: "person", title: "grace" },
        provenance: [purged.event_id],
        subjects: ["person:grace"],
        producer: "deterministic",
        confidence: 0.8,
        sensitivity: "personal",
        taint: "clean",
      },
    );
    expect(gone.outcome).toBe("stored");
    const keptClaim = await insertClaim(
      { db, now: () => AT },
      {
        kind: "claim",
        target: "people/grace",
        subject: "person:grace",
        predicate: "contact.email",
        object: "grace@acme.test",
        polarity: "positive",
        body: "Contact: grace@acme.test.",
        frontmatter: { type: "person", title: "grace" },
        provenance: [kept.event_id],
        subjects: ["person:grace"],
        producer: "deterministic",
        confidence: 0.8,
        sensitivity: "personal",
        taint: "clean",
      },
    );
    expect(keptClaim.outcome).toBe("stored");

    const port = fts5(vaultPath);
    const outcome = await runPurge(
      db,
      vaultPath,
      { event_id: purged.event_id },
      "source deleted",
      { retrieval: port, now: () => AT },
    );

    expect(readHolds(db)).toEqual([]);
    expect(isHeld(db, "people/grace.md")).toBe(false);
    expect(outcome.rewritten.map(({ page_path }) => page_path)).toEqual([
      "people/grace.md",
    ]);
    if (gone.outcome === "stored") {
      expect(getClaim(db, gone.claim.claim_id)?.status).toBe("purged");
    }
    if (keptClaim.outcome === "stored") {
      expect(getClaim(db, keptClaim.claim.claim_id)?.status).toBe("live");
    }

    const page = readFileSync(join(vaultPath, "people/grace.md"), "utf8");
    expect(page).not.toContain(purged.event_id);
    expect(page).toContain(kept.event_id);
    expect(page).not.toContain("Grace runs partnerships at Acme.");
    expect(page).toContain("Contact: grace@acme.test.");

    const rewrite = listCanonReceipts(db, { page_path: "people/grace.md" }).find(
      (row) => row.kind === "purge_rewrite",
    );
    expect(rewrite).toBeDefined();
    expect(rewrite?.page_action).toBe("edit");
  });

  test("raw subject purge works while alias expansion refuses before mutation", () => {
    const { db, vaultPath } = vault();
    const grace = storeEvent(db, {
      source_record_id: "grace.md",
      subjects: [{ subject_id: "person:grace", role: "about" }],
    });
    const alias = storeEvent(db, {
      source_record_id: "alias.md",
      subjects: [{ subject_id: "person:g.hopper", role: "about" }],
    });
    db.exec(`
      CREATE TABLE IF NOT EXISTS identity_links (
        subject_a TEXT NOT NULL,
        subject_b TEXT NOT NULL,
        score REAL NOT NULL,
        evidence TEXT NOT NULL,
        status TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        receipt_id TEXT,
        at TEXT NOT NULL,
        PRIMARY KEY (subject_a, subject_b)
      ) STRICT;
    `);
    db.query(
      `INSERT INTO identity_links
         (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      "person:grace",
      "person:g.hopper",
      0.95,
      "[]",
      "merged",
      "test",
      AT,
    );

    const without = purgeEvents(
      db,
      vaultPath,
      { subject_handle: "person:grace" },
      "subject request",
      { include_aliases: false, now: () => AT },
    );
    expect(without.receipts.map(({ event_id }) => event_id)).toEqual([
      grace.event_id,
    ]);
    expect(
      db
        .query<{ event_id: string }, [string]>(
          "SELECT event_id FROM events WHERE event_id = ?",
        )
        .get(alias.event_id)?.event_id,
    ).toBe(alias.event_id);

    expect(() => purgeEvents(
      db,
      vaultPath,
      { subject_handle: "person:grace" },
      "subject request",
      { include_aliases: true, now: () => AT },
    )).toThrow("identity authority unavailable");
    expect(
      db.query<{ event_id: string }, [string]>(
        "SELECT event_id FROM events WHERE event_id = ?",
      ).get(alias.event_id)?.event_id,
    ).toBe(alias.event_id);
  });

  test("purge removes parsed legacy support and refuses to claim absence around malformed support", () => {
    const { db, vaultPath } = vault();
    const erased = storeEvent(db, {
      source_record_id: "erased.md",
      subjects: [{ subject_id: "person:erased", role: "about" }],
    });
    const untouched = storeEvent(db, { source_record_id: "untouched.md" });
    db.query(
      `INSERT INTO identity_links
       (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run("person:legacy-a", "person:legacy-b", 1, JSON.stringify([`event:${erased.event_id}`]), "merged", "forged", AT);
    const result = purgeEvents(db, vaultPath, { event_id: erased.event_id }, "remove support", { now: () => AT });
    expect(result.receipts).toHaveLength(1);
    expect(db.query("SELECT 1 FROM identity_links").get()).toBeNull();
    db.query(
      `INSERT INTO identity_links
       (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run("person:malformed-a", "person:malformed-b", 1, "{", "merged", "forged", AT);
    expect(() => purgeEvents(db, vaultPath, { event_id: untouched.event_id }, "must prove absence", { now: () => AT }))
      .toThrow("identity link evidence is malformed or unresolved");
    expect(db.query<{ event_id: string }, [string]>("SELECT event_id FROM events WHERE event_id=?").get(untouched.event_id)?.event_id)
      .toBe(untouched.event_id);
    db.query("DELETE FROM identity_links").run();
    db.query(
      `INSERT INTO identity_links
       (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run("person:dangling-a", "person:dangling-b", 1, JSON.stringify(["event:does-not-exist"]), "candidate", "legacy", AT);
    expect(() => purgeEvents(db, vaultPath, { event_id: untouched.event_id }, "must resolve support", { now: () => AT }))
      .toThrow("purge retained erased identity support");
  });

  test("public verification is unprovable while unrelated inert identity history remains", async () => {
    const { db, vaultPath } = vault();
    const erased = storeEvent(db, { source_record_id: "erased-proof.md" });
    const surviving = storeEvent(db, { source_record_id: "surviving-proof.md" });
    db.query(
      `INSERT INTO identity_links
       (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run("person:unrelated-a", "person:unrelated-b", 1, JSON.stringify([`event:${surviving.event_id}`]), "candidate", "legacy", AT);
    const outcome = purgeEvents(db, vaultPath, { event_id: erased.event_id }, "remove one", { now: () => AT });
    expect(outcome.receipts).toHaveLength(1);
    const report = await verifyPurge(db, vaultPath, outcome.receipts[0]!.receipt_id, { now: () => AT });
    expect(report.ok).toBe(false);
  });

  test("verification never certifies an arbitrary receipt id", async () => {
    const { db, vaultPath } = vault();
    expect((await verifyPurge(db, vaultPath, "not-a-purge-receipt", { now: () => AT })).ok).toBe(false);
  });

  test("public verification rechecks identity residue after an awaited store callback", async () => {
    const { db, vaultPath } = vault();
    const erased = storeEvent(db, {
      source_record_id: "public-verify-race.md",
      subjects: [{ subject_id: "person:erased", role: "about" }],
    });
    const surviving = storeEvent(db, { source_record_id: "public-verify-surviving.md" });
    const port = fts5(vaultPath);
    const outcome = await runPurge(db, vaultPath, { event_id: erased.event_id }, "race", { retrieval: port, now: () => AT });
    const verify = port.verifyAbsent.bind(port);
    port.verifyAbsent = async (ids) => {
      const proof = await verify(ids);
      db.query(
        `INSERT INTO identity_links
         (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run("person:erased", "person:residue", 1, JSON.stringify([`event:${surviving.event_id}`]), "candidate", "race", AT);
      return proof;
    };
    expect((await verifyPurge(db, vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: port, now: () => AT })).ok).toBe(false);
  });

  test("malformed selected subjects roll back before endpoint cleanup can be claimed", () => {
    const { db, vaultPath } = vault();
    const erased = storeEvent(db, {
      source_record_id: "bad-subjects.md",
      subjects: [{ subject_id: "person:erased", role: "about" }],
    });
    const surviving = storeEvent(db, { source_record_id: "bad-subjects-surviving.md" });
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.query("UPDATE events SET subjects=? WHERE event_id=?").run("{", erased.event_id);
    db.query(
      `INSERT INTO identity_links
       (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run("person:erased", "person:survives", 1, JSON.stringify([`event:${surviving.event_id}`]), "candidate", "legacy", AT);
    expect(() => purgeEvents(db, vaultPath, { event_id: erased.event_id }, "strict subjects", { now: () => AT }))
      .toThrow("purge subject snapshot is malformed or exceeds its bound");
    expect(db.query("SELECT 1 FROM events WHERE event_id=?").get(erased.event_id)).not.toBeNull();
    expect(db.query("SELECT 1 FROM identity_links WHERE subject_a='person:erased'").get()).not.toBeNull();
  });

  test("purge accepts all 65 valid raw subjects allowed by the event contract", () => {
    const { db, vaultPath } = vault();
    const subjects = Array.from({ length: 65 }, (_, index) => ({ subject_id: `person:subject-${index}`, role: "about" as const }));
    const event = storeEvent(db, { source_record_id: "many-subjects.md", subjects });
    expect(purgeEvents(db, vaultPath, { event_id: event.event_id }, "many valid subjects", { now: () => AT }).receipts)
      .toHaveLength(1);
  });

  test("malformed subject role or extra field rolls back endpoint erasure", () => {
    for (const subjects of [
      [{ subject_id: "person:erased", role: "unknown" }],
      [{ subject_id: "person:erased", role: "about", extra: "forbidden" }],
    ]) {
      const { db, vaultPath } = vault();
      const erased = storeEvent(db, { source_record_id: `invalid-subject-${JSON.stringify(subjects)}.md` });
      db.query("UPDATE events SET subjects=? WHERE event_id=?").run(JSON.stringify(subjects), erased.event_id);
      db.query(
        `INSERT INTO identity_links
         (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run("person:erased", "person:survives", 1, JSON.stringify([`event:${erased.event_id}`]), "candidate", "legacy", AT);
      expect(() => purgeEvents(db, vaultPath, { event_id: erased.event_id }, "strict role", { now: () => AT }))
        .toThrow("purge subject snapshot is malformed or exceeds its bound");
      expect(db.query("SELECT 1 FROM events WHERE event_id=?").get(erased.event_id)).not.toBeNull();
      expect(db.query("SELECT 1 FROM identity_links WHERE subject_a='person:erased'").get()).not.toBeNull();
    }
  });
});
