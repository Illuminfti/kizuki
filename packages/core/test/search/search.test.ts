import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stampDerived } from "../../src/derived-meta";
import { MAX_RETRIEVAL_LIMIT } from "../../src/contracts/retrieval";
import { indexEvent, indexPage, rebuildSearch, removeDoc } from "../../src/search/indexer";
import { search, searchResult, toFtsQuery } from "../../src/search/query";
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
      status: "active",
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
    ["NEAR(beta gamma)", '"NEAR(beta" "gamma)"'],
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

  test("keeps literal dates, handles, times, and hyphenated words as typed", () => {
    expect(toFtsQuery("2026-02-03")).toBe('"2026-02-03"');
    expect(toFtsQuery("person:ada")).toBe('"person:ada"');
    expect(toFtsQuery("e-mail")).toBe('"e-mail"');
    expect(toFtsQuery("10:30")).toBe('"10:30"');
    expect(toFtsQuery("c++")).toBe('"c++"');
  });

  test("searches a literal date the way it was typed", () => {
    const db = searchDb();
    indexPage(db, page("fact:dated", "Meeting on 2026-02-03 at noon."));
    expect(search(db, "2026-02-03").map(({ doc_id }) => doc_id)).toEqual([
      "page:fact:dated",
    ]);
  });

  test("drops control characters and a NUL query does not throw", () => {
    const db = searchDb();
    indexPage(db, page("fact:hello", "hello world"));
    expect(toFtsQuery(`a\u0000b`)).toBe('"ab"');
    expect(search(db, `a\u0000b`)).toEqual([]);
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
    expect(search(db, "new").map(({ doc_id }) => doc_id)).toEqual(["page:fact:one"]);
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
    expect(hit?.doc_id).toBe("page:fact:prefix");
    expect(hit?.snippet).toContain("[telescope]");
  });

  test("unicode61 matches diacritics-insensitively", () => {
    const db = searchDb();
    indexPage(db, page("fact:cafe", "The café closes at dusk."));
    expect(search(db, "cafe").map(({ doc_id }) => doc_id)).toEqual([
      "page:fact:cafe",
    ]);
  });

  test("title matches outrank body matches", () => {
    const db = searchDb();
    indexPage(
      db,
      page("fact:title", "other body words", { title: "UniqueKeyword here" }),
    );
    indexPage(
      db,
      page("fact:body", "UniqueKeyword here", { title: "Other title words" }),
    );

    expect(search(db, "UniqueKeyword").map(({ doc_id }) => doc_id)).toEqual([
      "page:fact:title",
      "page:fact:body",
    ]);
  });

  test("indexing a canon page does not delete a ledger row with the same id", () => {
    const db = searchDb();
    const event = storedEvent(db, "shared-id", { text: "ledger unique phrase" });
    indexEvent(db, event);
    indexPage(db, page(event.event_id, "canon unique phrase"));

    expect(
      search(db, "ledger").map(({ scope, doc_id }) => `${scope}:${doc_id}`),
    ).toEqual([`ledger:event:${event.event_id}`]);
    expect(
      search(db, "canon").map(({ scope, doc_id }) => `${scope}:${doc_id}`),
    ).toEqual([`canon:page:${event.event_id}`]);

    removeDoc(db, "canon", event.event_id);
    expect(search(db, "canon")).toEqual([]);
    expect(search(db, "ledger").map(({ scope }) => scope)).toEqual(["ledger"]);
    removeDoc(db, "ledger", event.event_id);
    expect(search(db, "ledger")).toEqual([]);
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

  test("rebuildSearch stays linear for thousands of ledger rows", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    const insert = db.query(
      `INSERT INTO events (
         event_id, connector_id, source_record_id, kind, occurred_at, observed_at,
         text, subjects, sensitivity_hint, deleted, attachments, metadata,
         content_hash, accepted_at
       ) VALUES (?, 'fixture', ?, 'message', '2026-02-28T10:30:00Z',
                '2026-03-01T00:00:00Z', ?, '[]', 'personal', 0, '[]', '{}', ?, ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 6000; index += 1) {
        insert.run(
          `E${String(index).padStart(25, "0")}`,
          `src-${index}`,
          `body ${index}`,
          `${"h".repeat(64)}${index}`,
          "2026-03-01T00:00:00.000Z",
        );
      }
    })();

    const started = performance.now();
    const result = rebuildSearch(db, vault.path);
    const elapsed = performance.now() - started;

    expect(result.events).toBe(6000);
    expect(elapsed).toBeLessThan(1000);
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
    ).toEqual(["page:fact:personal", "page:fact:public"]);
  });

  test("public ceiling hides personal, private, and unlabeled documents", () => {
    expect(
      search(policyDb(), "shared", { ceiling: "public" }).map(
        ({ doc_id }) => doc_id,
      ),
    ).toEqual(["page:fact:public"]);
  });

  test.todo(
    "retrieval-fts5 lane: owner search excludes documents without sensitivity",
    () => {
      expect(
        search(policyDb(), "shared").map(({ doc_id }) => doc_id),
      ).not.toContain("page:fact:unlabeled");
    },
  );

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
    ).toEqual(["page:topic:kept"]);
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
    ).toEqual([`event:${later.event_id}`]);
  });

  test("compares since and until as instants, not raw strings", () => {
    const db = searchDb();
    const offset = storedEvent(db, "offset", {
      text: "windowword",
      occurred_at: "2026-02-03T00:30:00-05:00",
    });
    indexEvent(db, offset);
    indexPage(db, page("fact:empty", "windowword"));

    expect(
      search(db, "windowword", {
        since: "2026-02-03T04:00:00Z",
        until: "2026-02-03T06:00:00Z",
      })
        .map(({ doc_id, scope }) => `${scope}:${doc_id}`)
        .sort(),
    ).toEqual([`canon:page:fact:empty`, `ledger:event:${offset.event_id}`].sort());
    expect(
      search(db, "windowword", { since: "2026-02-03T00:00:00Z" }).map(
        ({ scope }) => scope,
      ),
    ).toContain("canon");
  });

  test("rejects a garbage search time bound instead of matching nothing", () => {
    const db = searchDb();
    indexEvent(db, storedEvent(db, "live", { text: "windowword" }));
    expect(() => search(db, "windowword", { since: "garbage" })).toThrow(
      RangeError,
    );
    expect(() => search(db, "windowword", { until: "garbage" })).toThrow(
      RangeError,
    );
  });

  test("caps limit at MAX_RETRIEVAL_LIMIT before SQL", () => {
    expect(() => search(searchDb(), "word", { limit: MAX_RETRIEVAL_LIMIT + 1 })).toThrow(
      RangeError,
    );
  });

  test("ledger hits are quoted and canon hits carry taint", () => {
    const db = searchDb();
    indexPage(db, page("fact:clean", "taintword", { taint: "clean" }));
    const event = storedEvent(db, "quoted-src", { text: "taintword captured" });
    indexEvent(db, event);
    const hits = search(db, "taintword");
    expect(hits.find((hit) => hit.scope === "canon")?.taint).toBe("clean");
    expect(hits.find((hit) => hit.scope === "ledger")).toMatchObject({
      taint: "quoted",
      doc_id: `event:${event.event_id}`,
    });
  });

  test("a missing search table is empty and index-degraded", () => {
    const db = new Database(":memory:");
    expect(searchResult(db, "anything")).toEqual({
      hits: [],
      degraded: ["index-degraded"],
    });
  });

  test("declares index-degraded when derived_meta is not ok", () => {
    const db = searchDb();
    indexPage(db, page("fact:one", "degradeword"));
    stampDerived(db, {
      layer: "search",
      generation: "gen-1",
      rebuilt_at: "2026-09-02T12:00:00.000Z",
      doc_count: 1,
      source_count: 1,
      skipped_count: 1,
      status: "degraded",
    });
    expect(searchResult(db, "degradeword").degraded).toContain("index-degraded");
  });
});

describe("search live eligibility and identity", () => {
  test("refuses to index an archived page and removes a stale row", () => {
    const db = searchDb();
    indexPage(db, page("fact:gone", "vanishing archived"));
    expect(search(db, "vanishing")).toHaveLength(1);
    indexPage(
      db,
      page("fact:gone", "vanishing archived", { status: "archived" }),
    );
    expect(search(db, "vanishing")).toEqual([]);
  });

  test("rebuild omits archived pages", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    writeCanon(
      vault.path,
      "facts/live.md",
      {
        id: "fact:live",
        title: "Live",
        type: "fact",
        status: "active",
        sensitivity: "public",
      },
      "liveword",
    );
    writeCanon(
      vault.path,
      "facts/old.md",
      {
        id: "fact:old",
        title: "Old",
        type: "fact",
        status: "archived",
        sensitivity: "public",
      },
      "liveword archived",
    );
    expect(rebuildSearch(db, vault.path).pages).toBe(1);
    expect(search(db, "liveword").map(({ doc_id }) => doc_id)).toEqual([
      "page:fact:live",
    ]);
  });

  test("search_documents enforces unique doc_id", () => {
    const db = searchDb();
    indexPage(db, page("fact:one", "once"));
    expect(() =>
      db.exec(
        `INSERT INTO search_documents (
           doc_id, scope, title, body, path, page_type, sensitivity,
           taint, authority, occurred_at, connector_id, subjects, provenance
         ) VALUES (
           'page:fact:one', 'canon', 'x', 'y', 'p', 'fact', 'public',
           'clean', 'owner_authored', '', '', '[]', '[]'
         )`,
      ),
    ).toThrow();
  });

  test("a skipped rebuild stamps degraded, not ok", () => {
    const db = searchDb();
    const vault = tempVault();
    disposers.push(vault.dispose);
    writeCanon(
      vault.path,
      "facts/ok.md",
      {
        id: "fact:ok",
        title: "Ok",
        type: "fact",
        status: "active",
        sensitivity: "public",
      },
      "okword",
    );
    writeFileSync(join(vault.path, "facts", "bad.md"), "no frontmatter\n");
    const result = rebuildSearch(db, vault.path);
    expect(result.status).toBe("degraded");
    expect(result.skipped).toHaveLength(1);
    expect(
      db
        .query<{ status: string }, []>(
          "SELECT status FROM derived_meta WHERE layer = 'search'",
        )
        .get()?.status,
    ).toBe("degraded");
  });
});
