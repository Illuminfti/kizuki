import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept, applyCanonWrite, createBudgetTracker, insertClaim, resolveTarget } from "@kizuki/core";
import type { CaptureEventInput, Claim, InsertClaimInput } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli, tempDir, tempVault } = createHelpers();
afterEach(cleanup);

function fixtureEvent(): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: "fixture",
    source_record_id: `rec-${crypto.randomUUID()}`,
    kind: "message",
    occurred_at: "2026-02-28T10:30:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text: "Grace runs partnerships at Acme.",
    subjects: [{ subject_id: "person:grace", role: "from", display_name: "Grace" }],
    sensitivity_hint: "personal",
    deleted: false,
    attachments: [],
    metadata: {},
  };
}

async function storeClaim(
  db: ReturnType<typeof openLedger>,
  eventId: string,
  overrides: Partial<InsertClaimInput> = {},
): Promise<Claim> {
  const input: InsertClaimInput = {
    kind: "claim",
    target: "people/grace",
    subject: "person:grace",
    predicate: "employment.works_at",
    object: "acme",
    polarity: "positive",
    body: "Grace runs partnerships at Acme.",
    frontmatter: { type: "person", title: "Grace" },
    provenance: [eventId],
    subjects: ["person:grace"],
    producer: "deterministic",
    confidence: 0.8,
    sensitivity: "personal",
    taint: "clean",
    events: [
      {
        event_id: eventId,
        connector_id: "fixture",
        taint: "untrusted",
        text: "Grace runs partnerships at Acme.",
      },
    ],
    ...overrides,
  };
  const result = await insertClaim({ db }, input);
  if (result.outcome === "stored") return result.claim;
  if (result.outcome === "contested") return result.incoming;
  throw new Error(`fixture claim was ${result.outcome}`);
}

async function writeGraceClaim(vault: string): Promise<string> {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const accepted = accept(db, fixtureEvent());
    if (accepted.status !== "stored") {
      throw new Error(`failed to store event: ${JSON.stringify(accepted)}`);
    }
    const claim = await storeClaim(db, accepted.event.event_id);
    applyCanonWrite(
      { db, vault_path: vault },
      claim,
      resolveTarget({ db, vault_path: vault }, claim),
      {
        writer: "loop",
        budget: createBudgetTracker({ canon_writes_per_run: 4 }),
      },
    );
    return claim.claim_id;
  } finally {
    db.close();
  }
}

