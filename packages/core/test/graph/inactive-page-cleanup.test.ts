import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openLedger } from "../../src/ledger/db";
import { listCanonPages } from "../../src/vault/pages";
import type { FrontmatterValue } from "../../src/contracts/proposal";
import { recordedPage } from "../helpers/recorded-page";
import { tempVault } from "../helpers/vault";
import { readDerivedMeta } from "../../src/derived-meta";
import {
  neighbors,
  rebuildGraph,
  refreshPageEdges,
  removePageEdges,
} from "../../src/graph/graph";
import { serializePage } from "../../src/vault/frontmatter";
import type { CanonPage } from "../../src/vault/pages";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function page(name: string, body: string, extra: Record<string, unknown> = {}): CanonPage {
  const id = `fact:${name.toLowerCase()}`;
  const data = {
    id, title: name, type: "fact", status: "active",
    sensitivity: "personal", taint: "clean", ...extra,
  };
  return {
    id,
    path: `facts/${name.toLowerCase()}.md`,
    relPath: `facts/${name.toLowerCase()}.md`,
    data,
    body,
    contentHash: new Bun.CryptoHasher("sha256")
      .update(serializePage({ data, body })).digest("hex"),
  };
}

function rebuild(db: Database, pages: CanonPage[]): void {
  rebuildGraph(db, {
    generation: "inactive-page-cleanup",
    pages,
    skipped: [],
    rebuilt_at: "2026-01-01T00:00:00.000Z",
    canon_hash: "synthetic-canon-snapshot",
  });
}

async function fixture() {
  const db = openLedger(":memory:");
  const vault = tempVault();
  disposers.push(() => db.close(), vault.dispose);
  for (const spec of [
    page("Target", "See [[Anchor]].", { subjects: ["person:target"] }),
    page("Origin", "See [[Target]] and [[Anchor]]."),
    page("Anchor", "Stable destination."),
    page("Skipped", "See [[Anchor]].", { subjects: ["person:kept"] }),
  ]) {
    await recordedPage(db, vault.path, spec.relPath, spec.data as Record<string, FrontmatterValue>, spec.body);
  }
  const pages = listCanonPages(vault.path);
  const named = (id: string) => pages.find(page => page.id === `fact:${id}`)!;
  rebuild(db, pages);
  return { db, vault, target: named("target"), origin: named("origin"), anchor: named("anchor"), skipped: named("skipped") };
}

function rows(db: Database) {
  return db.query<Record<string, unknown>, []>(
    "SELECT * FROM graph_edges ORDER BY src, dst, kind",
  ).all();
}

describe("inactive page cleanup during an incomplete graph walk", () => {
  for (const operation of ["archive", "delete"] as const) {
    test(`${operation} removes incoming and outgoing rows while preserving unrelated relations`, async () => {
      const { db, target, origin, anchor, skipped } = await fixture();
      const beforeRows = rows(db);
      const beforeMeta = readDerivedMeta(db, "graph");
      if (beforeMeta === null) throw new Error("fixture graph metadata is missing");
      expect(neighbors(db, target.id).edges).toHaveLength(4);

      const archived = page("Target", target.body, { ...target.data, status: "archived" });
      // The caller explicitly reports an unrelated skipped page. No unreadable
      // files or parser failure are needed to exercise the incomplete snapshot.
      if (operation === "archive") {
        refreshPageEdges(db, archived, [archived, origin, anchor], 1);
      } else {
        removePageEdges(db, target.id, [origin, anchor], 1);
      }

      const afterRows = rows(db);
      expect(afterRows).toEqual(beforeRows.filter(
        (edge) => edge["src"] !== target.id && edge["dst"] !== target.id,
      ));
      expect(neighbors(db, target.id)).toEqual({ id: target.id, edges: [], truncated: false });
      expect(neighbors(db, origin.id, { kinds: ["wikilink"] }).edges).toEqual([
        { src: origin.id, dst: anchor.id, kind: "wikilink" },
      ]);
      expect(readDerivedMeta(db, "graph")).toEqual({
        ...beforeMeta,
        rebuilt_at: expect.any(String),
        skipped_count: 1,
        status: "degraded",
      });

      const anchorNeighbors = neighbors(db, anchor.id);
      const skippedNeighbors = neighbors(db, skipped.id);
      // A later complete rebuild agrees on target absence and the retained
      // unrelated graph, after the skipped page becomes available again.
      rebuild(db, operation === "archive"
        ? [archived, origin, anchor, skipped]
        : [origin, anchor, skipped]);
      expect(neighbors(db, target.id)).toEqual({ id: target.id, edges: [], truncated: false });
      expect(neighbors(db, anchor.id)).toEqual(anchorNeighbors);
      expect(neighbors(db, skipped.id)).toEqual(skippedNeighbors);
      expect(readDerivedMeta(db, "graph")).toMatchObject({ status: "ok", skipped_count: 0 });
    });
  }

  test("active refresh retains incoming and skipped-page rows while replacing outgoing rows", async () => {
    const { db, vault, target, origin, anchor, skipped } = await fixture();
    const beforeRows = rows(db);
    await recordedPage(db, vault.path, target.relPath,
      target.data as Record<string, FrontmatterValue>, "See [[Origin]].");
    const updated = listCanonPages(vault.path).find(page => page.id === target.id)!;
    // Restore the pre-refresh derived rows after the writer has recorded the edit.
    rebuild(db, [target, origin, anchor, skipped]);

    refreshPageEdges(db, updated, [updated, origin, anchor], 1);

    expect(rows(db).filter((edge) => edge["src"] !== target.id)).toEqual(
      beforeRows.filter((edge) => edge["src"] !== target.id),
    );
    expect(neighbors(db, target.id, { kinds: ["wikilink"] }).edges).toEqual([
      { src: origin.id, dst: target.id, kind: "wikilink" },
      { src: target.id, dst: origin.id, kind: "wikilink" },
    ]);
    expect(readDerivedMeta(db, "graph")).toMatchObject({ status: "degraded", skipped_count: 1 });
  });
});
