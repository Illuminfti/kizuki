import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getClaim } from "../../src/claims/store";
import { snapshotCanonIo, withCanonMutationAsync } from "../../src/canon/io";
import {
  restoreReturnedSources,
  returnedSourceArchives,
} from "../../src/canon/source-restore";
import { accept } from "../../src/ledger/ledger";
import {
  cascadeTombstone,
  proposalsForEvent,
} from "../../src/staging/producers";
import { fileProposal, listProposals } from "../../src/staging/proposals";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { documentEvent } from "../fixtures";
import { openLedger } from "../../src/ledger/db";
import { tempVault } from "../helpers/vault";
import { ulid } from "../../src/util/ulid";
import { canonFixture, write, type CanonFixture } from "./helpers";

/**
 * A source that deletes a record and then has it again: the page its deletion
 * archived comes back, through the same receipted writer, and only while the
 * page is still exactly what the archive left.
 */

function statusOf(fixture: CanonFixture, pagePath: string): unknown {
  return parseFrontmatter(readFileSync(join(fixture.vault, pagePath), "utf8"))
    .data["status"];
}

function setup() {
  const fixture = canonFixture();
  const accepted = accept(fixture.db, documentEvent());
  if (accepted.status !== "stored") throw new Error("source admission failed");
  const proposal = fileProposal(
    fixture.db,
    proposalsForEvent(accepted.event).find((item) => item.kind === "claim")!,
  ).proposal;
  const created = write(
    fixture.io,
    getClaim(fixture.db, proposal.proposal_id)!,
  );
  const original = readFileSync(join(fixture.vault, created.page_path), "utf8");
  return { fixture, created, original };
}

function deleteRecord(fixture: CanonFixture, text: string): string {
  const deleted = accept(fixture.db, { ...documentEvent(), deleted: true, text });
  if (deleted.status !== "stored")
    throw new Error("tombstone admission failed");
  expect(
    cascadeTombstone(fixture.db, deleted.event, fixture.io).retractions_filed,
  ).toHaveLength(1);
  const deletion = listProposals(fixture.db, { kind: "deletion" }).at(-1)!;
  return write(fixture.io, getClaim(fixture.db, deletion.proposal_id)!)
    .receipt_id;
}

function returnRecord(fixture: CanonFixture, epoch: number): void {
  const restored = accept(fixture.db, {
    ...documentEvent(),
    metadata: { ...documentEvent().metadata, revision_epoch: epoch },
  });
  if (restored.status !== "stored")
    throw new Error("restored record was swallowed as a duplicate");
}

const restore = (fixture: CanonFixture) =>
  withCanonMutationAsync(snapshotCanonIo(fixture.io), (scope, owned) =>
    restoreReturnedSources(scope, owned, 32),
  );

