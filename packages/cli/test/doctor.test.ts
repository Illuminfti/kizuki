import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

describe("doctor", () => {
  test("a hand-appended bogus receipt is an orphan", () => {
    const setup = tempVault();
    const imported = runCli(
      setup.env,
      "import",
      "markdown-folder",
      "--source",
      setup.notes,
    );
    expect(imported.exitCode).toBe(0);
    const listed = runCli(setup.env, "review", "--list");
    const id = listed.stdout
      .split("\n")
      .find((line) => line.includes("acme"))
      ?.split(/\s+/)[0];
    expect(
      runCli(setup.env, "promote", id ?? "", "--sensitivity", "personal")
        .exitCode,
    ).toBe(0);

    appendFileSync(
      join(setup.vault, ".kizuki", "receipts", "promotions.jsonl"),
      `${JSON.stringify({
        receipt_id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
        proposal_id: "01BBBBBBBBBBBBBBBBBBBBBBBB",
        provenance: [],
        sensitivity: "personal",
        page_path: "captures/missing.md",
        kind: "claim",
        before_hash: null,
        after_hash: "00",
        at: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );

    const result = runCli(setup.env, "doctor");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "orphan receipt 01AAAAAAAAAAAAAAAAAAAAAAAA (no promotions row)",
    );
  });

  test("deleting a promoted page file is an orphan promotion", () => {
    const setup = tempVault();
    expect(
      runCli(
        setup.env,
        "import",
        "markdown-folder",
        "--source",
        setup.notes,
      ).exitCode,
    ).toBe(0);
    const listed = runCli(setup.env, "review", "--list");
    const id = listed.stdout
      .split("\n")
      .find((line) => line.includes("acme"))
      ?.split(/\s+/)[0];
    const promoted = runCli(
      setup.env,
      "promote",
      id ?? "",
      "--sensitivity",
      "personal",
    );
    expect(promoted.exitCode).toBe(0);
    const pagePath = promoted.stdout.match(/^page_path=(.+)$/m)?.[1];
    const receiptId = promoted.stdout.match(/^receipt_id=(.+)$/m)?.[1];
    expect(pagePath).toBeDefined();
    expect(receiptId).toBeDefined();
    rmSync(pagePath ?? "");

    const result = runCli(setup.env, "doctor");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`orphan promotion ${receiptId}`);
    expect(result.stdout).toContain("(missing on disk)");
  });
});
