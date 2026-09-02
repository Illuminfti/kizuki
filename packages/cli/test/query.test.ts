import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@kizuki/core";
import type { SearchHit } from "@kizuki/core";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

function pendingIds(stdout: string): string[] {
  return stdout
    .trimEnd()
    .split("\n")
    .filter((line) => /^01[A-Z0-9]{24}\s/.test(line))
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((id) => id.length > 0);
}

function importNotes(setup: ReturnType<typeof tempVault>) {
  const imported = runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    setup.notes,
  );
  expect(imported.exitCode).toBe(0);
  return imported;
}

describe("query", () => {
  test("--limit 0 and --limit x are usage errors", () => {
    const setup = tempVault();
    for (const limit of ["0", "x"]) {
      const result = runCli(setup.env, "query", "acme", "--limit", limit);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage: kizuki query");
    }
  });

  test("--scope canon and --scope ledger split labeled pages from unlabeled events", () => {
    const setup = tempVault();
    importNotes(setup);
    const listed = runCli(setup.env, "review", "--list");
    const ada = listed.stdout
      .split("\n")
      .find((line) => line.includes("acme"));
    const id = ada?.split(/\s+/)[0];
    expect(id).toBeDefined();
    expect(
      runCli(setup.env, "promote", id ?? "", "--sensitivity", "personal")
        .exitCode,
    ).toBe(0);

    const canon = runCli(setup.env, "query", "acme", "--scope", "canon");
    expect(canon.exitCode).toBe(0);
    expect(canon.stdout).toMatch(/^page /);
    expect(canon.stdout).not.toMatch(/^event /m);

    const ledger = runCli(setup.env, "query", "acme", "--scope", "ledger");
    expect(ledger.exitCode).toBe(0);
    expect(ledger.stdout).toBe("");
    expect(ledger.stderr).toContain("withheld=");
  });

  test("held and archived pages are never returned", () => {
    const setup = tempVault();
    importNotes(setup);
    const listed = runCli(setup.env, "review", "--list");
    const ada = listed.stdout
      .split("\n")
      .find((line) => line.includes("acme"));
    const id = ada?.split(/\s+/)[0];
    expect(id).toBeDefined();
    const promoted = runCli(
      setup.env,
      "promote",
      id ?? "",
      "--sensitivity",
      "personal",
    );
    expect(promoted.exitCode).toBe(0);
    const pagePath = promoted.stdout.match(/^page_path=(.+)$/m)?.[1];
    expect(pagePath).toBeDefined();
    const sources = parseFrontmatter(readFileSync(pagePath ?? "", "utf8")).data[
      "sources"
    ];
    const source =
      Array.isArray(sources) && typeof sources[0] === "string"
        ? sources[0]
        : undefined;
    expect(source).toBeDefined();

    const purged = runCli(
      setup.env,
      "purge",
      "--event",
      source ?? "",
      "--reason",
      "test",
    );
    expect(purged.exitCode).toBe(0);
    expect(purged.stdout).toContain("holds=1");
    const held = runCli(setup.env, "query", "acme");
    expect(held.stdout).toBe("");

    const other = listed.stdout
      .split("\n")
      .find((line) => line.includes("river-stone"));
    const otherId = other?.split(/\s+/)[0];
    expect(otherId).toBeDefined();
    expect(
      runCli(setup.env, "promote", otherId ?? "", "--sensitivity", "personal")
        .exitCode,
    ).toBe(0);
    rmSync(join(setup.notes, "grace.md"));
    const synced = runCli(setup.env, "sync", "markdown-folder");
    expect(synced.stdout).toContain("retractions_filed=1");
    const deletion = runCli(
      setup.env,
      "review",
      "--list",
      "--kind",
      "deletion",
    );
    const deletionId = pendingIds(deletion.stdout)[0];
    expect(deletionId).toBeDefined();
    expect(runCli(setup.env, "promote", deletionId ?? "").exitCode).toBe(0);
    const archived = runCli(setup.env, "query", "river-stone");
    expect(archived.stdout).toBe("");
  });

  test("tombstoned records never return their events", () => {
    const setup = tempVault();
    importNotes(setup);
    rmSync(join(setup.notes, "linus.md"));
    expect(runCli(setup.env, "sync", "markdown-folder").exitCode).toBe(0);
    const result = runCli(setup.env, "query", "moth-lantern", "--scope", "ledger");
    expect(result.stdout).toBe("");
  });

  test("--json lines parse as SearchHit", () => {
    const setup = tempVault();
    importNotes(setup);
    const listed = runCli(setup.env, "review", "--list");
    const ada = listed.stdout
      .split("\n")
      .find((line) => line.includes("acme"));
    const id = ada?.split(/\s+/)[0];
    expect(
      runCli(setup.env, "promote", id ?? "", "--sensitivity", "personal")
        .exitCode,
    ).toBe(0);

    const result = runCli(setup.env, "query", "acme", "--json");
    expect(result.exitCode).toBe(0);
    const hit = JSON.parse(result.stdout.trim()) as SearchHit;
    expect(hit.scope).toBe("canon");
    expect(hit.doc_id).toBeDefined();
    expect(hit.snippet).toContain("acme");
  });
});
