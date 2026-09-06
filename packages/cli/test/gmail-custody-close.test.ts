import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ConnectionStateStore, listConnections, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createGmailConnector, GMAIL_CONNECTOR_ID, GMAIL_SCOPES, type GmailConnectorConfig } from "@kizuki/connector-gmail";
import { encodeState, parseState } from "../../connector-gmail/src/state";
import { GmailFixture } from "../../connector-gmail/src/testing";
import { withVault } from "../src/context";
import { closeHostConnector, loadConnector, selectConnection } from "../src/connections";
import { createHelpers } from "./helpers";
import type { CliIo } from "../src/commands";
const h = createHelpers(); afterEach(h.cleanup);

test("host close bounds unknown custody without dropping a subsequently delivered rotation", async () => {
  const fixture = new GmailFixture(1), state = parseState(fixture.state);
  state.oauth.tokens.expires_at = "2020-01-01T00:00:00Z"; fixture.state = encodeState(state);
  let entered!: () => void, release!: (value: any) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const connector = createGmailConnector({ client: { id: "synthetic" }, secret_ref: "file:synthetic", fields: state.fields }, {
    now: fixture.now, fetch: fixture.fetch, persist: fixture.persist,
    oauth: { listen: async () => { throw Error("unused"); }, postForm: async () => { entered(); return new Promise(resolve => { release = resolve; }); } },
  });
  const connecting = connector.connect(async () => new TextDecoder().decode(fixture.state)).catch(() => {});
  await started;
  const before = Date.now();
  try {
    await expect(closeHostConnector(connector)).rejects.toThrow("credential_custody_unknown");
    expect(Date.now() - before).toBeLessThan(6500);
    await expect(connector.backfill(null)).rejects.toThrow();
  } finally {
    release({ status: 200, body: { access_token: "synthetic-drained-access", refresh_token: "synthetic-drained-refresh", expires_in: 3600, scope: GMAIL_SCOPES.join(" "), token_type: "Bearer" } });
    await connecting;
    await closeHostConnector(connector);
  }
  expect(parseState(fixture.state).oauth.tokens.refresh_token).toBe("synthetic-drained-refresh");
  expect((await connector.health()).state).toBe("disabled");
}, 10000);

for (const delayed of ["response", "write"] as const) test(`native host drains a late OAuth ${delayed} before closing its original state database`, async () => {
  const f = h.tempVault(), fixture = new GmailFixture(1);
  const state = parseState(fixture.state); state.oauth.tokens.expires_at = "2020-01-01T00:00:00Z";
  fixture.state = encodeState(state);
  const path = join(f.vault, ".kizuki/kizuki.db"), store = new ConnectionStateStore(join(f.vault, ".kizuki"));
  let db = openLedger(path);
  const enrollment = store.begin(); await enrollment.writer.write(fixture.state);
  const connection = store.save(db, GMAIL_CONNECTOR_ID, enrollment.pending);
  setSourceGrant(db, { source_key: connection.source_key, expected_revision: 0, operation_id: "synthetic-drain-grant", policy: {
    purposes: ["capture"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
  } });
  db.close();
  const output: string[] = [];
  const io: CliIo = { env: { ...f.env, KIZUKI_GMAIL_CLIENT_ID: "synthetic-client" }, vaultOverride: f.vault,
    stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: text => output.push(text), err: text => output.push(text), prompt: async () => { throw Error("unused"); } };
  const run = withVault(io, async ctx => {
    const selected = selectConnection(ctx.db, ctx.store, GMAIL_CONNECTOR_ID, connection.source_key);
    await loadConnector(selected, ctx.store, ctx.db, io.env, (_id, config, deps) => createGmailConnector(config as GmailConnectorConfig, {
      now: fixture.now, fetch: fixture.fetch,
      persist: async bytes => { if (delayed === "write") await Bun.sleep(5200); await deps!.persist!(bytes); },
      oauth: { listen: async () => { throw Error("unused"); }, postForm: async () => {
        if (delayed === "response") await Bun.sleep(5200);
        return { status: 200, body: { access_token: "synthetic-drained-access", refresh_token: "synthetic-drained-refresh", expires_in: 3600, scope: GMAIL_SCOPES.join(" "), token_type: "Bearer" } };
      } },
    }));
  }, { retrieval: "none" });
  await expect(run).rejects.toThrow("Gmail connection unavailable");
  // Allow the same delivered late result to settle on the old implementation;
  // its already-closed native DB must not be mistaken for successful custody.
  await Bun.sleep(300);
  db = openLedger(path);
  try {
    const current = listConnections(db).find(row => row.source_key === connection.source_key)!;
    const saved = parseState(store.read(current)!);
    expect(saved.oauth.tokens.refresh_token).toBe("synthetic-drained-refresh");
    expect(saved.oauth.account.id).toBe(state.oauth.account.id);
    expect(output.join("\n")).not.toContain("synthetic-drained");
  } finally { db.close(); }
}, 15000);
