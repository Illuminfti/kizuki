import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER } from "../src/agents";
import { openLedger } from "../src/ledger/db";
import * as ledger from "../src/ledger/ledger";
import * as sourceGrants from "../src/ledger/source-grants";
import { CanonAccessPhase } from "../src/serving/canon-access";
import { eligible, loadCanon, pageDecision } from "../src/serving/canon";
import { visibleIndexDegraded } from "../src/serving/index-health";
import { ensureReadProofEpoch, proofStatementSafe, READ_PROOF_TABLES, readProofEpoch } from "../src/serving/read-proof-epoch";
import { serveSearch } from "../src/serving/search";
import type { ServeContext } from "../src/serving/types";
import { seedLivePages } from "./helpers/bulk-pages";
import { tempVault } from "./helpers/vault";
import { serveFixture, storeEvent } from "./serving/helpers";

function fixture(count = 3) {
  const vault = tempVault();
  const path = join(vault.path, ".kizuki", "reuse.sqlite");
  const db = openLedger(path);
  const seeded = seedLivePages(db, vault.path, count);
  const ctx: ServeContext = { db, vaultPath: vault.path, principal: OWNER, keepProofs: true };
  const index = loadCanon(ctx);
  return { db, path, seeded, ctx, index, dispose() { db.close(); vault.dispose(); } };
}

/** Every proof the health flag and the candidate filter need, for every page. */
function proveAll(phase: CanonAccessPhase, index: ReturnType<typeof loadCanon>) {
  return index.pages.filter(eligible).map(page => ({
    decision: phase.decision(page), visible: phase.visible(page), derivable: phase.projectable(page),
  }));
}

describe("the read-proof epoch", () => {
  test("every listed table that exists carries its three triggers, and each kind of write moves the epoch", () => {
    const f = fixture(1);
    try {
      const existing = READ_PROOF_TABLES.filter(table => f.db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table) !== null);
      expect(existing.length).toBeGreaterThan(15);
      for (const table of existing) {
        const names = f.db.query<{ name: string }, [string]>("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND name LIKE 'read_proof_epoch_%'").all(table).map(row => row.name).sort();
        expect(names).toEqual([`read_proof_epoch_${table}_delete`, `read_proof_epoch_${table}_insert`, `read_proof_epoch_${table}_update`]);
      }
      const epoch = () => readProofEpoch(f.db)!.epoch;
      const start = epoch();
      f.db.query("UPDATE canon_read_generation SET generation=generation WHERE singleton=1").run();
      expect(epoch()).toBe(start + 1);
      const peer = new Database(f.path);
      try { peer.query("UPDATE canon_read_generation SET generation=generation WHERE singleton=1").run(); } finally { peer.close(); }
      expect(epoch()).toBe(start + 2);
      f.db.exec("BEGIN; UPDATE canon_read_generation SET generation=generation WHERE singleton=1; ROLLBACK");
      expect(epoch()).toBe(start + 2);
      // A run log is not a proof input, so the served call's own audit row never moves it.
      f.db.exec("CREATE TABLE fixture_log(value TEXT); INSERT INTO fixture_log VALUES ('x')");
      expect(epoch()).toBe(start + 2);
      ensureReadProofEpoch(f.db);
      expect(epoch()).toBe(start + 2);
    } finally { f.dispose(); }
  });

  test("a table rebuilt under its name gets its triggers back on the next writable open", () => {
    const f = fixture(1);
    try {
      f.db.exec("ALTER TABLE canon_holds RENAME TO canon_holds_retired; CREATE TABLE canon_holds AS SELECT * FROM canon_holds_retired WHERE 0");
      expect(proofStatementSafe(f.db, "SELECT 1 FROM canon_holds", readProofEpoch(f.db)!.schema)).toBe(false);
      ensureReadProofEpoch(f.db);
      expect(proofStatementSafe(f.db, "SELECT 1 FROM canon_holds", readProofEpoch(f.db)!.schema)).toBe(true);
      expect(proofStatementSafe(f.db, "SELECT 1 FROM canon_holds_retired", readProofEpoch(f.db)!.schema)).toBe(false);
    } finally { f.dispose(); }
  });

  test("only reads of guarded tables, with nothing volatile, are vouched for", () => {
    const f = fixture(1);
    try {
      const schema = readProofEpoch(f.db)!.schema;
      const safe = (sql: string) => proofStatementSafe(f.db, sql, schema);
      expect(safe("SELECT * FROM events WHERE event_id=?")).toBe(true);
      expect(safe("SELECT 1 FROM claims c JOIN claim_v2_semantics m USING(claim_id) WHERE c.claim_id=?")).toBe(true);
      expect(safe("SELECT 1 FROM event_purges WHERE event_id IN (SELECT value FROM json_each(?))")).toBe(true);
      expect(safe("SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version")).toBe(true);
      expect(safe("SELECT * FROM agent_audit LIMIT 1")).toBe(false);
      expect(safe("SELECT 1 FROM events WHERE EXISTS (SELECT 1 FROM agent_audit)")).toBe(false);
      expect(safe("SELECT 1 FROM events WHERE occurred_at < datetime('now')")).toBe(false);
      expect(safe("SELECT random()")).toBe(false);
      expect(safe("INSERT INTO event_purges SELECT * FROM event_purges WHERE 0")).toBe(false);
      f.db.exec("CREATE VIEW fixture_events AS SELECT * FROM events");
      const after = readProofEpoch(f.db)!.schema;
      expect(proofStatementSafe(f.db, "SELECT * FROM fixture_events", after)).toBe(false);
      // A trigger that no longer bumps the epoch takes its table out of the guarded set.
      f.db.exec("DROP TRIGGER read_proof_epoch_events_update");
      f.db.exec("CREATE TRIGGER read_proof_epoch_events_update AFTER UPDATE ON events BEGIN SELECT 1; END");
      expect(proofStatementSafe(f.db, "SELECT * FROM events WHERE event_id=?", readProofEpoch(f.db)!.schema)).toBe(false);
    } finally { f.dispose(); }
  });
});

