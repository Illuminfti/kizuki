import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault, writeNotes } = createHelpers();
afterEach(cleanup);

describe("sync selectors", () => {
  test("--source without a connector is a usage error", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "sync", "--source", setup.notes);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--source requires an explicit connector");
  });

  test("a named connector with no connections fails closed", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "sync", "markdown-folder");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no_connections");
  });

  test("one connection failure does not skip later connections", () => {
    const setup = tempVault();
    const extra = join(setup.root, "more-notes");
    writeNotes(extra);
    expect(
      runCli(setup.env, "connect", "markdown-folder", "--source", setup.notes)
        .exitCode,
    ).toBe(0);
    expect(
      runCli(setup.env, "connect", "markdown-folder", "--source", extra).exitCode,
    ).toBe(0);

    const synced = runCli(setup.env, "sync");
    expect(synced.exitCode).toBe(0);
    expect(synced.stdout).toContain("kizuki.markdown-folder");
    expect((synced.stdout.match(/events_stored=/g) ?? []).length).toBe(2);
  });
});

for (const args of [["sync", "--once"], ["serve", "run", "sync"]]) test(`${args.join(" ")} initializes the journal on an existing current-schema vault`, () => {
  const setup = tempVault();
  const path = join(setup.vault, ".kizuki/kizuki.db");
  const old = new Database(path);
  old.exec("DROP TABLE extract_batches"); old.close();
  const result = runCli(setup.env, ...args);
  expect(result.exitCode).toBe(0);
  const reopened = new Database(path, { readonly: true });
  expect(reopened.query("SELECT name FROM sqlite_master WHERE name='extract_batches'").all()).toHaveLength(1);
  reopened.close();
});
