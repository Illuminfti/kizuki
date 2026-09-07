import { expect, test } from "bun:test";
import { PORT_CONTRACTS, PortError } from "@kizuki/core";
import type { PortDescriptor } from "@kizuki/core";
import {
  ConnectorRegistry,
  KizukiError,
  OMNIVORE_IMPORT_CONNECTOR_ID,
  POCKET_IMPORT_CONNECTOR_ID,
  SCREENPIPE_CONNECTOR_ID,
  WHATSAPP_IMPORT_CONNECTOR_ID,
  X_API_CONNECTOR_ID,
  X_ARCHIVE_CONNECTOR_ID,
  getConnector,
  listConnectorDescriptors,
  sealConnector,
} from "../src";

test("getConnector builds kizuki.screenpipe", () => {
  expect(
    getConnector(SCREENPIPE_CONNECTOR_ID, {
      path: "/tmp/not-opened-screenpipe.sqlite",
    }).manifest().connector_id,
  ).toBe(SCREENPIPE_CONNECTOR_ID);
});

test("getConnector rejects an unknown connector id", () => {
  try {
    getConnector("kizuki.unknown", {});
    throw new Error("expected getConnector to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(KizukiError);
    if (!(error instanceof KizukiError)) return;
    expect(error.code).toBe("unknown_connector");
  }
});

test("getConnector builds every snapshot importer", () => {
  const cases: [string, Record<string, unknown>][] = [
    [WHATSAPP_IMPORT_CONNECTOR_ID, { path: "/exports/chat" }],
    [POCKET_IMPORT_CONNECTOR_ID, { path: "/exports/pocket.csv" }],
    [OMNIVORE_IMPORT_CONNECTOR_ID, { path: "/exports/omnivore" }],
    [X_ARCHIVE_CONNECTOR_ID, { path: "/exports/x-archive" }],
  ];
  for (const [id, config] of cases) {
    expect(getConnector(id, config).manifest().connector_id).toBe(id);
  }
});

test("X API registry entry is provider-bound, private, and fails closed without host composition", async () => {
  const connector = getConnector(X_API_CONNECTOR_ID, {});
  const manifest = connector.manifest();
  expect(manifest.connector_id).toBe("kizuki.x");
  expect(manifest.allowed_egress).toEqual(["api.x.com", "x.com"]);
  expect(manifest.kinds).toEqual(["post"]);
  expect(manifest.contract_minor).toBe(3);
  expect(manifest.default_sensitivity).toBe("private");
  expect(manifest.sensitivity_floor).toBe("private");
  expect(manifest.auth_modes).toEqual(["oauth", "secret_ref", "sign_in"]);
  expect(manifest.capabilities).toMatchObject({ backfill: true, sync: true, tombstones: false, purge: false, fixture: true });
  expect(listConnectorDescriptors().find((port) => port.id === "kizuki.connector.x")).toMatchObject({
    contract_minor: 3,
    optional_package: "@kizuki/connector-x/api",
    supports: ["backfill", "sync", "fixture", "sign_in"],
  });
  await expect(connector.connect(async () => "unused")).rejects.toMatchObject({ code: "misconfigured" });
  expect((await connector.health()).state).toBe("misconfigured");
});

test("sealing forwards the sign-in context a contract-minor-3 connector requires", async () => {
  const seen: unknown[] = [];
  const sealed = sealConnector(
    { ...getConnector(X_API_CONNECTOR_ID, {}), signIn: async (_io, _state, context) => { seen.push(context); return { display: "stub" }; } },
    { contract_minor: 3, implementation: "stub", allowed_egress: [], cursor_schema: null },
  );
  const io = { prompt: async () => "", notify: () => {}, openUrl: async () => {} };
  await sealed.signIn!(io, { write: async () => {} } as never, { mode: "new" });
  expect(seen).toEqual([{ mode: "new" }]);
});

test("X archive registry policy is local, posts-only, and personal", () => {
  const manifest = getConnector(X_ARCHIVE_CONNECTOR_ID, { path: "/exports/x-archive" }).manifest();
  expect(manifest.allowed_egress).toEqual([]);
  expect(manifest.kinds).toEqual(["post"]);
  expect(manifest.default_sensitivity).toBe("personal");
  expect(manifest.sensitivity_floor).toBe("personal");
  expect(manifest.capabilities).toMatchObject({
    backfill: true,
    sync: true,
    tombstones: false,
    purge: false,
    fixture: true,
  });
  expect(manifest.capabilities.page_candidates).toBeUndefined();
});

test("the registry lists frozen port descriptors and rejects unknown ids", () => {
  const listed = listConnectorDescriptors();
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.every((item) => item.kind === "connector")).toBe(true);
  expect(listed.every((item) => item.contract === PORT_CONTRACTS.connector)).toBe(
    true,
  );
  expect(() => {
    (listed as PortDescriptor[]).push(listed[0]!);
  }).toThrow();
  const sealed = getConnector(SCREENPIPE_CONNECTOR_ID, {
    path: "/tmp/not-opened-screenpipe.sqlite",
  }).manifest();
  expect(() => {
    (sealed.kinds as string[]).push("mutated");
  }).toThrow();
  expect(sealed.implementation).toBe("@kizuki/connector-screenpipe");
  expect(sealed.default_sensitivity).toBe("private");
});