describe("owner page proofs kept between served reads", () => {
  test("a later owner phase on an unchanged ledger proves nothing again and agrees with a fresh proof", () => {
    const f = fixture(5);
    const read = spyOn(ledger, "readLiveEvent"), inspect = spyOn(sourceGrants, "inspectSourceGrant");
    try {
      const first = proveAll(new CanonAccessPhase(f.index, structuredClone(OWNER.grant)), f.index);
      const reads = read.mock.calls.length;
      expect(reads).toBeGreaterThan(0);
      const later = new CanonAccessPhase(f.index, structuredClone(OWNER.grant));
      expect(proveAll(later, f.index)).toEqual(first);
      expect(read.mock.calls.length).toBe(reads);
      expect(visibleIndexDegraded(f.index, OWNER.grant, "search", f.index.pages, later)).toBe(visibleIndexDegraded(f.index, OWNER.grant, "search"));
      for (const page of f.index.pages) expect(later.decision(page)).toEqual(pageDecision(f.index, OWNER.grant, page));
    } finally { inspect.mockRestore(); read.mockRestore(); f.dispose(); }
  });

  test("a page proof reads nothing but the page and the database: no file, clock or randomness", () => {
    const f = fixture(4);
    const spies = [
      ...(["readFileSync", "existsSync", "statSync", "lstatSync", "openSync", "readSync", "readdirSync", "fstatSync"] as const).map(name => spyOn(fs, name)),
      spyOn(Date, "now"), spyOn(Math, "random"), spyOn(performance, "now"), spyOn(crypto, "getRandomValues"),
    ];
    try {
      const proofs = proveAll(new CanonAccessPhase(f.index, structuredClone(OWNER.grant)), f.index);
      expect(proofs.every(proof => proof.decision.allow)).toBe(true);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); f.dispose(); }
  });

  test("a write to any proof input between two phases is proved again, from this or another connection", () => {
    const f = fixture(2), page = f.index.pages[0]!, source = f.seeded[0]!.sourceId;
    const peer = new Database(f.path);
    try {
      const grant = structuredClone(OWNER.grant);
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      const original = f.db.query<{ text: string }, [string]>("SELECT text FROM events WHERE event_id=?").get(source)!.text;
      peer.query("UPDATE events SET text=? WHERE event_id=?").run("changed by another connection", source);
      expect(new CanonAccessPhase(f.index, grant).decision(page)).toEqual(pageDecision(f.index, grant, page));
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(false);
      f.db.query("UPDATE events SET text=? WHERE event_id=?").run(original, source);
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      f.db.query("UPDATE canon_receipts SET after_hash=? WHERE page_path=?").run("0".repeat(64), page.relPath);
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(false);
    } finally { peer.close(); f.dispose(); }
  });

  test("a table whose trigger is gone is never vouched for, so a write to it is still seen", () => {
    const f = fixture(2), page = f.index.pages[0]!, source = f.seeded[0]!.sourceId;
    try {
      const grant = structuredClone(OWNER.grant);
      f.db.exec("DROP TRIGGER read_proof_epoch_events_update");
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      const epoch = readProofEpoch(f.db)!.epoch;
      f.db.query("UPDATE events SET text=? WHERE event_id=?").run("changed with no trigger", source);
      expect(readProofEpoch(f.db)!.epoch).toBe(epoch);
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(false);
    } finally { f.dispose(); }
  });

  test("a proof that reads a table without its triggers is not kept", () => {
    const f = fixture(2), page = f.index.pages[0]!;
    const read = spyOn(ledger, "readLiveEvent");
    try {
      const grant = structuredClone(OWNER.grant);
      f.db.exec("DROP TRIGGER read_proof_epoch_canon_holds_insert");
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      const reads = read.mock.calls.length;
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      expect(read.mock.calls.length).toBeGreaterThan(reads);
      ensureReadProofEpoch(f.db);
      new CanonAccessPhase(f.index, grant).decision(page);
      const kept = read.mock.calls.length;
      new CanonAccessPhase(f.index, grant).decision(page);
      expect(read.mock.calls.length).toBe(kept);
    } finally { read.mockRestore(); f.dispose(); }
  });

  test("an epoch table dropped and created again never matches proofs kept under the old one", () => {
    const f = fixture(2), page = f.index.pages[0]!;
    const read = spyOn(ledger, "readLiveEvent");
    try {
      const grant = structuredClone(OWNER.grant);
      new CanonAccessPhase(f.index, grant).decision(page);
      const token = readProofEpoch(f.db)!.token;
      f.db.exec("DROP TABLE read_proof_epoch");
      ensureReadProofEpoch(f.db);
      expect(readProofEpoch(f.db)!.token).not.toBe(token);
      const reads = read.mock.calls.length;
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      expect(read.mock.calls.length).toBeGreaterThan(reads);
    } finally { read.mockRestore(); f.dispose(); }
  });

  test("a page or grant changed inside a batch voids the batch: it runs again unbatched and keeps nothing", () => {
    const f = fixture(2), page = f.index.pages[0]!;
    try {
      const grant: typeof OWNER.grant = { ...structuredClone(OWNER.grant), ceiling: "personal" };
      const phase = new CanonAccessPhase(f.index, grant);
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      let runs = 0;
      const result = phase.batch(() => {
        runs += 1;
        phase.decision(page);
        page.data.sensitivity = "private";
        return phase.decision(page);
      });
      expect(runs).toBe(2);
      expect(result.allow).toBe(false);
      expect(result).toEqual(pageDecision(f.index, grant, page));
      page.data.sensitivity = "public";
      const changed = phase.batch(() => { const before = phase.decision(page); grant.ceiling = "public"; return [before, phase.decision(page)]; });
      expect(changed[1]).toEqual(pageDecision(f.index, grant, page));
    } finally { f.dispose(); }
  });

  test("other principals, one-shot hosts and reads inside a transaction keep and reuse nothing", () => {
    const f = fixture(2), page = f.index.pages[0]!;
    const read = spyOn(ledger, "readLiveEvent");
    try {
      const grant = structuredClone(OWNER.grant);
      f.ctx.principal = { kind: "agent", grant, grant_epoch: 0,
        agent: { agent_id: "fixture", name: "fixture", created_at: "2026-01-01T00:00:00Z", revoked_at: null } };
      new CanonAccessPhase(f.index, grant).decision(page);
      let reads = read.mock.calls.length;
      new CanonAccessPhase(f.index, grant).decision(page);
      expect(read.mock.calls.length).toBeGreaterThan(reads);
      f.ctx.principal = OWNER;
      // A one-shot host does not declare that it keeps proofs.
      delete f.ctx.keepProofs;
      new CanonAccessPhase(f.index, grant).decision(page);
      reads = read.mock.calls.length;
      new CanonAccessPhase(f.index, grant).decision(page);
      expect(read.mock.calls.length).toBeGreaterThan(reads);
      f.ctx.keepProofs = true;
      f.db.exec("BEGIN");
      try {
        new CanonAccessPhase(f.index, grant).decision(page);
        reads = read.mock.calls.length;
        new CanonAccessPhase(f.index, grant).decision(page);
        expect(read.mock.calls.length).toBeGreaterThan(reads);
      } finally { f.db.exec("ROLLBACK"); }
    } finally { read.mockRestore(); f.dispose(); }
  });
});

