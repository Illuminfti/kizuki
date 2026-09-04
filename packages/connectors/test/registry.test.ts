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
  getConnector,
  listConnectorDescriptors,
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
  ];
  for (const [id, config] of cases) {
    expect(getConnector(id, config).manifest().connector_id).toBe(id);
  }
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
