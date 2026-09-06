import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite } from "../../src/canon/apply";
import { ownerEdited, resolveTarget } from "../../src/canon/arbiter";
import { createBudgetTracker } from "../../src/canon/budget";
import { initCanon } from "../../src/canon/schema";
import {
  CanonPageUnreadable,
  inspectPageIndex,
  pageIndexByPath,
  readPage,
  rebuildPageIndex,
} from "../../src/canon/store";
import { serializePage } from "../../src/vault/frontmatter";
import { listCanonPages } from "../../src/vault/pages";
import { hashBytes } from "../../src/vault/write";
import { canonFixture, putEvent, storeClaim } from "./helpers";
import type { CanonFixture } from "./helpers";

const fixtures: CanonFixture[] = [];

afterEach(() => {
  for (const item of fixtures.splice(0)) item.dispose();
});

describe("canon storage p1", () => {
  test("readPage treats a filesystem failure as unreadable, not missing", () => {
    const live = canonFixture();
    fixtures.push(live);
    mkdirSync(join(live.vault, "people", "grace.md"), { recursive: true });
    let error: unknown;
    try {
      readPage(live.io, "people/grace.md");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CanonPageUnreadable);
    expect((error as CanonPageUnreadable).code).toBe("EISDIR");
    expect(readPage(live.io, "people/missing.md")).toBeNull();
  });

  test("a write's after_hash is the hash of the bytes read back", async () => {
    const live = canonFixture();
    fixtures.push(live);
    const eventId = putEvent(live.db);
    const claim = await storeClaim(live.db, eventId);
    const receipt = applyCanonWrite(
      live.io,
      claim,
      { action: "create", rel_path: "people/grace.md" },
      { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }) },
    );
    const onDisk = readPage(live.io, "people/grace.md");
    expect(onDisk).not.toBeNull();
    if (onDisk === null) return;
    expect(receipt.after_hash).toBe(onDisk.hash);
    expect(receipt.after_hash).toBe(hashBytes(Buffer.from(onDisk.content, "utf8")));
    expect(onDisk.content).toBe(serializePage(onDisk.page));
    expect(inspectPageIndex(live.db)).toEqual([]);
  });

  test("doctor reports a page_index row whose last_receipt is gone", () => {
    const live = canonFixture();
    fixtures.push(live);
    initCanon(live.db);
    live.db
      .query(
        `INSERT INTO page_index (page_id, rel_path, subject_key, last_receipt, last_hash)
         VALUES ('page-1', 'people/grace.md', null, 'receipt-missing', 'abc')`,
      )
      .run();
    expect(inspectPageIndex(live.db)).toEqual(["page_index last_receipt missing"]);
  });

  test("rebuild keeps last_hash on the receipt so a hand edit is not index drift", async () => {
    const live = canonFixture();
    fixtures.push(live);
    const eventId = putEvent(live.db);
    const claim = await storeClaim(live.db, eventId);
    const receipt = applyCanonWrite(
      live.io,
      claim,
      { action: "create", rel_path: "people/grace.md" },
      { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }) },
    );
    const path = join(live.vault, receipt.page_path);
    writeFileSync(path, `${readFileSync(path, "utf8")}\nOwner hand edit.\n`);
    expect(ownerEdited(live.io, receipt.page_path)).toBe(true);

    const rebuilt = rebuildPageIndex(live.io);
    expect(rebuilt.pages).toBe(1);
    const indexed = pageIndexByPath(live.db, receipt.page_path);
    expect(indexed?.last_receipt).toBe(receipt.receipt_id);
    expect(indexed?.last_hash).toBe(receipt.after_hash);
    expect(indexed?.last_hash).not.toBe(hashBytes(readFileSync(path)));
    expect(inspectPageIndex(live.db)).toEqual([]);
    expect(ownerEdited(live.io, receipt.page_path)).toBe(true);
  });

  test("rebuild keeps a schema-invalid page so the arbiter cannot fork it", async () => {
    const live = canonFixture();
    fixtures.push(live);
    mkdirSync(join(live.vault, "people"));
    writeFileSync(
      join(live.vault, "people", "grace.md"),
      serializePage({
        data: {
          id: "hand:grace",
          title: "Grace",
          type: "person",
          status: "active",
          sensitivity: "personal",
          "x-subject-id": "person:grace",
        },
        body: "Hand-written page missing taint.\n",
      }),
    );

    const rebuilt = rebuildPageIndex(live.io);
    expect(rebuilt.pages).toBe(1);
    expect(listCanonPages(live.vault)).toEqual([]);
    const indexed = pageIndexByPath(live.db, "people/grace.md");
    expect(indexed?.page_id).toBe("hand:grace");
    expect(indexed?.subject_key).toBe("person:grace");
    expect(ownerEdited(live.io, "people/grace.md")).toBe(true);

    const claim = await storeClaim(live.db, putEvent(live.db), {
      target: "people/grace-alias",
    });
    expect(resolveTarget(live.io, claim)).toEqual({ action: "skip", reason: "owner_edited_body" });
  });

  test("rebuild refuses an incomplete walk and leaves the existing index", async () => {
    const live = canonFixture();
    fixtures.push(live);
    const eventId = putEvent(live.db);
    const claim = await storeClaim(live.db, eventId);
    const receipt = applyCanonWrite(
      live.io,
      claim,
      { action: "create", rel_path: "people/grace.md" },
      { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }) },
    );
    expect(rebuildPageIndex(live.io).pages).toBe(1);

    symlinkSync(join(live.vault, "people", "grace.md"), join(live.vault, "people", "alias.md"));
    expect(() => rebuildPageIndex(live.io)).toThrow(/page index rebuild refused/);
    const onDiskId = readPage(live.io, receipt.page_path)?.page.data["id"];
    expect(typeof onDiskId).toBe("string");
    if (typeof onDiskId !== "string") return;
    expect(pageIndexByPath(live.db, receipt.page_path)?.page_id).toBe(onDiskId);
  });

  test("rebuild refuses when a schema-invalid copy shares a live page id", async () => {
    const live = canonFixture();
    fixtures.push(live);
    const receipt = applyCanonWrite(
      live.io,
      await storeClaim(live.db, putEvent(live.db)),
      { action: "create", rel_path: "people/grace.md" },
      { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }) },
    );
    const existing = readPage(live.io, receipt.page_path);
    const id = existing?.page.data["id"];
    expect(typeof id).toBe("string");
    if (typeof id !== "string") return;
    expect(rebuildPageIndex(live.io).pages).toBe(1);

    writeFileSync(
      join(live.vault, "people", "fork.md"),
      serializePage({
        data: {
          id,
          title: "Fork",
          type: "person",
          status: "active",
          sensitivity: "personal",
          "x-subject-id": "person:grace",
        },
        body: "Invalid duplicate.\n",
      }),
    );

    expect(() => rebuildPageIndex(live.io)).toThrow(/page index rebuild refused/);
    expect(pageIndexByPath(live.db, receipt.page_path)?.page_id).toBe(id);
  });
});
