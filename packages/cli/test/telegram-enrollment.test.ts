import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConnectionStateStore, setSourceGrant, revokeSourceGrant, getCheckpoint, listConnections, runToCompletion } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { TelegramConnector, TelegramConnectorError, ScriptedTelegramApi, fixtureAccount, FIXTURE_CREDENTIALS, FIXTURE_SESSION, parseState, type SignInFlow } from "@kizuki/connector-telegram";
import { UsageError } from "../src/args";
import { runTelegramConnect } from "../src/commands/connect-telegram";
import { closeHostConnector, ConnectionError, loadConnector, selectConnection } from "../src/connections";
import type { CliIo } from "../src/commands";
import { createHelpers } from "./helpers";
const h = createHelpers(); afterEach(h.cleanup);
function grantFixture(db: ReturnType<typeof openLedger>, source: string) {
  setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "fixture-telegram-grant",
    policy: { purposes: ["capture"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" } });
}

function ownerIo(setup: ReturnType<typeof h.tempVault>) {
  const output: string[] = [], prompts: boolean[] = []; const answers = ["+15551234567", "22222"];
  const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true,
    out: line => output.push(line), err: line => output.push(line), prompt: async (_question, opts) => { prompts.push(opts?.secret === true); return answers.shift() ?? "22222"; } };
  return { io, output, prompts };
}

function cancellingIo(setup: ReturnType<typeof h.tempVault>, at: number, answers: string[] = ["+15551234567", "22222", "correct horse"]) {
  const output: string[] = [], prompts: boolean[] = []; let index = 0;
  const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true,
    out: line => output.push(line), err: line => output.push(line), prompt: async (_question, opts) => {
      prompts.push(opts?.secret === true);
      if (index === at) throw new UsageError("interactive sign-in cancelled");
      return answers[index++] ?? "22222";
    } };
  return { io, output, prompts };
}

