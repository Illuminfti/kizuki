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
  test("a readable page that becomes private withholds its rewrite metadata", async () => {
    fixture = await serveFixture();
    const live = fixture;
    const { claimId, pagePath } = await writtenUnkeyed(live);
    const ctx = live.agent("reader-public");
    const before = await serveSearch(ctx, { query: "nightly" });
    expect(JSON.stringify(before)).toContain(OLD);
    const statement = "The compiler ships weekly.";
    const envelope = await serveCorrect(ctx, { statement, target: { claim_id: claimId } });
    const data = envelope.data!;
    expect(getClaim(live.db, claimId)?.status).toBe("superseded");
    expect(getClaim(live.db, data.claim_id!)?.sensitivity).toBe("private");
    expect(data.superseded.map(entry => entry.claim_id)).toEqual([claimId]);
    expect(data.rewritten).toEqual([]);
    const receipt = getCanonReceipt(live.db, data.receipt_id!);
    expect(receipt?.page_path).toBe(pagePath);
    const response = JSON.stringify(envelope);
    expect(response).not.toContain(pagePath);
    expect(response).not.toContain(receipt!.before_hash!);
    expect(response).not.toContain(receipt!.after_hash);
    const page = readFileSync(join(live.vaultPath, pagePath), "utf8");
    expect(page).toContain(statement);
    expect(page).not.toContain(OLD);
    const after = await serveSearch(ctx, { query: "weekly" });
    expect(JSON.stringify(after)).not.toContain(statement);
  });

  test.each([false, true])("a permitted correction withholds mixed-sensitivity page snapshots and metadata (recovery=%s)", async (recovery) => {
    fixture = await serveFixture();
    const live = fixture;
    const { claimId, pagePath } = await writtenUnkeyed(live);
    const privateText = "The compiler has a confidential release canary.";
    expect(getClaim(live.db, claimId)?.sensitivity).toBe("public");
    const filed = await insertClaim({ db: live.db }, {
      kind: "claim", target: "facts:compiler", body: privateText,
      frontmatter: { type: "fact", title: "Compiler cadence" },
      subjects: ["topic:compiler"], provenance: [live.events["private"]!],
      producer: "deterministic", confidence: 1,
    });
    if (filed.outcome !== "stored") throw new Error(filed.outcome);
    const io = { db: live.db, vault_path: live.vaultPath };
    applyCanonWrite(io, filed.claim, resolveTarget(io, filed.claim), {
      writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
    });
    expect(readFileSync(join(live.vaultPath, pagePath), "utf8")).toContain(privateText);
    const search = await serveSearch(live.agent("reader-public"), { query: "canary" });
    expect(JSON.stringify(search)).not.toContain(privateText);
    if (recovery) {
      live.db.exec("CREATE TRIGGER synthetic_mixed_page_receipt_failure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic-receipt-failure'); END");
    }
    const envelope = await serveCorrect(live.agent("reader-public"), {
      statement: "The compiler ships weekly.", target: { claim_id: claimId },
    });
    expect(getClaim(live.db, claimId)?.status).toBe("superseded");
    const after = readFileSync(join(live.vaultPath, pagePath), "utf8");
    expect(after).toContain("The compiler ships weekly.");
    expect(after).toContain(privateText);
    expect(after).not.toContain(OLD);
    expect(envelope.data?.rewritten).toEqual([]);
    expect(JSON.stringify(envelope)).not.toContain(privateText);
    expect(JSON.stringify(envelope)).not.toContain(live.events["private"]!);
    expect(JSON.stringify(envelope)).not.toContain(pagePath);
    if (recovery) {
      expect(envelope.data?.recovery_pending).toEqual([]);
      // The statement's private evidence raises the correction above the
      // original caller's ceiling. Replay cannot grant that caller read access.
      expect(getClaim(live.db, envelope.data!.claim_id!)?.sensitivity).toBe("private");
      const refused = await serveCorrect(live.agent("reader-public"), {
        statement: "The compiler ships weekly.", target: { claim_id: claimId },
      }).catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "invalid_arguments", message: "invalid arguments: target.claim_id: names no live claim" });
      expect(JSON.stringify(refused)).not.toContain(privateText);
      expect(JSON.stringify(refused)).not.toContain(live.events["private"]!);
      expect(JSON.stringify(refused)).not.toContain(pagePath);
      // This caller can read the correction claim, but recovery still holds
      // the page. A claim grant does not disclose the held page's metadata.
      const replay = await serveCorrect(live.agent("reader-private"), {
        statement: "The compiler ships weekly.", target: { claim_id: claimId },
      });
      expect(replay.data?.claim_id).toBe(envelope.data!.claim_id!);
      expect(replay.data?.recovery_pending).toEqual([]);
      expect(JSON.stringify(replay)).not.toContain(privateText);
      expect(JSON.stringify(replay)).not.toContain(live.events["private"]!);
      expect(JSON.stringify(replay)).not.toContain(pagePath);
      expect(listSupersessions(live.db).filter(row => row.loser === claimId)).toHaveLength(1);
    } else {
      expect(envelope.data?.receipt_id).toBeString();
      const receipt = getCanonReceipt(live.db, envelope.data!.receipt_id!);
      expect(receipt?.page_path).toBe(pagePath);
      expect(JSON.stringify(envelope)).not.toContain(receipt!.before_hash!);
      expect(JSON.stringify(envelope)).not.toContain(receipt!.after_hash);
    }
  });

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
