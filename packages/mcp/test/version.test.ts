import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_VERSION } from "../src/version";

describe("the advertised server version", () => {
  test("matches the package manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(manifest.version);
  });
});
