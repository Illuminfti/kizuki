import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDriver, APP_SLOTS, SLOTS_PER_CASE } from "./app";
import { CORPUS_SIZE } from "./cases";
import { confuse, withValue } from "./app-arguments";

async function withDriver(body: (driver: Awaited<ReturnType<typeof appDriver>>, database: () => Database) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "kizuki-fuzz-app-"));
  const driver = await appDriver(scratch);
  try { await body(driver, () => new Database(join(scratch, "vault/.kizuki/kizuki.db"))); }
  finally { await driver.close(); rmSync(scratch, { recursive: true, force: true }); }
}

test("the short object case reaches enrollment, consent, model, grant, correction and world parsers", async () => {
  await withDriver(async driver => {
    expect(await driver.run({ id: "object", text: "{}", bytes: Buffer.from("{}") })).toEqual({
      enroll: ["misconfigured", "invalid_request"],
      consent: ["succeeded", "invalid_request"],
      source_model_consent: ["succeeded", "invalid_request"],
      model_save: ["succeeded", "credential_invalid", "configuration_invalid"],
      agent_enroll: ["succeeded", "invalid_grant", "invalid_grant"],
      correction_preview: ["succeeded", "invalid_request", "invalid_request"],
      correct: ["succeeded", "invalid_request", "invalid_request"],
      world_view: ["succeeded", "invalid_request"],
    });
  });
});

test("an envelope missing a prerequisite stops before the nested parser it was meant to reach", async () => {
  await withDriver(async driver => {
    const grant = { ceiling: "private", types: null, subjects: null, since: null, until: null, tools: ["{}"], rate_limit_per_minute: 10, relay_owner_corrections: false };
    // Without a name the request is refused before the grant is read; with one, admission rejects the tool.
    expect((await driver.request("agent_enroll", { operation_id: "synthetic-missing-name", grant })).code).toBe("invalid_request");
    expect((await driver.request("agent_enroll", { name: "synthetic-named", operation_id: "synthetic-with-name", grant })).code).toBe("invalid_grant");
  });
});

test("damaged app storage fails the campaign even when the app encodes it as HTTP 400", async () => {
  await withDriver(async (driver, database) => {
    const db = database();
    try { db.exec("DROP TABLE IF EXISTS vault_epoch; CREATE TABLE vault_epoch (broken TEXT)"); } finally { db.close(); }
    await expect(driver.run({ id: "synthetic", text: "{}", bytes: Buffer.from("{}") })).rejects.toThrow("app-crash");
  });
});

test("an operation that fails after the app accepted it fails the campaign", async () => {
  await withDriver(async (driver, database) => {
    const request = { receipt_id: "synthetic-receipt", cascade: false };
    // Healthy storage: an unknown receipt is the caller's error.
    expect((await driver.request("undo", request)).code).toBe("invalid_request");
    const db = database();
    try { db.exec("DROP TABLE canon_receipts"); } finally { db.close(); }
    await expect(driver.request("undo", request)).rejects.toThrow("app-crash");
  });
});

test("the CI budget reaches every varied app field, including nested grant, policy and model fields", () => {
  expect(APP_SLOTS.length).toBeLessThanOrEqual(SLOTS_PER_CASE * (CORPUS_SIZE + 8));
  const fields = (route: string) => APP_SLOTS.filter(slot => slot.route === route).map(slot => slot.path.join("."));
  expect(fields("agent_enroll")).toEqual(expect.arrayContaining(["name", "grant", "grant.ceiling", "grant.tools", "grant.tools.0", "grant.since", "grant.rate_limit_per_minute"]));
  expect(fields("consent")).toEqual(expect.arrayContaining(["policy", "policy.allowed_fields.0", "policy.retention", "policy.egress"]));
  expect(fields("model_save")).toEqual(expect.arrayContaining(["selection.kind", "selection.base_url", "credential.action"]));
  expect(fields("world_view")).toEqual(expect.arrayContaining(["valid.kind", "valid.from", "knownAt.ref.token", "cursor", "concept.token"]));
  // A folder path would persist one source per accepted value, so no campaign varies one.
  expect(APP_SLOTS.some(slot => slot.path.at(-1) === "path")).toBe(false);
});

test("a mutation replaces exactly one field of a valid envelope", () => {
  const valid = { a: { b: [1, 2], c: 3 }, d: 4 };
  expect(withValue(valid, ["a", "b", 1], "x")).toEqual({ a: { b: [1, "x"], c: 3 }, d: 4 });
  expect(JSON.stringify(withValue(valid, ["d"], confuse("hostile", 2)))).toBe('{"a":{"b":[1,2],"c":3}}');
  expect(valid).toEqual({ a: { b: [1, 2], c: 3 }, d: 4 });
  expect([0, 1, 3, 4, 5, 6, 7, 8].map(choice => confuse("hostile", choice))).toEqual(["hostile", null, ["hostile"], { text: "hostile" }, 7, -7, true, false]);
});
