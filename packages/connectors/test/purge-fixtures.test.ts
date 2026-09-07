import { expect, test } from "bun:test";
import { chmodSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPurgeFixture } from "../src/purge-conformance";
import { getConnector, POCKET_IMPORT_CONNECTOR_ID } from "../src";
import { exportPurgeFixture } from "./purge-fixtures";

for (const target of ["source", "sentinel", "root"] as const) {
  test(`export snapshot refuses a planning mode mutation of ${target}`, async () => {
    const before = new Set(readdirSync(tmpdir())), fixture = await exportPurgeFixture(POCKET_IMPORT_CONNECTOR_ID);
    const roots = readdirSync(tmpdir()).filter(name => name.startsWith("kizuki-purge-source-fixture-") && !before.has(name));
    expect(roots).toHaveLength(1);
    const root = join(tmpdir(), roots[0]!), path = target === "source" ? join(root, "source/pocket.csv")
      : target === "sentinel" ? join(root, "unrelated.txt") : root;
    const mode = statSync(path).mode & 0o777, original = fixture.connector.purgeSource.bind(fixture.connector);
    fixture.connector.purgeSource = async subject => { const plan = await original(subject); chmodSync(path, mode ^ 0o040); return plan; };
    const failures: string[] = [];
    await checkPurgeFixture(getConnector(POCKET_IMPORT_CONNECTOR_ID, { path: "/nonexistent/synthetic-configured" }), async () => fixture,
      (_label, operation) => operation(), failures);
    expect(failures).toContain("purge fixture planning mutated the source");
  });
}
