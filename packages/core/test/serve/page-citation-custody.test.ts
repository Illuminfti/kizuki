import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureEventInput } from "../../src/contracts/event";
import type { ProducerPort } from "../../src/contracts/producer";
import { OWNER, registerConnection, resumeSourceRevocation, revokeSourceGrant, serveGetPage, setSourceGrant } from "../../src/index";
import { runBatch } from "../../src/ingest/run";
import { openLedger } from "../../src/ledger/db";
import { runRail } from "../../src/serve/rails";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { initVault } from "../../src/vault/init";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";

/**
 * Pages whose claims carry more evidence than a page can cite must still be
 * reachable by every source's revocation, erasure and deletion.
 */

setDefaultTimeout(300_000);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const producer: ProducerPort = {
  descriptor: { id: "kizuki.producer.custody-test", kind: "producer", contract: "kizuki.producer/v1",
    contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
  health: async () => ({ status: "ready", detail: {} }),
  close: async () => undefined,
  produce: async () => ({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }),
};
const policy = {
  purposes: ["capture", "recall", "session", "derive", "extract", "export"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "personal",
};
const PAGE = "auto/fixture/person/ada.md";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-citation-custody-"));
  roots.push(root);
  const path = join(root, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  const a = ulid(), b = ulid();
  for (const [source, op] of [[a, "grant-a"], [b, "grant-b"]] as const) {
    registerConnection(db, "fixture", source);
    setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: op, policy });
  }
  const ingest = (events: CaptureEventInput[], source: string) => {
    const result = runBatch(db, { events, cursor: null, has_more: false }, { page_candidates: false },
      { source_key: source, expected_revision: 1 }, { vault_path: path });
    expect(result.errors).toEqual([]);
  };
  const pass = () => runRail(db, path, "sync", { hooks: { producer, claims: { db }, model_ref: "kizuki.llm.synthetic:custody-test" } });
  const page = () => parseFrontmatter(readFileSync(join(path, PAGE), "utf8")).data;
  const served = () => serveGetPage({ db, vaultPath: path, principal: OWNER }, { path: PAGE }).canon.length;
  const eventOf = (record: string) =>
    db.query<{ event_id: string }, [string]>("SELECT event_id FROM events WHERE source_record_id=? AND deleted=0 ORDER BY accepted_at DESC, event_id DESC").get(record)!.event_id;
  return { db, path, a, b, ingest, pass, page, served, eventOf };
}

const message = (index: number, tag: string): CaptureEventInput => ({
  ...validEvent(), source_record_id: `${tag}-${index}`, text: `Synthetic ${tag} message ${index}.`,
});

for (const fromA of [99, 100]) {
  test(`a page cites every source its claim rests on, so revoking and erasing one withholds it (${fromA} + 1 events)`, async () => {
    const f = fixture();
    try {
      f.ingest(Array.from({ length: fromA }, (_, index) => message(index, "a")), f.a);
      f.ingest([message(0, "b")], f.b);
      expect((await f.pass()).errors).toEqual([]);
      const sources = f.page()["sources"] as string[];
      expect(sources.length).toBeLessThanOrEqual(100);
      expect(sources).toContain(f.eventOf("b-0"));
      expect(f.served()).toBe(1);

      revokeSourceGrant(f.db, { source_key: f.b, expected_revision: 1, operation_id: "revoke-b" });
      expect(f.served()).toBe(0);
      const done = await resumeSourceRevocation(f.db, f.path, "revoke-b",
        { ownedRetrieval: { stores: async () => ({ stores: [], absent_store_ids: [] }) } });
      expect(done.status).toBe("purged");
      expect(existsSync(join(f.path, PAGE)) && f.page()["status"] === "active").toBe(false);
      expect(f.served()).toBe(0);
    } finally { f.db.close(); }
  });
}

for (const count of [50, 120]) {
  test(`deleting a cited record archives the page and the citation repair leaves it archived (${count} events)`, async () => {
    const f = fixture();
    try {
      f.ingest(Array.from({ length: count }, (_, index) => message(index, "a")), f.a);
      expect((await f.pass()).errors).toEqual([]);
      const victim = f.eventOf("a-5");
      expect(f.page()["sources"]).toContain(victim);

      f.ingest([{ ...message(5, "a"), deleted: true, text: "Synthetic deletion." }], f.a);
      const first = await f.pass();
      expect(first.errors).toEqual([]);
      expect(f.page()["status"]).toBe("archived");
      expect(f.served()).toBe(0);
      const second = await f.pass();
      expect(second.errors).toEqual([]);
      expect(second.canon_writes).toBe(0);
      expect(f.page()["status"]).toBe("archived");
      expect(f.served()).toBe(0);
      expect(f.db.query("SELECT 1 FROM claims WHERE kind='deletion' AND receipt_id IS NULL").get()).toBeNull();
    } finally { f.db.close(); }
  });
}

for (const count of [20, 120]) {
  test(`a record deleted, returned and deleted again archives the page again (${count} events)`, async () => {
    const f = fixture();
    try {
      f.ingest(Array.from({ length: count }, (_, index) => message(index, "a")), f.a);
      expect((await f.pass()).errors).toEqual([]);
      const gone = { ...message(5, "a"), deleted: true, text: "Synthetic deletion." };
      f.ingest([gone], f.a);
      expect((await f.pass()).errors).toEqual([]);
      expect(f.page()["status"]).toBe("archived");

      f.ingest([{ ...message(5, "a"), metadata: { thread: "t-9", revision_epoch: 2 } }], f.a);
      expect((await f.pass()).errors).toEqual([]);
      expect(f.page()["status"]).toBe("active");
      expect(f.page()["sources"]).toContain(f.eventOf("a-5"));
      expect(f.served()).toBe(1);

      f.ingest([{ ...gone, occurred_at: "2026-03-05T00:00:00Z" }], f.a);
      expect((await f.pass()).errors).toEqual([]);
      expect(f.page()["status"]).toBe("archived");
      expect(f.served()).toBe(0);
    } finally { f.db.close(); }
  });
}
