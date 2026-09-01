import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { indexEvent, indexPage, rebuildSearch } from "../../src/search/indexer";
import { search, toFtsQuery } from "../../src/search/query";
import { initSearch } from "../../src/search/schema";
import { serializePage } from "../../src/vault/frontmatter";
import type { CanonPage } from "../../src/vault/pages";
import { searchDb, storedEvent, tempVault } from "./helpers";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function page(
  id: string,
  body: string,
  overrides: Record<string, unknown> = {},
): CanonPage {
  const relPath = `facts/${id.replace(":", "-")}.md`;
  return {
    id,
    path: relPath,
    relPath,
    data: {
      id,
      title: `Title ${id}`,
      type: "fact",
      sensitivity: "personal",
      ...overrides,
    },
    body,
  };
}

function writeCanon(
  vaultPath: string,
  relPath: string,
  data: Record<string, unknown>,
  body: string,
): void {
  writeFileSync(join(vaultPath, relPath), serializePage({ data, body }), "utf8");
}

describe("toFtsQuery", () => {
  test("keeps a quoted phrase as one implicit-AND token", () => {
    expect(toFtsQuery('"like this" other')).toBe('"like this" "other"');
  });

  test("escapes a doubled quote inside a phrase", () => {
    expect(toFtsQuery('"say ""hello"""')).toBe('"say ""hello"""');
  });

  const neutralized: [string, string][] = [
    ["alpha OR beta", '"alpha" "beta"'],
    ["NEAR(beta gamma)", '"beta" "gamma"'],
    ["alpha - ^ beta", '"alpha" "beta"'],
    ['"unfinished phrase', '"unfinished phrase"'],
    ["mid*dle", '"middle"'],
    ["prefix*", '"prefix"*'],
  ];
  for (const [raw, expected] of neutralized) {
    test(`neutralizes ${raw}`, () => {
      expect(toFtsQuery(raw)).toBe(expected);
    });
  }

  test("drops a query with no usable token without touching SQLite", () => {
    const db = new Database(":memory:");
    expect(search(db, "OR - ^")).toEqual([]);
  });
});

describe("search indexing", () => {
  test("initSearch is idempotent and creates both derived tables", () => {
    const db = searchDb();
    initSearch(db);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name IN ('search_docs', 'derived_meta') ORDER BY name",
        )
        .all()
        .map(({ name }) => name),
    ).toEqual(["derived_meta", "search_docs"]);
  });

  test("indexPage replaces an existing document instead of appending", () => {
    const db = searchDb();
    indexPage(db, page("fact:one", "old wording"));
    indexPage(db, page("fact:one", "new wording"));

    expect(search(db, "old")).toEqual([]);
    expect(search(db, "new").map(({ doc_id }) => doc_id)).toEqual(["fact:one"]);
    expect(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM search_docs").get(),
    ).toEqual({ count: 1 });
  });

  test("a later tombstone removes every indexed version of its source record", () => {
    const db = searchDb();
    const event = storedEvent(db, "same-source", { text: "vanishing record" });
    indexEvent(db, event);
    expect(search(db, "vanishing")).toHaveLength(1);

    const tombstone = storedEvent(db, "same-source", {
      text: "",
      deleted: true,
    });
    expect(tombstone.event_id).not.toBe(event.event_id);
    indexEvent(db, tombstone);

    expect(search(db, "vanishing")).toEqual([]);
  });

  test("prefix search works and snippets mark the match", () => {
    const db = searchDb();
    indexPage(db, page("fact:prefix", "A telescope reveals distant worlds."));

    const [hit] = search(db, "tele*");
    expect(hit?.doc_id).toBe("fact:prefix");
    expect(hit?.snippet).toContain("[telescope]");
  });

  test("unicode61 matches diacritics-insensitively", () => {
    const db = searchDb();
    indexPage(db, page("fact:cafe", "The café closes at dusk."));
    expect(search(db, "cafe").map(({ doc_id }) => doc_id)).toEqual([
      "fact:cafe",
    ]);
  });
});

