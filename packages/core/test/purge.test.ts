import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureEventInput } from "../src/contracts/event";
import { initGraph } from "../src/graph/schema";
import { openLedger } from "../src/ledger/db";
import { accept, count, readSince } from "../src/ledger/ledger";
import {
  PURGE_REASON_MAX_BYTES,
  PurgeError,
  isHeld,
  listHistoricalConnectorIds,
  normalizePurgeReason,
  previewPurge,
  purgeEvents,
  resolvePurgeConnectorId,
  runPurge,
} from "../src/ledger/purge";
import { tableExists } from "../src/ledger/schema";
import { indexEvent } from "../src/search/indexer";
import { initSearch } from "../src/search/schema";
import {
  fileProposal,
  getProposal,
  initStaging,
} from "../src/staging/proposals";
import { serializePage } from "../src/vault/frontmatter";
import { initVault } from "../src/vault/init";
import { validEvent } from "./fixtures";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const directories: string[] = [];

function temporaryVault(): string {
  const path = mkdtempSync(join(tmpdir(), "kizuki-purge-vault-"));
  directories.push(path);
  initVault(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
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
      temporaryVault(),
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
      temporaryVault(),
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
      temporaryVault(),
      { subject_handle: "person:grace" },
      "subject request",
    ).receipts;
    expect(receipts.map(({ event_id }) => event_id)).toEqual([matching.event_id]);
    expect(readSince(db, null, 10).events.map(
      ({ source_record_id }) => source_record_id,
    )).toEqual(["other"]);
    db.close();
  });

  test("rejects an empty filter and treats no matches as a non-success", () => {
    const db = openLedger(":memory:");
    storedEvent(db, validEvent());
    const vaultPath = temporaryVault();
    expect(() => purgeEvents(db, vaultPath, {}, "unsafe")).toThrow(PurgeError);
    expect(() => purgeEvents(db, vaultPath, {}, "unsafe")).toThrow("filter");
    try {
      purgeEvents(db, vaultPath, { connector_id: "missing" }, "no match");
      throw new Error("expected no_match");
    } catch (error) {
      expect(error).toBeInstanceOf(PurgeError);
      expect((error as PurgeError).code).toBe("no_match");
      expect((error as PurgeError).message).toContain("connector_id=missing");
    }
    expect(
      purgeEvents(
        db,
        vaultPath,
        { connector_id: "missing" },
        "no match",
        { allow_empty: true },
      ),
    ).toEqual({
      receipts: [],
      withdrawn_proposals: [],
      canon_holds: [],
      purge_ops: [],
      rewritten: [],
      uncertain_pages: [],
    });
    expect(count(db)).toBe(1);
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM event_purges").get(),
    ).toEqual({ n: 0 });
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
      temporaryVault(),
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

  test("holds an unreadable page and still deletes matching events", async () => {
    const db = openLedger(":memory:");
    const target = storedEvent(db, event("target"));
    const vaultPath = temporaryVault();
    writeFileSync(join(vaultPath, "facts", "orphan.md"), "no frontmatter\n");
    const outcome = await runPurge(
      db,
      vaultPath,
      { event_id: target.event_id },
      "record request",
    );
    expect(outcome.receipts.map(({ event_id }) => event_id)).toEqual([
      target.event_id,
    ]);
    expect(outcome.uncertain_pages).toEqual(["facts/orphan.md"]);
    expect(outcome.canon_holds.map(({ page_path }) => page_path)).toEqual([
      "facts/orphan.md",
    ]);
    expect(outcome.rewritten).toEqual([]);
    expect(count(db)).toBe(0);
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM event_purges").get(),
    ).toEqual({ n: 1 });
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_holds").get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  test("does not rewrite uncertain pages or lift their holds", async () => {
    const db = openLedger(":memory:");
    const target = storedEvent(db, event("target"));
    const vaultPath = temporaryVault();
    writeFileSync(
      join(vaultPath, "facts", "bad-sources.md"),
      [
        "---",
        "id: page-bad-sources",
        "title: bad",
        "type: fact",
        "status: active",
        "sensitivity: personal",
        "taint: clean",
        "sources: 123",
        "---",
        "",
        "unreadable sources\n",
      ].join("\n"),
    );
    writeFileSync(
      join(vaultPath, "facts", "first.md"),
      serializePage({
        data: {
          id: "page-dup",
          title: "first",
          type: "fact",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
          sources: ["unrelated"],
        },
        body: "first copy\n",
      }),
      "utf8",
    );
    writeFileSync(
      join(vaultPath, "facts", "second.md"),
      serializePage({
        data: {
          id: "page-dup",
          title: "second",
          type: "fact",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
          sources: [target.event_id],
        },
        body: "duplicate copy\n",
      }),
      "utf8",
    );
    const outcome = await runPurge(
      db,
      vaultPath,
      { event_id: target.event_id },
      "record request",
    );
    expect(outcome.receipts.map(({ event_id }) => event_id)).toEqual([
      target.event_id,
    ]);
    expect(outcome.uncertain_pages.sort()).toEqual([
      "facts/bad-sources.md",
      "facts/second.md",
    ]);
    expect(outcome.rewritten.map(({ page_path }) => page_path)).toEqual([
      "facts/second.md",
    ]);
    expect(
      db
        .query<{ page_path: string }, []>(
          "SELECT page_path FROM canon_holds ORDER BY page_path",
        )
        .all()
        .map(({ page_path }) => page_path),
    ).toEqual(["facts/bad-sources.md"]);
    expect(readFileSync(join(vaultPath, "facts", "second.md"), "utf8")).not.toContain(
      target.event_id,
    );
    db.close();
  });

  test("a later purge does not lift an unreadable hold with the new event ids", async () => {
    const db = openLedger(":memory:");
    const first = storedEvent(db, event("first"));
    const vaultPath = temporaryVault();
    writeFileSync(join(vaultPath, "facts", "orphan.md"), "no frontmatter\n");
    await runPurge(db, vaultPath, { event_id: first.event_id }, "record request");
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_holds").get(),
    ).toEqual({ n: 1 });

    const second = storedEvent(db, event("second"));
    const later = await runPurge(
      db,
      vaultPath,
      { event_id: second.event_id },
      "later request",
    );
    expect(later.rewritten).toEqual([]);
    expect(isHeld(db, "facts/orphan.md")).toBe(true);
    expect(readFileSync(join(vaultPath, "facts", "orphan.md"), "utf8")).toBe(
      "no frontmatter\n",
    );
    db.close();
  });

  test("a repaired hold is rewritten from event_purges, not the later selector", async () => {
    const db = openLedger(":memory:");
    const first = storedEvent(db, event("first"));
    const vaultPath = temporaryVault();
    writeFileSync(
      join(vaultPath, "facts", "held.md"),
      [
        "---",
        "id: page-held",
        "title: held",
        "type: fact",
        "status: active",
        "sensitivity: personal",
        "taint: clean",
        "sources: 123",
        "---",
        "",
        "blocked\n",
      ].join("\n"),
    );
    await runPurge(db, vaultPath, { event_id: first.event_id }, "record request");
    writeFileSync(
      join(vaultPath, "facts", "held.md"),
      serializePage({
        data: {
          id: "page-held",
          title: "held",
          type: "fact",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
          sources: [first.event_id],
        },
        body: "repaired\n",
      }),
      "utf8",
    );
    const second = storedEvent(db, event("second"));
    const later = await runPurge(
      db,
      vaultPath,
      { event_id: second.event_id },
      "later request",
    );
    expect(later.rewritten.map(({ page_path }) => page_path)).toEqual([
      "facts/held.md",
    ]);
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_holds").get(),
    ).toEqual({ n: 0 });
    const page = readFileSync(join(vaultPath, "facts", "held.md"), "utf8");
    expect(page).not.toContain(first.event_id);
    expect(page).not.toContain(second.event_id);
    db.close();
  });

  test("does not lift a hold on an id-less page with no sources", async () => {
    const db = openLedger(":memory:");
    const target = storedEvent(db, event("target"));
    const vaultPath = temporaryVault();
    const raw = [
      "---",
      "title: noid",
      "type: fact",
      "status: active",
      "sensitivity: personal",
      "taint: clean",
      "---",
      "",
      "id-less page\n",
    ].join("\n");
    writeFileSync(join(vaultPath, "facts", "noid.md"), raw);
    const outcome = await runPurge(
      db,
      vaultPath,
      { event_id: target.event_id },
      "record request",
    );
    expect(outcome.uncertain_pages).toEqual(["facts/noid.md"]);
    expect(outcome.rewritten).toEqual([]);
    expect(isHeld(db, "facts/noid.md")).toBe(true);
    expect(readFileSync(join(vaultPath, "facts", "noid.md"), "utf8")).toBe(raw);
    db.close();
  });

  test("does not lift a hold when the held file is missing", async () => {
    const db = openLedger(":memory:");
    const first = storedEvent(db, event("first"));
    const vaultPath = temporaryVault();
    writeFileSync(join(vaultPath, "facts", "gone.md"), "no frontmatter\n");
    await runPurge(db, vaultPath, { event_id: first.event_id }, "record request");
    expect(isHeld(db, "facts/gone.md")).toBe(true);
    rmSync(join(vaultPath, "facts", "gone.md"));

    const second = storedEvent(db, event("second"));
    const later = await runPurge(
      db,
      vaultPath,
      { event_id: second.event_id },
      "later request",
    );
    expect(later.rewritten).toEqual([]);
    expect(isHeld(db, "facts/gone.md")).toBe(true);
    db.close();
  });

  test("lifts a leftover hold once the page is readable and cites nothing purged", async () => {
    const db = openLedger(":memory:");
    const first = storedEvent(db, event("first"));
    const vaultPath = temporaryVault();
    writeFileSync(join(vaultPath, "facts", "held.md"), "no frontmatter\n");
    await runPurge(db, vaultPath, { event_id: first.event_id }, "record request");
    writeFileSync(
      join(vaultPath, "facts", "held.md"),
      serializePage({
        data: {
          id: "page-held",
          title: "held",
          type: "fact",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
          sources: [],
        },
        body: "clean\n",
      }),
      "utf8",
    );
    const second = storedEvent(db, event("second"));
    const later = await runPurge(
      db,
      vaultPath,
      { event_id: second.event_id },
      "later request",
    );
    expect(later.rewritten).toEqual([]);
    expect(isHeld(db, "facts/held.md")).toBe(false);
    expect(readFileSync(join(vaultPath, "facts", "held.md"), "utf8")).toContain(
      "clean",
    );
    db.close();
  });

  test("removes matching derived search and graph rows through real schemas", () => {
    const db = openLedger(":memory:");
    const source = storedEvent(db, event("search-source"));
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
      temporaryVault(),
      { event_id: source.event_id },
      "source erased",
    );
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM search_docs").get(),
    ).toEqual({ count: 0 });
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM graph_edges").get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  test("does not create search or graph tables on a ledger-only vault", () => {
    const db = openLedger(":memory:");
    const target = storedEvent(db, event("target"));
    const vaultPath = temporaryVault();
    expect(tableExists(db, "search_docs")).toBe(false);
    expect(tableExists(db, "graph_edges")).toBe(false);
    const outcome = purgeEvents(
      db,
      vaultPath,
      { event_id: target.event_id },
      "record request",
    );
    expect(outcome.receipts).toHaveLength(1);
    expect(outcome.purge_ops).toEqual([]);
    expect(tableExists(db, "search_docs")).toBe(false);
    expect(tableExists(db, "graph_edges")).toBe(false);
    expect(
      existsSync(
        join(
          vaultPath,
          ".kizuki",
          "retrieval",
          "kizuki.retrieval.fts5",
          "store",
          "retrieval.db",
        ),
      ),
    ).toBe(false);
    db.close();
  });

  test("requires a bounded non-empty reason", () => {
    expect(() => normalizePurgeReason("")).toThrow(PurgeError);
    expect(() => normalizePurgeReason("   ")).toThrow("non-empty");
    expect(() => normalizePurgeReason("line\nbreak")).toThrow("control");
    expect(() => normalizePurgeReason("a".repeat(PURGE_REASON_MAX_BYTES + 1))).toThrow(
      "UTF-8",
    );
    expect(normalizePurgeReason("  owner request  ")).toBe("owner request");
    const db = openLedger(":memory:");
    storedEvent(db, event("target"));
    const vaultPath = temporaryVault();
    expect(() => purgeEvents(db, vaultPath, { connector_id: "mail" }, "")).toThrow(
      PurgeError,
    );
    expect(count(db)).toBe(1);
    db.close();
  });

  test("resolves retired connector ids from the ledger, not a registry", () => {
    const db = openLedger(":memory:");
    storedEvent(db, event("retired", { connector_id: "retired.mail" }));
    storedEvent(db, event("folder", { connector_id: "kizuki.markdown-folder" }));
    expect(listHistoricalConnectorIds(db)).toEqual([
      "kizuki.markdown-folder",
      "retired.mail",
    ]);
    expect(resolvePurgeConnectorId(db, "retired.mail")).toBe("retired.mail");
    expect(resolvePurgeConnectorId(db, "markdown-folder")).toBe(
      "kizuki.markdown-folder",
    );
    const receipts = purgeEvents(
      db,
      temporaryVault(),
      { connector_id: resolvePurgeConnectorId(db, "retired.mail") },
      "connector removed",
    ).receipts;
    expect(receipts.map(({ connector_id }) => connector_id)).toEqual(["retired.mail"]);
    expect(count(db)).toBe(1);
    db.close();
  });

  test("preview reports a bounded plan without writing", () => {
    const db = openLedger(":memory:");
    const first = storedEvent(db, event("a", { connector_id: "mail" }));
    storedEvent(db, event("b", { connector_id: "mail" }));
    storedEvent(db, event("keep", { connector_id: "calendar" }));
    const vaultPath = temporaryVault();
    const preview = previewPurge(
      db,
      vaultPath,
      { connector_id: "mail" },
      "  account erased  ",
    );
    expect(preview.reason).toBe("account erased");
    expect(preview.event_count).toBe(2);
    expect(preview.event_ids).toContain(first.event_id);
    expect(preview.connector_ids).toEqual(["mail"]);
    expect(preview.search).toBe("not_configured");
    expect(preview.graph).toBe("not_configured");
    expect(preview.retrieval).toBe("not_configured");
    expect(count(db)).toBe(3);
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM event_purges").get(),
    ).toEqual({ n: 0 });
    db.close();
  });

  test("matches page sources with a set, not a nested scan", () => {
    const db = openLedger(":memory:");
    const vaultPath = temporaryVault();
    const purged: string[] = [];
    for (let index = 0; index < 80; index += 1) {
      purged.push(
        storedEvent(db, event(`mail-${index}`, { connector_id: "mail" })).event_id,
      );
    }
    storedEvent(db, event("keep", { connector_id: "calendar" }));
    const wanted = new Set(purged);
    writeFileSync(
      join(vaultPath, "facts", "hub.md"),
      serializePage({
        data: {
          id: "page-hub",
          title: "hub",
          type: "fact",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
          sources: ["unrelated", purged[purged.length - 1]],
        },
        body: "hub page\n",
      }),
      "utf8",
    );
    const started = performance.now();
    const outcome = purgeEvents(
      db,
      vaultPath,
      { connector_id: "mail" },
      "account erased",
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(outcome.receipts).toHaveLength(80);
    expect(outcome.canon_holds.map(({ page_path }) => page_path)).toEqual([
      "facts/hub.md",
    ]);
    expect(count(db)).toBe(1);
    expect(
      db
        .query<{ event_id: string }, []>("SELECT event_id FROM events")
        .all()
        .every((row) => !wanted.has(row.event_id)),
    ).toBe(true);
    db.close();
  });
});
