import { afterEach, expect, test } from "bun:test";
import { indexPage, removeDoc } from "../../src/search/indexer";
import { search } from "../../src/search/query";
import type { FrontmatterValue } from "../../src/contracts/proposal";
import type { CanonPage } from "../../src/vault/pages";
import { listCanonPages } from "../../src/vault/pages";
import { recordedPage } from "../helpers/recorded-page";
import { searchDb, tempVault } from "./helpers";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

test("a pending canon hold is withheld from search before ceiling filters", async () => {
  const db = searchDb();
  const vault = tempVault();
  disposers.push(vault.dispose);

  async function write(id: string): Promise<CanonPage> {
    const relPath = `facts/${id.replace(":", "-")}.md`;
    await recordedPage(
      db,
      vault.path,
      relPath,
      {
        id,
        title: `Title ${id}`,
        type: "fact",
        status: "active",
        sensitivity: "private",
        taint: "clean",
      } as Record<string, FrontmatterValue>,
      "shared hold token",
    );
    const recorded = listCanonPages(vault.path).find((page) => page.relPath === relPath)!;
    removeDoc(db, "canon", recorded.id);
    indexPage(db, recorded);
    return recorded;
  }

  const held = await write("fact:held");
  const kept = await write("fact:kept");
  db.query(
    `INSERT INTO canon_holds (page_path, proposal_id, reason, held_at)
     VALUES (?, '01HOLDTEST0000000000000001', 'purge', '2026-09-07T00:00:00.000Z')`,
  ).run(held.relPath);

  expect(
    search(db, "shared", { ceiling: "private" }).map(({ doc_id }) => doc_id),
  ).toEqual([`page:${kept.id}`]);
});