describe("kizuki tell", () => {
  test("tell --claim corrects and rewrites without a model", async () => {
    const setup = tempVault();
    const claimId = await writeGraceClaim(setup.vault);
    const result = runCli(
      setup.env,
      "tell",
      "grace is at initech now, not acme",
      "--claim",
      claimId,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("initech");
    expect(result.stdout).toContain("people/grace.md");
    expect(result.stdout).toContain("kizuki undo");
    expect(readFileSync(join(setup.vault, "people/grace.md"), "utf8")).toContain(
      "grace is at initech now, not acme",
    );
  });

  test("configured lexical-only SQL retrieval preserves offline correction, retry and undo", async () => {
    const setup = tempVault();
    const claimId = await writeGraceClaim(setup.vault);
    const pagePath = join(setup.vault, "people/grace.md");
    const before = readFileSync(pagePath, "utf8");
    writeFileSync(join(setup.vault, ".kizuki/serve.toml"), '[ports]\nretrieval="kizuki.retrieval.embedded-pg"\n');
    expect(runCli(setup.env, "rebuild", "--json").exitCode).toBe(0);
    const args = ["tell", "grace is at initech now, not acme", "--claim", claimId, "--json"];
    const correction = runCli(setup.env, ...args);
    expect(correction.stderr).toBe("");
    expect(correction.exitCode).toBe(0);
    const receipt = JSON.parse(correction.stdout).data.receipt_id as string;
    expect(receipt).toBeString();
    const read = runCli(setup.env, "query", "initech", "--json");
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout).data.hits.some((hit: { authority: string; scope: string }) =>
      hit.scope === "canon" && hit.authority === "owner_correction")).toBe(true);
    const retry = runCli(setup.env, ...args);
    expect(retry.exitCode).toBe(0);
    expect(JSON.parse(retry.stdout).data.receipt_id).toBe(receipt);
    expect(runCli(setup.env, "undo", receipt).exitCode).toBe(0);
    expect(readFileSync(pagePath, "utf8")).toBe(before);
    expect(runCli(setup.env, "rebuild", "--json").exitCode).toBe(0);
    const restored = runCli(setup.env, "query", "grace", "--json");
    expect(restored.exitCode).toBe(0);
    const canon = JSON.parse(restored.stdout).data.hits.filter((hit: { scope: string }) => hit.scope === "canon");
    expect(canon).toHaveLength(1);
    expect(canon[0].authority).toBe("model_inference");
  }, 60_000);

  test("tell a new statement at a superseded --claim fails closed without rewriting", async () => {
    const setup = tempVault();
    const claimId = await writeGraceClaim(setup.vault);
    const first = runCli(
      setup.env,
      "tell",
      "grace is at initech now, not acme",
      "--claim",
      claimId,
    );
    expect(first.exitCode).toBe(0);
    const before = readFileSync(join(setup.vault, "people/grace.md"), "utf8");
    const replay = runCli(
      setup.env,
      "tell",
      "grace is at initech now, not acme",
      "--claim",
      claimId,
    );
    expect(replay.exitCode).toBe(0);
    expect(readFileSync(join(setup.vault, "people/grace.md"), "utf8")).toBe(before);
    const denied = runCli(
      setup.env,
      "tell",
      "grace is at contoso now, not initech",
      "--claim",
      claimId,
    );
    expect(denied.exitCode).toBe(1);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toContain("claim_not_live");
    expect(readFileSync(join(setup.vault, "people/grace.md"), "utf8")).toBe(before);
  });

  test("tell without --claim fails closed and prints the resolving flags", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "tell", "grace is at initech now, not acme");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("target_required");
    expect(result.stderr).toContain("--claim");
    expect(result.stderr).not.toContain("--about");
    expect(result.stderr).not.toContain("--page");
  });

  test("tell rejects --about and --page as usage before opening a vault", () => {
    const env = isolatedEnv();
    const root = tempDir();
    const absent = join(root, "absent");
    const before = readdirSync(root);
    for (const [flag, extra] of [
      ["--about", ["--about", "person:ada"]],
      ["--page", ["--page", "people/ada.md"]],
      ["--about", ["--claim", "synthetic-claim", "--about", "person:ada"]],
      ["--page", ["--claim", "synthetic-claim", "--page", "people/ada.md"]],
    ] as const) {
      const result = runCli(env, "--vault", absent, "tell", "the name is Ada", ...extra);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: unknown option ${flag}`);
      expect(result.stderr).toContain("usage: kizuki tell");
      expect(result.stderr).not.toContain("vault is not initialized");
      expect(result.stderr).not.toContain("no vault configured");
      expect(result.stderr).not.toContain("target_required");
    }
    expect(readdirSync(root)).toEqual(before);
    expect(existsSync(absent)).toBe(false);
  });

  test("tell --json prints the CorrectResult and --verbose prints the diff", async () => {
    const setup = tempVault();
    const claimId = await writeGraceClaim(setup.vault);
    const json = runCli(
      setup.env,
      "tell",
      "grace is at initech now, not acme",
      "--claim",
      claimId,
      "--json",
    );
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      schema: string;
      data: { rewritten: { diff: string }[] };
    };
    expect(parsed.schema).toBe("kizuki.cli.tell/v1");
    expect(parsed.data.rewritten[0]?.diff).toContain("people/grace.md");

    const setup2 = tempVault();
    const claimId2 = await writeGraceClaim(setup2.vault);
    const verbose = runCli(
      setup2.env,
      "tell",
      "grace is at initech now, not acme",
      "--claim",
      claimId2,
      "--verbose",
    );
    expect(verbose.exitCode).toBe(0);
    expect(verbose.stdout).toContain("--- a/people/grace.md");
  });
});
