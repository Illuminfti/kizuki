import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listConnections, readSince, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

const h = createHelpers();
afterEach(h.cleanup);

function source(kind: "events" | "wiki" = "events") {
  const setup = h.tempVault();
  const path = join(setup.root, kind === "events" ? "events.jsonl" : "wiki");
  const mappingPath = kind === "events" ? `${path}.kizuki-mapping.json` : join(path, "kizuki-mapping.json");
  const row = (id: number, text: string) => JSON.stringify({ id: `synthetic-${id}`, text,
    occurred_at: "2026-01-01T00:00:00Z", observed_at: "2026-01-02T00:00:00Z", subjects: ["ada"] }) + "\n";
  if (kind === "events") {
    writeFileSync(path, row(1, "The lapis lantern is in the library."));
    writeFileSync(mappingPath, JSON.stringify({
      schema: "kizuki.legacy-events-mapping/v1", table: null,
      source_record_id: { column: "id" }, kind: { const: "message" }, text: { column: "text" },
      occurred_at: { column: "occurred_at", format: "rfc3339" }, observed_at: { column: "observed_at", format: "rfc3339" },
      subjects: [{ column: "subjects", role: "about", namespace: "synthetic", split: null }],
      sensitivity_hint: { const: "private" }, metadata: { columns: [] },
    }));
  } else {
    mkdirSync(path);
    writeFileSync(join(path, "ada.md"), "---\ntitle: Ada\ntype: Person\n---\nThe lapis lantern is in the library.\n");
    writeFileSync(mappingPath, JSON.stringify({ schema: "kizuki.legacy-wiki-mapping/v1",
      type: { field: "type", values: { Person: "person" }, default: "topic" }, ignore: [] }));
  }
  return { ...setup, path, mappingPath, id: `import-legacy-${kind}`,
    appendRecord() {
      if (kind === "events") appendFileSync(path, row(2, "The turquoise compass is in the library."));
      else writeFileSync(join(path, "grace.md"), "---\ntitle: Grace\ntype: Person\n---\nThe turquoise compass is in the library.\n");
    } };
}

function grant(vault: string): string {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const rows = listConnections(db);
    expect(rows).toHaveLength(1);
    expect(readSince(db, null, 8).events).toHaveLength(0);
    // Exact synthetic consent through public Core. Native policy-file custody
    // has a separate suite and is not relaxed in this UID-mapped namespace.
    const key = rows[0]!.source_key;
    setSourceGrant(db, { source_key: key, expected_revision: 0, operation_id: "synthetic-mapped-grant", policy: {
      purposes: ["capture", "recall"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
    } });
    return key;
  } finally { db.close(); }
}

function eventCount(vault: string): number {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try { return readSince(db, null, 8).events.length; } finally { db.close(); }
}

for (const kind of ["events", "wiki"] as const) {
  test.each(["connect", "import"])(`mapped legacy ${kind} enrollment in %s preserves source consent`, (command) => {
    const setup = source(kind);
    const first = h.runCli(setup.env, command, setup.id, "--source", setup.path, "--vault", setup.vault);
    expect(first.exitCode).toBe(command === "connect" ? 0 : 1);
    expect(first.stderr).not.toContain("not enrollable");
    const refused = h.runCli(setup.env, "import", setup.id, "--source", setup.path, "--vault", setup.vault);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("consent-required");
    grant(setup.vault);
    const imported = h.runCli(setup.env, "import", setup.id, "--source", setup.path, "--vault", setup.vault);
    expect(imported.stderr).not.toContain("error:");
    expect(imported.exitCode).toBe(0);
    const query = h.runCli(setup.env, "query", "lapis", "--scope", "ledger", "--degraded", "--vault", setup.vault);
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toContain("lapis lantern");
    const replay = h.runCli(setup.env, "import", setup.id, "--source", setup.path, "--vault", setup.vault);
    expect(replay.exitCode).toBe(0);
    expect(replay.stdout).toContain("stored=0");
  });

  test(`named ${kind} backfill and sync resolve persisted state across CLI restarts`, () => {
    const setup = source(kind);
    expect(h.runCli(setup.env, "connect", setup.id, "--source", setup.path, "--vault", setup.vault).exitCode).toBe(0);
    for (const command of ["backfill", "sync"]) {
      const denied = h.runCli(setup.env, command, setup.id, "--vault", setup.vault);
      expect(denied.exitCode).toBe(1);
      expect(denied.stderr).toContain("source_capture_denied");
    }
    const key = grant(setup.vault);
    const backfill = h.runCli(setup.env, "backfill", `kizuki.${setup.id}`, "--source", key, "--vault", setup.vault);
    expect(backfill.exitCode).toBe(0);
    expect(eventCount(setup.vault)).toBe(1);
    setup.appendRecord();
    const sync = h.runCli(setup.env, "sync", setup.id, "--source", setup.path, "--vault", setup.vault);
    expect(sync.exitCode).toBe(0);
    expect(eventCount(setup.vault)).toBe(2);
    const query = h.runCli(setup.env, "query", "turquoise", "--scope", "ledger", "--degraded", "--vault", setup.vault);
    expect(query.exitCode).toBe(0);
    expect(query.stdout).toContain("turquoise compass");
    const replay = h.runCli(setup.env, "sync", `kizuki.${setup.id}`, "--vault", setup.vault);
    expect(replay.exitCode).toBe(0);
    expect(replay.stdout).toContain("stored=0");
    const mapping = readFileSync(setup.mappingPath);
    unlinkSync(setup.mappingPath);
    const broken = h.runCli(setup.env, "sync", setup.id, "--vault", setup.vault);
    expect(broken.exitCode).toBe(1);
    expect(broken.stderr).toContain("mapping file not found");
    expect(broken.stderr).not.toContain("not enrollable");
    expect(eventCount(setup.vault)).toBe(2);
    writeFileSync(setup.mappingPath, mapping);
    expect(h.runCli(setup.env, "sync", setup.id, "--source", key, "--vault", setup.vault).exitCode).toBe(0);
    expect(eventCount(setup.vault)).toBe(2);
  });

  test(`missing legacy ${kind} mapping fails before enrollment`, () => {
    const setup = source(kind);
    unlinkSync(setup.mappingPath);
    for (const command of ["connect", "import"]) {
      const result = h.runCli(setup.env, command, setup.id, "--source", setup.path, "--vault", setup.vault);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("mapping file not found");
    }
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try { expect(listConnections(db)).toHaveLength(0); } finally { db.close(); }
  });
}

test("the catalog advertises mapped import support and names its required mapping without a vault", () => {
  const result = h.runCli(h.isolatedEnv(), "connect", "--list", "--json");
  expect(result.exitCode).toBe(0);
  const sources = JSON.parse(result.stdout).data.sources as { id: string; available: boolean; cli_enrollable: boolean; detail: string }[];
  for (const id of ["kizuki.import-legacy-events", "kizuki.import-legacy-wiki"]) {
    const item = sources.find((source) => source.id === id);
    expect(item?.available).toBe(true);
    expect(item?.cli_enrollable).toBe(true);
    expect(item?.detail).toContain("mapping");
  }
});
