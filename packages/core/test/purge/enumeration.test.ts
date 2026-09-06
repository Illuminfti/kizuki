import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hashBody } from "../../src/claims/hash";
import { getClaim, markClaimsAfterPurge } from "../../src/claims/store";
import type { ClaimStatus } from "../../src/contracts/proposal";
import type { RetrievalDoc } from "../../src/contracts/retrieval";
import { rebuildDerived } from "../../src/derived";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import {
  createVaultFts5Port, isHeld, purgeEvents, resumePurge, runPurge, verifyPurge,
} from "../../src/ledger/purge";
import { validEvent } from "../fixtures";
import { recordedPage } from "../helpers/recorded-page";
import { write } from "../canon/helpers";
import { insertClaim } from "../../src/claims/store";
import { tempVault } from "../helpers/vault";

const AT = "2026-09-06T12:00:00.000Z";
const RECORDED_AT = new Date(Date.parse(AT) - 2_000).toISOString();
const MERGED_AT = new Date(Date.parse(AT) - 1_000).toISOString();
const disposers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function fixture() {
  const disk = tempVault("kizuki-purge-enumeration-");
  const db = openLedger(":memory:");
  disposers.push(disk.dispose, () => db.close());
  const event = (name: string) => {
    const result = accept(db, { ...validEvent(), source_record_id: name, text: name });
    if (result.status !== "stored") throw new Error("fixture event not stored");
    return result.event;
  };
  return { db, vaultPath: disk.path, erased: event("retired Atlas note"), kept: event("current Atlas note") };
}

/** Ordinary archived claim rows, with unique bodies, avoid model/dedup work. */
function seedClaims(
  db: ReturnType<typeof openLedger>, prefix: string, count: number,
  provenance: string[], status: ClaimStatus = "live",
): string[] {
  const ids: string[] = [];
  const insert = db.query(
    `INSERT INTO claims
       (claim_id, kind, body, frontmatter, provenance, subjects, producer,
        confidence, status, created_at, body_hash, sensitivity, taint,
        valid_from, asserted_at)
     VALUES (?, 'claim', ?, '{}', ?, '[]', 'deterministic',
             0.8, ?, ?, ?, 'personal', 'quoted', ?, ?)`,
  );
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = `${prefix}-${String(index).padStart(5, "0")}`;
      const body = `Atlas fixture ${id}.`;
      insert.run(id, body, JSON.stringify(provenance), status, AT, hashBody(body), AT, AT);
      ids.push(id);
    }
  })();
  return ids;
}

function retrieval(vaultPath: string) {
  const port = createVaultFts5Port(vaultPath, () => AT);
  disposers.push(() => port.close());
  return port;
}

function doc(id: string, provenance: string[]): RetrievalDoc {
  return {
    doc_id: id, kind: id.startsWith("claim:") ? "claim" : "page",
    title: "Atlas", text: "Ordinary Atlas fixture", sensitivity: "personal",
    taint: "quoted", authority: "connector_evidence", subjects: [], provenance,
    occurred_at: AT, updated_at: AT,
  };
}

function projections(db: ReturnType<typeof openLedger>) {
  return {
    search: db.query("SELECT * FROM search_documents ORDER BY doc_id").all(),
    fts: db.query("SELECT * FROM search_docs ORDER BY doc_id").all(),
    graph: db.query("SELECT * FROM graph_edges ORDER BY src, dst, kind").all(),
  };
}

