import { describe, expect, test } from "bun:test";
import { CanonicalQuoteCollector, eventsCitedByPages } from "../../src/serving/dedupe";
import type { CanonPage } from "../../src/vault/pages";

function page(body: string, sources: string[]): CanonPage {
  return {
    id: "01TESTPAGE0000000000000001",
    path: "notes/test.md",
    relPath: "notes/test.md",
    contentHash: "0".repeat(64),
    data: { sources },
    body,
  };
}

describe("eventsCitedByPages", () => {
  test("suppresses events cited by an untruncated page within the 600-code-point excerpt bound", () => {
    const exact600 = "a".repeat(600);
    const cited = eventsCitedByPages(
      [page(exact600, ["event:01EVENT0000000000000000001", "01EVENT0000000000000000002"])],
      ["01EVENT0000000000000000001", "01EVENT0000000000000000002", "01EVENT0000000000000000003"],
    );
    expect([...cited].sort()).toEqual([
      "01EVENT0000000000000000001",
      "01EVENT0000000000000000002",
    ]);
  });

  test("counts Unicode code points rather than UTF-16 code units at the 600-point boundary", () => {
    // 600 astral code points = 1200 UTF-16 code units, still fits within excerptOf(..., 600).
    const astral600 = "🪿".repeat(600);
    expect(astral600.length).toBe(1200);
    const cited = eventsCitedByPages(
      [page(astral600, ["01EVENT0000000000000000001"])],
      ["01EVENT0000000000000000001"],
    );
    expect(cited.has("01EVENT0000000000000000001")).toBe(true);

    const astral601 = "🪿".repeat(601);
    const truncated = eventsCitedByPages(
      [page(astral601, ["01EVENT0000000000000000001"])],
      ["01EVENT0000000000000000001"],
    );
    expect(truncated.size).toBe(0);
  });

  test("keeps events visible when only a truncated page (>600 code points) cites them", () => {
    const longPage = page("x".repeat(601), ["01EVENT0000000000000000001", "01EVENT0000000000000000002"]);
    const shortPage = page("short summary", ["01EVENT0000000000000000002"]);
    const cited = eventsCitedByPages(
      [longPage, shortPage],
      ["01EVENT0000000000000000001", "01EVENT0000000000000000002"],
    );
    expect([...cited]).toEqual(["01EVENT0000000000000000002"]);
  });

  test("returns empty set when pages or candidates are empty", () => {
    expect(eventsCitedByPages([], ["01EVENT0000000000000000001"]).size).toBe(0);
    expect(eventsCitedByPages([page("hello", ["01EVENT0000000000000000001"])], []).size).toBe(0);
  });
});

describe("CanonicalQuoteCollector", () => {
  test("folds duplicate source records in place while upgrading to newer accepted revisions", () => {
    const collector = new CanonicalQuoteCollector<{ event_id: string; text: string }>();
    const out: { event_id: string; text: string }[] = [];
    expect(collector.admit(
      { event_id: "01EV1", connector_id: "c", kind: "note", occurred_at: "2026-09-01T00:00:00Z", source_record_id: "rec-1", accepted_at: "2026-09-01T00:00:01Z" },
      { event_id: "01EV1", text: "v1" },
      out,
      10,
    )).toBe(true);
    expect(collector.admit(
      { event_id: "01EV2", connector_id: "c", kind: "note", occurred_at: "2026-09-01T00:00:00Z", source_record_id: "rec-1", accepted_at: "2026-09-01T00:00:02Z" },
      { event_id: "01EV2", text: "v2" },
      out,
      10,
    )).toBe(false);
    expect(collector.folded).toBe(1);
    expect(out).toEqual([{ event_id: "01EV2", text: "v2" }]);
  });
});
