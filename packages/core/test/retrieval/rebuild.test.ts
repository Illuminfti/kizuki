import { afterEach, expect, test } from "bun:test";
import { truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRetrievalDocuments, rebuildRetrieval } from "../../src/retrieval/rebuild";
import { serveFixture } from "../serving/helpers";
import type { Fixture } from "../serving/helpers";
let fixture: Fixture | undefined;
afterEach(() => fixture?.dispose());

test("authoritative canon with no receipt has unknown dates and stable projections", () => {
  fixture = serveFixture();
  const docs = readRetrievalDocuments(fixture.db, fixture.vaultPath);
  const pages = docs.filter(doc => doc.kind === "page");
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    expect(page.updated_at).toBeNull();
    expect(page.occurred_at).toBeNull();
    expect(page.authority).toBe("owner_authored");
  }
  expect(readRetrievalDocuments(fixture.db, fixture.vaultPath)).toEqual(docs);
});

test("unreadable canon refuses before the selected engine or lexical floor changes", async () => {
  fixture = serveFixture();
  const before = fixture.db.query("SELECT * FROM search_documents ORDER BY doc_id").all();
  writeFileSync(join(fixture.vaultPath, "facts", "malformed.md"), "---\ninvalid: [\n---\nsecret");
  let called = false;
  const port = { rebuildFromDocuments: async () => { called = true; } } as never;
  await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, port)).rejects.toThrow();
  expect(called).toBe(false);
  expect(fixture.db.query("SELECT * FROM search_documents ORDER BY doc_id").all()).toEqual(before);
});

test("source byte limits refuse before a sparse oversized canon file can be read or swapped", async () => {
  fixture = serveFixture();
  const path = join(fixture.vaultPath, "facts", "oversized.md");
  writeFileSync(path, "");
  truncateSync(path, 64 * 1024 * 1024 + 1);
  let called = false;
  const port = { rebuildFromDocuments: async () => { called = true; } } as never;
  await expect(rebuildRetrieval(fixture.db, fixture.vaultPath, port)).rejects.toThrow("rebuild corpus exceeds");
  expect(called).toBe(false);
});

test("the default rebuild reconstructs its existing lexical floor", async () => {
  fixture = serveFixture();
  const result = await rebuildRetrieval(fixture.db, fixture.vaultPath);
  expect(result.store).toBe("kizuki.retrieval.fts5");
  expect(result.documents).toBeGreaterThan(0);
  expect(fixture.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_documents").get()!.n).toBeGreaterThan(0);
});
