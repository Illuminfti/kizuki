import { expect, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { serveCorrect } from "../../src/serving/correct";
import { readWorldView } from "../../src/serving/world-view";
import { ENVELOPE_V2_SCHEMA } from "../../src/serving/types";
import { tempVault } from "../helpers/vault";
import { worldFixture } from "./world-fixture";

test("scoped correction preview reports dry_run without issuing hypothetical evidence or writing authority", async () => {
  const vault = tempVault("kizuki-scoped-preview-"), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  try {
    const world = await worldFixture(db), ctx = { ...world.ctx, vaultPath: vault.path };
    const read = readWorldView(ctx, { operation: "concept", concept: world.ref,
      valid: { kind: "all" }, knownAt: { kind: "current" } });
    if (!("result" in read) || read.result.status === "unavailable" || read.result.data.schema !== "kizuki.concept-card/v1")
      throw new Error("fixture concept unavailable");
    const target = read.result.data.definitions[0]!.claim;
    const snapshot = () => ({
      events: db.query("SELECT * FROM events ORDER BY event_id").all(),
      claims: db.query("SELECT * FROM claims ORDER BY claim_id").all(),
      receipts: db.query("SELECT * FROM canon_receipts ORDER BY receipt_id").all(),
      eventReferences: db.query("SELECT * FROM world_wire_event_version_targets ORDER BY namespace_id, wire_ref").all(),
    });
    const before = snapshot();
    const result = await serveCorrect(ctx, { target, statement: "Use prior odds and evidence.", dry_run: true }, ENVELOPE_V2_SCHEMA);
    expect(result.schema).toBe(ENVELOPE_V2_SCHEMA);
    expect(result.data).toMatchObject({ message: "dry_run", receipt: null, eventVersion: null, claim: null,
      superseded: [target], rewritten: [], ambiguous: [] });
    expect(result.canon).toEqual([]);
    expect(result.quoted).toEqual([]);
    expect(snapshot()).toEqual(before);
  } finally { db.close(); vault.dispose(); }
});
