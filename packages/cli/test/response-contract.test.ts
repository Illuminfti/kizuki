import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER, accept, listAudit } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { worldSeed } from "../../core/test/helpers/world-seed";
import { serveWorldView } from "../../core/src/serving/world-view";
import { WRITER_REFUSAL_V2 } from "../../core/src/contracts/scoped-tools";
import { tryWriteFlock } from "../../core/src/serve/flock";
import { createHelpers, fixtureConsent } from "./helpers";

setDefaultTimeout(120_000);
const { cleanup, tempVault, runCli } = createHelpers();
afterEach(cleanup);
const V1 = "kizuki.envelope/v1";
const V2 = "kizuki.envelope/v2";
const keys = ["at", "canon", "data", "principal", "quoted", "schema", "tool"];

function forbidden(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(forbidden);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(["epoch", "claims_epoch", "source_policy", "denied"].includes(key) ? [key] : []),
    ...forbidden(item),
  ]);
}

test("CLI query and context preserve explicit owner v1 and render the selected v2 envelope", () => {
  const setup = tempVault();
  for (const [command, args, tool] of [
    ["context", ["--budget", "1000"], "context_packet"],
    ["query", ["ordinary", "--degraded"], "search"],
  ] as const) {
    const legacy = runCli(setup.env, command, ...args, "--response-contract", V1, "--json");
    expect(legacy.exitCode, legacy.stderr).toBe(0);
    expect(JSON.parse(legacy.stdout).schema).toBe(`kizuki.cli.${command}/v1`);
    const run = runCli(setup.env, command, ...args, "--response-contract", V2, "--json");
    expect(run.exitCode, run.stderr).toBe(0);
    const wire = JSON.parse(run.stdout);
    expect(Object.keys(wire).sort()).toEqual(["command", "result", "schema"]);
    expect(wire).toMatchObject({ schema: "kizuki.cli-result/v2", command, result: { schema: V2, tool } });
    expect(Object.keys(wire.result).sort()).toEqual(keys);
    expect(forbidden(wire)).toEqual([]);
    if (command === "context") {
      expect(wire.result.data.schema).toBe("kizuki.context-packet/v2");
      const text = runCli(setup.env, command, ...args, "--response-contract", V2);
      expect(text.stdout).toStartWith("KIZUKI CONTEXT v2\n");
      expect(text.stdout).not.toMatch(/epoch|etag|packet_hash/);
    }
  }
});

test("unknown CLI contracts fail with an audited fixed refusal", () => {
  const setup = tempVault();
  for (const [command, args] of [["context", []], ["query", ["ordinary", "--degraded"]], ["tell", ["Use the current statement."]]] as const) {
    const result = runCli(setup.env, command, ...args, "--response-contract", "kizuki.envelope/v9", "--json");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requested contract unavailable");
    expect(JSON.parse(result.stdout)).toEqual({ schema: "kizuki.cli-result/v2", command,
      result: { ok: false, error: { code: "unsupported_contract", message: "requested contract unavailable", retryable: false } },
    });
  }
});

test("an unknown query contract is refused and audited even when the index is stale", () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    expect(accept(db, {
      schema: "kizuki.event/v1", connector_id: "fixture", source_record_id: "contract-stale",
      kind: "message", occurred_at: "2026-09-01T00:00:00Z", observed_at: "2026-09-01T00:00:00Z",
      text: "An ordinary fixture", subjects: [], deleted: false, attachments: [], metadata: {},
    }).status).toBe("stored");
    const result = runCli(setup.env, "query", "ordinary", "--response-contract", "kizuki.envelope/v9", "--json");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requested contract unavailable");
    expect(JSON.parse(result.stdout)).toMatchObject({ result: { error: { code: "unsupported_contract" } } });
    const row = listAudit(db, "owner", { kind: "access", limit: 1 })[0];
    expect(row?.served).toEqual([]);
    expect(row?.denied).toEqual([{ id: "tool:search", reason: "unsupported_contract" }]);
  } finally { db.close(); }
});

test("v2 queries preserve bounded excerpts and explicit full-text reads", () => {
  const setup = tempVault();
  writeFileSync(join(setup.notes, "long.md"), `zqxenvexcerpt ${"filler word ".repeat(500)}\n`);
  const imported = runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root));
  expect(imported.exitCode, imported.stderr).toBe(0);
  const args = ["query", "zqxenvexcerpt", "--scope", "ledger", "--response-contract", V2];
  const bounded = runCli(setup.env, ...args, "--json");
  expect(bounded.exitCode, bounded.stderr).toBe(0);
  const [chunk] = JSON.parse(bounded.stdout).result.quoted;
  expect(Array.from(chunk.text)).toHaveLength(600);
  expect(chunk).not.toHaveProperty("truncated");
  expect(chunk.eventVersion.kind).toBe("event_version");
  const text = runCli(setup.env, ...args);
  expect(text.exitCode, text.stderr).toBe(0);
  expect(text.stdout).toContain(chunk.text);
  const whole = runCli(setup.env, ...args, "--full-text", "--json");
  expect(whole.exitCode, whole.stderr).toBe(0);
  const [full] = JSON.parse(whole.stdout).result.quoted;
  expect(full.text.length).toBeGreaterThan(5000);
  expect(full.truncated).toBeUndefined();
});


test("CLI typed correction uses retained refs and gives the same fixed busy and erasure refusal", async () => {
  const setup = tempVault(), db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  try {
    const seed = await worldSeed(db), ctx = { db, vaultPath: setup.vault, principal: OWNER };
    const card = serveWorldView(ctx, { operation: "concept", concept: seed.ref, valid: { kind: "all" }, knownAt: { kind: "current" } }).data as any;
    const ref = card.result.data.definitions[0].claim;
    const args = ["tell", "The updated definition.", "--world-claim", ref.token, "--response-contract", V2, "--json"];
    for (const mode of ["busy", "erasure"] as const) {
      const lock = mode === "busy" ? tryWriteFlock(setup.vault) : null;
      if (mode === "busy") expect(lock).not.toBeNull();
      else db.query("INSERT INTO canon_source_erasure_intents(page_path,source_key,intent,digest) VALUES (?,?,?,?)").run("unrelated-pending", "unrelated-source", "{}", "fixture");
      try {
        const result = runCli(setup.env, ...args);
        expect(result.exitCode, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({ schema: "kizuki.cli-result/v2", command: "tell", result: WRITER_REFUSAL_V2 });
        expect(db.query("SELECT 1 FROM native_owner_evidence").get()).toBeNull();
      } finally { lock?.release(); }
    }
    db.query("DELETE FROM canon_source_erasure_intents").run();
    const result = runCli(setup.env, ...args);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.result.data.message).toBe("correction_recorded");
    expect(output.result.data.superseded).toEqual([ref]);
    expect(output.result.data.claim.kind).toBe("claim");
    expect(output.result.data).not.toHaveProperty("answer");
  } finally { db.close(); }
});
