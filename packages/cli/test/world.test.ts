import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const { cleanup, isolatedEnv, runCli, tempVault } = createHelpers();
afterEach(cleanup);

function token(fill: number): string {
  return Buffer.from(Uint8Array.from({ length: 32 }, () => fill)).toString(
    "base64url",
  );
}

const OBJECT = token(1);

describe("world", () => {
  test("situation lookup of an absent anchor is not found", () => {
    const setup = tempVault();
    const result = runCli(
      setup.env,
      "world",
      "--operation",
      "situation",
      "--ref",
      OBJECT,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("not found");
  });

  test("empty discovery points at the model loop on stderr and keeps stdout plain", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "world", "--operation", "find_concepts");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe("No admitted matches in your current scope.");
    expect(result.stdout).toMatch(/View: [A-Za-z0-9_-]{43} \(valid until .+\)/);
    expect(result.stderr).toContain("kizuki doctor");
  });

  test("json names the not_found result", () => {
    const setup = tempVault();
    const result = runCli(
      setup.env,
      "world",
      "--operation",
      "concept",
      "--ref",
      OBJECT,
      "--json",
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      schema: string;
      status: string;
      data: { schema: string; data: { status: string } };
    };
    expect(body.schema).toBe("kizuki.cli.world/v1");
    expect(body.status).toBe("ok");
    expect(body.data.schema).toBe("kizuki.envelope/v2");
    expect(body.data.data).toEqual({ status: "not_found" });
  });

  test("missing vault is a runtime error before lookup", () => {
    const result = runCli(
      isolatedEnv(),
      "world",
      "--operation",
      "situation",
      "--ref",
      OBJECT,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no vault configured");
  });

  test("usage errors stay on stderr and exit 2", () => {
    const env = isolatedEnv();
    for (const [args, message] of [
      [["world"], "usage: kizuki world"],
      [["world", "--operation", "situation"], "usage: kizuki world"],
      [["world", "--operation", "situation", "--ref"], "missing value for --ref"],
      [["world", "--operation", "history", "--ref", OBJECT], "usage: kizuki world"],
      [["world", "--operation", "situation", "--ref", "nope"], "usage: kizuki world"],
      [["world", "--operation", "situation", "--ref", OBJECT, "extra"], "usage: kizuki world"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(message);
    }
  }, 60_000);
});

import { openLedger } from "../../core/src/ledger/db";
import { setSourceGrant } from "../../core/src/ledger/source-grants";
import { worldFixture } from "../../core/test/serving/world-fixture";
import { join } from "node:path";

test("CLI discovers a real admitted concept then reads the issued object token",async()=>{
  const setup=tempVault(),db=openLedger(join(setup.vault,".kizuki/kizuki.db"));
  try {await worldFixture(db);} finally {db.close();}
  const found=runCli(setup.env,"world","--operation","find_concepts","--label","Bayesian","--json");
  expect(found.exitCode).toBe(0);
  const discovery=JSON.parse(found.stdout).data;
  expect(discovery.schema).toBe("kizuki.envelope/v2");
  const ref=discovery.data.result.data.matches[0].ref;
  const read=runCli(setup.env,"world","--operation","concept","--ref",ref.token,"--json");
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout).data.data.result.data.definitions[0].object.value).toBe("Revise beliefs using evidence");
  expect(runCli(setup.env,"world","--operation","concept","--ref","A".repeat(42)+"B").exitCode).toBe(2);
});

test("CLI tell corrects a world card's opaque claim token", async () => {
  const setup = tempVault(), db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  try { await worldFixture(db); } finally { db.close(); }
  const found = runCli(setup.env, "world", "--operation", "find_concepts", "--label", "Bayesian", "--json");
  expect(found.exitCode).toBe(0);
  const ref = JSON.parse(found.stdout).data.data.result.data.matches[0].ref;
  const before = runCli(setup.env, "world", "--operation", "concept", "--ref", ref.token, "--json");
  expect(before.exitCode).toBe(0);
  const claim = JSON.parse(before.stdout).data.data.result.data.definitions[0].claim;
  const correction = runCli(
    setup.env,
    "tell",
    "Use posterior odds after new evidence.",
    "--world-claim",
    claim.token,
    "--json",
  );
  expect(correction.exitCode).toBe(0);
  const after = runCli(setup.env, "world", "--operation", "concept", "--ref", ref.token, "--json");
  expect(after.exitCode).toBe(0);
  expect(after.stdout).toContain("Use posterior odds after new evidence.");
});