describe("a returned source record un-archives its page", () => {
  test("a full window of edited archives cannot starve a later returned page across restarts", async () => {
    const temporary = tempVault("kizuki-restore-progress-");
    writeFileSync(join(temporary.path, ".kizuki", "serve.toml"), "[budget]\ncanon_writes_per_day = 1024\n");
    const dbPath = join(temporary.path, ".kizuki", "kizuki.db");
    const db = openLedger(":memory:");
    const fixture = { db, vault: temporary.path, io: { db, vault_path: temporary.path }, dispose: temporary.dispose };
    try {
      const archive = (record: string) => {
        const input = { ...documentEvent(), source_record_id: record, text: `body ${record}` };
        const accepted = accept(fixture.db, input);
        if (accepted.status !== "stored") throw new Error("source admission failed");
        const proposal = fileProposal(fixture.db, {
          kind: "claim", target: `sources/${record}`, body: input.text,
          frontmatter: { type: "source", title: record },
          provenance: [accepted.event.event_id], producer: "deterministic", confidence: 1,
        }).proposal;
        const created = write(fixture.io, getClaim(fixture.db, proposal.proposal_id)!);
        const deletion = accept(fixture.db, { ...input, text: "", deleted: true });
        if (deletion.status !== "stored") throw new Error("tombstone admission failed");
        const cascade = cascadeTombstone(fixture.db, deletion.event, fixture.io);
        expect(cascade.retractions_filed).toHaveLength(1);
        const receipt = write(fixture.io, getClaim(fixture.db, cascade.retractions_filed[0]!)!);
        expect(accept(fixture.db, { ...input, metadata: { revision_epoch: 2 } }).status).toBe("stored");
        return { path: created.page_path, receipt, claim: cascade.retractions_filed[0]! };
      };
      const first = archive("first");
      const firstPath = join(fixture.vault, first.path);
      const firstArchive = readFileSync(firstPath, "utf8");
      writeFileSync(firstPath, `${firstArchive}\nOwner note.\n`);

      // Seed the already-edited inventory from one real archive. Only the
      // two pages this test actually restores need full writer histories;
      // 514 fixture writes would measure receipt materialization, not scan
      // progress. Every seeded entry has changed bytes and must be kept.
      type Row = Record<string, string | number | null>;
      const receiptRow = db.query<Row, [string]>("SELECT * FROM canon_receipts WHERE receipt_id = ?").get(first.receipt.receipt_id)!;
      const claimRow = db.query<Row, [string]>("SELECT * FROM claims WHERE claim_id = ?").get(first.claim)!;
      const insert = (table: "canon_receipts" | "claims", row: Row) => {
        db.query(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
          .run(...Object.values(row));
      };
      db.transaction(() => {
        for (let index = 1; index < 256; index++) {
          const receiptId = ulid(), claimId = ulid(), pageId = ulid();
          const pagePath = `sources/held-${index}.md`;
          insert("canon_receipts", { ...receiptRow, receipt_id: receiptId, page_path: pagePath, claim_ids: JSON.stringify([claimId]) });
          insert("claims", { ...claimRow, claim_id: claimId, receipt_id: receiptId, target: pagePath.slice(0, -3), content_hash: "" });
          db.query("INSERT INTO page_index (page_id,rel_path,last_receipt,last_hash) VALUES (?,?,?,?)")
            .run(pageId, pagePath, receiptId, first.receipt.after_hash);
          writeFileSync(join(fixture.vault, pagePath), `${firstArchive}\nOwner note ${index}.\n`, { mode: 0o600 });
        }
      })();
      const untouched = archive("last").path;
      // Each invocation is bounded. Progress belongs to the ledger, so a new
      // IO snapshot (as after a restart) resumes beyond the edited prefix.
      expect(await restore(fixture)).toEqual({ restored: 0, kept: 256 });
      writeFileSync(dbPath, fixture.db.serialize());
      fixture.db.close();
      fixture.db = openLedger(dbPath);
      fixture.io = { db: fixture.db, vault_path: fixture.vault };
      expect(await restore(fixture)).toEqual({ restored: 1, kept: 0 });
      expect(statusOf(fixture, untouched)).toBe("active");
      // Progress cycles: restoring an edited page's archived bytes makes it
      // eligible again, rather than permanently skipping it.
      writeFileSync(firstPath, firstArchive);
      expect(await restore(fixture)).toEqual({ restored: 1, kept: 255 });
    } finally {
      fixture.db.close();
      temporary.dispose();
    }
  });
  test("delete then restore identical bytes leaves the page active with its original bytes", async () => {
    const { fixture, created, original } = setup();
    try {
      deleteRecord(fixture, "synthetic deletion one");
      expect(statusOf(fixture, created.page_path)).toBe("archived");
      // Still deleted at the source: nothing to restore.
      expect(returnedSourceArchives(fixture.db, 32)).toEqual([]);
      expect(await restore(fixture)).toEqual({ restored: 0, kept: 0 });

      returnRecord(fixture, 2);
      expect(returnedSourceArchives(fixture.db, 32)).toHaveLength(1);
      expect(await restore(fixture)).toEqual({ restored: 1, kept: 0 });
      expect(readFileSync(join(fixture.vault, created.page_path), "utf8")).toBe(
        original,
      );
      expect(statusOf(fixture, created.page_path)).toBe("active");
      // Once is enough; the next pass finds nothing to do.
      expect(await restore(fixture)).toEqual({ restored: 0, kept: 0 });
    } finally {
      fixture.dispose();
    }
  });

  test("the record can be deleted, restored and deleted again", async () => {
    const { fixture, created } = setup();
    try {
      deleteRecord(fixture, "synthetic deletion one");
      returnRecord(fixture, 2);
      await restore(fixture);
      expect(statusOf(fixture, created.page_path)).toBe("active");

      deleteRecord(fixture, "synthetic deletion two");
      expect(statusOf(fixture, created.page_path)).toBe("archived");
      returnRecord(fixture, 4);
      expect(await restore(fixture)).toEqual({ restored: 1, kept: 0 });
      expect(statusOf(fixture, created.page_path)).toBe("active");
    } finally {
      fixture.dispose();
    }
  });

  test("a page edited since it was archived stays as it is", async () => {
    const { fixture, created } = setup();
    try {
      deleteRecord(fixture, "synthetic deletion one");
      const path = join(fixture.vault, created.page_path);
      const edited = `${readFileSync(path, "utf8")}\nOwner note.\n`;
      writeFileSync(path, edited);
      returnRecord(fixture, 2);
      expect(await restore(fixture)).toEqual({ restored: 0, kept: 1 });
      expect(readFileSync(path, "utf8")).toBe(edited);
    } finally {
      fixture.dispose();
    }
  });

  test("a deletion of a different record is not undone by an unrelated record returning", async () => {
    const { fixture, created } = setup();
    try {
      deleteRecord(fixture, "synthetic deletion one");
      const other = accept(fixture.db, {
        ...documentEvent(),
        source_record_id: "other-record",
        text: "another record",
      });
      expect(other.status).toBe("stored");
      expect(await restore(fixture)).toEqual({ restored: 0, kept: 0 });
      expect(statusOf(fixture, created.page_path)).toBe("archived");
    } finally {
      fixture.dispose();
    }
  });
});
