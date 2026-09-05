import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionStateStore, enrollConnection, getConnection, openLedger } from "@kizuki/core";
import { createXApiConnector } from "../../src/api/connector";
import { XApiFixture } from "../../src/api/testkit";
import { X_API_CONNECTOR_ID, digest, encodeState, parseState } from "../../src/api/state";

test("actual fresh host replacement refuses pending revocation before any egress", async () => {
  const root = mkdtempSync(join(tmpdir(), "x-api-pending-replacement-")), db = openLedger(join(root, "ledger.db"));
  try {
    const f = new XApiFixture(1), state = parseState(f.state); state.revocation = "pending"; f.state = encodeState(state); f.authorize = true;
    const store = new ConnectionStateStore(root), pending = store.begin(); await pending.writer.write(f.state);
    const saved = store.save(db, X_API_CONNECTOR_ID, pending.pending), before = store.read(saved)!;
    let listeners = 0;
    const port = createXApiConnector(f.config(saved.secret_refs[0]!), f.deps({ oauth: { ...f.oauth, listen: async path => { listeners++; return f.oauth.listen(path); } } }));
    await expect(store.replace(db, saved, port, f.io)).rejects.toThrow("unavailable");
    expect(listeners).toBe(0); expect(f.authorizations).toEqual([]); expect(f.forms).toEqual([]); expect(f.requests).toEqual([]);
    expect(getConnection(db, X_API_CONNECTOR_ID, saved.source_key)).toEqual(saved); expect(store.read(saved)).toEqual(before);
    expect(readdirSync(store.directory)).toEqual([`${saved.source_key}.state`]); await port.close();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const terminal of [false, true]) test(`fresh host reauthentication preserves prior identity and pending capture after ${terminal ? "terminal revoke" : "active authorization"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "x-api-allowed-replacement-")), db = openLedger(join(root, "ledger.db"));
  try {
    const f = new XApiFixture(3), first = await f.connected(); await first.sync(null);
    if (terminal) { const oldRefresh = f.refresh, oldAccess = f.access; await first.revokeProviderAccess(); expect([...f.revokedTokens]).toEqual([oldRefresh, oldAccess]); }
    else await first.close();
    const before = parseState(f.state); expect(before.pending).not.toBeNull(); before.retry_at = "2026-02-02T00:00:00.000Z"; f.state = encodeState(before);
    const store = new ConnectionStateStore(root), pending = store.begin(); await pending.writer.write(f.state);
    const saved = store.save(db, X_API_CONNECTOR_ID, pending.pending); f.authorize = true; f.requests = []; f.forms = [];
    const port = createXApiConnector(f.config(saved.secret_refs[0]!), f.deps());
    const replaced = await store.replace(db, saved, port, f.io), after = parseState(store.read(replaced)!);
    expect(replaced.source_key).toBe(saved.source_key); expect(after.revocation).toBe("active");
    expect(after.oauth.account.id).toBe(before.oauth.account.id); expect(after.app).toBe(before.app); expect(after.selection).toEqual(before.selection);
    expect(after.checkpoint).toBe(before.checkpoint); expect(after.pending).toEqual(before.pending); expect(after.retry_at).toBe(before.retry_at);
    expect(after.oauth.tokens.refresh_token).not.toBe(before.oauth.tokens.refresh_token);
    expect(f.authorizations).toHaveLength(1); expect(f.forms).toHaveLength(1); expect(f.requests).toHaveLength(1); await port.close();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("prior app, account, selection and malformed state refuse before the replacement browser opens", async () => {
  for (const mismatch of ["app", "account", "selection", "malformed"] as const) {
    const root = mkdtempSync(join(tmpdir(), "x-api-bound-replacement-")), db = openLedger(":memory:");
    try {
      const f = new XApiFixture(1), state = parseState(f.state); f.authorize = true;
      if (mismatch === "app") state.app = digest("different-app");
      if (mismatch === "account") state.oauth.account.id = "8";
      if (mismatch === "selection") state.selection.history_start = "2026-01-03T00:00:00.000Z";
      const original = mismatch === "malformed" ? new TextEncoder().encode("SYNTHETIC_BAD_STATE_CANARY") : encodeState(state);
      const store = new ConnectionStateStore(root), pending = store.begin(); await pending.writer.write(original);
      const saved = store.save(db, X_API_CONNECTOR_ID, pending.pending), port = createXApiConnector(f.config(saved.secret_refs[0]!), f.deps());
      await expect(store.replace(db, saved, port, f.io)).rejects.toThrow(mismatch === "malformed" ? "invalid_state" : "identity_mismatch");
      expect(f.authorizations).toEqual([]); expect(f.forms).toEqual([]); expect(f.requests).toEqual([]); expect(store.read(saved)).toEqual(original); await port.close();
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("native initial enrollment supplies explicit new mode and context-less direct X sign-in fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "x-api-new-enrollment-")), db = openLedger(":memory:");
  try {
    const f = new XApiFixture(1); f.authorize = true;
    const port = createXApiConnector(f.config(), f.deps()); let writes = 0;
    await expect(port.signIn(f.io, { write: async () => { writes++; } })).rejects.toThrow("misconfigured");
    expect(f.authorizations).toEqual([]); expect(f.forms).toEqual([]); expect(f.requests).toEqual([]); expect(writes).toBe(0);
    const store = new ConnectionStateStore(root), saved = await enrollConnection(db, store, port, f.io);
    expect(parseState(store.read(saved)!).oauth.account.id).toBe(f.account); expect(f.authorizations).toHaveLength(1); await port.close();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("fresh replacement binds the authorized account to prior custody even without a config account hint", async () => {
  const root = mkdtempSync(join(tmpdir(), "x-api-account-replacement-")), db = openLedger(":memory:");
  try {
    const f = new XApiFixture(1); f.authorize = true;
    const store = new ConnectionStateStore(root), pending = store.begin(); await pending.writer.write(f.state);
    const saved = store.save(db, X_API_CONNECTOR_ID, pending.pending), before = store.read(saved)!;
    f.before = async () => Response.json({ data: { id: "8" } });
    const config = f.config(saved.secret_refs[0]!); delete config.expected_account;
    const port = createXApiConnector(config, f.deps());
    await expect(store.replace(db, saved, port, f.io)).rejects.toThrow("identity_mismatch");
    expect(f.authorizations).toHaveLength(1); expect(f.forms).toHaveLength(1); expect(f.requests).toHaveLength(1);
    expect(store.read(saved)).toEqual(before); expect(getConnection(db, X_API_CONNECTOR_ID, saved.source_key)).toEqual(saved); await port.close();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