test("CLI tell names a world claim's predicate and literal values in preview and correction", async () => {
  const setup = tempVault(), db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  try { await worldFixture(db); } finally { db.close(); }
  const ref = JSON.parse(runCli(setup.env, "world", "--operation", "find_concepts", "--label", "Bayesian", "--json").stdout).data.data.result.data.matches[0].ref;
  const claim = JSON.parse(runCli(setup.env, "world", "--operation", "concept", "--ref", ref.token, "--json").stdout).data.data.result.data.definitions[0].claim;
  const statement = "Use posterior odds after new evidence.";
  const preview = runCli(setup.env, "tell", statement, "--world-claim", claim.token, "--dry-run");
  expect(preview.exitCode).toBe(0);
  expect(preview.stdout).toContain(`Would correct: concept.definition is ${statement} (was: Revise beliefs using evidence).`);
  expect(preview.stdout).toContain("Would supersede 1 claim.");
  expect(preview.stdout).not.toContain("Rewrote ");
  const applied = runCli(setup.env, "tell", statement, "--world-claim", claim.token);
  expect(applied.exitCode).toBe(0);
  expect(applied.stdout).toContain(`Corrected: concept.definition is ${statement} (was: Revise beliefs using evidence).`);
  expect(applied.stdout).toContain("Superseded 1 claim.");
});

test("CLI renders a situation card with human item labels", async () => {
  const setup = tempVault(), db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  try { await worldFixture(db, { kind: "situation", label: "Harbor rollout" }); } finally { db.close(); }
  const found = JSON.parse(runCli(setup.env, "world", "--operation", "find_situations", "--label", "Harbor", "--json").stdout);
  const read = runCli(setup.env, "world", "--operation", "situation", "--ref", found.data.data.result.data.matches[0].ref.token);
  expect(read.exitCode).toBe(0);
  expect(read.stdout).toContain("Harbor rollout\nObjective: Revise beliefs using evidence\n");
  expect(read.stdout).not.toContain("situation.objective");
});

test("CLI matches labels without regard to case and pages with --cursor", async () => {
  const setup = tempVault(), db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  try {
    const first = await worldFixture(db, { label: "Topic 00", subject: "topic:0" });
    for (let i = 1; i < 33; i += 1)
      await worldFixture(db, { sourceKey: first.sourceKey, label: `Topic ${String(i).padStart(2, "0")}`, subject: `topic:${i}` });
  } finally { db.close(); }
  const one = runCli(setup.env, "world", "--operation", "find_concepts", "--label", "TOPIC");
  expect(one.exitCode).toBe(0);
  const lines = one.stdout.trim().split("\n");
  expect(lines).toHaveLength(34);
  expect(lines[32]).toBe("Coverage: partial (traversal_limit); history: unavailable.");
  const more = /^More matches: --cursor (\S{43})$/.exec(lines[33]!);
  expect(more).not.toBeNull();
  const two = runCli(setup.env, "world", "--operation", "find_concepts", "--label", "topic", "--cursor", more![1]!, "--json");
  expect(two.exitCode).toBe(0);
  const page = JSON.parse(two.stdout).data.data.result.data;
  expect(page.matches).toHaveLength(1);
  expect(page.cursor).toBeNull();
  expect(page.coverage.status).toBe("complete_for_query");
  for (const args of [
    ["--operation", "find_concepts", "--cursor", "nope"],
    ["--operation", "find_concepts", "--cursor", "A".repeat(43)],
    ["--operation", "concept", "--ref", OBJECT, "--cursor", more![1]!],
  ])
    expect(runCli(setup.env, "world", ...args).exitCode).toBe(2);
}, 120_000);

test("CLI empty discovery with an unconsumed extraction backlog says partial, not complete", async () => {
  const setup = tempVault(), db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  try {
    const f = await worldFixture(db);
    setSourceGrant(db, {
      source_key: f.sourceKey,
      expected_revision: 1,
      operation_id: "cli-extract",
      policy: {
        purposes: ["capture", "derive", "recall", "correction", "export", "extract"],
        allowed_fields: ["text", "subjects", "metadata", "attachments"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: "public",
      },
    });
  } finally { db.close(); }
  const result = runCli(setup.env, "world", "--operation", "find_concepts", "--label", "nothing like it");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("No admitted matches in your current scope.");
  expect(result.stdout).toContain("Coverage: partial (pending_consolidation); history: unavailable.");
}, 60_000);
