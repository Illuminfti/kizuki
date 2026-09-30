import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { accept, applyCanonWrite, createBudgetTracker, insertClaim, resolveTarget } from "@kizuki/core";
import { OLD, seedUnkeyed } from "./fixtures/unkeyed-claim";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

function compilerPages(vault: string): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(vault, relative), { withFileTypes: true })) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) { if (!entry.name.startsWith(".") && next !== "archive") walk(next); }
      else if (entry.name.endsWith(".md") && next.includes("compiler")) found.push(next);
    }
  };
  walk("");
  return found;
}

function rows<T>(vault: string, sql: string): T[] {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try { return db.query<T, []>(sql).all(); } finally { db.close(); }
}

describe("kizuki tell --claim on an unkeyed claim", () => {
  test("ordinary matching text cannot become the correction winner, and undo restores the target", async () => {
    const setup = tempVault();
    const { claimId, pagePath } = await seedUnkeyed(setup.vault);
    const statement = "The compiler ships weekly.";
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    let ordinaryId: string;
    try {
      const accepted = accept(db, {
        schema: "kizuki.event/v1", connector_id: "fixture", source_record_id: "weekly",
        kind: "message", occurred_at: "2026-02-28T10:30:00Z", observed_at: "2026-03-01T00:00:00Z",
        text: statement, subjects: [], sensitivity_hint: "personal", deleted: false, attachments: [], metadata: {},
      });
      if (accepted.status !== "stored") throw new Error(accepted.status);
      const filed = await insertClaim({ db }, {
        kind: "entity", target: "entities/compiler", body: statement, provenance: [accepted.event.event_id],
        subjects: [], producer: "deterministic", confidence: 0.8,
        frontmatter: { type: "topic", title: "Compiler" },
      });
      if (filed.outcome !== "stored") throw new Error(filed.outcome);
      ordinaryId = filed.claim.claim_id;
      const io = { db, vault_path: setup.vault };
      const receipt = applyCanonWrite(io, filed.claim, resolveTarget(io, filed.claim), {
        writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 1 }),
      });
      expect(receipt.page_path).toBe(pagePath);
    } finally { db.close(); }
    const before = readFileSync(join(setup.vault, pagePath), "utf8");
    expect(before).toContain(OLD);
    expect(before).toContain(statement);
    const told = runCli(setup.env, "tell", statement, "--claim", claimId, "--json");
    expect(told.exitCode, told.stderr).toBe(0);
    const result = JSON.parse(told.stdout).data;
    expect(result.superseded.map((claim: { claim_id: string }) => claim.claim_id)).toEqual([claimId]);
    expect(result.claim_ids[0]).not.toBe(ordinaryId);
    const claims = rows<{ claim_id: string; status: string; authority: string }>(setup.vault, "SELECT claim_id,status,authority FROM claims");
    expect(claims.find(claim => claim.claim_id === result.claim_ids[0])?.authority).toBe("owner_correction");
    expect(claims.find(claim => claim.claim_id === ordinaryId)?.status).toBe("live");
    expect(result.rewritten.map((page: { page_path: string }) => page.page_path)).toEqual([pagePath]);
    expect(readFileSync(join(setup.vault, pagePath), "utf8")).toContain(statement);
    expect(readFileSync(join(setup.vault, pagePath), "utf8")).not.toContain(OLD);
    expect(compilerPages(setup.vault)).toEqual([pagePath]);
    const nightly = JSON.parse(runCli(setup.env, "query", "nightly", "--json").stdout).data.hits;
    expect(nightly.filter((hit: { scope: string }) => hit.scope === "canon")).toEqual([]);
    const replay = runCli(setup.env, "tell", statement, "--claim", claimId, "--json");
    expect(replay.exitCode, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout).data.claim_ids).toEqual(result.claim_ids);
    expect(rows(setup.vault, "SELECT * FROM claim_supersessions")).toHaveLength(1);
    expect(runCli(setup.env, "undo", result.receipt_id).exitCode).toBe(0);
    expect(readFileSync(join(setup.vault, pagePath), "utf8")).toBe(before);
    expect(rows<{ status: string }>(setup.vault, `SELECT status FROM claims WHERE claim_id='${claimId}'`)[0]?.status).toBe("live");
    expect(rows<{ status: string }>(setup.vault, `SELECT status FROM claims WHERE claim_id='${ordinaryId}'`)[0]?.status).toBe("live");
  });

  test("retires exactly that claim and rewrites the page that holds it", async () => {
    const setup = tempVault();
    const { claimId, pagePath } = await seedUnkeyed(setup.vault);
    const told = runCli(setup.env, "tell", "The compiler ships weekly.", "--claim", claimId);
    expect(told.stderr).toBe("");
    expect(told.exitCode).toBe(0);
    expect(told.stdout).toContain("Superseded 1 claim.");
    expect(told.stdout).toContain(`Rewrote ${pagePath}.`);

    const claims = rows<{ claim_id: string; status: string }>(setup.vault, "SELECT claim_id,status FROM claims ORDER BY created_at");
    expect(claims.map((claim) => claim.status)).toEqual(["superseded", "live"]);
    expect(claims[0]?.claim_id).toBe(claimId);
    const winner = claims[1]!.claim_id;
    expect(rows(setup.vault, `SELECT 1 FROM claim_supersessions WHERE winner='${winner}' AND loser='${claimId}'`)).toHaveLength(1);

    // One page for the target, holding the correction and not the old reading.
    expect(compilerPages(setup.vault)).toEqual([pagePath]);
    const page = readFileSync(join(setup.vault, pagePath), "utf8");
    expect(page).toContain("The compiler ships weekly.");
    expect(page).not.toContain(OLD);

    const receipts = rows<{ receipt_id: string }>(setup.vault, "SELECT receipt_id FROM canon_receipts WHERE writer='correction'");
    expect(receipts).toHaveLength(1);
    for (const { receipt_id } of receipts) expect(told.stdout).toContain(`kizuki undo ${receipt_id}`);

    const weekly = JSON.parse(runCli(setup.env, "query", "weekly", "--json").stdout).data.hits;
    expect(weekly.some((hit: { scope: string }) => hit.scope === "canon")).toBe(true);
    const nightly = JSON.parse(runCli(setup.env, "query", "nightly", "--json").stdout).data.hits;
    expect(nightly.filter((hit: { scope: string }) => hit.scope === "canon")).toEqual([]);
  });

  test("a rehearsal names the claim it would retire and writes nothing", async () => {
    const setup = tempVault();
    const { claimId } = await seedUnkeyed(setup.vault);
    const rehearsal = runCli(setup.env, "tell", "The compiler ships weekly.", "--claim", claimId, "--dry-run");
    expect(rehearsal.exitCode).toBe(0);
    expect(rehearsal.stdout).toContain("Would supersede 1 claim.");
    expect(rows<{ status: string }>(setup.vault, "SELECT status FROM claims").map((claim) => claim.status)).toEqual(["live"]);
  });

  test("undo restores the retired claim and the page bytes", async () => {
    const setup = tempVault();
    const { claimId, pagePath } = await seedUnkeyed(setup.vault);
    const before = readFileSync(join(setup.vault, pagePath), "utf8");
    const told = runCli(setup.env, "tell", "The compiler ships weekly.", "--claim", claimId, "--json");
    expect(told.exitCode).toBe(0);
    const receiptId = JSON.parse(told.stdout).data.receipt_id as string;
    const undone = runCli(setup.env, "undo", receiptId);
    expect(undone.exitCode).toBe(0);
    expect(readFileSync(join(setup.vault, pagePath), "utf8")).toBe(before);
    const status = rows<{ claim_id: string; status: string }>(setup.vault, "SELECT claim_id,status FROM claims").find((claim) => claim.claim_id === claimId);
    expect(status?.status).toBe("live");
  });

  test("a second tell on the same claim is refused because it is no longer live", async () => {
    const setup = tempVault();
    const { claimId } = await seedUnkeyed(setup.vault);
    expect(runCli(setup.env, "tell", "The compiler ships weekly.", "--claim", claimId).exitCode).toBe(0);
    const again = runCli(setup.env, "tell", "The compiler ships monthly.", "--claim", claimId);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("claim_not_live");
    expect(compilerPages(setup.vault)).toHaveLength(1);
  });
});
