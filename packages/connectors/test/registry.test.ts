import { expect, test } from "bun:test";
import { KizukiError, getConnector } from "../src";

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