describe("two served owner searches with a write between them", () => {
  async function served(ctx: ServeContext): Promise<string> {
    const envelope = await serveSearch(ctx, { query: "kettle" });
    return JSON.stringify({ canon: envelope.canon, quoted: envelope.quoted, denied: envelope.denied, has_withheld: envelope.has_withheld, source_policy: envelope.source_policy, redacted: envelope.redacted, data: envelope.data });
  }
  /** The same search on a new connection, which has no kept proofs. */
  async function fresh(fixture: Awaited<ReturnType<typeof serveFixture>>): Promise<string> {
    const db = new Database(join(fixture.vaultPath, ".kizuki", "kizuki.db"));
    try { return await served({ db, vaultPath: fixture.vaultPath, principal: OWNER }); } finally { db.close(); }
  }

  test("an unchanged ledger serves the same bytes and proves fewer pages the second time", async () => {
    const fixture = await serveFixture();
    const read = spyOn(ledger, "readLiveEvent");
    try {
      const first = await served({ ...fixture.owner(), keepProofs: true });
      const firstReads = read.mock.calls.length;
      read.mockClear();
      expect(await served({ ...fixture.owner(), keepProofs: true })).toBe(first);
      expect(read.mock.calls.length).toBeLessThan(firstReads);
    } finally { read.mockRestore(); fixture.dispose(); }
  }, 60_000);

  test("a capture that retracts a page's source is seen by the next search", async () => {
    const fixture = await serveFixture();
    try {
      expect(await served({ ...fixture.owner(), keepProofs: true })).toContain("Ada keeps the kettle warm.");
      storeEvent(fixture.db, "rec-public", "2026-02-28T10:00:00Z", "the public kettle is on", "person:ada", "public", true);
      const after = await served({ ...fixture.owner(), keepProofs: true });
      expect(after).not.toContain("Ada keeps the kettle warm.");
      expect(after).toBe(await fresh(fixture));
    } finally { fixture.dispose(); }
  }, 60_000);

  test("an event rewritten by another connection is seen by the next search", async () => {
    const fixture = await serveFixture();
    const peer = new Database(join(fixture.vaultPath, ".kizuki", "kizuki.db"));
    try {
      expect(await served({ ...fixture.owner(), keepProofs: true })).toContain("Ada keeps the kettle warm.");
      peer.query("UPDATE events SET text=? WHERE event_id=?").run("rewritten outside this process", fixture.events["public"]!);
      const after = await served({ ...fixture.owner(), keepProofs: true });
      expect(after).not.toContain("Ada keeps the kettle warm.");
      expect(after).toBe(await fresh(fixture));
    } finally { peer.close(); fixture.dispose(); }
  }, 60_000);

  test("a page whose receipt is repaired between two searches is ranked and served again", async () => {
    const fixture = await serveFixture();
    const path = "entities/person-grace.md";
    try {
      const recorded = fixture.db.query<{ after_hash: string }, [string]>("SELECT after_hash FROM canon_receipts WHERE page_path=? ORDER BY at DESC, receipt_id DESC LIMIT 1").get(path)!.after_hash;
      fixture.db.query("UPDATE canon_receipts SET after_hash=? WHERE page_path=?").run("0".repeat(64), path);
      expect(await served({ ...fixture.owner(), keepProofs: true })).not.toContain("Grace reviews the kettle log.");
      fixture.db.query("UPDATE canon_receipts SET after_hash=? WHERE page_path=?").run(recorded, path);
      const after = await served({ ...fixture.owner(), keepProofs: true });
      expect(after).toContain("Grace reviews the kettle log.");
      expect(after).toBe(await fresh(fixture));
    } finally { fixture.dispose(); }
  }, 60_000);

  test("index health follows a projection row removed between two searches", async () => {
    const fixture = await serveFixture();
    try {
      expect(await served({ ...fixture.owner(), keepProofs: true })).toBe(await fresh(fixture));
      fixture.db.query("DELETE FROM search_documents WHERE scope='canon' AND doc_id=?").run("page:person:grace");
      const after = await served({ ...fixture.owner(), keepProofs: true });
      expect(after).toContain("index-degraded");
      expect(after).toBe(await fresh(fixture));
    } finally { fixture.dispose(); }
  }, 60_000);
});

