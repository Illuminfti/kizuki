import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accept,
  applyCanonWrite,
  createBudgetTracker,
  insertClaim,
  openLedger,
  resolveTarget,
} from "@kizuki/core";
import type { CaptureEventInput, Claim, InsertClaimInput } from "@kizuki/core";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
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
