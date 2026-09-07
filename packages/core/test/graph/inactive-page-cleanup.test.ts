import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readDerivedMeta } from "../../src/derived-meta";
import {
  neighbors,
  rebuildGraph,
  refreshPageEdges,
  removePageEdges,
} from "../../src/graph/graph";
import { serializePage } from "../../src/vault/frontmatter";
import type { CanonPage } from "../../src/vault/pages";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
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

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  const target = page("Target", "See [[Anchor]].", {
    subjects: ["person:target"], sources: ["event:target"],
  });
  const origin = page("Origin", "See [[Target]] and [[Anchor]].");
  const anchor = page("Anchor", "Stable destination.");
  const skipped = page("Skipped", "See [[Anchor]].", {
    subjects: ["person:kept"], sources: ["event:kept"],
  });
  rebuild(db, [target, origin, anchor, skipped]);
  return { db, target, origin, anchor, skipped };
}

function rows(db: Database) {
  return db.query<Record<string, unknown>, []>(
    "SELECT * FROM graph_edges ORDER BY src, dst, kind",
  ).all();
}

describe("inactive page cleanup during an incomplete graph walk", () => {
  for (const operation of ["archive", "delete"] as const) {
    test(`${operation} removes incoming and outgoing rows while preserving unrelated relations`, () => {
      const { db, target, origin, anchor, skipped } = fixture();
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
      expect(neighbors(db, origin.id).edges).toEqual([
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

  test("active refresh retains incoming and skipped-page rows while replacing outgoing rows", () => {
    const { db, target, origin, anchor } = fixture();
    const beforeRows = rows(db);
    const updated = page("Target", "See [[Origin]].");

    refreshPageEdges(db, updated, [updated, origin, anchor], 1);

    expect(rows(db).filter((edge) => edge["src"] !== target.id)).toEqual(
      beforeRows.filter((edge) => edge["src"] !== target.id),
    );
    expect(neighbors(db, target.id).edges).toEqual([
      { src: origin.id, dst: target.id, kind: "wikilink" },
      { src: target.id, dst: origin.id, kind: "wikilink" },
    ]);
    expect(readDerivedMeta(db, "graph")).toMatchObject({ status: "degraded", skipped_count: 1 });
  });
});
