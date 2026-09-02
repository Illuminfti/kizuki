import { expect, test } from "bun:test";
import {
  KizukiError,
  SCREENPIPE_CONNECTOR_ID,
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
