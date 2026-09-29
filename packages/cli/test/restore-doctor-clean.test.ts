import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accept, applyCanonWrite, createBudgetTracker, insertClaim, resolveTarget } from "@kizuki/core";
import type { Claim } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers, fixtureConsent } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

/** Write one owner-visible canon page through the receipted writer, as the loop would. */
async function writeCanonPage(vault: string, slug: string): Promise<void> {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const accepted = accept(db, {
      schema: "kizuki.event/v1", connector_id: "fixture", source_record_id: `rec-${slug}`, kind: "message",
      occurred_at: "2026-02-28T10:30:00Z", observed_at: "2026-03-01T00:00:00Z", text: `${slug} works at Acme.`,
      subjects: [{ subject_id: `person:${slug}`, role: "from", display_name: slug }], sensitivity_hint: "personal",
      deleted: false, attachments: [], metadata: {},
    });
    if (accepted.status !== "stored") throw new Error("fixture event was not stored");
    const stored = await insertClaim({ db }, {
      kind: "claim", target: `people/${slug}`, subject: `person:${slug}`, predicate: "employment.works_at", object: "acme",
      polarity: "positive", body: `${slug} works at Acme.`, frontmatter: { type: "person", title: slug },
      provenance: [accepted.event.event_id], subjects: [`person:${slug}`], producer: "deterministic", confidence: 0.8,
      sensitivity: "personal", taint: "clean",
      events: [{ event_id: accepted.event.event_id, connector_id: "fixture", taint: "untrusted", text: `${slug} works at Acme.` }],
    });
    if (stored.outcome !== "stored") throw new Error(`fixture claim was ${stored.outcome}`);
    const claim: Claim = stored.claim;
    applyCanonWrite({ db, vault_path: vault }, claim, resolveTarget({ db, vault_path: vault }, claim), {
      writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }),
    });
  } finally { db.close(); }
}

/** The loop refreshes derived state after each write; the in-process writer does not, so do it here. */
async function writeIndexed(f: ReturnType<typeof tempVault>, vault: string, slug: string): Promise<void> {
  await writeCanonPage(vault, slug);
  expect(runCli(f.env, "rebuild", "--vault", vault).exitCode).toBe(0);
}

function vaultWithCanon() {
  const f = tempVault();
  expect(runCli(f.env, "import", "markdown-folder", "--source", f.notes, ...fixtureConsent(f.root)).exitCode).toBe(0);
  return f;
}

function expectHealthy(f: ReturnType<typeof tempVault>, restored: string, receipts: number): void {
  const doctor = runCli(f.env, "doctor", "--vault", restored);
  expect(doctor.stdout).toContain(`receipts=${receipts} orphans=0`);
  expect(doctor.stdout).not.toContain("status=failed");
  expect(doctor.exitCode, doctor.stdout + doctor.stderr).toBe(0);
  expect(readFileSync(join(restored, ".kizuki", "receipts", "promotions.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(receipts);
}

test("an exported vault restores with its receipt journal, passes doctor with no orphans, and prints the agent reminder", async () => {
  const f = vaultWithCanon();
  await writeIndexed(f, f.vault, "grace");
  await writeIndexed(f, f.vault, "linus");
  const out = join(f.root, "export");
  expect(runCli(f.env, "export", "--out", out).exitCode).toBe(0);
  const restored = join(f.root, "restored");
  const restore = runCli(f.env, "restore", "--from", out, "--into", restored);
  expect(restore.exitCode, restore.stderr).toBe(0);
  expect(restore.stdout).toContain("doctor_invalid=0");
  expect(restore.stdout).toContain("reenroll_agents=unknown");
  expectHealthy(f, restored, 2);
  await writeIndexed(f, restored, "ada");
  expectHealthy(f, restored, 3);
});

test("a live snapshot restores into a healthy vault that still accepts canon writes, and names the agents to re-enroll", async () => {
  const f = vaultWithCanon();
  await writeIndexed(f, f.vault, "grace");
  await writeIndexed(f, f.vault, "linus");
  const grant = join(f.root, "grant.json");
  await Bun.write(grant, JSON.stringify({ tools: ["propose"], types: ["claim"], subjects: [], ceiling: "personal", since: "1970-01-01T00:00:00.000Z", until: "2100-01-01T00:00:00.000Z", rate_limit_per_minute: 30, relay_owner_corrections: false }));
  const enrolled = runCli(f.env, "agent", "add", "example-agent", "--grant", grant, "--token-ref", `file:${join(f.root, "example-agent.token")}`, "--operation-id", "enroll-example-1");
  expect(enrolled.exitCode, enrolled.stderr + enrolled.stdout).toBe(0);
  const out = join(f.root, "snapshot");
  const backup = runCli(f.env, "backup", "--out", out);
  expect(backup.exitCode, backup.stderr).toBe(0);
  expect(backup.stdout).toContain("schema=kizuki.snapshot/v1 complete=true");
  expect(backup.stdout).toContain("receipts=2");
  expect(backup.stdout).toContain("agents=1");
  expect(runCli(f.env, "restore", "--from", out, "--verify").exitCode).toBe(0);
  const restored = join(f.root, "restored");
  const restore = runCli(f.env, "restore", "--from", out, "--into", restored);
  expect(restore.exitCode, restore.stderr).toBe(0);
  expect(restore.stdout).toContain("reenroll_agent=example-agent");
  expectHealthy(f, restored, 2);
  expect(runCli(f.env, "agent", "list", "--vault", restored).stdout).toContain("No agents are enrolled.");
  await writeIndexed(f, restored, "ada");
  expectHealthy(f, restored, 3);
  expect(runCli(f.env, "backup", "--out", out).exitCode).toBe(1);
});
