import { expect, test } from "bun:test";
import {
  MAX_CURSOR_STORE_BYTES,
  getCheckpoint,
  readCursorStore,
  registerConnection,
  runToCompletion,
  setSourceGrant,
} from "@kizuki/core";
import type { Connector, RunContext, SyncBatch } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { TelegramConnector, encodeState, scriptedDeps } from "@kizuki/connector-telegram";
import { FakeImapServer, fixtureMailbox, fixtureState, memoryDialer } from "@kizuki/connector-imap/testing";
import {
  ConnectorRegistry,
  IMAP_CONNECTOR_ID,
  TELEGRAM_CONNECTOR_ID,
  createImapConnector,
  defaultConnectorRegistry,
  getConnector,
  sealConnector,
} from "../src";
import { runConformance } from "../src/testkit";

const SOURCE = "01JJ0000000000000000000000";

function ledger(connectorId: string) {
  const db = openLedger(":memory:");
  registerConnection(db, connectorId, SOURCE);
  setSourceGrant(db, {
    source_key: SOURCE,
    expected_revision: 0,
    operation_id: "synthetic-grant",
    policy: {
      purposes: ["capture"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "private",
    },
  });
  return db;
}

/** Use the registered production overlay, with an explicitly scripted factory. */
function fromRegistry(inner: Connector): Connector {
  const manifest = defaultConnectorRegistry.seal(inner).manifest();
  const descriptor = defaultConnectorRegistry.list().find(
    (port) => port.id === manifest.connector_id.replace(/^kizuki\./, "kizuki.connector."),
  );
  if (descriptor === undefined) throw new Error("missing connector descriptor");
  const registry = new ConnectorRegistry();
  registry.register(manifest.connector_id, descriptor, () => inner, {
    contract_minor: manifest.contract_minor!,
    implementation: manifest.implementation!,
    allowed_egress: manifest.allowed_egress!,
    cursor_schema: manifest.cursor_schema ?? null,
  });
  return registry.get(manifest.connector_id);
}

test("sealing forwards the lent run context to backfill and sync", async () => {
  const seen: Array<RunContext | undefined> = [];
  const base = getConnector(IMAP_CONNECTOR_ID, {});
  const stub: Connector = {
    ...base,
    manifest: () => base.manifest(),
    backfill: async (_cursor, context): Promise<SyncBatch> => {
      seen.push(context);
      return { events: [], cursor: null };
    },
    sync: async (_cursor, context): Promise<SyncBatch> => {
      seen.push(context);
      return { events: [], cursor: null };
    },
  };
  const sealed = sealConnector(stub, {
    contract_minor: 1,
    implementation: "stub",
    allowed_egress: [],
    cursor_schema: null,
  });
  expect(sealed.manifest().capabilities.cursor_store).toBe("host");
  const context: RunContext = { cursor_store: new Map([["k", "v"]]) };
  await sealed.backfill(null, context);
  await sealed.sync(null, context);
  expect(seen).toEqual([context, context]);
});

test("a registry-built IMAP connector backfills and syncs through the real runner with the host-held map", async () => {
  const state = fixtureState();
  const server = new FakeImapServer(fixtureMailbox(), { username: state.username, password: state.password });
  const inner = createImapConnector(
    { secret_ref: "file:connections/01ABCDEFGHJKMNPQRSTVWXYZ00.state" },
    { dial: memoryDialer(server) },
  );
  await inner.connect(async () => JSON.stringify(state));
  const sealed = fromRegistry(inner);
  const db = ledger(IMAP_CONNECTOR_ID);

  const backfilled = await runToCompletion(db, sealed, IMAP_CONNECTOR_ID, SOURCE, "backfill");
  expect(backfilled.errors).toEqual([]);
  expect(backfilled.stored).toBe(14);
  expect(getCheckpoint(db, IMAP_CONNECTOR_ID, SOURCE)?.backfill_complete).toBe(true);
  expect(readCursorStore(db, IMAP_CONNECTOR_ID, SOURCE).size).toBeGreaterThan(0);

  const synced = await runToCompletion(db, sealed, IMAP_CONNECTOR_ID, SOURCE, "sync");
  expect(synced.errors).toEqual([]);
  expect(synced.stored).toBe(0);
  db.close();
});

test("a registry-built Telegram connector backfills and syncs through the real runner with the host-held map", async () => {
  const inner = new TelegramConnector({ state_ref: "file:connections/01JJ0000000000000000000000.state" }, scriptedDeps());
  await inner.connect(async () =>
    new TextDecoder().decode(
      encodeState({
        schema: "kizuki.telegram-state/v1",
        user_id: "1001",
        session: "fixture-session-token-not-a-real-credential",
      }),
    ),
  );
  const sealed = fromRegistry(inner);
  const db = ledger(TELEGRAM_CONNECTOR_ID);

  const backfilled = await runToCompletion(db, sealed, TELEGRAM_CONNECTOR_ID, SOURCE, "backfill");
  expect(backfilled.errors).toEqual([]);
  expect(backfilled.stored).toBeGreaterThan(0);
  expect(readCursorStore(db, TELEGRAM_CONNECTOR_ID, SOURCE).size).toBeGreaterThan(0);

  const synced = await runToCompletion(db, sealed, TELEGRAM_CONNECTOR_ID, SOURCE, "sync");
  expect(synced.errors).toEqual([]);
  expect(synced.stored).toBe(0);
  await inner.close();
  db.close();
});

test("the conformance harness holds a hosted connector to the side-map bound", async () => {
  const state = fixtureState();
  const server = new FakeImapServer(fixtureMailbox(), { username: state.username, password: state.password });
  const inner = createImapConnector(
    { secret_ref: "file:connections/01ABCDEFGHJKMNPQRSTVWXYZ00.state" },
    { dial: memoryDialer(server) },
  );
  await inner.connect(async () => JSON.stringify(state));
  const oversized: Connector = {
    ...inner,
    manifest: () => inner.manifest(),
    health: () => inner.health(),
    connect: (resolve) => inner.connect(resolve),
    revoke: () => inner.revoke(),
    purgeSource: (subject) => inner.purgeSource(subject),
    fixture: () => inner.fixture(),
    backfill: async (cursor, context) => ({
      ...(await inner.backfill(cursor, context)),
      cursor_store: { big: "x".repeat(MAX_CURSOR_STORE_BYTES + 1) },
    }),
    sync: (cursor, context) => inner.sync(cursor, context),
  };
  const result = await runConformance(oversized, { backfillTwice: false });
  expect(result.pass).toBe(false);
  expect(result.failures.some((failure) => failure.includes("cursor_store would exceed"))).toBe(true);
});
