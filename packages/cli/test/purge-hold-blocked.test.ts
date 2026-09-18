import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createVaultFts5Port, readSince, serializePage } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers, fixtureConsent } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
const AT = "2026-09-02T12:00:00.000Z";
afterEach(cleanup);

// A hand-created or adopted vault folder inherits a permissive umask. The canon
// file layer then refuses to rewrite any page beneath it, so the purge hold can
// never be lifted by running --verify again.
test("purge --verify names the held pages when only the canon rewrite is blocked", async () => {
  const setup = tempVault();
  writeFileSync(join(setup.notes, "acme.md"), "Grace runs partnerships at Acme.\n");
  expect(
    runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode,
  ).toBe(0);

  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  let eventId = "";
  try {
    const target = readSince(db, null, 20).events.find((event) => event.source_record_id === "acme.md");
    expect(target).toBeDefined();
    eventId = target?.event_id ?? "";
  } finally {
    db.close();
  }

  const folder = join(setup.vault, "people");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "grace.md"),
    serializePage({
      data: {
        id: "page-grace",
        title: "grace",
        type: "person",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
        sources: [eventId],
      },
      body: "Grace runs partnerships at Acme.\n",
    }),
    { encoding: "utf8", mode: 0o600 },
  );

  const port = createVaultFts5Port(setup.vault);
  await port.upsert([
    {
      doc_id: `event:${eventId}`,
      kind: "event",
      title: "acme",
      text: "Grace runs partnerships at Acme.",
      sensitivity: "personal",
      taint: "quoted",
      authority: "connector_evidence",
      subjects: [],
      provenance: [eventId],
      occurred_at: AT,
      updated_at: AT,
    },
  ]);
  await port.close();

  chmodSync(folder, 0o775);

  const purged = runCli(
    setup.env, "purge", "--connector", "kizuki.markdown-folder", "--record", "acme.md", "--reason", "source deleted",
  );
  expect(purged.exitCode).toBe(0);
  const receipt = purged.stdout.match(/receipt ([0-9A-HJKMNP-TV-Z]{26})/)?.[1];
  expect(receipt).toBeDefined();
  if (receipt === undefined) return;

  const blocked = runCli(setup.env, "purge", "--verify", receipt);
  expect(blocked.exitCode).toBe(1);
  expect(blocked.stdout).toMatch(/hold remains/);
  expect(blocked.stderr).toContain("people/grace.md");
  expect(blocked.stderr).toContain("repeating --verify alone cannot lift the hold");

  const json = runCli(setup.env, "purge", "--verify", receipt, "--json");
  expect(json.exitCode).toBe(1);
  expect(JSON.parse(json.stdout).data).toMatchObject({
    hold_lifted: false,
    held_pages: ["people/grace.md"],
  });

  chmodSync(folder, 0o700);
  const lifted = runCli(setup.env, "purge", "--verify", receipt);
  expect(lifted.exitCode).toBe(0);
  expect(lifted.stdout).toMatch(/hold lifted/);
  expect(lifted.stderr).not.toContain("cannot lift the hold");
}, 60_000);
