import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { listConnections, openLedger, parseFrontmatter } from "@kizuki/core";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

function pendingRows(stdout: string): string[] {
  return stdout
    .trimEnd()
    .split("\n")
    .filter((line) => /^01[A-Z0-9]{24}\s/.test(line));
}

describe("kizuki CLI stranger loop", () => {
  test("init, import, review, promote, query, purge, export", () => {
    const setup = tempVault();
    expect(setup.env.KIZUKI_CONFIG).toBeDefined();
    expect(readFileSync(setup.env.KIZUKI_CONFIG ?? "", "utf8")).toContain(
      "default_vault",
    );

    const imported = runCli(
      setup.env,
      "import",
      "markdown-folder",
      "--source",
      setup.notes,
    );
    expect(imported).toMatchObject({
      exitCode: 0,
      stdout:
        "events_stored=3 duplicates=0 proposals_created=3 withdrawn=0 retractions_filed=0 errors=0\n",
    });

    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    let key = "";
    try {
      const rows = listConnections(db);
      expect(rows).toHaveLength(1);
      const connection = rows[0];
      expect(connection).toBeDefined();
      if (connection === undefined) throw new Error("missing connection");
      expect(connection.config.state_ref_index).toBe(0);
      expect(connection.secret_refs).toEqual([
        `file:connections/${connection.source_key}.state`,
      ]);
      key = connection.source_key;
    } finally {
      db.close();
    }
    const statePath = join(
      setup.vault,
      ".kizuki",
      "connections",
      `${key}.state`,
    );
    expect(statSync(statePath).mode & 0o777).toBe(0o600);

    const unlabeled = runCli(setup.env, "query", "acme");
    expect(unlabeled.exitCode).toBe(0);
    expect(unlabeled.stdout).toBe("");
    expect(unlabeled.stderr).toBe("withheld=1 (no sensitivity label)\n");

    const listed = runCli(setup.env, "review", "--list");
    expect(listed.exitCode).toBe(0);
    const rows = pendingRows(listed.stdout);
    expect(rows).toHaveLength(3);
    const promotedRow = rows.find((line) => line.includes("acme"));
    const rejectedRow = rows.find((line) => line.includes("river-stone"));
    expect(promotedRow).toBeDefined();
    expect(rejectedRow).toBeDefined();
    const promotedId = promotedRow?.split(/\s+/)[0];
    const rejectedId = rejectedRow?.split(/\s+/)[0];
    if (promotedId === undefined || rejectedId === undefined) {
      throw new Error("proposal ids were not rendered");
    }

    const unsafe = runCli(setup.env, "promote", promotedId);
    expect(unsafe.exitCode).toBe(1);
    expect(existsSync(join(setup.vault, "captures"))).toBe(false);

    const promotion = runCli(
      setup.env,
      "promote",
      promotedId,
      "--sensitivity",
      "personal",
    );
    expect(promotion.exitCode).toBe(0);
    const pagePath = promotion.stdout.match(/^page_path=(.+)$/m)?.[1];
    const receiptId = promotion.stdout.match(/^receipt_id=(.+)$/m)?.[1];
    expect(pagePath).toBeDefined();
    expect(receiptId).toMatch(/^01[A-Z0-9]{24}$/);
    expect(promotion.stdout).toContain("kind=claim");
    if (pagePath === undefined) throw new Error("page path was not printed");
    expect(readFileSync(pagePath, "utf8")).toContain('sensitivity: "personal"');

    const labeled = runCli(setup.env, "query", "acme");
    expect(labeled.exitCode).toBe(0);
    expect(labeled.stdout).toMatch(/^page\s+\S+\s+\S+\s+personal\s+.*acme/m);

    const rejection = runCli(
      setup.env,
      "reject",
      rejectedId,
      "--reason",
      "not canonical",
    );
    expect(rejection.exitCode).toBe(0);

    const doctor = runCli(setup.env, "doctor");
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain("health=ok");
    expect(doctor.stdout).toContain("connection kizuki.markdown-folder");

    rmSync(join(setup.notes, "ada.md"));
    rmSync(join(setup.notes, "linus.md"));
    const synced = runCli(setup.env, "sync", "markdown-folder");
    expect(synced.exitCode).toBe(0);
    expect(synced.stdout).toContain("withdrawn=1");
    expect(synced.stdout).toContain("retractions_filed=1");

    const doctorAfter = runCli(setup.env, "doctor");
    expect(doctorAfter.exitCode).toBe(0);
    expect(doctorAfter.stdout).toMatch(
      /^retraction-pending 01[A-Z0-9]{24} page=captures\/01[A-Z0-9]{24}\.md$/m,
    );

    const deletion = runCli(
      setup.env,
      "review",
      "--list",
      "--kind",
      "deletion",
    );
    const deletionId = pendingRows(deletion.stdout)[0]?.split(/\s+/)[0];
    if (deletionId === undefined) {
      throw new Error("deletion proposal id was not rendered");
    }
    expect(runCli(setup.env, "promote", deletionId).exitCode).toBe(0);
    const archived = runCli(setup.env, "query", "acme");
    expect(archived.stdout).toBe("");

    const sources = parseFrontmatter(readFileSync(pagePath, "utf8")).data[
      "sources"
    ];
    const eventId =
      Array.isArray(sources) && typeof sources[0] === "string"
        ? sources[0]
        : undefined;
    expect(eventId).toBeDefined();
    const purged = runCli(
      setup.env,
      "purge",
      "--event",
      eventId ?? "",
      "--reason",
      "test",
    );
    expect(purged.exitCode).toBe(0);
    expect(purged.stdout).toContain("purged=1");
    expect(purged.stdout).toContain("holds=1");
    expect(purged.stdout).toMatch(/^receipt 01[A-Z0-9]{24} event=/m);
    expect(purged.stdout).toMatch(/^hold captures\/01[A-Z0-9]{24}\.md proposal=/m);

    const doctorHold = runCli(setup.env, "doctor");
    expect(doctorHold.exitCode).toBe(0);
    expect(doctorHold.stdout).toContain("hold captures/");

    const purgeReview = runCli(
      setup.env,
      "review",
      "--list",
      "--kind",
      "purge_review",
    );
    const purgeId = pendingRows(purgeReview.stdout)[0]?.split(/\s+/)[0];
    if (purgeId === undefined) {
      throw new Error("purge_review proposal id was not rendered");
    }
    expect(runCli(setup.env, "promote", purgeId).exitCode).toBe(0);
    const afterReview = runCli(setup.env, "doctor");
    expect(afterReview.exitCode).toBe(0);
    expect(afterReview.stdout).not.toMatch(/^hold /m);
    // Deletion archived the page; query excludes archived paths even after
    // the purge-review hold is cleared. Core does not un-archive on promote.
    const stillArchived = runCli(setup.env, "query", "acme");
    expect(stillArchived.stdout).toBe("");

    const outDir = join(setup.root, "export");
    const exported = runCli(setup.env, "export", "--out", outDir);
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain(`manifest=${outDir}/manifest.json`);
    const manifest = JSON.parse(
      readFileSync(join(outDir, "manifest.json"), "utf8"),
    ) as { files: Record<string, { count: number }> };
    expect(Object.keys(manifest.files).some((key) => key.startsWith("vault/"))).toBe(
      true,
    );
    expect(manifest.files["ledger/events.jsonl"]?.count).toBeGreaterThan(0);
    expect(manifest.files["connections.jsonl"]?.count).toBe(1);
    expect(readdirSync(join(outDir, "vault")).length).toBeGreaterThan(0);
  });

  test("purge_review of an active page returns it to query", () => {
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
    const sources = parseFrontmatter(readFileSync(pagePath ?? "", "utf8")).data[
      "sources"
    ];
    const eventId =
      Array.isArray(sources) && typeof sources[0] === "string"
        ? sources[0]
        : undefined;
    expect(
      runCli(setup.env, "purge", "--event", eventId ?? "", "--reason", "test")
        .exitCode,
    ).toBe(0);
    expect(runCli(setup.env, "query", "acme").stdout).toBe("");
    const review = runCli(setup.env, "review", "--list", "--kind", "purge_review");
    const purgeId = pendingRows(review.stdout)[0]?.split(/\s+/)[0];
    expect(runCli(setup.env, "promote", purgeId ?? "").exitCode).toBe(0);
    expect(runCli(setup.env, "query", "acme").stdout).toMatch(/^page\s+/);
  });
});
