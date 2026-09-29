import { afterEach, expect, test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { runRail } from "../../src/serve/rails";
import { listRunReceipts } from "../../src/serve/receipts";
import { MODEL, recordText, scriptedModelProducer, throughputVault, writeServeToml } from "./throughput-fixture";

const SECRET = `ghp_${"B".repeat(36)}`;
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });

test("a sync pass scrubs the prompt, leaves the ledger alone and counts redactions in the run receipt", async () => {
  const vault = throughputVault(2, index => `${recordText(index)} Token ${SECRET} and DB_PASSWORD=${"p".repeat(10)}`);
  const db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  writeServeToml(vault.vault, "[extraction]\nmax_calls_per_pass = 4\nrecords_per_request = 1\n");
  const scripted = scriptedModelProducer(vault.vault, () => "ok");
  const result = await runRail(db, vault.vault, "sync", { hooks: { producer: scripted.producer, claims: { db }, model_ref: MODEL } });

  expect(result).toMatchObject({ status: "ok", claims_extracted: 2, model: { calls: 2, redacted: { api_token: 2, secret_assignment: 2 } } });
  expect(scripted.prompts).toHaveLength(2);
  for (const prompt of scripted.prompts) {
    expect(prompt).not.toContain(SECRET);
    expect(prompt).not.toContain("p".repeat(10));
    expect(prompt).toContain("[redacted:api_token]");
  }
  const stored = db.query<{ text: string }, []>("SELECT text FROM events ORDER BY event_id").all();
  expect(stored).toHaveLength(2);
  for (const row of stored) expect(row.text).toContain(SECRET);
  expect(listRunReceipts(db, { rail: "sync" }).at(-1)?.model.redacted).toEqual({ api_token: 2, secret_assignment: 2 });
});

test("a pass over text without secrets reports no redaction field", async () => {
  const vault = throughputVault(1);
  const db = openLedger(vault.ledger);
  disposers.push(vault.dispose, () => db.close());
  const scripted = scriptedModelProducer(vault.vault, () => "ok");
  const result = await runRail(db, vault.vault, "sync", { hooks: { producer: scripted.producer, claims: { db }, model_ref: MODEL } });
  expect(result.model).not.toHaveProperty("redacted");
});
