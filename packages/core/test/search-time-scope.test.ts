import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { search, searchAuditCandidates, searchResult } from "../src/search/query";
import type { SearchOptions } from "../src/search/query";
import { initSearch } from "../src/search/schema";

const since = "2026-01-02T10:00:00Z";
const until = "2026-01-03T10:00:00Z";
const unsupported = "canon-time-scope-unsupported";

function fixture(): Database {
  const db = new Database(":memory:");
  initSearch(db);
  // This query-layer fixture needs only the path projection of hold records.
  db.exec(`
    CREATE TABLE canon_holds (page_path TEXT);
    CREATE TABLE canon_write_intents (page_path TEXT);
    CREATE TABLE canon_projection_obligations (page_path TEXT);
  `);
  const rows = [
    ["canon-undated", "canon", "", "public"],
    ["canon-dated", "canon", since, "public"],
    ["before", "ledger", "2026-01-02T09:59:59Z", "public"],
    ["lower", "ledger", since, "public"],
    ["offset", "ledger", "2026-01-02t11:00:00+01:00", "public"],
    ["inside", "ledger", "2026-01-02T11:00:00Z", "public"],
    ["upper", "ledger", until, "public"],
    ["private", "ledger", since, "private"],
  ];
  for (const [id, scope, at, sensitivity] of rows) {
    db.query(`INSERT INTO search_docs (
      doc_id, scope, title, body, path, page_type, sensitivity, taint,
      authority, occurred_at, connector_id, subjects, provenance
    ) VALUES (?, ?, 'needle', 'needle evidence', ?, ?, ?, 'quoted',
      'connector_evidence', ?, 'fixture', ?, '[]')`)
      .run(id!, scope!, `${id}.md`, id === "inside" ? "note" : "message",
        sensitivity!, at!, JSON.stringify([id === "inside" ? "person:ada" : "person:grace"]));
  }
  return db;
}

function ids(rows: readonly { doc_id: string }[]): string[] {
  return rows.map(row => row.doc_id).sort();
}

function withFixture(run: (db: Database) => void): void {
  const db = fixture();
  try {
    run(db);
  } finally {
    db.close();
  }
}

describe("search occurrence-time scope", () => {
  const windows = [
    { name: "since", bounds: { since }, expected: ["inside", "lower", "offset", "private", "upper"] },
    { name: "until", bounds: { until }, expected: ["before", "inside", "lower", "offset", "private"] },
    { name: "bounded", bounds: { since, until }, expected: ["inside", "lower", "offset", "private"] },
  ];
  const scopes: SearchOptions["scope"][] = [undefined, "all", "canon", "ledger"];
  for (const scope of scopes) {
    for (const { name, bounds, expected } of windows) {
      test(`${scope ?? "default"} ${name} applies the same bounds to results and audit candidates`, () => {
        withFixture(db => {
          const options: SearchOptions = { ...bounds, ceiling: "private" };
          if (scope !== undefined) options.scope = scope;
          const result = searchResult(db, "needle", options);
          const audit = searchAuditCandidates(db, "needle", options);
          const wanted = scope === "canon" ? [] : expected;
          expect(ids(result.hits)).toEqual(wanted);
          expect(ids(audit.candidates)).toEqual(wanted);
          expect(result.degraded).toEqual(scope === "ledger" ? [] : [unsupported]);
          expect(audit.degraded).toEqual(result.degraded);
          expect(result.hits.every(hit => hit.scope === "ledger")).toBe(true);
          expect(ids(search(db, "needle", options))).toEqual(wanted);
        });
      });
    }
  }

  test("untimed canon search is unchanged and carries no unsupported-time warning", () => {
    withFixture(db => {
      const result = searchResult(db, "needle", { scope: "canon", ceiling: "public" });
      expect(ids(result.hits)).toEqual(["canon-dated", "canon-undated"]);
      expect(result.degraded).toEqual([]);
    });
  });

  test("time filtering preserves the public sensitivity ceiling", () => {
    withFixture(db => {
      const result = searchResult(db, "needle", { since, until, ceiling: "public" });
      expect(ids(result.hits)).toEqual(["inside", "lower", "offset"]);
      expect(result.degraded).toEqual([unsupported]);
    });
  });

  test("type, subject and path filters remain conjunctive with the time window", () => {
    withFixture(db => {
      const options: SearchOptions = {
        since, until, ceiling: "private", types: ["note"], subjects: ["person:ada"],
      };
      expect(ids(search(db, "needle", options))).toEqual(["inside"]);
      expect(search(db, "needle", { ...options, excludePaths: ["inside.md"] })).toEqual([]);
    });
  });

  test("time exclusion happens before the result limit", () => {
    withFixture(db => {
      const result = searchResult(db, "needle", { since, until, ceiling: "public", limit: 1 });
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.scope).toBe("ledger");
      expect(result.degraded).toEqual([unsupported]);
    });
  });

  test("invalid bounds are still rejected, including a canon-only request", () => {
    withFixture(db => {
      for (const scope of ["canon", "ledger", "all"] as const) {
        expect(() => searchResult(db, "needle", {
          scope, ceiling: "public", since: "2026-02-30T00:00:00Z",
        })).toThrow(RangeError);
        expect(() => searchAuditCandidates(db, "needle", {
          scope, until: "not-a-timestamp",
        })).toThrow(RangeError);
      }
    });
  });

  test("held canon stays withheld from untimed results", () => {
    withFixture(db => {
      db.query("INSERT INTO canon_holds VALUES (?)").run("canon-undated.md");
      expect(ids(search(db, "needle", { scope: "canon", ceiling: "public" })))
        .toEqual(["canon-dated"]);
    });
  });

  test("a window with no eligible events returns no canon fallback", () => {
    withFixture(db => {
      const result = searchResult(db, "needle", {
        ceiling: "private", since: "2027-01-01T00:00:00Z",
      });
      expect(result.hits).toEqual([]);
      expect(result.degraded).toEqual([unsupported]);
    });
  });
});
