import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accept,
  initVault,
  registerConnection,
  setSourceGrant,
  revokeSourceGrant,
  insertClaim,
} from "../src/index";
import { openLedger } from "../src/ledger/db";
import { validEvent } from "./fixtures";
import { ulid } from "../src/util/ulid";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "source-integrity-"));
  initVault(dir);
  const db = openLedger(join(dir, ".kizuki", "kizuki.db"));
  const source = ulid();
  registerConnection(db, "kizuki.fixture", source);
  const request = {
    source_key: source,
    expected_revision: 0,
    operation_id: "grant",
    policy: {
      purposes: ["capture", "derive"],
      allowed_fields: ["text"],
      sensitivity_floor: "private",
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
    },
  };
  setSourceGrant(db, request);
  return { db, dir, source };
}
test("captured owner connector and forged event facts cannot mint new owner authority", async () => {
  const { db, dir } = setup();
  try {
    const accepted = accept(db, {
      ...validEvent(),
      connector_id: "kizuki.owner",
      text: "Synthetic owner label",
    });
    if (accepted.status !== "stored") throw new Error("fixture failed");
    for (const producer of ["deterministic", "owner"] as const) {
      const result = await insertClaim(
        { db },
        {
          kind: "claim",
          body: "Synthetic owner label",
          target: producer,
          provenance: [accepted.event.event_id],
          producer,
          confidence: 1,
          taint: "clean",
          sensitivity: "private",
          events: [
            {
              event_id: accepted.event.event_id,
              connector_id: "kizuki.owner",
              text: "Synthetic owner label",
              taint: "owner",
            },
          ],
        },
      );
      if (!("claim" in result)) throw new Error("fixture claim failed");
      expect(result.claim.authority).not.toBe("owner_authored");
      expect(result.claim.authority).not.toBe("owner_confirmed");
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("exact revoke retries reject valid-shaped timestamp and policy digest corruption", () => {
  const { db, dir, source } = setup();
  try {
    const request = {
      source_key: source,
      expected_revision: 1,
      operation_id: "revoke",
    };
    const original = revokeSourceGrant(db, request);
    for (const replacement of [
      { ...original, at: "2026-01-01T00:00:00Z" },
      { ...original, policy_digest: "a".repeat(64) },
    ]) {
      db.query(
        "UPDATE source_grant_receipts SET receipt=? WHERE operation_id='revoke'",
      ).run(JSON.stringify(replacement));
      expect(() => revokeSourceGrant(db, request)).toThrow(
        "source_receipt_corrupt",
      );
      db.query(
        "UPDATE source_grant_receipts SET receipt=? WHERE operation_id='revoke'",
      ).run(JSON.stringify(original));
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner credentials on propose do not attest to the captured source statement", async () => {
  const { db, dir } = setup();
  try {
    const accepted = accept(db, {
      ...validEvent(),
      connector_id: "kizuki.owner",
      text: "Captured material",
    });
    if (accepted.status !== "stored") throw new Error("fixture failed");
    const { servePropose, OWNER } = await import("../src/index");
    await expect(servePropose(
      { db, vaultPath: dir, principal: OWNER },
      {
        kind: "claim",
        body: "An interpretation of captured material",
        provenance: [accepted.event.event_id],
      },
    )).rejects.toThrow("propose requires an agent principal");
    expect(db.query("SELECT count(*) AS n FROM claims").get()).toEqual({n:0});
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
