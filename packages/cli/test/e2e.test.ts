import { fixtureConsent } from "./helpers";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { listClaims, listConnections } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
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
      setup.notes, ...fixtureConsent(setup.root),
    );
    expect(imported).toMatchObject({
      exitCode: 0,
      stdout:
        "events_stored=3 duplicates=0 proposals_created=6 withdrawn=0 retractions_filed=0 errors=0\n",
    });

    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    let key = "";
    try {
      const entities = listClaims(db).filter((claim) => claim.kind === "entity");
      expect(entities).toHaveLength(3);
      expect(new Set(entities.flatMap((claim) => claim.subjects)).size).toBe(3);
      for (const entity of entities) {
        expect(entity.frontmatter["type"]).toBe("topic");
        expect(entity.subjects[0]).toMatch(
          /^kizuki\.markdown-folder\/markdown-folder\/[a-f0-9]{64}$/,
        );
        expect(entity.frontmatter["x-subject-id"]).toMatch(
          /^markdown-folder:[a-f0-9]{64}$/,
        );
        expect(entity.authority).toBe("connector_evidence");
        expect(entity.provenance).toHaveLength(1);
      }
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

    const recalled = runCli(setup.env, "query", "acme");
    expect(recalled.exitCode).toBe(0);
    expect(recalled.stdout).toMatch(/^event /);
    expect(recalled.stdout).toContain("acme");
    expect(recalled.stderr).toBe("");

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
    expect(doctor.stdout).toMatch(
      /claims live=6 filed=0 written=0 unwritten=6 superseded=0 skipped=0/,
    );
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
    expect(synced.stdout).toContain("withdrawn=2");
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

    const verified = runCli(setup.env, "restore", "--from", outDir, "--verify");
    expect(verified.exitCode).toBe(0);
    expect(verified.stdout).toContain(`verified=${outDir}/manifest.json`);
    const restored = join(setup.root, "restored");
    const restore = runCli(setup.env, "restore", "--from", outDir, "--into", restored);
    expect(restore.exitCode).toBe(0);
    expect(restore.stdout).toContain(`vault=${restored}`);
    expect(existsSync(join(restored, ".kizuki"))).toBe(true);
  });
});
