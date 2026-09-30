import { Database } from "bun:sqlite";
import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PURGE_STORE_NAMES, applyCanonWrite, createBudgetTracker, listClaims, readSince, resolveTarget } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers, fixtureConsent } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

const MARKER = "zqxcliptotalmarker5520";

function filesHolding(dir: string, marker: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesHolding(path, marker, found);
    else if (readFileSync(path).includes(marker)) found.push(path);
  }
  return found;
}

test("an imported note is gone from every file after purge, and --verify proves each store", () => {
  const s = tempVault();
  writeFileSync(join(s.notes, "acme.md"), `Grace runs partnerships at Acme. ${MARKER}\n`);
  expect(runCli(s.env, "import", "markdown-folder", "--source", s.notes, ...fixtureConsent(s.root)).exitCode).toBe(0);

  const path = join(s.vault, ".kizuki", "kizuki.db");
  const db = openLedger(path);
  let eventId: string;
  try {
    eventId = readSince(db, null, 20).events.find((event) => event.source_record_id === "acme.md")!.event_id;
    const claim = listClaims(db).find((item) => item.kind === "claim" && item.body.includes(MARKER))!;
    const io = { db, vault_path: s.vault };
    applyCanonWrite(io, claim, resolveTarget(io, claim), { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 1 }) });
  } finally { db.close(); }
  // The marker sits in the ledger, claims, the canon page and the search index before purge.
  expect(filesHolding(s.vault, MARKER).length).toBeGreaterThan(0);

  const purged = runCli(s.env, "purge", "--event", eventId, "--reason", "retire");
  expect(purged.exitCode).toBe(0);
  expect(purged.stdout).toContain("ledger files compacted");
  // The source file is untouched, and the notes directory sits outside the vault.
  expect(filesHolding(s.vault, MARKER)).toEqual([]);

  const receipt = /receipt (\S+)/.exec(purged.stdout)![1]!;
  const verified = runCli(s.env, "purge", "--verify", receipt, "--json");
  expect(verified.exitCode).toBe(0);
  const report = JSON.parse(verified.stdout);
  expect(report.data.stores.map((proof: { store: string }) => proof.store)).toEqual([...PURGE_STORE_NAMES]);
  for (const proof of report.data.stores) expect(proof.found).toEqual([]);
  expect(filesHolding(s.vault, MARKER)).toEqual([]);

  const human = runCli(s.env, "purge", "--verify", receipt);
  expect(human.exitCode).toBe(0);
  for (const store of PURGE_STORE_NAMES) expect(human.stdout).toMatch(new RegExp(`${store}\\s+checked \\d+\\s+found 0\\s+clean`));
});

function importedEvent(s: ReturnType<typeof tempVault>): string {
  writeFileSync(join(s.notes, "acme.md"), `Grace runs partnerships at Acme. ${MARKER}\n`);
  expect(runCli(s.env, "import", "markdown-folder", "--source", s.notes, ...fixtureConsent(s.root)).exitCode).toBe(0);
  const db = openLedger(join(s.vault, ".kizuki", "kizuki.db"));
  try { return readSince(db, null, 20).events.find((event) => event.source_record_id === "acme.md")!.event_id; }
  finally { db.close(); }
}

