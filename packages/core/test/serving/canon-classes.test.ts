import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { withCanonMutationSync } from "../../src/canon/io";
import { rewriteCanon } from "../../src/serving/rewrite";
import { undoReceipt } from "../../src/canon/undo";
import { recoverCanonWrites } from "../../src/canon/recovery";
import { getClaim, insertClaim } from "../../src/claims/store";
import { rebuildDerived } from "../../src/derived";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { classesOfEvents } from "../../src/ledger/event-classes";
import { searchAuditCandidates } from "../../src/search/query";
import { serveCorrect } from "../../src/serving/correct";
import { serveGetPage } from "../../src/serving/page";
import { serveSearch } from "../../src/serving/search";
import { claimInput, eventFacts } from "../claims/helpers";
import { write } from "../canon/helpers";
import { recordedPage, serveFixture, storeEvent, type Fixture } from "./helpers";

const fixtures: Fixture[] = [];
const copies: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  for (const path of copies.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function setup() {
  const fixture = await serveFixture();
  fixtures.push(fixture);
  fixture.tokens["open"] = addAgent(fixture.db, "open", { ...OWNER_AGENT_GRANT, deny_classes: [] }).token;
  return fixture;
}

const CREDENTIAL_PROSE = "The synthetic password = synthetic-canary-482 is recorded here.";

describe("produced canon classes", () => {
  test("recovery stamps the committed after image and undo of creation removes its stamp", async () => {
    const f = await setup();
    const filed = await insertClaim({ db: f.db }, claimInput(f.events["public"]!, {
      target: "facts/recovered-secret", body: CREDENTIAL_PROSE,
      frontmatter: { type: "fact", title: "Recovered note" },
    }));
    if (filed.outcome !== "stored") throw new Error("fixture claim");
    const io = { db: f.db, vault_path: f.vaultPath };
    f.db.exec("CREATE TRIGGER class_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic row failure'); END");
    expect(() => write(io, filed.claim)).toThrow("synthetic row failure");
    f.db.exec("DROP TRIGGER class_receipt_failure");
    const recovered = recoverCanonWrites(io);
    expect(recovered.pending).toBe(false);
    expect(recovered.completed).toHaveLength(1);
    const path = "facts/recovered-secret.md";
    expect(serveGetPage(f.agent("reader-private"), { path }).canon).toEqual([]);
    const page = serveGetPage(f.owner(), { path }).canon[0];
    expect(page?.excerpt).toContain(CREDENTIAL_PROSE);
    expect(f.db.query("SELECT credential FROM canon_page_classes WHERE page_id=?").get(page!.page_id)).toEqual({ credential: 1 });
    await undoReceipt(io, recovered.completed[0]!);
    expect(f.db.query("SELECT 1 FROM canon_page_classes WHERE page_id=?").get(page!.page_id)).toBeNull();
  });

  test("clean provenance cannot make credential prose readable; rewrite, undo, rebuild and restore preserve denial", async () => {
    const f = await setup();
    const source = f.events["public"]!;
    expect(classesOfEvents(f.db, [source])).toEqual([]);
    const path = "facts/produced-secret.md";
    const data = { id: "fact:produced-secret", type: "fact", title: "Produced kettle", status: "active", sensitivity: "public", taint: "clean", sources: [source] };
    const protectedRead = async () => {
      expect(serveGetPage(f.agent("reader-private"), { path }).canon).toEqual([]);
      expect(serveGetPage(f.owner(), { path }).canon[0]?.excerpt).toContain(CREDENTIAL_PROSE);
      const allowed = serveGetPage(f.agent("open"), { path }).canon;
      expect(allowed).toHaveLength(1);
      expect(allowed[0]?.excerpt).toContain("[redacted:secret_assignment]");
      const search = await serveSearch(f.agent("reader-private"), { query: "synthetic", scope: "canon" });
      expect(search.canon.map(page => page.path)).not.toContain(path);
    };
    await recordedPage(f.db, f.vaultPath, path, data, CREDENTIAL_PROSE);
    expect(f.db.query("SELECT credential FROM canon_page_classes WHERE page_id=?").get(data.id)).toEqual({ credential: 1 });
    expect(searchAuditCandidates(f.db, "synthetic", {
      scope: "canon", source: { owner: false, deny_classes: ["credential"] }, limit: 1,
    }).candidates).toEqual([]);
    await protectedRead();
    const edited = await recordedPage(f.db, f.vaultPath, path, data, "The clean kettle note.");
    expect(f.db.query("SELECT credential FROM canon_page_classes WHERE page_id=?").get(data.id)).toEqual({ credential: 0 });
    expect(serveGetPage(f.agent("reader-private"), { path }).canon).toHaveLength(1);
    await undoReceipt({ db: f.db, vault_path: f.vaultPath }, edited.receipt.receipt_id);
    await protectedRead();
    expect(f.db.query("SELECT credential FROM canon_page_classes WHERE page_id=?").get(data.id)).toEqual({ credential: 1 });
    f.db.query("UPDATE canon_page_classes SET content_hash=?, credential=0 WHERE page_id=?").run("0".repeat(64), data.id);
    await protectedRead();
    f.db.exec("DROP TABLE canon_page_classes");
    await protectedRead();
    rebuildDerived(f.db, f.vaultPath);
    await protectedRead();
    expect(f.db.query("SELECT credential FROM canon_page_classes WHERE page_id=?").get(data.id)).toEqual({ credential: 1 });
    const backup = `${f.vaultPath}-backup`, restored = `${f.vaultPath}-restored`;
    copies.push(backup, restored);
    await exportVault(f.db, f.vaultPath, backup);
    restoreVault(backup, restored);
    const db = openLedger(join(restored, ".kizuki", "kizuki.db"));
    try {
      const enrolled = addAgent(db, "restored-reader", { ...OWNER_AGENT_GRANT });
      const principal = authenticate(db, enrolled.token);
      if (principal === null) throw new Error("fixture restored principal");
      const ctx = { db, vaultPath: restored, principal };
      expect(serveGetPage(ctx, { path }).canon).toEqual([]);
      expect(serveGetPage({ ...f.owner(), db, vaultPath: restored }, { path }).canon).toHaveLength(1);
    } finally { db.close(); }
  });
});

describe("correction page snapshots", () => {
  test("a readable before image does not authorize newly protected output", async () => {
    const f = await setup();
    const source = f.events["public"]!;
    const filed = await insertClaim({ db: f.db }, claimInput(source, {
      frontmatter: { type: "person", title: "Grace" },
    }));
    if (filed.outcome !== "stored") throw new Error("fixture claim");
    const receipt = write({ db: f.db, vault_path: f.vaultPath }, filed.claim);
    const ctx = f.agent("reader-private");
    expect(serveGetPage(ctx, { path: receipt.page_path }).canon).toHaveLength(1);
    // The writer can produce credential prose from clean evidence. A reader's
    // permission to the old page does not authorize these new produced bytes.
    const incoming = await insertClaim({ db: f.db }, claimInput(source, {
      body: CREDENTIAL_PROSE, object: "studio", confidence: 1,
      frontmatter: { type: "person", title: "Grace" },
    }));
    const claim = incoming.outcome === "contested" ? incoming.incoming : incoming.outcome === "stored" ? incoming.claim : null;
    if (claim === null || filed.claim.claim_key === null) throw new Error("fixture replacement");
    const corrected = withCanonMutationSync({ db: f.db, vault_path: f.vaultPath }, (scope, io) =>
      rewriteCanon(scope, io, ctx, claim, [filed.claim.claim_key!]));
    expect(corrected.failed).toBe(false);
    expect(corrected.rewritten).toEqual([]);
    expect(corrected.receipt_id).toBeNull();
    expect(JSON.stringify(corrected)).not.toContain(receipt.page_path);
    expect(serveGetPage(f.owner(), { path: receipt.page_path }).canon[0]?.excerpt).toContain(CREDENTIAL_PROSE);
  });

  test("a mixed page returns diffs and page metadata only to the owner or an opted-in agent", async () => {
    for (const inherited of [false, true]) {
      for (const name of ["reader-private", "open", "owner"] as const) {
        const f = await setup();
        const source = f.events["public"]!;
        const hiddenSource = inherited ? storeEvent(f.db, "credential-source", "2026-02-28T15:00:00Z", CREDENTIAL_PROSE, "person:tern", "public") : source;
        const subject = "person:tern";
        // Both claims share a key but remain live at equal authority/confidence.
        const hiddenResult = await insertClaim({ db: f.db }, claimInput(hiddenSource, {
          subject, subjects: [subject], body: CREDENTIAL_PROSE, object: "depot",
          frontmatter: { type: "person", title: "Tern" }, events: [eventFacts(hiddenSource)],
        }));
        if (hiddenResult.outcome !== "stored") throw new Error("fixture hidden claim");
        const hidden = hiddenResult.claim;
        write({ db: f.db, vault_path: f.vaultPath }, hidden);
        const visibleResult = await insertClaim({ db: f.db }, claimInput(source, {
          subject, subjects: [subject], body: "Tern works at the workshop.", object: "workshop",
          frontmatter: { type: "person", title: "Tern" }, events: [eventFacts(source)],
        }));
        const visible = visibleResult.outcome === "contested" ? visibleResult.incoming : visibleResult.outcome === "stored" ? visibleResult.claim : null;
        if (visible === null) throw new Error("fixture visible claim");
        const receipt = write({ db: f.db, vault_path: f.vaultPath }, visible);
        const ctx = name === "owner" ? f.owner() : f.agent(name);
        const result = await serveCorrect(ctx, { statement: "Tern works at the studio.", target: { claim_id: visible.claim_id } });
        if (name === "reader-private") {
          if (inherited) expect(getClaim(f.db, hidden.claim_id)?.status).toBe("live");
          expect(result.data?.rewritten).toEqual([]);
          expect(result.data?.receipt_id).toBeNull();
          const bytes = JSON.stringify(result);
          for (const value of [CREDENTIAL_PROSE, receipt.page_path, receipt.after_hash]) expect(bytes).not.toContain(value);
        } else {
          expect(result.data?.rewritten).toHaveLength(1);
          expect(result.data?.rewritten[0]?.diff).toContain(name === "owner" ? CREDENTIAL_PROSE : "[redacted:secret_assignment]");
        }
        expect(getClaim(f.db, visible.claim_id)?.status).toBe("superseded");
      }
    }
  });
});
