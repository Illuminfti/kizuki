import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { disconnect, PAGE_CANDIDATE_KEY } from "@kizuki/core";
import { openLedger } from "@kizuki/core/internal";
import { getConnector, LEGACY_WIKI_CONNECTOR_ID } from "@kizuki/connectors";
import { createHelpers, fixtureConsent } from "./helpers";

const helpers = createHelpers();
afterEach(() => helpers.cleanup());

const profile = resolve(import.meta.dir, "../../../examples/import-mappings/wordcell.json");
const original = [
  "---",
  "document_id: 11111111-1111-4111-8111-111111111111",
  "title: Quasar parser decision",
  "type: decision",
  "repository_scopes:",
  "  - packages/parser",
  "tags:",
  "  - architecture",
  "publish: true",
  "---",
  "wordcellquasar retries stop after three attempts.",
  "The plan depends on [[notes/constraints]].",
  "",
].join("\n");

function wordcell(root: string): { source: string; note: string } {
  const source = join(root, "wordcell");
  mkdirSync(join(source, "notes"), { recursive: true });
  const note = join(source, "notes", "decision.md");
  writeFileSync(note, original);
  return { source, note };
}

function counts(vault: string): { events: number; active: number } {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    return {
      events: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n,
      active: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM connections WHERE disconnected_at IS NULL").get()!.n,
    };
  } finally { db.close(); }
}

test("Wordcell profile preserves source identity, scope metadata and literal links without publishing", async () => {
  const root = helpers.tempDir();
  const { source, note } = wordcell(root);
  const connector = getConnector(LEGACY_WIKI_CONNECTOR_ID, { path: source, mapping: profile });
  expect(connector.manifest().allowed_egress).toEqual([]);
  const first = await connector.backfill(null);
  expect(first.events).toHaveLength(1);
  const event = first.events[0]!;
  expect(event.source_record_id).toBe("notes/decision.md");
  expect(event.sensitivity_hint).toBe("private");
  expect(event.text).toContain("[[notes/constraints]]");
  expect(event.metadata[PAGE_CANDIDATE_KEY]).toMatchObject({
    type: "source",
    extensions: {
      "x-wordcell-document-id": "11111111-1111-4111-8111-111111111111",
      "x-wordcell-repository-scopes": ["packages/parser"],
      "x-wordcell-tags": ["architecture"],
      "x-wordcell-publish": true,
      "x-legacy-type": "decision",
    },
  });
  expect(readFileSync(note, "utf8")).toBe(original);
  expect(readdirSync(source)).toEqual(["notes"]);
  const repeated = await connector.sync(first.cursor);
  expect(repeated.events).toEqual([]);
  writeFileSync(note, original.replace("three attempts", "two attempts"));
  const changed = await connector.sync(repeated.cursor);
  expect(changed.events).toHaveLength(1);
  expect(changed.events[0]!.source_record_id).toBe(event.source_record_id);
  expect(changed.events[0]!.text).toContain("two attempts");
  unlinkSync(note);
  const deleted = await connector.sync(changed.cursor);
  expect(deleted.events).toHaveLength(1);
  expect(deleted.events[0]).toMatchObject({ source_record_id: "notes/decision.md", deleted: true, text: "" });
});

test("CLI imports a Wordcell vault through an external mapping and reuses it on restart", async () => {
  const { root, vault, env } = helpers.tempVault();
  const { source, note } = wordcell(root);
  const first = await helpers.runCliAsync(env, "import", "import-legacy-wiki", "--source", source,
    "--mapping", relative(process.cwd(), profile), ...fixtureConsent(root));
  expect(first.exitCode).toBe(0);
  expect(first.stdout).toContain("events_stored=1");
  expect(counts(vault).events).toBe(1);
  expect(readFileSync(note, "utf8")).toBe(original);
  expect(readdirSync(source)).toEqual(["notes"]);
  expect(existsSync(join(source, "kizuki-mapping.json"))).toBe(false);
  expect(existsSync(join(vault, "sources", "notes", "decision.md"))).toBe(false);

  const again = await helpers.runCliAsync(env, "import", "import-legacy-wiki", "--source", source, "--mapping", profile);
  expect(again.exitCode).toBe(0);
  expect(again.stdout).toContain("events_stored=0");
  // A new process with no flag loads the persisted absolute mapping path.
  const resumed = await helpers.runCliAsync(env, "import", "import-legacy-wiki", "--source", source);
  expect(resumed.exitCode).toBe(0);
  expect(counts(vault).events).toBe(1);
  const found = await helpers.runCliAsync(env, "query", "wordcellquasar");
  expect(found.exitCode).toBe(0);
  expect(found.stdout).toContain("wordcellquasar");
}, 30_000);

