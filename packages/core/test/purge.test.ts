import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureEventInput } from "../src/contracts/event";
import { neighbors } from "../src/graph/graph";
import { initGraph } from "../src/graph/schema";
import { openLedger } from "../src/ledger/db";
import { accept, count, readSince } from "../src/ledger/ledger";
import { purgeEvents } from "../src/ledger/purge";
import { indexEvent } from "../src/search/indexer";
import { search } from "../src/search/query";
import { initSearch } from "../src/search/schema";
import {
  fileProposal,
  getProposal,
  initStaging,
} from "../src/staging/proposals";
import { validEvent } from "./fixtures";
import { tempVault } from "./helpers/vault";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const disposers: (() => void)[] = [];

function vault(): string {
  const created = tempVault("kizuki-purge-vault-");
  disposers.push(created.dispose);
  return created.path;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function event(
  sourceRecordId: string,
  overrides: Partial<CaptureEventInput> = {},
): CaptureEventInput {
  return { ...validEvent(), source_record_id: sourceRecordId, ...overrides };
}

function storedEvent(db: Database, input: CaptureEventInput) {
  const result = accept(db, input);
  if (result.status !== "stored") throw new Error("expected stored event");
  return result.event;
}

describe("purgeEvents", () => {
  test("purges one event by event_id", () => {
    const db = openLedger(":memory:");
    const target = storedEvent(db, event("target"));
    storedEvent(db, event("keep"));
    const outcome = purgeEvents(
      db,
      vault(),
      { event_id: target.event_id },
      "record request",
    );
    expect(outcome.receipts.map(({ event_id }) => event_id)).toEqual([
      target.event_id,
    ]);
    expect(readSince(db, null, 10).events.map(
      ({ source_record_id }) => source_record_id,
    )).toEqual(["keep"]);
    db.close();
  });

  test("purges by connector and persists one receipt per event", () => {
    const db = openLedger(":memory:");
    storedEvent(db, event("a", { connector_id: "mail" }));
    storedEvent(db, event("b", { connector_id: "mail" }));
    storedEvent(db, event("c", { connector_id: "calendar" }));
    const receipts = purgeEvents(
      db,
      vault(),
      { connector_id: "mail" },
      "account erased",
    ).receipts;
    expect(receipts).toHaveLength(2);
    expect(receipts.every(({ receipt_id }) => ULID.test(receipt_id))).toBe(true);
    expect(receipts.every(({ connector_id }) => connector_id === "mail")).toBe(true);
    expect(count(db)).toBe(1);
    expect(
      db
        .query<{ receipt_id: string }, []>(
          "SELECT receipt_id FROM event_purges ORDER BY receipt_id",
        )
        .all()
        .map(({ receipt_id }) => receipt_id),
    ).toEqual(receipts.map(({ receipt_id }) => receipt_id).sort());
    db.close();
  });

  test("purges only events matching a subject handle", () => {
    const db = openLedger(":memory:");
    const matching = storedEvent(db, event("matching", {
      subjects: [{ subject_id: "person:grace", role: "about" }],
    }));
    storedEvent(db, event("other", {
      subjects: [{ subject_id: "person:ada", role: "about" }],
    }));
    const receipts = purgeEvents(
      db,
      vault(),
      { subject_handle: "person:grace" },
      "subject request",
    ).receipts;
    expect(receipts.map(({ event_id }) => event_id)).toEqual([matching.event_id]);
    expect(readSince(db, null, 10).events.map(
      ({ source_record_id }) => source_record_id,
    )).toEqual(["other"]);
    db.close();
  });

  test("rejects an empty filter and returns an empty outcome for no matches", () => {
    const db = openLedger(":memory:");
    storedEvent(db, validEvent());
    const vaultPath = vault();
    expect(() => purgeEvents(db, vaultPath, {}, "unsafe")).toThrow("filter");
    expect(
      purgeEvents(db, vaultPath, { connector_id: "missing" }, "no match"),
    ).toEqual({ receipts: [], withdrawn_proposals: [], canon_holds: [] });
    expect(count(db)).toBe(1);
    db.close();
  });

  test("withdraws pending proposals citing purged events and leaves others", () => {
    const db = openLedger(":memory:");
    initStaging(db);
    const purged = storedEvent(db, event("purged"));
    const kept = storedEvent(db, event("kept"));
    const citingPurged = fileProposal(db, {
      kind: "claim",
      body: "purged proposal",
      frontmatter: { type: "fact", title: "Purged" },
      provenance: [purged.event_id],
      producer: "deterministic",
      confidence: 1,
    });
    const citingKept = fileProposal(db, {
      kind: "claim",
      body: "kept proposal",
      frontmatter: { type: "fact", title: "Kept" },
      provenance: [kept.event_id],
      producer: "deterministic",
      confidence: 1,
    });
    if (citingPurged.outcome !== "stored" || citingKept.outcome !== "stored") {
      throw new Error("expected stored proposals");
    }
    const outcome = purgeEvents(
      db,
      vault(),
      { event_id: purged.event_id },
      "source erased",
    );
    expect(outcome.withdrawn_proposals).toEqual([
      citingPurged.proposal.proposal_id,
    ]);
    expect(getProposal(db, citingPurged.proposal.proposal_id)?.status).toBe(
      "withdrawn",
    );
    expect(getProposal(db, citingKept.proposal.proposal_id)?.status).toBe("pending");
    db.close();
  });

  test("refuses to purge while a canon page cannot be read", () => {
    const db = openLedger(":memory:");
    const target = storedEvent(db, event("target"));
    const vaultPath = vault();
    writeFileSync(join(vaultPath, "facts", "orphan.md"), "no frontmatter\n");
    expect(() =>
      purgeEvents(db, vaultPath, { event_id: target.event_id }, "record request"),
    ).toThrow(/purge refused/);
    expect(count(db)).toBe(1);
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM event_purges").get(),
    ).toEqual({ n: 0 });
    db.close();
  });

  test("removes matching derived search and graph rows through real schemas", () => {
    const db = openLedger(":memory:");
    const source = storedEvent(
      db,
      event("search-source", { text: "purgeable phrase" }),
    );
    initSearch(db);
    initGraph(db);
    indexEvent(db, source);
    db.query(
      "INSERT INTO graph_edges (src, dst, kind) VALUES (?, ?, ?), (?, ?, ?)",
    ).run(
      "fact:one",
      source.event_id,
      "source",
      source.event_id,
      "fact:two",
      "source",
    );
    purgeEvents(
      db,
      vault(),
      { event_id: source.event_id },
      "source erased",
    );
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM search_docs").get(),
    ).toEqual({ count: 0 });
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM graph_edges").get(),
    ).toEqual({ count: 0 });
    // The rows are gone from the public readers too, at every ceiling.
    expect(search(db, "purgeable")).toEqual([]);
    expect(search(db, "purgeable", { ceiling: "private" })).toEqual([]);
    expect(neighbors(db, "fact:one").edges).toEqual([]);
    db.close();
  });
});
