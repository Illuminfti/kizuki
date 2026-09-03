import { expect, test } from "bun:test";
import {
  KizukiError,
  OMNIVORE_IMPORT_CONNECTOR_ID,
  POCKET_IMPORT_CONNECTOR_ID,
  SCREENPIPE_CONNECTOR_ID,
  WHATSAPP_IMPORT_CONNECTOR_ID,
  getConnector,
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
