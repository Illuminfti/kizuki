import { expect, test } from "bun:test";
import {
  KizukiError,
  REGISTRY,
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

test("the repository README names every registered connector", async () => {
  // The front door states what is built; a registry entry it does not list is
  // an unsupported claim about the current revision either way round.
  const readme = await Bun.file(
    new URL("../../../README.md", import.meta.url).pathname,
  ).text();

  for (const id of Object.keys(REGISTRY)) {
    expect(readme).toContain(`\`${id}\``);
  }
});
