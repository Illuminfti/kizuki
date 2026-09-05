import { expect, test } from "bun:test";
import { TelegramConnector } from "../src/connector";
import { ScriptedTelegramApi } from "../src/scripted";
import { fixtureAccount, FIXTURE_CREDENTIALS, FIXTURE_SESSION } from "../src/fixture";
import { assertSameTelegramIdentity, encodeState, parseState, TELEGRAM_STATE_SCHEMA } from "../src/state";
import { STATE_REF } from "./helpers";
const state = () => encodeState({ schema: TELEGRAM_STATE_SCHEMA, user_id: "1001", session: FIXTURE_SESSION });

test("replacement validates the same durable Telegram identity", () => {
  expect(() => assertSameTelegramIdentity(state(), state())).not.toThrow();
  expect(() => assertSameTelegramIdentity(state(), encodeState({ schema: TELEGRAM_STATE_SCHEMA, user_id: "2002", session: "synthetic-other-session" }))).toThrow("identity");
});

test("persisted FloodWait blocks restart before transport opens and expires honestly", async () => {
  const account = fixtureAccount(); let saved = state(); let now = Date.parse("2026-09-05T12:00:00Z");
  const api = new ScriptedTelegramApi(account);
  const deps = { api: () => api, credentials: () => FIXTURE_CREDENTIALS, now: () => now, persist: async (bytes: Uint8Array) => { saved = bytes; } };
  const port = new TelegramConnector({ state_ref: STATE_REF }, deps);
  await port.connect(async () => new TextDecoder().decode(saved));
  api.floodProbe(120);
  expect((await port.health()).state).toBe("rate_limited");
  expect(parseState(saved).retry_not_before).toBe("2026-09-05T12:02:00.000Z");
  await port.close();
  expect(api.calls.some(c => c.method === "logOut")).toBe(false);
  const nextApi = new ScriptedTelegramApi(account);
  const restart = new TelegramConnector({ state_ref: STATE_REF }, { ...deps, api: () => nextApi });
  await expect(restart.connect(async () => new TextDecoder().decode(saved))).rejects.toThrow("wait");
  expect(nextApi.calls).toHaveLength(0);
  now += 120_001;
  await restart.connect(async () => new TextDecoder().decode(saved));
  await restart.close();
  await expect(restart.connect(async () => new TextDecoder().decode(saved))).rejects.toThrow("closed");
});

test("reconnect FloodWait persists before rejection and a failed write never reports saved cooldown", async () => {
  let saved = state(); const account = fixtureAccount(), api = new ScriptedTelegramApi(account); api.floodProbe(90);
  const deps = { api: () => api, credentials: () => FIXTURE_CREDENTIALS, persist: async (bytes: Uint8Array) => { saved = bytes; } };
  const port = new TelegramConnector({ state_ref: STATE_REF }, deps);
  await expect(port.connect(async () => new TextDecoder().decode(saved))).rejects.toThrow("wait");
  expect(parseState(saved).retry_not_before).toBeDefined();
  expect(api.calls.at(-1)?.method).toBe("disconnect");
  const failedApi = new ScriptedTelegramApi(account);
  const failed = new TelegramConnector({ state_ref: STATE_REF }, { api: () => failedApi, credentials: () => FIXTURE_CREDENTIALS, persist: async () => { throw Error("PRIVATE_STORAGE_ERROR"); } });
  await failed.connect(async () => new TextDecoder().decode(state())); failedApi.floodProbe(90);
  await expect(failed.health()).rejects.toThrow("cooldown could not be saved");
  await failed.close();
});

test("close fences a delayed native history result and never logs out", async () => {
  const account = fixtureAccount(), api = new ScriptedTelegramApi(account);
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const original = api.messages.bind(api);
  api.messages = async function* (...args) { await wait; yield* original(...args); };
  const port = new TelegramConnector({ state_ref: STATE_REF }, { api: () => api, credentials: () => FIXTURE_CREDENTIALS, persist: async () => {} });
  await port.connect(async () => new TextDecoder().decode(state()));
  const reading = port.backfill(null); await Promise.resolve();
  await port.close(); release(); await expect(reading).rejects.toThrow("closed");
  expect(api.calls.some(c => c.method === "logOut")).toBe(false);
});

test("partial history persists provider wait before returning its resumable checkpoint", async () => {
  const account = fixtureAccount(), api = new ScriptedTelegramApi(account); let saved = state();
  let now = Date.parse("2026-09-05T12:00:00Z");
  const deps = { credentials: () => FIXTURE_CREDENTIALS, now: () => now, persist: async (bytes: Uint8Array) => { saved = bytes; } };
  const port = new TelegramConnector({ state_ref: STATE_REF }, { ...deps, api: () => api });
  await port.connect(async () => new TextDecoder().decode(saved)); api.floodAfter(0, 120);
  const partial = await port.backfill(null);
  expect(partial.events.length).toBeGreaterThan(0); expect(partial.cursor).not.toBeNull();
  expect(parseState(saved).retry_not_before).toBe("2026-09-05T12:02:00.000Z");
  await port.close(); now += 120_001;
  const restart = new TelegramConnector({ state_ref: STATE_REF }, { ...deps, api: () => new ScriptedTelegramApi(account) });
  await restart.connect(async () => new TextDecoder().decode(saved));
  const resumed = await restart.backfill(partial.cursor); await restart.close();
  const prior = new Set(partial.events.map(event => event.source_record_id));
  expect(resumed.events.every(event => !prior.has(event.source_record_id))).toBe(true);
});
