import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConnectionStateStore, getCheckpoint, listConnections, openLedger, runToCompletion } from "@kizuki/core";
import { TelegramConnector, ScriptedTelegramApi, fixtureAccount, FIXTURE_CREDENTIALS, FIXTURE_SESSION, parseState } from "@kizuki/connector-telegram";
import { runTelegramConnect } from "../src/commands/connect-telegram";
import { closeHostConnector, loadConnector, selectConnection } from "../src/connections";
import type { CliIo } from "../src/commands";
import { createHelpers } from "./helpers";
const h = createHelpers(); afterEach(h.cleanup);

function ownerIo(setup: ReturnType<typeof h.tempVault>) {
  const output: string[] = [], prompts: boolean[] = []; const answers = ["+15551234567", "22222"];
  const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true,
    out: line => output.push(line), err: line => output.push(line), prompt: async (_question, opts) => { prompts.push(opts?.secret === true); return answers.shift() ?? "22222"; } };
  return { io, output, prompts };
}

test("native Telegram command enrolls, resumes history and refuses changed account identity", async () => {
  const setup = h.tempVault(), owner = ownerIo(setup), account = fixtureAccount();
  const create = () => new TelegramConnector({}, { api: () => new ScriptedTelegramApi(account), credentials: () => FIXTURE_CREDENTIALS, sleep: async () => {} });
  expect(await runTelegramConnect(owner.io, { json: true }, () => {}, create)).toBe(0);
  expect(owner.prompts).toEqual([true, true]);
  const dbPath = join(setup.vault, ".kizuki/kizuki.db"), db = openLedger(dbPath), store = new ConnectionStateStore(join(setup.vault, ".kizuki"));
  try {
    const first = listConnections(db)[0]!;
    const bytes = store.read(first)!; expect(parseState(bytes).user_id).toBe("1001");
    expect(statSync(join(setup.vault, ".kizuki", first.secret_refs[0]!.slice(5))).mode & 0o777).toBe(0o600);
    const open = async () => loadConnector(selectConnection(db, store, "kizuki.telegram", first.source_key), store, {}, (_id, config, deps) => new TelegramConnector(config as { state_ref: string }, { ...deps, api: () => new ScriptedTelegramApi(account), credentials: () => FIXTURE_CREDENTIALS }), db);
    const connector = await open();
    const initial = await runToCompletion(db, connector, "kizuki.telegram", first.source_key, "backfill"); await closeHostConnector(connector);
    expect(initial.errors).toEqual([]); expect(initial.stored).toBeGreaterThan(0);
    const cursor = getCheckpoint(db, "kizuki.telegram", first.source_key)!.cursor;
    const restarted = await open(); const replay = await runToCompletion(db, restarted, "kizuki.telegram", first.source_key, "backfill"); await closeHostConnector(restarted);
    expect(replay.stored).toBe(0); expect(getCheckpoint(db, "kizuki.telegram", first.source_key)!.cursor).toBe(cursor);
    const again = ownerIo(setup); expect(await runTelegramConnect(again.io, { source: first.source_key, json: true }, () => {}, create)).toBe(0);
    expect(listConnections(db)[0]!.source_key).toBe(first.source_key); expect(getCheckpoint(db, "kizuki.telegram", first.source_key)!.cursor).toBe(cursor);
    const prior = store.read(listConnections(db)[0]!)!;
    const other = fixtureAccount(); other.me.id = "2002";
    await expect(runTelegramConnect(ownerIo(setup).io, { source: first.source_key, json: true }, () => {}, () => new TelegramConnector({}, { api: () => new ScriptedTelegramApi(other), credentials: () => FIXTURE_CREDENTIALS }))).rejects.toThrow("identity");
    expect(store.read(listConnections(db)[0]!)).toEqual(prior);
    expect(owner.output.join("\n")).not.toContain(FIXTURE_SESSION);
    expect(readFileSync(dbPath).includes(Buffer.from(FIXTURE_SESSION))).toBe(false);
  } finally { db.close(); }
});

test("missing Telegram project credentials refuse before any prompt or source state", async () => {
  const setup = h.tempVault(), owner = ownerIo(setup); let calls = 0;
  await expect(runTelegramConnect(owner.io, { json: true }, () => {}, () => new TelegramConnector({}, { credentials: () => null, api: () => { calls++; throw Error("unexpected network"); } }))).rejects.toThrow("app credentials");
  expect(calls).toBe(0); expect(owner.prompts).toEqual([]);
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db")); try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
});

test("host persists Telegram cooldown before health returns and reauthentication cannot clear it", async () => {
  const setup = h.tempVault(), owner = ownerIo(setup), account = fixtureAccount();
  await runTelegramConnect(owner.io, { json: true }, () => {}, () => new TelegramConnector({}, { api: () => new ScriptedTelegramApi(account), credentials: () => FIXTURE_CREDENTIALS }));
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db")), store = new ConnectionStateStore(join(setup.vault, ".kizuki"));
  try {
    const row = listConnections(db)[0]!; const api = new ScriptedTelegramApi(account);
    const port = await loadConnector(selectConnection(db, store, "kizuki.telegram", row.source_key), store, {}, (_id, config, deps) => new TelegramConnector(config as {state_ref:string}, { ...deps, api: () => api, credentials: () => FIXTURE_CREDENTIALS }), db);
    api.floodProbe(120); expect((await port.health()).state).toBe("rate_limited"); await closeHostConnector(port);
    expect(Date.parse(parseState(store.read(listConnections(db)[0]!)!).retry_not_before!)).toBeGreaterThan(Date.now());
    const nextApi = new ScriptedTelegramApi(account);
    await expect(loadConnector(selectConnection(db, store, "kizuki.telegram", row.source_key), store, {}, (_id, config, deps) => new TelegramConnector(config as {state_ref:string}, { ...deps, api: () => nextApi, credentials: () => FIXTURE_CREDENTIALS }), db)).rejects.toThrow("wait");
    expect(nextApi.calls).toHaveLength(0);
    const retry = ownerIo(setup);
    await expect(runTelegramConnect(retry.io, { source: row.source_key, json: true }, () => {}, () => new TelegramConnector({}, { api: () => nextApi, credentials: () => FIXTURE_CREDENTIALS }))).rejects.toThrow("wait");
    expect(retry.prompts).toEqual([]);
  } finally { db.close(); }
});

test("cancelled Telegram enrollment preserves no pending session and redacts the answer", async () => {
  const setup = h.tempVault(), owner = ownerIo(setup);
  owner.io.prompt = async () => { throw new Error("SYNTHETIC_PHONE_SECRET"); };
  await expect(runTelegramConnect(owner.io, { json: true }, () => {}, () => new TelegramConnector({}, { credentials: () => FIXTURE_CREDENTIALS }))).rejects.toThrow("did not complete");
  expect(owner.output.join("\n")).not.toContain("SYNTHETIC_PHONE_SECRET");
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db")); try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
});

test("failed initial Telegram transport opening is cleaned up without enrolling", async () => {
  const setup = h.tempVault(), owner = ownerIo(setup), api = new ScriptedTelegramApi(fixtureAccount());
  api.connect = async () => { throw new Error("SYNTHETIC_TRANSPORT_FAILURE"); };
  await expect(runTelegramConnect(owner.io, { json: true }, () => {}, () => new TelegramConnector({}, { api: () => api, credentials: () => FIXTURE_CREDENTIALS }))).rejects.toThrow("did not complete");
  expect(api.calls.some(call => call.method === "disconnect")).toBe(true);
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db")); try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
});