test("--verify fails and names the store when a copy reappears after the purge, and --repair erases it", () => {
  const s = tempVault();
  const eventId = importedEvent(s);
  const receipt = /receipt (\S+)/.exec(runCli(s.env, "purge", "--event", eventId, "--reason", "retire").stdout)![1]!;

  writeFileSync(join(s.vault, "archive", "left-copy.md"), `---\nid: left\nsources:\n  - ${eventId}\n---\n${MARKER}\n`, { mode: 0o600 });
  const failed = runCli(s.env, "purge", "--verify", receipt, "--json");
  expect(failed.exitCode).toBe(1);
  const dirty = JSON.parse(failed.stdout);
  expect(dirty.status).toBe("error");
  expect(dirty.data.stores.find((proof: { store: string }) => proof.store === "archive").found).toEqual(["archive/left-copy.md"]);
  expect(dirty.data.repaired_stores).toEqual([]);
  // Verifying alone left the copy where it was.
  expect(filesHolding(s.vault, MARKER)).toEqual([join(s.vault, "archive", "left-copy.md")]);
  const human = runCli(s.env, "purge", "--verify", receipt);
  expect(human.exitCode).toBe(1);
  expect(human.stdout).toContain("still holds archive/left-copy.md");
  expect(human.stderr).toContain(`kizuki purge --verify ${receipt} --repair`);

  const repaired = runCli(s.env, "purge", "--verify", receipt, "--repair", "--json");
  expect(repaired.exitCode).toBe(0);
  const healed = JSON.parse(repaired.stdout);
  expect(healed.data.ok).toBe(true);
  expect(healed.data.repaired_stores).toEqual(["archive"]);
  expect(filesHolding(s.vault, MARKER)).toEqual([]);
  expect(runCli(s.env, "purge", "--verify", receipt).exitCode).toBe(0);
});

test("--repair without --verify is a usage error", () => {
  const s = tempVault();
  expect(runCli(s.env, "purge", "--repair").exitCode).toBe(2);
  expect(runCli(s.env, "purge", "--event", "X", "--reason", "r", "--repair").exitCode).toBe(2);
});

test("--verify names a page it could not read instead of calling the canon clean", () => {
  const s = tempVault();
  const eventId = importedEvent(s);
  const receipt = /receipt (\S+)/.exec(runCli(s.env, "purge", "--event", eventId, "--reason", "retire").stdout)![1]!;
  mkdirSync(join(s.vault, "people"), { recursive: true });
  writeFileSync(join(s.vault, "people", "broken.md"), "---\nid: [unclosed\n---\nBroken.\n", { mode: 0o600 });
  const failed = runCli(s.env, "purge", "--verify", receipt, "--json");
  expect(failed.exitCode).toBe(1);
  const canon = JSON.parse(failed.stdout).data.stores.find((proof: { store: string }) => proof.store === "canon");
  expect(canon.found).toEqual([]);
  expect(canon.unverifiable).toEqual(["people/broken.md (parse)"]);
  const human = runCli(s.env, "purge", "--verify", receipt);
  expect(human.stdout).toContain("unproven");
  expect(human.stderr).toContain("could not be proven clean: people/broken.md (parse)");
});

test("--verify fails and names the store while another connection keeps the ledger files open", () => {
  const s = tempVault();
  const eventId = importedEvent(s);
  const receipt = /receipt (\S+)/.exec(runCli(s.env, "purge", "--event", eventId, "--reason", "retire").stdout)![1]!;

  // An open read transaction stops the write-ahead log from being truncated.
  const reader = new Database(join(s.vault, ".kizuki", "kizuki.db"), { readonly: true });
  try {
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM events").get();
    // A later write leaves log frames the reader's snapshot predates, so they cannot be truncated.
    const writer = new Database(join(s.vault, ".kizuki", "kizuki.db"));
    try { writer.exec("UPDATE purge_erasures SET erased_at = '2026-01-01T00:00:00.000Z'"); } finally { writer.close(); }
    const blocked = runCli(s.env, "purge", "--verify", receipt, "--json");
    expect(blocked.exitCode).toBe(1);
    const report = JSON.parse(blocked.stdout);
    expect(report.status).toBe("error");
    expect(report.data.stores.find((proof: { store: string }) => proof.store === "database").found).toEqual(["ledger_files_busy"]);
    expect(runCli(s.env, "purge", "--verify", receipt).stdout).toContain("still holds ledger_files_busy");
  } finally { reader.close(); }
  expect(runCli(s.env, "purge", "--verify", receipt).exitCode).toBe(0);
});
