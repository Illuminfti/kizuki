import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { getClaim } from "../../src/claims/store";
import type { CaptureEventInput } from "../../src/contracts/event";
import type { ProducerPort } from "../../src/contracts/producer";
import { derivedPageSkips } from "../../src/derived-health";
import { runBatch } from "../../src/ingest/run";
import { openLedger } from "../../src/ledger/db";
import { runWritePass } from "../../src/serve/write-pass";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { initVault } from "../../src/vault/init";
import { listCanonPagesReport } from "../../src/vault/pages";
import { MAX_FRONTMATTER_ARRAY_ITEMS } from "../../src/vault/schema";
import { validEvent } from "../fixtures";

/**
 * What a legacy page cites once its claims carry more evidence than a page can
 * name, or name evidence a source tombstone has ended. Every page here must
 * be written and must stay admissible to the derived index.
 */

setDefaultTimeout(120_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const producer: ProducerPort = {
  descriptor: {
    id: "kizuki.producer.citations-test", kind: "producer", contract: "kizuki.producer/v1",
    contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null,
  },
  health: async () => ({ status: "ready", detail: {} }),
  close: async () => undefined,
  produce: async () => ({ status: "ok", claims: [], usage: { calls: 1, input_tokens: 1, output_tokens: 1 } }),
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-page-citations-"));
  roots.push(root);
  const path = join(root, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  const ingest = (events: CaptureEventInput[]) => {
    const result = runBatch(db, { events, cursor: null, has_more: false }, { page_candidates: false }, undefined, { vault_path: path });
    expect(result.errors).toEqual([]);
  };
  const pass = () => runWritePass(db, path, {
    budget: createBudgetTracker({ canon_writes_per_run: 16 }),
    model_ref: "kizuki.llm.synthetic:citations-test", producer, claims: { db },
  });
  const page = (relPath: string) => parseFrontmatter(readFileSync(join(path, relPath), "utf8")).data;
  const skips = () => derivedPageSkips(db, listCanonPagesReport(path));
  return { db, path, ingest, pass, page, skips };
}

const file = (revision: number): CaptureEventInput => ({
  ...validEvent(), kind: "file", source_record_id: "notes.md",
  text: `Synthetic note, revision ${revision}.`, metadata: { revision_epoch: revision },
});

test("a subject seen in more events than a page can cite still gets its page, citing a page's worth", async () => {
  const { db, ingest, pass, page, skips } = fixture();
  try {
    const count = MAX_FRONTMATTER_ARRAY_ITEMS + 21;
    ingest(Array.from({ length: count }, (_, index) => ({
      ...validEvent(), source_record_id: `message-${index}`, text: `Synthetic message ${index}.`,
    })));
    const entity = db.query<{ claim_id: string }, []>("SELECT claim_id FROM claims WHERE kind='entity' AND status='live'").get()!;
    expect(getClaim(db, entity.claim_id)!.provenance).toHaveLength(count);

    const report = await pass();
    expect(report.errors).toEqual([]);
    const written = getClaim(db, entity.claim_id)!;
    expect(written.receipt_id).not.toBeNull();
    expect(written.provenance).toHaveLength(count);
    const sources = page("auto/fixture/person/ada.md")["sources"] as string[];
    expect(sources).toEqual(written.provenance.slice(0, MAX_FRONTMATTER_ARRAY_ITEMS));
    expect(skips()).toEqual([]);
  } finally { db.close(); }
});

test("a record revised more times than a page can cite keeps its page current", async () => {
  const { db, ingest, pass, page, skips } = fixture();
  try {
    // The page starts one short of full: the subject's other evidence plus the first revision.
    ingest([
      ...Array.from({ length: MAX_FRONTMATTER_ARRAY_ITEMS - 2 }, (_, index) => ({
        ...validEvent(), source_record_id: `message-${index}`, text: `Synthetic message ${index}.`,
      })),
      file(1),
    ]);
    expect((await pass()).errors).toEqual([]);
    expect(page("auto/fixture/person/ada.md")["sources"]).toHaveLength(MAX_FRONTMATTER_ARRAY_ITEMS - 1);
    for (let revision = 2; revision <= 5; revision += 1) {
      ingest([file(revision)]);
      expect((await pass()).errors).toEqual([]);
    }
    const data = page("auto/fixture/person/ada.md");
    const sources = data["sources"] as string[];
    expect(sources.length).toBeLessThanOrEqual(MAX_FRONTMATTER_ARRAY_ITEMS);
    const latest = db.query<{ event_id: string }, []>(
      "SELECT event_id FROM events WHERE source_record_id='notes.md' ORDER BY accepted_at DESC, event_id DESC LIMIT 1",
    ).get()!;
    expect(sources).toContain(latest.event_id);
    expect(data["x-source-revision"]).toBe(5);
    expect(db.query("SELECT 1 FROM claims WHERE status='live' AND receipt_id IS NULL").get()).toBeNull();
    expect(skips()).toEqual([]);
  } finally { db.close(); }
});

test("a page restored for a returned record stops citing the version its deletion ended", async () => {
  const { db, ingest, pass, page, skips } = fixture();
  try {
    ingest([file(1)]);
    expect((await pass()).errors).toEqual([]);
    const ended = (page("auto/fixture/person/ada.md")["sources"] as string[])[0]!;

    ingest([{ ...file(1), deleted: true, text: "Synthetic deletion." }]);
    expect((await pass()).errors).toEqual([]);
    expect(page("auto/fixture/person/ada.md")["status"]).toBe("archived");

    ingest([file(2)]);
    expect((await pass()).errors).toEqual([]);
    const data = page("auto/fixture/person/ada.md");
    expect(data["status"]).toBe("active");
    expect(data["sources"]).not.toContain(ended);
    expect(data["x-source-revision"]).toBe(2);
    expect(skips()).toEqual([]);
  } finally { db.close(); }
});
