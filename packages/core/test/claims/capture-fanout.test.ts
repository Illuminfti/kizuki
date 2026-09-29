import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Claim } from "../../src/contracts/proposal";
import {
  CAPTURE_FANOUT_SKIP_REASON,
  SKIP_REASON_KEY,
  countCaptureFanout,
  isCaptureFanoutSkip,
  skipCaptureFanoutClaims,
} from "../../src/claims/capture-fanout";
import {
  getClaim,
  listUnwrittenLiveClaims,
  reviveUncontestedSkipped,
} from "../../src/claims/store";
import { countCanonReceipts } from "../../src/canon/receipts";
import { canonFixture, putEvent, storeClaim, write } from "../canon/helpers";

const AT = "2026-09-29T10:00:00.000Z";
const fixtures: ReturnType<typeof canonFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function fixture() {
  const f = canonFixture();
  fixtures.push(f);
  return f;
}

/** A capture note in the shape earlier revisions filed for a conversational event. */
async function legacyNote(
  f: ReturnType<typeof canonFixture>,
  index: number,
  overrides: { kind?: string; target?: string; connector?: string } = {},
): Promise<Claim> {
  const eventId = putEvent(f.db, {
    source_record_id: `session-1/${index}`,
    text: `turn ${index}`,
  });
  const connector = overrides.connector ?? "session-connector";
  return storeClaim(f.db, eventId, {
    kind: "claim",
    target: overrides.target ?? `captures/${connector}/2026-09-01`,
    subject: null,
    predicate: null,
    object: null,
    body: `Captured from \`${connector}\` (message) at 2026-09-01T09:00:00Z.\n\n> turn ${index}`,
    frontmatter: {
      type: "source",
      title: `Capture from ${connector} at 2026-09-01T09:00:00Z`,
      "x-connector": connector,
      "x-capture-kind": overrides.kind ?? "message",
    },
    subjects: [],
    confidence: 1,
    taint: "quoted",
    sensitivity: "private",
  });
}

describe("closing out capture notes filed for conversational events", () => {
  test("skips every live unwritten message and email note with a named reason", async () => {
    const f = fixture();
    const notes = [
      await legacyNote(f, 1),
      await legacyNote(f, 2, { kind: "email", connector: "mail-connector" }),
      await legacyNote(f, 3, { target: "captures/session-connector" }),
    ];
    expect(countCaptureFanout(f.db)).toEqual({ pending: 3, skipped: 0 });

    expect(skipCaptureFanoutClaims(f.db, AT)).toBe(3);

    for (const note of notes) {
      const claim = getClaim(f.db, note.claim_id)!;
      expect(claim.status).toBe("skipped");
      expect(claim.retracted_at).toBe(AT);
      expect(claim.frontmatter[SKIP_REASON_KEY]).toBe(
        CAPTURE_FANOUT_SKIP_REASON,
      );
      expect(claim.receipt_id).toBeNull();
      expect(isCaptureFanoutSkip(claim)).toBe(true);
      // The claim keeps everything it said; only its standing changed.
      expect(claim.body).toBe(note.body);
      expect(claim.frontmatter["x-capture-kind"]).toBe(
        note.frontmatter["x-capture-kind"],
      );
    }
    expect(countCaptureFanout(f.db)).toEqual({ pending: 0, skipped: 3 });
  });

  test("is idempotent and creates no canon page", async () => {
    const f = fixture();
    for (let index = 0; index < 5; index += 1) await legacyNote(f, index);

    expect(skipCaptureFanoutClaims(f.db, AT)).toBe(5);
    const before = f.db.query("SELECT * FROM claims ORDER BY claim_id").all();
    expect(skipCaptureFanoutClaims(f.db, "2026-09-30T00:00:00.000Z")).toBe(0);
    expect(f.db.query("SELECT * FROM claims ORDER BY claim_id").all()).toEqual(
      before,
    );

    expect(countCanonReceipts(f.db)).toBe(0);
    expect(existsSync(join(f.vault, "captures"))).toBe(false);
    // The writer's own scan no longer sees them and a write pass does not revive them.
    expect(listUnwrittenLiveClaims(f.db)).toEqual([]);
    expect(reviveUncontestedSkipped(f.db)).toBe(0);
    expect(countCaptureFanout(f.db)).toEqual({ pending: 0, skipped: 5 });
  });

  test("leaves written notes, page-kind notes, typed pages and other claims alone", async () => {
    const f = fixture();
    const written = await legacyNote(f, 1);
    write(f.io, written);
    const fileNote = await legacyNote(f, 2, {
      kind: "file",
      connector: "kizuki.markdown-folder",
    });
    const typedPage = await legacyNote(f, 3, { target: "people/ada" });
    const other = await storeClaim(
      f.db,
      putEvent(f.db, { text: "Grace works at Acme." }),
    );
    expect(getClaim(f.db, written.claim_id)!.receipt_id).not.toBeNull();

    expect(skipCaptureFanoutClaims(f.db, AT)).toBe(0);

    for (const claim of [written, fileNote, typedPage, other]) {
      expect(getClaim(f.db, claim.claim_id)!.status).toBe("live");
      expect(
        getClaim(f.db, claim.claim_id)!.frontmatter[SKIP_REASON_KEY],
      ).toBeUndefined();
    }
    expect(countCaptureFanout(f.db)).toEqual({ pending: 0, skipped: 0 });
  });

  test("a claim that another sweep already closed is not counted twice", async () => {
    const f = fixture();
    const note = await legacyNote(f, 1);
    f.db
      .query("UPDATE claims SET status = 'skipped' WHERE claim_id = ?")
      .run(note.claim_id);
    expect(skipCaptureFanoutClaims(f.db, AT)).toBe(0);
    // Skipped for another reason, so it is not reported as a capture fan-out skip.
    expect(countCaptureFanout(f.db)).toEqual({ pending: 0, skipped: 0 });
  });

  test("a repair stops at its limit and the next call takes the rest", async () => {
    const f = fixture();
    for (let index = 0; index < 7; index += 1) await legacyNote(f, index);
    expect(skipCaptureFanoutClaims(f.db, AT, 3)).toBe(3);
    expect(countCaptureFanout(f.db)).toEqual({ pending: 4, skipped: 3 });
    expect(skipCaptureFanoutClaims(f.db, AT)).toBe(4);
    expect(countCaptureFanout(f.db)).toEqual({ pending: 0, skipped: 7 });
  });

  test("a ledger with no claims table reports nothing to do", () => {
    const db = new Database(":memory:");
    expect(countCaptureFanout(db)).toEqual({ pending: 0, skipped: 0 });
    expect(skipCaptureFanoutClaims(db, AT)).toBe(0);
  });
});
