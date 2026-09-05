import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionStateStore, createStatePersister, getConnection, getCheckpoint, openLedger, replayLive, runToCompletion, setSourceGrant } from "@kizuki/core";
import { XApiFixture } from "../../src/api/testkit";
import { X_API_CONNECTOR_ID, X_API_SCOPES, encodeState, parseState } from "../../src/api/state";

const ID = X_API_CONNECTOR_ID;
function grant(db: ReturnType<typeof openLedger>, source: string) {
  setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "synthetic-x-capture-grant", policy: {
    purposes: ["capture"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
  } });
}

for (const changed of [false, true]) test(`native partial acceptance restarts with ${changed ? "changed content refused" : "exact IDs deduplicated"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "x-api-native-")); let db = openLedger(join(root, "ledger.db"));
  try {
    const f = new XApiFixture(2), initial = new ConnectionStateStore(root), pending = initial.begin();
    await pending.writer.write(f.state); const saved = initial.save(db, ID, pending.pending), source = saved.source_key;
    let store = initial, handle = createStatePersister(db, store, saved);
    let port = await f.connected({ persist: async bytes => { await handle.persist(bytes); await f.persist(bytes); } });
    f.requests = [];
    const denied = await runToCompletion(db, port, ID, source, "backfill");
    expect(denied.errors.length).toBeGreaterThan(0); expect(f.requests).toEqual([]);
    grant(db, source);
    db.exec("CREATE TRIGGER synthetic_x_partial BEFORE INSERT ON events WHEN NEW.source_record_id = 'post:101' BEGIN SELECT RAISE(ABORT, 'synthetic partial accept'); END");
    const partial = await runToCompletion(db, port, ID, source, "backfill");
    expect(partial.stored).toBe(1); expect(partial.errors.length).toBeGreaterThan(0);
    expect(getCheckpoint(db, ID, source)?.cursor ?? null).toBeNull();
    expect(parseState(f.state).pending?.entries.map(entry => entry.id)).toEqual(["100", "101"]);
    db.exec("DROP TRIGGER synthetic_x_partial"); await port.close(); db.close();
    db = openLedger(join(root, "ledger.db")); store = new ConnectionStateStore(root);
    expect(store.recover(db).unresolved).toEqual([]);
    const reopened = getConnection(db, ID, source)!; f.state = store.read(reopened)!; handle = createStatePersister(db, store, reopened);
    if (changed) f.records[1]!.text = "Changed provider content after partial acceptance.";
    port = await f.connected({ persist: async bytes => { await handle.persist(bytes); await f.persist(bytes); } });
    f.requests = [];
    const retry = await runToCompletion(db, port, ID, source, "backfill");
    expect(new URL(f.requests[1]!.url).pathname).toBe("/2/tweets");
    if (changed) { expect(retry.errors.length).toBeGreaterThan(0); expect(getCheckpoint(db, ID, source)?.cursor ?? null).toBeNull(); expect([...replayLive(db)]).toHaveLength(1); }
    else { expect(retry.errors).toEqual([]); expect(retry.duplicates).toBe(1); expect(retry.stored).toBe(1); expect([...replayLive(db)]).toHaveLength(2); expect((await runToCompletion(db, port, ID, source, "sync")).stored).toBe(0); }
    expect(JSON.stringify([...replayLive(db)])).not.toContain("SYNTHETIC_X_REFRESH_CANARY"); await port.close();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("actual child exit after a durable pending plan replays before any host acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "x-api-crash-")); let db = openLedger(join(root, "ledger.db"));
  try {
    const f = new XApiFixture(2), store = new ConnectionStateStore(root), pending = store.begin();
    await pending.writer.write(f.state); const saved = store.save(db, ID, pending.pending), source = saved.source_key; grant(db, source); db.close();
    const script = join(root, "crash.ts");
    writeFileSync(script, `import {openLedger,ConnectionStateStore,getConnection,createStatePersister,runToCompletion} from ${JSON.stringify(join(import.meta.dir, "../../../core/src/index.ts"))};
import {XApiFixture} from ${JSON.stringify(join(import.meta.dir, "../../src/api/testkit.ts"))};
const db=openLedger(${JSON.stringify(join(root, "ledger.db"))}),store=new ConnectionStateStore(${JSON.stringify(root)}),saved=getConnection(db,${JSON.stringify(ID)},${JSON.stringify(source)}),handle=createStatePersister(db,store,saved),f=new XApiFixture(2);
f.state=store.read(saved);const port=await f.connected({persist:async bytes=>{await handle.persist(bytes);if(JSON.parse(new TextDecoder().decode(bytes)).pending!==null)process.exit(17)}});
await runToCompletion(db,port,${JSON.stringify(ID)},${JSON.stringify(source)},"backfill");process.exit(19);`);
    const child = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(17);
    db = openLedger(join(root, "ledger.db")); expect([...replayLive(db)]).toHaveLength(0); expect(getCheckpoint(db, ID, source)).toBeNull();
    expect(store.recover(db).unresolved).toEqual([]); const reopened = getConnection(db, ID, source)!; f.state = store.read(reopened)!;
    const handle = createStatePersister(db, store, reopened), port = await f.connected({ persist: async bytes => { await handle.persist(bytes); await f.persist(bytes); } });
    const result = await runToCompletion(db, port, ID, source, "backfill"); expect(result.errors).toEqual([]); expect(result.stored).toBe(2); await port.close();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}, 10_000);

for (const replacement of ["none", "same-account", "different-account", "revocation-pending", "revocation-pending-429"] as const) test(`late token work keeps original native CAS after close: ${replacement}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "x-api-custody-")); let db = openLedger(join(root, "ledger.db"));
  try {
    const f = new XApiFixture(1), state = parseState(f.state); state.oauth.tokens.expires_at = "2026-02-01T01:00:00Z"; f.state = encodeState(state);
    let store = new ConnectionStateStore(root); const pending = store.begin(); await pending.writer.write(f.state);
    const saved = store.save(db, ID, pending.pending), handle = createStatePersister(db, store, saved);
    let release!: (value: { status: number; body: unknown }) => void, entered!: () => void, rejected = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const port = await f.connected({ persist: async bytes => { try { await handle.persist(bytes); await f.persist(bytes); } catch (error) { rejected++; throw error; } },
      oauth: { listen: async () => { throw Error("not enrollment"); }, postForm: async () => new Promise(resolve => { release = resolve; entered(); }) } });
    const first = await port.sync(null), plan = parseState(f.state).pending; expect(first.events).toHaveLength(1); expect(plan).not.toBeNull();
    f.time = new Date("2026-02-01T02:00:00Z"); const running = port.sync(first.cursor); await started;
    let newer: Uint8Array | null = null;
    if (replacement !== "none") {
      const value = parseState(f.state); value.oauth.tokens.access_token = "synthetic-replacement-access"; value.oauth.tokens.refresh_token = "synthetic-replacement-refresh";
      if (replacement === "different-account") { value.oauth.account.id = "8"; value.checkpoint = null; value.pending = null; }
      if (replacement.startsWith("revocation-pending")) value.revocation = "pending";
      newer = encodeState(value); await createStatePersister(db, store, handle.current()).persist(newer);
    }
    await port.close(); release(replacement === "revocation-pending-429" ? { status: 429, body: { error: "SYNTHETIC_LATE_RATE_CANARY" } } :
      { status: 200, body: { access_token: "synthetic-late-access", refresh_token: "synthetic-late-refresh", expires_in: 3600, scope: X_API_SCOPES.join(" "), token_type: "Bearer" } });
    expect((await running).status).toBe("unavailable"); await expect(port.sync(null)).rejects.toThrow();
    const durable = store.read(getConnection(db, ID, saved.source_key)!)!;
    if (newer !== null) { expect(rejected).toBe(1); expect(durable).toEqual(newer); }
    else {
      expect(rejected).toBe(0); expect(parseState(durable).oauth.tokens.refresh_token).toBe("synthetic-late-refresh"); expect(parseState(durable).pending).toEqual(plan);
      db.close(); db = openLedger(join(root, "ledger.db")); store = new ConnectionStateStore(root); expect(store.recover(db).unresolved).toEqual([]);
      const reopened = getConnection(db, ID, saved.source_key)!; f.state = store.read(reopened)!; f.time = new Date("2026-02-01T04:00:00Z");
      let used: string | undefined;
      const restarted = await f.connected({ persist: createStatePersister(db, store, reopened).persist, oauth: { listen: async () => { throw Error("not enrollment"); }, postForm: async (_url, form) => {
        used = form.refresh_token; return { status: 200, body: { access_token: "synthetic-restarted-access", refresh_token: "synthetic-restarted-refresh", expires_in: 3600, scope: X_API_SCOPES.join(" "), token_type: "Bearer" } };
      } } });
      expect((await restarted.sync(first.cursor)).status).toBeUndefined(); expect(used).toBe("synthetic-late-refresh"); await restarted.close();
    }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("concurrent native revoke handles admit remote work only for the winning durable fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "x-api-concurrent-revoke-")), db = openLedger(join(root, "ledger.db"));
  try {
    const f = new XApiFixture(1), store = new ConnectionStateStore(root), pending = store.begin(); await pending.writer.write(f.state);
    const saved = store.save(db, ID, pending.pending), a = createStatePersister(db, store, saved), b = createStatePersister(db, store, saved);
    const first = await f.connected({ persist: async bytes => { await a.persist(bytes); await f.persist(bytes); } });
    const second = await f.connected({ persist: async bytes => { await b.persist(bytes); await f.persist(bytes); } });
    const results = await Promise.allSettled([first.revokeProviderAccess(), second.revokeProviderAccess()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(f.forms.map(entry => entry.form.token)).toEqual(["SYNTHETIC_X_REFRESH_CANARY_0", "SYNTHETIC_X_ACCESS_CANARY_0"]);
    expect(parseState(store.read(getConnection(db, ID, saved.source_key)!)!).revocation).toBe("revoked");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