test("duplicate connector ids and contract mismatches are hard failures", () => {
  const registry = new ConnectorRegistry();
  const descriptor = listConnectorDescriptors()[0]!;
  const factory = () =>
    getConnector(SCREENPIPE_CONNECTOR_ID, {
      path: "/tmp/not-opened-screenpipe.sqlite",
    });
  const overlay = {
    contract_minor: 1,
    implementation: "@kizuki/connectors",
    allowed_egress: [],
    cursor_schema: null as string | null,
  };
  registry.register(SCREENPIPE_CONNECTOR_ID, descriptor, factory, overlay);
  expect(() =>
    registry.register(SCREENPIPE_CONNECTOR_ID, descriptor, factory, overlay),
  ).toThrow(PortError);
  expect(() =>
    registry.register(
      "kizuki.other",
      { ...descriptor, contract: "kizuki.connector/v2" },
      factory,
      overlay,
    ),
  ).toThrow(PortError);
});

test("a snapshot importer without a path is refused", () => {
  for (const id of [
    WHATSAPP_IMPORT_CONNECTOR_ID,
    POCKET_IMPORT_CONNECTOR_ID,
    OMNIVORE_IMPORT_CONNECTOR_ID,
    X_ARCHIVE_CONNECTOR_ID,
  ]) {
    try {
      getConnector(id, {});
      throw new Error("expected getConnector to refuse an empty config");
    } catch (error) {
      expect(error).toBeInstanceOf(KizukiError);
      if (!(error instanceof KizukiError)) return;
      expect(error.code).toBe("misconfigured");
    }
  }
});

test('X API registry exposes native sign-in and passes exact Core new/replace context', async () => {
  const { XApiFixture } = await import('@kizuki/connector-x/api/testkit');
  const { createXApiConnector } = await import('@kizuki/connector-x/api');
  const { defaultConnectorRegistry } = await import('../src');
  const fixture = new XApiFixture(1); fixture.authorize = true;
  const raw = createXApiConnector(fixture.config(), fixture.deps());
  const sealed = defaultConnectorRegistry.seal(raw);
  expect(sealed.manifest()).toMatchObject({ connector_id: 'kizuki.x', contract_minor: 3, implementation: '@kizuki/connector-x/api', auth_modes: ['oauth', 'secret_ref', 'sign_in'], capabilities: { tombstones: false, purge: false } });
  expect(listConnectorDescriptors().find(item => item.id === 'kizuki.connector.x')).toMatchObject({ contract_minor: 3, supports: ['backfill', 'sync', 'fixture', 'sign_in'] });
  let state: Uint8Array | undefined;
  const writer = { write: async (bytes: Uint8Array) => { state = bytes; } };
  await sealed.signIn!(fixture.io, writer, { mode: 'new' }); expect(state).toBeDefined(); await raw.closeForHost();
  const replacement = createXApiConnector(fixture.config(), fixture.deps());
  await defaultConnectorRegistry.seal(replacement).signIn!(fixture.io, writer, { mode: 'replace', previous_state: state! });
  await replacement.closeForHost();
});
