import { expect, test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { insertClaim } from "../../src/claims/store";
import { parseWorldAdmission } from "../../src/contracts/world-admission";
import { worldFixture } from "../serving/world-fixture";

test("typed admission refuses anchor mismatch, out-of-range spans and split UTF-16 without allocating state", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db, { label: "A😀B" });
    const admission = parseWorldAdmission(
      JSON.parse(
        db
          .query<
            { admission: string },
            [string]
          >("SELECT admission FROM claim_v2_support WHERE claim_id=?")
          .get(f.claims[2]!)!.admission,
      ),
    )!;
    const before = db.query("SELECT count(*) AS n FROM claims").get();
    const anchors = admission.semantic.anchors;
    for (const bad of [
      [{ event_id: f.eventId, start_utf16: 1, end_utf16: 2 }],
      [{ event_id: f.eventId, start_utf16: 0, end_utf16: 999 }],
    ]) {
      const semantic = {
        ...admission.semantic,
        object: { kind: "literal" as const, value: "changed" },
        anchors: bad,
      };
      await expect(
        insertClaim(
          { db },
          {
            kind: "claim",
            body: "changed",
            provenance: [f.eventId],
            producer: "deterministic",
            confidence: 0.5,
            semantic,
            world_admission: { ...admission, semantic },
          },
        ),
      ).rejects.toThrow();
      expect(db.query("SELECT count(*) AS n FROM claims").get()).toEqual(
        before,
      );
    }
    const semantic = {
      ...admission.semantic,
      anchors: [{ ...anchors[0]!, end_utf16: 1 }],
    };
    await expect(
      insertClaim(
        { db },
        {
          kind: "claim",
          body: "changed",
          provenance: [f.eventId],
          producer: "deterministic",
          confidence: 0.5,
          semantic,
          world_admission: admission,
        },
      ),
    ).rejects.toThrow();
    expect(db.query("SELECT count(*) AS n FROM claims").get()).toEqual(before);
    expect(
      parseWorldAdmission({
        ...admission,
        semantic: {
          ...admission.semantic,
          subject: { kind: "supplied", id: "topic:bayes" },
        },
      }),
    ).toBeNull();
  } finally {
    db.close();
  }
});

test("the complete independent perspective and assertion anchor union can exceed eight spans", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db);
    const admission = parseWorldAdmission(
      JSON.parse(
        db
          .query<
            { admission: string },
            [string]
          >("SELECT admission FROM claim_v2_support WHERE claim_id=?")
          .get(f.claims[2]!)!.admission,
      ),
    )!;
    const anchor = (start: number) => ({
      event_id: f.eventId,
      start_utf16: start,
      end_utf16: start + 1,
    });
    const semantic = {
      ...admission.semantic,
      object: { kind: "literal" as const, value: "Many evidence spans" },
      anchors: Array.from({ length: 8 }, (_, i) => anchor(i)),
      perspective: { ...admission.semantic.perspective, anchors: [anchor(8)] },
    };
    const result = await insertClaim(
      { db },
      {
        kind: "claim",
        body: "Many evidence spans",
        provenance: [f.eventId],
        producer: "deterministic",
        confidence: 0.5,
        semantic,
        world_admission: { ...admission, semantic },
      },
    );
    expect(result.outcome).toBe("stored");
    if(result.outcome!=="stored") throw new Error("expected stored typed claim");
    expect(
      JSON.parse(
        db
          .query<
            { anchors: string },
            [string]
          >("SELECT anchors FROM claim_v2_support WHERE claim_id=?")
          .get(result.claim.claim_id)!.anchors,
      ),
    ).toHaveLength(9);
  } finally {
    db.close();
  }
});
