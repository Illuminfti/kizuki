import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { listConnections, openLedger } from "@kizuki/core";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

describe("kizuki CLI stranger loop", () => {
  test("init, import, fail-closed query, doctor, sync, export", () => {
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

    const doctor = runCli(setup.env, "doctor");
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain("Kizuki doctor");
    expect(doctor.stdout).toContain("health=ok");
    expect(doctor.stdout).toContain("connection kizuki.markdown-folder");
    expect(doctor.stdout).toContain("claims live=");
    expect(doctor.stdout).toContain("status=ok");
    expect(doctor.stdout).not.toContain("proposals pending=");
    expect(doctor.stdout).not.toContain("retraction-pending");
    expect(doctor.stdout).toContain("claims live=");
    expect(doctor.stdout).toContain("filed=");
    expect(doctor.stdout).toContain("unwritten=");
    expect(doctor.stdout).toContain("derived search=");
    expect(doctor.stdout).toContain("next: kizuki tell");
    expect(doctor.stdout).not.toContain("tell --claim needs a live claim");
    expect(doctor.stdout.split("\n").some((line) => line.startsWith("claim "))).toBe(
      true,
    );

    rmSync(join(setup.notes, "linus.md"));
    const synced = runCli(setup.env, "sync", "markdown-folder");
    expect(synced.exitCode).toBe(0);
    expect(synced.stdout).toContain("withdrawn=1");
    expect(synced.stdout).toContain("retractions_filed=0");

    const doctorAfter = runCli(setup.env, "doctor");
    expect(doctorAfter.exitCode).toBe(0);
    expect(doctorAfter.stdout).not.toContain("retraction-pending");

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
});
