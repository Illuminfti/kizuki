import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as archive from "../../src";
import * as api from "../../src/api";
import * as testkit from "../../src/api/testkit";

test("the explicit API subpath excludes fixture custody and has no registry dependency", async () => {
  expect(typeof api.createXApiConnector).toBe("function"); expect(typeof testkit.XApiFixture).toBe("function");
  expect("XApiFixture" in api).toBe(false); expect("parseState" in api).toBe(false); expect("createXApiConnector" in archive).toBe(false);
  const root = join(import.meta.dir, "../../src/api"), files = (await readdir(root)).filter(file => file.endsWith(".ts") && file !== "testkit.ts");
  const source = (await Promise.all(files.map(file => readFile(join(root, file), "utf8")))).join("\n");
  expect(source).not.toContain("@kizuki/connectors"); expect(source).not.toContain("./testkit");
});