test("an external mapping does not grant capture consent", async () => {
  const { root, vault, env } = helpers.tempVault();
  const { source } = wordcell(root);
  const denied = await helpers.runCliAsync(env, "import", "import-legacy-wiki", "--source", source, "--mapping", profile);
  expect(denied.exitCode).not.toBe(0);
  expect(denied.stderr).toContain("source_capture_denied");
  expect(counts(vault).events).toBe(0);
  expect(denied.stderr).not.toContain("wordcellquasar");
}, 30_000);

for (const disconnected of [false, true]) {
  test(`mapping conflict is refused before ${disconnected ? "reactivation" : "capture"}`, async () => {
    const { root, vault, env } = helpers.tempVault();
    const { source } = wordcell(root);
    const first = await helpers.runCliAsync(env, "import", "import-legacy-wiki", "--source", source,
      "--mapping", profile, ...fixtureConsent(root));
    expect(first.exitCode).toBe(0);
    if (disconnected) {
      const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
      try {
        const row = db.query<{ source_key: string }, [string]>(
          "SELECT source_key FROM connections WHERE connector_id = ? AND disconnected_at IS NULL",
        ).get(LEGACY_WIKI_CONNECTOR_ID)!;
        disconnect(db, LEGACY_WIKI_CONNECTOR_ID, row.source_key);
      } finally { db.close(); }
    }
    const before = counts(vault);
    const other = join(root, "other-mapping.json");
    writeFileSync(other, readFileSync(profile));
    const refused = await helpers.runCliAsync(env, "import", "import-legacy-wiki", "--source", source, "--mapping", other);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("mapping_conflict");
    expect(refused.stderr).not.toContain(other);
    expect(refused.stdout).toBe("");
    expect(counts(vault)).toEqual(before);
    const resumed = await helpers.runCliAsync(env, "import", "import-legacy-wiki", "--source", source, "--mapping", profile);
    expect(resumed.exitCode).toBe(0);
    expect(counts(vault).events).toBe(before.events);
  }, 30_000);
}

test("unsupported connectors and estate-slice refuse --mapping before input reads", async () => {
  const env = helpers.isolatedEnv();
  for (const connector of ["markdown-folder", "estate-slice"]) {
    const result = await helpers.runCliAsync(env, "import", connector, "--source", "absent-source", "--mapping", "absent-mapping");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--mapping is only supported");
    expect(result.stdout).toBe("");
  }
  const help = await helpers.runCliAsync(env, "import", "--help");
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("--mapping");
}, 30_000);

test("missing or malformed external mappings do not create records or connections", async () => {
  const { root, vault, env } = helpers.tempVault();
  const { source } = wordcell(root);
  const mapping = join(root, "mapping.json");
  const before = counts(vault);
  for (const content of [null, "not JSON", '{"schema":"wrong"}']) {
    if (content !== null) writeFileSync(mapping, content);
    const result = await helpers.runCliAsync(env, "import", "import-legacy-wiki", "--source", source,
      "--mapping", mapping, ...fixtureConsent(root));
    expect(result.exitCode).not.toBe(0);
    expect(counts(vault)).toEqual(before);
    expect(result.stderr).not.toContain("wordcellquasar");
  }
}, 30_000);

test("legacy event JSONL also accepts an external mapping without modifying its source", async () => {
  const { root, vault, env } = helpers.tempVault();
  const source = join(root, "events.jsonl");
  const mapping = join(root, "events-mapping.json");
  const record = JSON.stringify({ id: "external-1", at: "2026-01-01T00:00:00Z", body: "A synthetic external run report." }) + "\n";
  writeFileSync(source, record);
  writeFileSync(mapping, JSON.stringify({
    schema: "kizuki.legacy-events-mapping/v1",
    source_record_id: { column: "id" },
    kind: { const: "note" },
    occurred_at: { column: "at", format: "rfc3339" },
    text: { column: "body" },
  }));
  const result = await helpers.runCliAsync(env, "import", "import-legacy-events", "--source", source,
    "--mapping", mapping, ...fixtureConsent(root));
  expect(result.exitCode).toBe(0);
  expect(counts(vault).events).toBe(1);
  expect(readFileSync(source, "utf8")).toBe(record);
  expect(existsSync(`${source}.kizuki-mapping.json`)).toBe(false);
}, 30_000);