function wrapPromptErrors(api: ScriptedTelegramApi): ScriptedTelegramApi {
  const start = api.start.bind(api);
  api.start = async (flow: SignInFlow) => {
    try {
      await start(flow);
    } catch (error) {
      if (error instanceof TelegramConnectorError) throw error;
      throw new TelegramConnectorError("unreachable", "kizuki.telegram: telegram is unreachable");
    }
  };
  return api;
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected throw");
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
    let transports = 0;
    const open = async () => loadConnector(selectConnection(db, store, "kizuki.telegram", first.source_key), store, db, {}, (_id, config, deps) => new TelegramConnector(config as { state_ref: string }, { ...deps, api: () => { transports++; return new ScriptedTelegramApi(account); }, credentials: () => FIXTURE_CREDENTIALS }));
    expect(owner.output.join("\n")).toContain("consent-required");
    await expect(open()).rejects.toThrow("source_capture_denied");
    expect(transports).toBe(0);
    grantFixture(db, first.source_key);
    const connector = await open();
    const initial = await runToCompletion(db, connector, "kizuki.telegram", first.source_key, "backfill"); await closeHostConnector(connector);
    expect(initial.errors).toEqual([]); expect(initial.stored).toBeGreaterThan(0);
    const cursor = getCheckpoint(db, "kizuki.telegram", first.source_key)!.cursor;
    const restarted = await open(); const replay = await runToCompletion(db, restarted, "kizuki.telegram", first.source_key, "backfill"); await closeHostConnector(restarted);
    expect(replay.stored).toBe(0); expect(getCheckpoint(db, "kizuki.telegram", first.source_key)!.cursor).toBe(cursor);
    const again = ownerIo(setup); expect(await runTelegramConnect(again.io, { source: first.source_key, json: true }, () => {}, create)).toBe(0);
    expect(listConnections(db)[0]!.source_key).toBe(first.source_key); expect(getCheckpoint(db, "kizuki.telegram", first.source_key)!.cursor).toBe(cursor);
    revokeSourceGrant(db, { source_key: first.source_key, expected_revision: 1, operation_id: "fixture-telegram-revoke" });
    const beforeRevokedOpen = transports;
    await expect(open()).rejects.toThrow("source_capture_denied");
    expect(transports).toBe(beforeRevokedOpen);
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
    const row = listConnections(db)[0]!; grantFixture(db, row.source_key); const api = new ScriptedTelegramApi(account);
    const port = await loadConnector(selectConnection(db, store, "kizuki.telegram", row.source_key), store, db, {}, (_id, config, deps) => new TelegramConnector(config as {state_ref:string}, { ...deps, api: () => api, credentials: () => FIXTURE_CREDENTIALS }));
    api.floodProbe(120); expect((await port.health()).state).toBe("rate_limited"); await closeHostConnector(port);
    expect(Date.parse(parseState(store.read(listConnections(db)[0]!)!).retry_not_before!)).toBeGreaterThan(Date.now());
    const nextApi = new ScriptedTelegramApi(account);
    await expect(loadConnector(selectConnection(db, store, "kizuki.telegram", row.source_key), store, db, {}, (_id, config, deps) => new TelegramConnector(config as {state_ref:string}, { ...deps, api: () => nextApi, credentials: () => FIXTURE_CREDENTIALS }))).rejects.toThrow("wait");
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

test("phone cancellation keeps UsageError classification and enrolls nothing", async () => {
  const setup = h.tempVault(), owner = cancellingIo(setup, 0); let created = 0;
  const error = await thrown(() => runTelegramConnect(owner.io, { json: true }, () => {}, () => { created++; return new TelegramConnector({}, { credentials: () => FIXTURE_CREDENTIALS, api: () => { throw new Error("unexpected network"); } }); }));
  expect(error).toBeInstanceOf(UsageError);
  expect(error).not.toBeInstanceOf(ConnectionError);
  expect((error as Error).message).toBe("interactive sign-in cancelled");
  expect(owner.output.join("\n")).not.toContain("enrolled");
  expect(owner.output.join("\n")).not.toContain("connected kizuki.telegram");
  expect(created).toBe(1);
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db")); try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
});

test("code cancellation survives adapter wrapping without enrolling", async () => {
  const setup = h.tempVault(), owner = cancellingIo(setup, 1), api = wrapPromptErrors(new ScriptedTelegramApi(fixtureAccount()));
  const error = await thrown(() => runTelegramConnect(owner.io, { json: true }, () => {}, () => new TelegramConnector({}, { api: () => api, credentials: () => FIXTURE_CREDENTIALS, sleep: async () => {} })));
  expect(error).toBeInstanceOf(UsageError);
  expect((error as Error).message).toBe("interactive sign-in cancelled");
  expect((error as Error).message).not.toContain("connectivity");
  expect(owner.output.join("\n")).not.toContain("enrolled");
  expect(api.calls.some(call => call.method === "disconnect")).toBe(true);
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db")); try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
});

test("password cancellation survives adapter wrapping without enrolling", async () => {
  const setup = h.tempVault();
  const account = fixtureAccount();
  account.sign_in = { code: "22222", password: "correct horse" };
  const owner = cancellingIo(setup, 2), api = wrapPromptErrors(new ScriptedTelegramApi(account));
  const error = await thrown(() => runTelegramConnect(owner.io, { json: true }, () => {}, () => new TelegramConnector({}, { api: () => api, credentials: () => FIXTURE_CREDENTIALS, sleep: async () => {} })));
  expect(error).toBeInstanceOf(UsageError);
  expect((error as Error).message).toBe("interactive sign-in cancelled");
  expect(owner.output.join("\n")).not.toContain("enrolled");
  expect(api.calls.some(call => call.method === "disconnect")).toBe(true);
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db")); try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
});

test("sign-in flood wait of 120s reports the duration and enrolls nothing", async () => {
  const setup = h.tempVault(), owner = ownerIo(setup);
  const account = fixtureAccount();
  account.sign_in = { code: "22222", flood: { seconds: 120, times: 1 } };
  const api = new ScriptedTelegramApi(account);
  const error = await thrown(() => runTelegramConnect(owner.io, { json: true }, () => {}, () => new TelegramConnector({}, { api: () => api, credentials: () => FIXTURE_CREDENTIALS, sleep: async () => {} })));
  expect(error).toBeInstanceOf(ConnectionError);
  expect((error as Error).message).toBe("Telegram asked you to wait 120s before retrying.");
  expect((error as Error).message).not.toContain("connectivity");
  expect(owner.output.join("\n")).not.toContain("enrolled");
  expect(api.calls.some(call => call.method === "disconnect")).toBe(true);
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db")); try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
});

test("unspecified sign-in flood wait reports waiting without a fabricated duration", async () => {
  const setup = h.tempVault(), owner = ownerIo(setup);
  const api = new ScriptedTelegramApi(fixtureAccount());
  api.start = async () => {
    throw new TelegramConnectorError("flood_wait", "kizuki.telegram: telegram asked us to wait, without saying how long");
  };
  const error = await thrown(() => runTelegramConnect(owner.io, { json: true }, () => {}, () => new TelegramConnector({}, { api: () => api, credentials: () => FIXTURE_CREDENTIALS, sleep: async () => {} })));
  expect(error).toBeInstanceOf(ConnectionError);
  expect((error as Error).message).toBe("Telegram asked you to wait before retrying.");
  expect((error as Error).message).not.toMatch(/\d+s/);
  expect((error as Error).message).not.toContain("connectivity");
  expect(owner.output.join("\n")).not.toContain("enrolled");
  expect(api.calls.some(call => call.method === "disconnect")).toBe(true);
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db")); try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
});

test("ordinary unreachable sign-in keeps the generic connectivity diagnostic", async () => {
  const setup = h.tempVault(), owner = ownerIo(setup), api = new ScriptedTelegramApi(fixtureAccount());
  api.disconnectNetwork();
  const error = await thrown(() => runTelegramConnect(owner.io, { json: true }, () => {}, () => new TelegramConnector({}, { api: () => api, credentials: () => FIXTURE_CREDENTIALS })));
  expect(error).toBeInstanceOf(ConnectionError);
  expect((error as Error).message).toBe("Telegram sign-in failed. Check connectivity and retry without changing the selected source.");
  expect(owner.output.join("\n")).not.toContain("enrolled");
  expect(api.calls.some(call => call.method === "disconnect")).toBe(true);
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db")); try { expect(listConnections(db)).toEqual([]); } finally { db.close(); }
});