/**
 * One test per component of the reuse key. Each sets up two reads whose only
 * difference is that component, so the second read is wrong if it is dropped.
 */
describe("every component of the reuse key is load-bearing", () => {
  const owner = () => structuredClone(OWNER.grant);
  function rewriteSource(f: ReturnType<typeof fixture>, text: string) {
    const source = f.seeded[0]!.sourceId;
    const original = f.db.query<{ text: string }, [string]>("SELECT text FROM events WHERE event_id=?").get(source)!.text;
    f.db.query("UPDATE events SET text=? WHERE event_id=?").run(text, source);
    return original;
  }

  test("epoch: a write moves it and the next read proves again", () => {
    const f = fixture(2), page = f.index.pages[0]!, grant = owner();
    try {
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      rewriteSource(f, "rewritten source text");
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(false);
    } finally { f.dispose(); }
  });

  test("token: a counter row replaced with an equal epoch but another token is not trusted", () => {
    const f = fixture(2), page = f.index.pages[0]!, grant = owner();
    try {
      const before = readProofEpoch(f.db)!;
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      rewriteSource(f, "rewritten source text");
      // A counter row carried over from another ledger state: same number, other token.
      f.db.query("UPDATE read_proof_epoch SET epoch=?, token=? WHERE id=1").run(before.epoch, "f".repeat(32));
      expect(readProofEpoch(f.db)!.epoch).toBe(before.epoch);
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(false);
    } finally { f.dispose(); }
  });

  test("schema version: an equal counter and token under a changed schema are not trusted", () => {
    const f = fixture(2), page = f.index.pages[0]!, grant = owner();
    try {
      const before = readProofEpoch(f.db)!;
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      rewriteSource(f, "rewritten source text");
      f.db.exec("CREATE TABLE fixture_schema_change(value TEXT)");
      f.db.query("UPDATE read_proof_epoch SET epoch=? WHERE id=1").run(before.epoch);
      const after = readProofEpoch(f.db)!;
      expect([after.token, after.epoch]).toEqual([before.token, before.epoch]);
      expect(after.schema).not.toBe(before.schema);
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(false);
    } finally { f.dispose(); }
  });

  test("reader grant: a narrower ceiling is never served the wider reader's proof", () => {
    const f = fixture(2), page = f.index.pages[0]!;
    try {
      expect(new CanonAccessPhase(f.index, owner()).decision(page).allow).toBe(true);
      const narrow = { ...owner(), ceiling: "public" as const };
      expect(new CanonAccessPhase(f.index, narrow).decision(page)).toEqual(pageDecision(f.index, narrow, page));
      expect(new CanonAccessPhase(f.index, narrow).decision(page).allow).toBe(false);
    } finally { f.dispose(); }
  });

  test("page bytes: a page edited by hand on disk is never served from a kept proof", () => {
    const f = fixture(2), grant = owner();
    try {
      const page = f.index.pages[0]!;
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(true);
      const path = join(f.ctx.vaultPath, page.relPath);
      writeFileSync(path, readFileSync(path, "utf8") + "\nAn unrecorded edit made by hand.\n");
      const edited = loadCanon(f.ctx), changed = edited.byPath.get(page.relPath)!;
      expect(changed.contentHash).not.toBe(page.contentHash);
      expect(changed.data).toEqual(page.data);
      expect(new CanonAccessPhase(edited, grant).decision(changed)).toEqual(pageDecision(edited, grant, changed));
      expect(new CanonAccessPhase(edited, grant).decision(changed).allow).toBe(false);
    } finally { f.dispose(); }
  });

  test("canon read generation: an index loaded before a canon write is not served the newer index's proof", () => {
    const f = fixture(2), grant = owner();
    try {
      const stale = f.index;
      f.db.query("UPDATE canon_read_generation SET generation=generation+1 WHERE singleton=1").run();
      const current = loadCanon(f.ctx);
      const page = current.byPath.get(stale.pages[0]!.relPath)!;
      expect(new CanonAccessPhase(current, grant).decision(page).allow).toBe(true);
      const old = stale.byPath.get(page.relPath)!;
      expect(new CanonAccessPhase(stale, grant).decision(old)).toEqual(pageDecision(stale, grant, old));
      expect(new CanonAccessPhase(stale, grant).decision(old).allow).toBe(false);
    } finally { f.dispose(); }
  });

  test("hold flag: an index that holds a page is not served the proof of one that does not", () => {
    const f = fixture(2), grant = owner();
    try {
      const path = f.index.pages[0]!.relPath;
      f.db.query("INSERT INTO canon_holds(page_path, proposal_id, reason, held_at) VALUES (?,?,?,?)").run(path, "fixture", "fixture", "2026-01-01T00:00:00Z");
      const held = loadCanon(f.ctx);
      expect(held.holds.has(path)).toBe(true);
      f.db.query("DELETE FROM canon_holds WHERE page_path=?").run(path);
      const free = loadCanon(f.ctx);
      expect(new CanonAccessPhase(free, grant).decision(free.byPath.get(path)!).allow).toBe(true);
      const page = held.byPath.get(path)!;
      expect(new CanonAccessPhase(held, grant).decision(page)).toEqual(pageDecision(held, grant, page));
      expect(new CanonAccessPhase(held, grant).decision(page).allow).toBe(false);
    } finally { f.dispose(); }
  });

  test("stamp: a proof that another connection's commit overlapped is not kept", () => {
    const f = fixture(2), page = f.index.pages[0]!, grant = owner();
    const peer = new Database(f.path);
    const real = ledger.readLiveEvent;
    let wrote = false;
    const read = spyOn(ledger, "readLiveEvent").mockImplementation((db, id) => {
      const event = real(db, id);
      // The proof has read the valid row; the source changes before it finishes.
      if (!wrote) { wrote = true; peer.query("UPDATE events SET text=? WHERE event_id=?").run("changed mid-proof", f.seeded[0]!.sourceId); }
      return event;
    });
    try {
      new CanonAccessPhase(f.index, grant).decision(page);
      read.mockRestore();
      expect(new CanonAccessPhase(f.index, grant).decision(page)).toEqual(pageDecision(f.index, grant, page));
      expect(new CanonAccessPhase(f.index, grant).decision(page).allow).toBe(false);
    } finally { read.mockRestore(); peer.close(); f.dispose(); }
  });
});
