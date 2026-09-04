import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stampDerived } from "../../src/derived-meta";
import { serveGetPage } from "../../src/serving/page";
import { serveSearch } from "../../src/serving/search";
import type { SearchData } from "../../src/serving/search";
import { ServeError } from "../../src/serving/types";
import type { Envelope } from "../../src/serving/types";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeAll(() => {
  fixture = serveFixture();
});

afterAll(() => {
  fixture.dispose();
});

function pageIds(envelope: Envelope<SearchData>): string[] {
  return envelope.canon.map((chunk) => chunk.page_id).sort();
}

function eventIds(envelope: Envelope<SearchData>): string[] {
  return envelope.quoted.map((chunk) => chunk.event_id).sort();
}

function refusal(run: () => unknown): ServeError {
  try {
    run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

describe("serveSearch enforces the grant below the prompt layer", () => {
  test("the sensitivity ceiling decides which canon pages exist", () => {
    const personal = serveSearch(fixture.agent("reader-personal"), {
      query: "kettle",
    });
    expect(pageIds(personal)).not.toContain("fact:kettle");
    expect(personal.denied).toContainEqual({
      reason: "above_ceiling",
      count: 1,
    });

    const priv = serveSearch(fixture.agent("reader-private"), {
      query: "kettle",
    });
    expect(pageIds(priv)).toContain("fact:kettle");
    expect(priv.data).toBeUndefined();
  });

  test("an unlabeled page is withheld from every principal, owner included", () => {
    for (const ctx of [
      fixture.owner(),
      fixture.agent("reader-private"),
      fixture.agent("reader-public"),
    ]) {
      const envelope = serveSearch(ctx, { query: "kettle" });
      expect(pageIds(envelope)).not.toContain("fact:unlabeled");
      expect(envelope.denied).toContainEqual({
        reason: "missing_sensitivity",
        count: 1,
      });
    }
  });

  test("held and archived pages are never served", () => {
    const envelope = serveSearch(fixture.owner(), { query: "kettle" });
    expect(pageIds(envelope)).not.toContain("fact:archived");
    expect(
      envelope.canon.some((chunk) => chunk.path === fixture.heldPath),
    ).toBe(false);
  });

  test("a withheld page leaks neither its id nor its title", () => {
    const envelope = serveSearch(fixture.agent("reader-personal"), {
      query: "kettle",
    });
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("fact:kettle");
    expect(json).not.toContain("Kettle protocol");
    expect(envelope.denied.every((entry) => entry.count > 0)).toBe(true);
  });

  test("ledger hits arrive as quoted capture stamped tainted", () => {
    const envelope = serveSearch(fixture.agent("reader-private"), {
      query: "kettle",
      scope: "ledger",
    });
    expect(envelope.quoted.length).toBeGreaterThan(0);
    expect(envelope.quoted.every((chunk) => chunk.tainted === true)).toBe(true);
    expect(envelope.canon).toEqual([]);
    expect(eventIds(envelope)).toContain(fixture.events["public"] as string);
  });

  test("a tombstoned record is never quoted", () => {
    const envelope = serveSearch(fixture.owner(), {
      query: "retracted",
      scope: "all",
    });
    expect(eventIds(envelope)).not.toContain(
      fixture.events["tombstoned"] as string,
    );
  });

  test("an unhinted event is counted as missing_sensitivity", () => {
    const envelope = serveSearch(fixture.agent("reader-private"), {
      query: "unhinted",
      scope: "ledger",
    });
    expect(envelope.quoted).toEqual([]);
    expect(envelope.denied).toEqual([
      { reason: "missing_sensitivity", count: 1 },
    ]);
  });

  test("a types-scoped grant sees only its own page type", () => {
    const ctx = fixture.agent("typed");
    const envelope = serveSearch(ctx, { query: "kettle" });
    expect(envelope.canon.every((chunk) => chunk.type === "person")).toBe(true);
    expect(
      refusal(() => serveSearch(ctx, { query: "kettle", types: ["fact"] }))
        .code,
    ).toBe("type_out_of_scope");
  });

  test("a subjects-scoped grant only sees pages about its subject", () => {
    const envelope = serveSearch(fixture.agent("subjected"), {
      query: "kettle",
    });
    expect(
      envelope.canon.every((chunk) => chunk.subjects.includes("person:ada")),
    ).toBe(true);
    expect(pageIds(envelope)).not.toContain("person:grace");
    expect(
      refusal(() =>
        serveSearch(fixture.agent("subjected"), {
          query: "kettle",
          subjects: ["person:grace"],
        }),
      ).code,
    ).toBe("subject_out_of_scope");
  });

  test("the served window is the intersection of grant and request", () => {
    const envelope = serveSearch(fixture.agent("windowed"), {
      query: "kettle",
      scope: "ledger",
    });
    expect(eventIds(envelope)).toEqual(
      [
        fixture.events["personal"] as string,
        fixture.events["private"] as string,
      ].sort(),
    );
  });

  test("out-of-range arguments are refused before any read", () => {
    const ctx = fixture.agent("reader-private");
    expect(
      refusal(() => serveSearch(ctx, { query: "kettle", limit: 51 })).code,
    ).toBe("invalid_arguments");
    expect(
      refusal(() => serveSearch(ctx, { query: "k".repeat(513) })).code,
    ).toBe("invalid_arguments");
  });

  test("a query with no usable token is an empty answer, not an error", () => {
    const envelope = serveSearch(fixture.agent("reader-private"), {
      query: "***",
    });
    expect(envelope.canon).toEqual([]);
    expect(envelope.quoted).toEqual([]);
    expect(envelope.denied).toEqual([]);
    expect(envelope.data).toEqual({ degraded: ["query-empty"] });
  });

  test("a degraded search index is named on the envelope", () => {
    const isolated = serveFixture();
    try {
      isolated.db.exec("DROP TABLE search_docs");
      stampDerived(isolated.db, {
        layer: "search",
        generation: "schema-v10",
        rebuilt_at: "2026-03-01T00:00:00.000Z",
        doc_count: 0,
        source_count: 0,
        skipped_count: 0,
        status: "degraded",
      });
      const envelope = serveSearch(isolated.owner(), { query: "kettle" });
      expect(envelope.canon).toEqual([]);
      expect(envelope.quoted).toEqual([]);
      expect(envelope.data).toEqual({
        degraded: ["index-degraded"],
      });
    } finally {
      isolated.dispose();
    }
  });

  test("a page carrying capture is served as canon, stamped as capture", () => {
    const envelope = serveSearch(fixture.agent("reader-public"), {
      query: "disregard",
    });
    // The page is produced canon that quotes a record, so it stays in the
    // canon field; the stamp is what tells a reader the body holds capture.
    expect(pageIds(envelope)).toEqual(["fact:quoted"]);
    expect(envelope.canon[0]?.taint).toBe("quoted");
    expect(envelope.quoted).toEqual([]);

    const prose = serveSearch(fixture.agent("reader-public"), {
      query: "kettles",
    });
    expect(pageIds(prose)).toEqual(["org:acme"]);
    expect(prose.canon[0]?.taint).toBe("clean");
  });

  test("a page with no taint stamp is served to nobody, the owner included", () => {
    for (const ctx of [fixture.owner(), fixture.agent("reader-private")]) {
      const envelope = serveSearch(ctx, { query: "nobody stamped" });
      expect(pageIds(envelope)).toEqual([]);
      expect(envelope.denied).toEqual([{ reason: "missing_taint", count: 1 }]);
    }
    // Named directly it is withheld too, and the reason is the missing stamp.
    expect(
      serveGetPage(fixture.owner(), { id: "fact:untainted" }).denied,
    ).toEqual([{ reason: "missing_taint", count: 1 }]);
  });
});
