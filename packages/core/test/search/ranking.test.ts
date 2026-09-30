import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { machineOriginSql, isMachineOriginPath } from "../../src/canon/origin";
import { indexDocument } from "../../src/search/indexer";
import { search } from "../../src/search/query";
import { searchDb } from "./helpers";

/**
 * A canon-shaped search row. Loop-written pages need the loop's byte-intent
 * custody to exist on disk, which a ranking test does not exercise.
 */
function indexRow(db: Database, id: string, path: string, title: string, body: string, pageType: string): string {
  const docId = `page:${id}`;
  indexDocument(db, {
    docId, scope: "canon", title, body, path, pageType, sensitivity: "personal", taint: "clean",
    authority: "owner_authored", occurredAt: "", connectorId: "", subjects: [], provenance: [],
  });
  return docId;
}

const OPTIONS = { ceiling: "private", scope: "canon" } as const;

describe("exact-title boost", () => {
  test("an exact title keeps its internal spacing", () => {
    const db = searchDb();
    const exact = indexRow(db, "exact", "orgs/kestrel.md", "Kestrel  Labs", "Kestrel Labs platform. ".repeat(80), "org");
    indexRow(db, "other", "notes/other.md", "Kestrel Labs note", "Kestrel Labs platform.", "topic");
    expect(search(db, "Kestrel  Labs", OPTIONS)[0]?.doc_id).toBe(exact);
  });

  test("searching a name returns the page called that before longer pages that mention it", () => {
    const db = searchDb();
    const filler = "Kestrel Labs builds storage tooling. ".repeat(40);
    const entity = indexRow(db, "entity", "orgs/kestrel.md", "Kestrel", `${filler}Founded by two engineers.`, "org");
    for (const index of [1, 2, 3]) {
      indexRow(db, `note-${index}`, `notes/kestrel-${index}.md`, `Kestrel note ${index}`, "Kestrel ships weekly.", "topic");
    }
    const hits = search(db, "Kestrel", OPTIONS);
    expect(hits.length).toBe(4);
    expect(hits[0]?.doc_id).toBe(entity);
  });

  test("the title match is case-insensitive and ignores surrounding space", () => {
    const db = searchDb();
    const entity = indexRow(db, "entity", "orgs/kestrel.md", "Kestrel", "Kestrel Labs.", "org");
    indexRow(db, "other", "notes/other.md", "Other", "Kestrel Kestrel Kestrel Kestrel Kestrel.", "topic");
    expect(search(db, "  kestrel ", OPTIONS)[0]?.doc_id).toBe(entity);
  });

  test("an exact question title keeps its boost when the query is relaxed", () => {
    const db = searchDb();
    const query = "What is the launch date?";
    const exact = indexRow(db, "exact", "notes/launch.md", query, "The launch date is March. ".repeat(80), "topic");
    indexRow(db, "other", "notes/other.md", "Launch date", "Launch date is April.", "topic");
    expect(search(db, query, OPTIONS)[0]?.doc_id).toBe(exact);
  });

  test("an exact Unicode title is preserved and surrounding title spaces are ignored", () => {
    const db = searchDb();
    const exact = indexRow(db, "exact", "notes/elan.md", " Élan ", "Élan launch notes. ".repeat(80), "topic");
    indexRow(db, "other", "notes/other.md", "Élan note", "Élan launch.", "topic");
    expect(search(db, "Élan", OPTIONS)[0]?.doc_id).toBe(exact);
  });
});

describe("machine-exhaust ranking", () => {
  const body = "Quarterly runway review covers hiring and burn.";

  test("a page the owner wrote outranks an identical loop-written page", () => {
    const db = searchDb();
    // The machine page sorts first on doc id, so only the weighting can demote it.
    const machine = indexRow(db, "a", "auto/notes/runway.md", "Runway review", body, "topic");
    const owner = indexRow(db, "b", "notes/runway.md", "Runway review", body, "topic");
    expect(search(db, "runway review hiring", OPTIONS).map((hit) => hit.doc_id)).toEqual([owner, machine]);
  });

  test("a daily brief and a rollup rank below an identical entity page", () => {
    const db = searchDb();
    const brief = indexRow(db, "a", "dashboards/brief-2026-09-17.md", "Runway review", body, "topic");
    const rollup = indexRow(db, "b", "notes/rollup.md", "Runway review", body, "rollup");
    const topic = indexRow(db, "c", "notes/topic.md", "Runway review", body, "topic");
    expect(search(db, "runway review hiring", OPTIONS).map((hit) => hit.doc_id)).toEqual([topic, brief, rollup]);
  });

  test("a clearly more relevant machine page still wins", () => {
    const db = searchDb();
    const machine = indexRow(db, "a", "auto/notes/gizmo.md", "Gizmo", "Gizmo gizmo gizmo gizmo.", "topic");
    indexRow(db, "b", "notes/passing.md", "Other", `${"Filler words about weather. ".repeat(60)}A gizmo appears once.`, "topic");
    expect(search(db, "gizmo", OPTIONS)[0]?.doc_id).toBe(machine);
  });
});

describe("machineOriginSql", () => {
  test("agrees with isMachineOriginPath", () => {
    const db = searchDb();
    const paths = [
      "auto/people/grace.md", "auto", "people/grace.md", "autograph.md", "Auto/x.md",
      "dashboards/brief-2026-09-17.md", "dashboards/weekly.md", "dashboards/brief-2026-09-17.md.bak",
    ];
    for (const path of paths) {
      const row = db.query<{ machine: number }, [string]>(`SELECT ${machineOriginSql("?1")} AS machine`).get(path)!;
      expect({ path, machine: row.machine === 1 }).toEqual({ path, machine: isMachineOriginPath(path) });
    }
  });
});