describe("search rebuild", () => {
  test("indexes canon and ledger and stamps derived_meta", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    writeCanon(
      vault.path,
      "facts/tea.md",
      {
        id: "fact:tea",
        title: "Tea ritual",
        type: "fact",
        status: "active",
        sensitivity: "personal",
      },
      "A copper kettle whistles.",
    );
    storedEvent(db, "mail-one", { text: "A porcelain teacup arrived." });

    const result = rebuildSearch(db, vault.path);

    expect(result.pages).toBe(1);
    expect(result.events).toBe(1);
    expect(search(db, "kettle").map(({ scope }) => scope)).toEqual(["canon"]);
    expect(search(db, "teacup").map(({ scope }) => scope)).toEqual(["ledger"]);
    expect(
      db
        .query<{ layer: string; doc_count: number }, []>(
          "SELECT layer, doc_count FROM derived_meta WHERE layer = 'search'",
        )
        .get(),
    ).toEqual({ layer: "search", doc_count: 2 });
  });

  test("rebuilding twice preserves counts without duplicates", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    writeCanon(
      vault.path,
      "facts/one.md",
      {
        id: "fact:one",
        title: "One",
        type: "fact",
        status: "active",
        sensitivity: "public",
      },
      "repeatable",
    );
    storedEvent(db, "repeat", { text: "repeatable" });

    rebuildSearch(db, vault.path);
    rebuildSearch(db, vault.path);

    expect(search(db, "repeatable")).toHaveLength(2);
    expect(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM search_docs").get(),
    ).toEqual({ count: 2 });
  });

  test("does not index deleted ledger events", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    storedEvent(db, "gone", { text: "never indexed", deleted: true });
    expect(rebuildSearch(db, vault.path).events).toBe(0);
    expect(search(db, "indexed")).toEqual([]);
  });

  test("rebuild applies tombstones after earlier source versions", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    storedEvent(db, "same-source", { text: "obsolete record" });
    storedEvent(db, "same-source", { text: "", deleted: true });

    expect(rebuildSearch(db, vault.path).events).toBe(0);
    expect(search(db, "obsolete")).toEqual([]);
  });
});

describe("search policy and filters", () => {
  function policyDb(): Database {
    const db = searchDb();
    indexPage(db, page("fact:public", "shared keyword", { sensitivity: "public" }));
    indexPage(
      db,
      page("fact:personal", "shared keyword", { sensitivity: "personal" }),
    );
    indexPage(
      db,
      page("fact:private", "shared keyword", { sensitivity: "private" }),
    );
    indexPage(db, page("fact:unlabeled", "shared keyword", { sensitivity: undefined }));
    return db;
  }

  test("personal ceiling hides private and unlabeled documents", () => {
    expect(
      search(policyDb(), "shared", { ceiling: "personal" }).map(
        ({ doc_id }) => doc_id,
      ),
    ).toEqual(["fact:personal", "fact:public"]);
  });

  test("public ceiling hides personal, private, and unlabeled documents", () => {
    expect(
      search(policyDb(), "shared", { ceiling: "public" }).map(
        ({ doc_id }) => doc_id,
      ),
    ).toEqual(["fact:public"]);
  });

  test("owner search without a ceiling includes unlabeled documents", () => {
    expect(search(policyDb(), "shared")).toHaveLength(4);
  });

  test("scope, type, and excluded-path filters compose", () => {
    const db = searchDb();
    const held = page("fact:held", "filterword", { type: "fact" });
    indexPage(db, held);
    indexPage(db, page("topic:kept", "filterword", { type: "topic" }));
    indexEvent(db, storedEvent(db, "filtered-event", { text: "filterword" }));

    expect(
      search(db, "filterword", {
        scope: "canon",
        types: ["topic"],
        excludePaths: [held.relPath],
      }).map(({ doc_id }) => doc_id),
    ).toEqual(["topic:kept"]);
  });

  test("time and subject filters select matching ledger events", () => {
    const db = searchDb();
    indexEvent(
      db,
      storedEvent(db, "early", {
        text: "windowword",
        occurred_at: "2026-01-01T00:00:00Z",
        subjects: [{ subject_id: "person:ada", role: "about" }],
      }),
    );
    const later = storedEvent(db, "later", {
      text: "windowword",
      occurred_at: "2026-02-01T00:00:00Z",
      subjects: [{ subject_id: "person:grace", role: "about" }],
    });
    indexEvent(db, later);

    expect(
      search(db, "windowword", {
        since: "2026-01-15T00:00:00Z",
        until: "2026-03-01T00:00:00Z",
        subjects: ["person:grace"],
      }).map(({ doc_id }) => doc_id),
    ).toEqual([later.event_id]);
  });
});
