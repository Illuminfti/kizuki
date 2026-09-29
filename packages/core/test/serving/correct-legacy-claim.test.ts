import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCanonWrite,
  createBudgetTracker,
  getCanonReceipt,
  resolveTarget,
} from "../../src/canon";
import { getClaim, insertClaim, listSupersessions } from "../../src/claims/store";
import { undoReceipt } from "../../src/canon/undo";
import { serveCorrect } from "../../src/serving/correct";
import { serveSearch } from "../../src/serving/search";
import { ServeError } from "../../src/serving/types";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

const OLD = "The compiler ships nightly.";

/** A deterministic importer claim with no predicate, written to a page by the receipted writer. */
async function writtenUnkeyed(live: Fixture): Promise<{ claimId: string; pagePath: string }> {
  const filed = await insertClaim(
    { db: live.db },
    {
      kind: "claim",
      target: "facts:compiler",
      body: OLD,
      frontmatter: { type: "fact", title: "Compiler cadence" },
      subjects: ["topic:compiler"],
      provenance: [live.events["public"] as string],
      producer: "deterministic",
      confidence: 1,
    },
  );
  if (filed.outcome !== "stored") throw new Error(filed.outcome);
  expect(filed.claim.claim_key).toBeNull();
  const io = { db: live.db, vault_path: live.vaultPath };
  const receipt = applyCanonWrite(io, filed.claim, resolveTarget(io, filed.claim), {
    writer: "loop",
    budget: createBudgetTracker({ canon_writes_per_run: 4 }),
  });
  return { claimId: filed.claim.claim_id, pagePath: receipt.page_path };
}

async function canonTexts(live: Fixture, query: string): Promise<string[]> {
  const found = await serveSearch(live.owner(), { query });
  return found.canon.map((chunk) => chunk.excerpt);
}

describe("serveCorrect retracts a claim that has no predicate", () => {
  for (const [name, principal] of [
    ["owner", "owner"],
    ["a relaying agent", "reader-private"],
  ] as const) {
    test(`${name} retires exactly the named claim and the page holding it is rewritten`, async () => {
      fixture = await serveFixture();
      const live = fixture;
      const { claimId, pagePath } = await writtenUnkeyed(live);
      expect((await canonTexts(live, "nightly")).join("\n")).toContain(OLD);

      const ctx = principal === "owner" ? live.owner() : live.agent(principal);
      const envelope = await serveCorrect(ctx, {
        statement: "The compiler ships weekly.",
        target: { claim_id: claimId },
      });
      const data = envelope.data!;
      expect(data.superseded.map((entry) => entry.claim_id)).toEqual([claimId]);
      expect(getClaim(live.db, claimId)?.status).toBe("superseded");
      expect(getClaim(live.db, claimId)?.superseded_by).toBe(data.claim_id!);
      expect(listSupersessions(live.db).filter((row) => row.loser === claimId)).toEqual([
        { winner: data.claim_id!, loser: claimId, rule: "R5" },
      ]);

      const correction = getClaim(live.db, data.claim_id!);
      expect(correction?.authority).toBe("owner_correction");
      expect(correction?.status).toBe("live");
      expect(correction?.body).toBe("The compiler ships weekly.");

      // The receipted writer rewrote the page that already held the claim.
      expect(data.rewritten.map((page) => page.page_path)).toEqual([pagePath]);
      expect(getCanonReceipt(live.db, data.receipt_id!)?.writer).toBe("correction");
      const page = readFileSync(join(live.vaultPath, pagePath), "utf8");
      expect(page).toContain("The compiler ships weekly.");
      expect(page).not.toContain(OLD);

      // Search stops returning the old text and finds the correction.
      expect((await canonTexts(live, "nightly")).join("\n")).not.toContain(OLD);
      expect((await canonTexts(live, "weekly")).join("\n")).toContain("weekly");
    });
  }

  test("an exact replay changes nothing and undo restores the retired claim", async () => {
    fixture = await serveFixture();
    const live = fixture;
    const { claimId, pagePath } = await writtenUnkeyed(live);
    const before = readFileSync(join(live.vaultPath, pagePath), "utf8");
    const args = { statement: "The compiler ships weekly.", target: { claim_id: claimId } };
    const first = await serveCorrect(live.owner(), args);
    const again = await serveCorrect(live.owner(), args);
    expect(again.data?.answer).toContain("already recorded");
    expect(again.data?.claim_id).toBe(first.data?.claim_id ?? "");
    expect(listSupersessions(live.db).filter((row) => row.loser === claimId)).toHaveLength(1);

    await undoReceipt({ db: live.db, vault_path: live.vaultPath }, first.data!.receipt_id!);
    expect(getClaim(live.db, claimId)?.status).toBe("live");
    expect(readFileSync(join(live.vaultPath, pagePath), "utf8")).toBe(before);
  });

  test("a rehearsal writes nothing, and a replacement object needs a predicate", async () => {
    fixture = await serveFixture();
    const live = fixture;
    const { claimId } = await writtenUnkeyed(live);
    const rehearsal = await serveCorrect(live.owner(), {
      statement: "The compiler ships weekly.",
      target: { claim_id: claimId },
      dry_run: true,
    });
    expect(rehearsal.data?.superseded.map((entry) => entry.claim_id)).toEqual([claimId]);
    expect(getClaim(live.db, claimId)?.status).toBe("live");
    expect(
      live.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE connector_id='kizuki.owner'").get()?.n,
    ).toBe(0);

    const error = await serveCorrect(live.owner(), {
      statement: "The compiler ships weekly.",
      target: { claim_id: claimId },
      object: "weekly",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServeError);
    expect((error as ServeError).message).toContain("object");
    expect(getClaim(live.db, claimId)?.status).toBe("live");
  });
});
