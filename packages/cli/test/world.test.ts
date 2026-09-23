import { afterEach, describe, expect, test } from "bun:test";
import { createHelpers } from "./helpers";

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
    expect(result.stdout.trim()).toBe("No admitted matches in your current scope.");
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
  }, 15_000);
});

import { openLedger } from "../../core/src/ledger/db";
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
