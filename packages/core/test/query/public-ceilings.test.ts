import { expect, test } from "bun:test";
import * as core from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";

const methods = ["search", "searchResult", "timeline"] as const;
type Method = (typeof methods)[number];

function invoke(method: Method, db: unknown, options: unknown, query = "ceilingprobe"): unknown {
  return Reflect.apply(core[method], undefined, method === "timeline" ? [db, options] : [db, query, options]);
}

for (const method of methods) {
  test(`public ${method} requires a ceiling before touching the database`, () => {
    for (const options of [undefined, null, {}]) {
      let queries = 0;
      const db = { query: () => { queries++; throw Error("database must not be reached"); } };
      expect(() => invoke(method, db, options)).toThrow(RangeError);
      expect(queries).toBe(0);
    }
  });

  test(`public ${method} rejects malformed and coerced ceiling values before SQL`, () => {
    for (const ceiling of [undefined, null, "unknown", "__proto__", "constructor", "toString", 2, true,
      ["private"], new String("private"), { toString: () => "private" }]) {
      let queries = 0;
      const db = { query: () => { queries++; throw Error("database must not be reached"); } };
      expect(() => invoke(method, db, { ceiling })).toThrow(RangeError);
      expect(queries).toBe(0);
    }
  });

  test(`public ${method} validates policy before empty-query and zero-limit shortcuts`, () => {
    let queries = 0;
    const db = { query: () => { queries++; throw Error("database must not be reached"); } };
    for (const options of [{ limit: 0 }, { limit: 0, ceiling: null }, { limit: 0, ceiling: ["private"] }]) {
      expect(() => invoke(method, db, options, "")).toThrow(RangeError);
    }
    expect(queries).toBe(0);
    const result = invoke(method, db, { limit: 0, ceiling: "public" }, "");
    expect(method === "searchResult" ? (result as core.SearchResult).hits : result).toEqual([]);
    expect(queries).toBe(0);
  });
}

test("every public query ceiling withholds null, unknown and unlabeled rows in the actual ledger/index", () => {
  const db = openLedger(":memory:");
  try {
    core.initSearch(db);
    for (const label of ["public", "personal", "private", "unlabeled", "unknown", null]) {
      const result = core.accept(db, {
        schema: "kizuki.event/v1", connector_id: "synthetic", source_record_id: `ceilingprobe:${String(label)}`,
        kind: "message", text: "synthetic ceilingprobe", occurred_at: "2026-01-01T00:00:00Z", observed_at: "2026-02-01T00:00:00Z",
        subjects: [{ subject_id: "person:synthetic", role: "from" }], sensitivity_hint: "private", deleted: false, attachments: [], metadata: {},
      });
      if (result.status !== "stored") throw Error("synthetic event must be accepted");
      core.indexEvent(db, result.event);
      // Corrupt/missing labels are confined to this synthetic fixture.
      db.query("UPDATE events SET sensitivity_hint = ? WHERE event_id = ?").run(label, result.event.event_id);
      db.query("UPDATE search_docs SET sensitivity = ? WHERE doc_id = ?").run(label, `event:${result.event.event_id}`);
    }
    for (const ceiling of ["public", "personal", "private"] as const) {
      const expected = ["public", ...(ceiling === "public" ? [] : ["personal"]), ...(ceiling === "private" ? ["private"] : [])].sort();
      expect(core.search(db, "ceilingprobe", { ceiling }).map(hit => hit.sensitivity).sort()).toEqual(expected);
      expect(core.searchResult(db, "ceilingprobe", { ceiling }).hits.map(hit => hit.sensitivity).sort()).toEqual(expected);
      expect(core.timeline(db, { ceiling }).map(entry => entry.sensitivity).sort()).toEqual(expected);
    }
    for (const method of methods) {
      let reads = 0;
      const result = invoke(method, db, { get ceiling() { return ++reads === 1 ? "public" : "private"; } });
      const hits = method === "searchResult" ? (result as core.SearchResult).hits : result as { sensitivity: string }[];
      expect(hits.map(hit => hit.sensitivity)).toEqual(["public"]);
      expect(reads).toBe(1);
    }
  } finally { db.close(); }
});

test("the public retrieval query validator rejects inherited names as sensitivity labels", () => {
  for (const ceiling of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    expect(() => core.validateRetrievalQuery({ text: "ceilingprobe", mode: "lexical", scope: {}, ceiling, limit: 10, deadline_ms: 1_000 })).toThrow(core.PortError);
  }
  expect(core.validateRetrievalQuery({ text: "ceilingprobe", mode: "lexical", scope: {}, ceiling: "private", limit: 10, deadline_ms: 1_000 }).ceiling).toBe("private");
});
