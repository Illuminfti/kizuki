import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MAX_RETRIEVAL_LIMIT } from "../../src/contracts/retrieval";
import { neighbors, rebuildGraph } from "../../src/graph/graph";
import type { GraphEdge } from "../../src/graph/graph";
import { MAX_CANON_PAGE_BYTES } from "../../src/vault/pages";
import type { CanonPage } from "../../src/vault/pages";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function page(id: string, body: string, sensitivity = "personal"): CanonPage {
  return {
    id,
    path: `facts/${id}.md`,
    relPath: `facts/${id}.md`,
    contentHash: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
    data: { id, title: id, type: "fact", status: "active", sensitivity, taint: "clean" },
    body,
  };
}

function graph(pages: CanonPage[]): Database {
  const db = new Database(":memory:");
  databases.push(db);
  // Drive the real rebuild seam with synthetic pages, not a private parser export.
  rebuildGraph(db, {
    generation: "synthetic-graph-resource-test",
    pages,
    skipped: [],
    rebuilt_at: "2026-01-01T00:00:00.000Z",
    canon_hash: null,
    authorities: new Map(pages.map((item) => [item.relPath, "owner_authored" as const])),
  });
  return db;
}

function targets(db: Database): string[] {
  return db.query<{ dst: string }, []>(
    "SELECT dst FROM graph_edges WHERE kind = 'wikilink' ORDER BY dst",
  ).all().map((row) => row.dst);
}

describe("graph delimiter bounds (#367)", () => {
  const cases: readonly [string, string, string[]][] = [
    ["plain, aliased and duplicate links", "[[Target]] [[Other|label]] [[Target]]", ["Other", "Target"]],
    ["code spans and backtick fences", "[[Visible]] `[[Inline]]` ```\n[[Fenced]]\n```", ["Visible"]],
    ["unmatched backtick", "Unmatched ` then [[Visible]]", ["Visible"]],
    ["balanced nested brackets", "[[Outer [[Inner]]]] [[Visible]]", ["Visible"]],
    ["unmatched outer with a matched inner", "[[Outer [[Inner]]", ["Inner"]],
    ["overlapping malformed openers", "[[[[x]]", ["[x"]],
    ["an extra opening bracket in a target", "[[[x]]", ["[x"]],
    ["empty targets", "[[]] [[ |label]]", []],
    ["exact backtick-run matching", "`` a ` [[Hidden]] ` b `` [[Visible]]", ["Visible"]],
  ];
  for (const [name, body, expected] of cases) {
    test(name, () => expect(targets(graph([page("origin", body)]))).toEqual(expected));
  }

  test("does not repeatedly rescan fifty thousand unmatched opening pairs", () => {
    const body = "[[Visible]] " + "[[".repeat(50_000);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_CANON_PAGE_BYTES);
    expect(targets(graph([page("origin", body)]))).toEqual(["Visible"]);
  });

  test("distinct unmatched backtick runs remain literal within the existing page bound", () => {
    const body = Array.from({ length: 1_400 }, (_, index) => "`".repeat(index + 1) + " x ").join("") + "[[Visible]]";
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_CANON_PAGE_BYTES);
    expect(targets(graph([page("origin", body)]))).toEqual(["Visible"]);
  });

  test("deep balanced nesting is ignored without recursive parsing", () => {
    const body = "[[".repeat(20_000) + "Hidden" + "]]".repeat(20_000) + " [[Visible]]";
    expect(targets(graph([page("origin", body)]))).toEqual(["Visible"]);
  });
});

describe("graph frontier membership (#365)", () => {
  function wideGraph(): Database {
    const pages: CanonPage[] = [];
    const links: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const node = `node-${index.toString().padStart(2, "0")}`;
      const leaf = `leaf-${index.toString().padStart(2, "0")}`;
      links.push(`[[${node}]]`);
      pages.push(page(node, `[[${leaf}]]`), page(leaf, ""));
    }
    pages.push(page("root", links.join(" ") + " [[secret]]"));
    pages.push(page("secret", "[[secret-leaf]]", "private"));
    pages.push(page("secret-leaf", "", "private"));
    return graph(pages);
  }

  test("bounded two-hop expansion stays deterministic, deduplicated and ceiling-safe", () => {
    const db = wideGraph();
    const one = neighbors(db, "root", { depth: 1, ceiling: "personal" });
    const two = neighbors(db, "root", { depth: 2, ceiling: "personal" });
    expect(one.edges).toHaveLength(40);
    expect(two.edges).toHaveLength(80);
    expect(two.truncated).toBe(false);
    expect(new Set(two.edges.map((edge) => `${edge.src}\0${edge.dst}\0${edge.kind}`)).size).toBe(80);
    expect(two.edges.some((edge) => edge.src.startsWith("secret") || edge.dst.startsWith("secret"))).toBe(false);
    expect(neighbors(db, "root", { depth: 2, ceiling: "personal" })).toEqual(two);
  });

  test("limit and empty-kind semantics are unchanged", () => {
    const db = wideGraph();
    const limited = neighbors(db, "root", { depth: 2, ceiling: "personal", limit: 17 });
    expect(limited.edges).toHaveLength(17);
    expect(limited.truncated).toBe(true);
    expect(neighbors(db, "root", { limit: 0 })).toEqual({ id: "root", edges: [], truncated: false });
    expect(neighbors(db, "root", { kinds: [] })).toEqual({ id: "root", edges: [], truncated: false });
    expect(() => neighbors(db, "root", { limit: MAX_RETRIEVAL_LIMIT + 1 })).toThrow(RangeError);
  });

  test("incoming edges and cycles retain the same unique edge set", () => {
    const db = graph([
      page("root", "[[b]]"),
      page("a", "[[root]] [[b]]"),
      page("b", "[[root]]"),
    ]);
    const expected: GraphEdge[] = [
      { src: "a", dst: "b", kind: "wikilink" },
      { src: "a", dst: "root", kind: "wikilink" },
      { src: "b", dst: "root", kind: "wikilink" },
      { src: "root", dst: "b", kind: "wikilink" },
    ];
    expect(neighbors(db, "root", { depth: 2, ceiling: "personal" }).edges).toEqual(expected);
  });
});
