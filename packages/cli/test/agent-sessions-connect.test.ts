import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeSessionsFixtureTree } from "@kizuki/connectors/testkit";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const h = createHelpers();
afterEach(() => h.cleanup());

/** The owner-run grant the connector docs recommend: local capture and recall, no extraction. */
function sessionGrant(root: string, operation: string): string[] {
  const file = join(root, "sessions-policy.json");
  writeFileSync(
    file,
    JSON.stringify({
      purposes: ["capture", "recall", "session", "derive"],
      allowed_fields: ["text", "subjects", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "private",
    }),
    { mode: 0o600 },
  );
  return ["--policy", file, "--expected-revision", "0", "--operation-id", operation];
}

test("the catalog names both transcript sources and marks them ready", () => {
  const catalog = h.runCli(h.isolatedEnv(), "connect", "--json");
  const sources = JSON.parse(catalog.stdout).data.sources as Array<{ id: string; name: string; available: boolean; mode: string; detail: string }>;

  expect(sources).toContainEqual(expect.objectContaining({ id: "kizuki.claude-code-sessions", name: "Claude Code sessions", available: true, mode: "local source", detail: "ready to connect" }));
  expect(sources).toContainEqual(expect.objectContaining({ id: "kizuki.codex-sessions", name: "Codex sessions", available: true, mode: "local source", detail: "ready to connect" }));
});

for (const [flavor, connector] of [["claude-code", "claude-code-sessions"], ["codex", "codex-sessions"]] as const) {
  test(`connect ${connector} enrolls a transcript folder, captures only after consent, and syncs new turns`, async () => {
    const setup = h.tempVault();
    const sessions = h.tempDir("kizuki-sessions-cli-");
    await writeSessionsFixtureTree(sessions, flavor);

    const connected = h.runCli(setup.env, "connect", connector, "--source", sessions);
    expect(connected.exitCode, connected.stderr).toBe(0);
    expect(connected.stdout).toContain(`connected kizuki.${connector}`);
    expect(connected.stdout).toContain("health=ok");
    const sourceKey = connected.stdout.match(/source=([0-9A-HJKMNP-TV-Z]{26})/)?.[1] ?? "";
    expect(sourceKey).not.toBe("");

    const refused = h.runCli(setup.env, "backfill", connector, "--source", sourceKey);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("source_capture_denied");

    const granted = h.runCli(setup.env, "connect", "grant", "--source", sourceKey, ...sessionGrant(setup.root, `grant-${flavor}`));
    expect(granted.exitCode, granted.stderr).toBe(0);
    const backfilled = h.runCli(setup.env, "backfill", connector, "--source", sourceKey);
    expect(backfilled.exitCode, backfilled.stderr).toBe(0);
    expect(backfilled.stdout).toContain("events_stored=2");

    const file = readdirSync(sessions, { recursive: true, encoding: "utf8" }).find((name) => name.endsWith(".jsonl"))!;
    appendFileSync(
      join(sessions, file),
      JSON.stringify(
        flavor === "claude-code"
          ? { type: "user", uuid: "u-new", sessionId: "s-new", timestamp: "2026-01-16T09:00:00.000Z", cwd: "/work/example-app", message: { role: "user", content: "a decision made after enrollment" } }
          : { timestamp: "2026-01-16T09:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "a decision made after enrollment" }] } },
      ) + "\n",
    );
    const synced = h.runCli(setup.env, "sync", connector, "--source", sourceKey);
    expect(synced.exitCode, synced.stderr).toBe(0);
    expect(synced.stdout).toContain("events_stored=1");

    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      const row = db
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM events WHERE connector_id = ?")
        .get(`kizuki.${connector}`);
      expect(row?.n).toBe(3);
    } finally {
      db.close();
    }
    const status = h.runCli(setup.env, "connect", "status");
    expect(status.stdout).toContain(`kizuki.${connector}`);
    expect(status.stdout).toContain("private");
  });
}

test("connect refuses a transcript source that is not a readable directory", () => {
  const setup = h.tempVault();
  const refused = h.runCli(setup.env, "connect", "claude-code-sessions", "--source", join(setup.root, "absent"));

  expect(refused.exitCode).not.toBe(0);
  expect(h.runCli(setup.env, "connect", "status").stdout).toContain("No sources connected yet.");
});

test("a session run inside the vault is never captured, and the vault path is not stored in the connection", () => {
  const setup = h.tempVault();
  const sessions = h.tempDir("kizuki-sessions-cli-");
  const turn = (uuid: string, cwd: string, text: string) =>
    JSON.stringify({ type: "user", uuid, sessionId: `s-${uuid}`, timestamp: "2026-01-15T10:00:00.000Z", cwd, message: { role: "user", content: text } });
  mkdirSync(join(sessions, "proj"));
  writeFileSync(
    join(sessions, "proj", "a.jsonl"),
    [
      turn("u-1", setup.vault, "a paraphrase of recalled memory"),
      turn("u-2", join(setup.vault, "notes"), "another vault session turn"),
      turn("u-3", "/work/example-app", "a normal project decision"),
    ].join("\n") + "\n",
  );

  const connected = h.runCli(setup.env, "connect", "claude-code-sessions", "--source", sessions);
  expect(connected.exitCode, connected.stderr).toBe(0);
  const sourceKey = connected.stdout.match(/source=([0-9A-HJKMNP-TV-Z]{26})/)?.[1] ?? "";
  const granted = h.runCli(setup.env, "connect", "grant", "--source", sourceKey, ...sessionGrant(setup.root, "grant-vault-guard"));
  expect(granted.exitCode, granted.stderr).toBe(0);
  const backfilled = h.runCli(setup.env, "backfill", "claude-code-sessions", "--source", sourceKey);
  expect(backfilled.exitCode, backfilled.stderr).toBe(0);
  expect(backfilled.stdout).toContain("events_stored=1");

  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const rows = db.query<{ text: string }, []>("SELECT text FROM events WHERE connector_id = 'kizuki.claude-code-sessions'").all();
    expect(rows.map((row) => row.text)).toEqual(["a normal project decision"]);
  } finally {
    db.close();
  }
  for (const name of readdirSync(join(setup.vault, ".kizuki", "connections"), { recursive: true, encoding: "utf8" })) {
    if (!name.endsWith(".state")) continue;
    expect(readFileSync(join(setup.vault, ".kizuki", "connections", name), "utf8")).not.toContain(setup.vault);
  }
});
