import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runConformance } from "../../connectors/src/testkit";
import { XArchiveConnector } from "../src";
import { writeFixtureArchive } from "../src/testkit";

let root: string | null = null;
afterEach(async () => {
  if (root !== null) await rm(root, { recursive: true, force: true });
  root = null;
});

test("local X archive passes shared connector conformance", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "kizuki-x-conformance-"));
  await writeFixtureArchive(root);
  const connector = new XArchiveConnector(
    { path: root },
    { now: () => new Date("2026-01-01T00:00:00.000Z") },
  );
  expect(await runConformance(connector, {
    backfillTwice: true,
    unavailable: { connector: new XArchiveConnector({ path: path.join(root, "missing") }) },
  })).toEqual({ pass: true, failures: [] });
});