describe("purge exhaustive enumeration", () => {
  test("finishes every claim batch while statuses change and preserves unrelated claims", () => {
    const { db, vaultPath, erased, kept } = fixture();
    const full = seedClaims(db, "a-full", 550, [erased.event_id]);
    const mixed = seedClaims(db, "b-mixed", 550, [erased.event_id, kept.event_id]);
    const priorReduced = seedClaims(db, "c-reduced", 550, [erased.event_id], "provenance_reduced");
    const stillReduced = seedClaims(db, "d-reduced-mixed", 550, [erased.event_id, kept.event_id], "provenance_reduced");
    const unrelated = seedClaims(db, "e-unrelated", 550, [kept.event_id]);

    const outcome = purgeEvents(db, vaultPath, { event_id: erased.event_id }, "retire fixture", { now: () => AT });
    expect(outcome.receipts).toHaveLength(1);
    const idsWithStatus = (status: ClaimStatus) => db.query<{ claim_id: string }, [ClaimStatus]>(
      "SELECT claim_id FROM claims WHERE status = ? ORDER BY claim_id",
    ).all(status).map(row => row.claim_id);
    expect(idsWithStatus("purged")).toEqual([...full, ...priorReduced]);
    expect(idsWithStatus("provenance_reduced")).toEqual([...mixed, ...stillReduced]);
    expect(idsWithStatus("live")).toEqual(unrelated);
    expect(db.query<{ n: number }, []>(
      "SELECT count(*) AS n FROM claims WHERE status = 'purged' AND retracted_at IS NOT NULL",
    ).get()?.n).toBe(full.length + priorReduced.length);
    expect(markClaimsAfterPurge(db, AT)).toEqual({ purged: [], reduced: [] });
  });

  test("records and verifies late matching claims across every historical status", async () => {
    const { db, vaultPath, erased, kept } = fixture();
    seedClaims(db, "a-unrelated", 10_050, [kept.event_id]);
    const affected = (["live", "provenance_reduced", "purged", "superseded", "reverted", "skipped"] as const)
      .flatMap(status => seedClaims(db, `z-${status}`, status === "live" ? 10_025 : 2, [erased.event_id], status));
    const ids = affected.map(id => `claim:${id}`);
    const port = retrieval(vaultPath);
    // The closure also includes documents not yet indexed. Keep real rows at
    // both ends and in every historical status; verify all enumerated IDs.
    const indexed = [ids[0]!, ...ids.slice(-12)];
    await port.upsert([
      ...indexed.map(id => doc(id, [erased.event_id])),
      doc("claim:a-unrelated-00000", [kept.event_id]),
    ]);
    const outcome = await runPurge(db, vaultPath, { event_id: erased.event_id }, "retire late fixtures", {
      retrieval: port, now: () => AT,
    });
    const op = outcome.purge_ops[0]!;
    expect(new Set(op.ids)).toEqual(new Set([`event:${erased.event_id}`, ...ids]));
    expect(op.state).toBe("done");
    expect(op.proof?.checked).toBe(ids.length + 1);
    expect(op.proof?.found).toEqual([]);
    expect((await port.verifyAbsent(ids)).found).toEqual([]);
    expect((await port.verifyAbsent(["claim:a-unrelated-00000"])).found).toEqual(["claim:a-unrelated-00000"]);
    expect(getClaim(db, "z-live-00001")?.status).toBe("purged");
    expect(getClaim(db, "z-provenance_reduced-00001")?.status).toBe("purged");
    const report = await verifyPurge(db, vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: port, now: () => AT });
    expect(report.ok).toBe(true);
    expect(report.proofs[0]?.checked).toBe(ids.length + 1);
  });

  test("removes provenance projections in phase one and matches a fresh rebuild after rewriting", async () => {
    const { db, vaultPath, erased, kept } = fixture();
    const retiredBody = "Atlas fixture atlas-retired.";
    const page = (id: string, title: string, sources: string[], body: string) => recordedPage(
      db, vaultPath, `facts/${id}.md`, {
        id, title, type: "fact", status: "active", sensitivity: "personal", taint: "quoted",
        subjects: ["person:ada"],
      }, body, sources, { now: () => RECORDED_AT },
    );
    const retired = await page("atlas", "Atlas", [erased.event_id], retiredBody);
    const claimId = retired.claim.claim_id;
    const current = await insertClaim({ db, now: () => MERGED_AT }, {
      provenance: [kept.event_id], sensitivity: "personal", confidence: 0.8,
      kind: "merge", target: "facts/atlas", body: "Current Atlas notes.",
      subjects: [], subject: null, predicate: null, object: null, frontmatter: {},
      producer: "model", model_ref: "fixture:synthetic", taint: "quoted",
    });
    if (current.outcome !== "stored") throw new Error("current fixture claim was not stored");
    write({ db, vault_path: vaultPath, now: () => MERGED_AT }, current.claim);
    await page("reference", "Reference", [kept.event_id], "See [[Atlas]].");
    await page("retired-copy", "Retired copy", [erased.event_id], "Previous Atlas projection.");
    rebuildDerived(db, vaultPath);
    // A normal removed page can leave its old projection awaiting maintenance.
    rmSync(join(vaultPath, "facts/retired-copy.md"));
    const port = retrieval(vaultPath);
    await port.upsert([
      doc("page:atlas", [erased.event_id, kept.event_id]),
      doc("page:retired-copy", [`event:${erased.event_id}`]),
      doc("page:reference", [kept.event_id]),
      doc(`claim:${claimId}`, [erased.event_id]),
    ]);
    const outcome = purgeEvents(db, vaultPath, { event_id: erased.event_id }, "retire Atlas fixture", {
      retrieval_store: port.descriptor.id, now: () => AT,
    });
    expect(isHeld(db, "facts/atlas.md")).toBe(true);
    expect(outcome.purge_ops[0]?.ids).toContain("page:retired-copy");
    for (const table of ["search_documents", "search_docs", "graph_edges"]) {
      expect(db.query(
        `SELECT 1 FROM ${table}, json_each(${table}.provenance) AS p
          WHERE p.value IN (?, ?)`,
      ).all(erased.event_id, `event:${erased.event_id}`)).toEqual([]);
    }
    expect(db.query("SELECT 1 FROM search_documents WHERE doc_id='page:reference'").get()).not.toBeNull();
    const report = await resumePurge(db, vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: port, now: () => AT });
    expect(report.ok).toBe(true);
    expect(report.pages_rewritten).toBe(1);
    expect(isHeld(db, "facts/atlas.md")).toBe(false);
    const rewritten = readFileSync(join(vaultPath, "facts/atlas.md"), "utf8");
    expect(rewritten).not.toContain(retiredBody);
    expect(rewritten).toContain("Current Atlas notes.");
    expect((await port.verifyAbsent(["page:retired-copy", `claim:${claimId}`])).found).toEqual([]);
    expect((await port.verifyAbsent(["page:reference"])).found).toEqual(["page:reference"]);
    const incremental = projections(db);
    rebuildDerived(db, vaultPath);
    expect(projections(db)).toEqual(incremental);
  });
});
