import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializePage } from "../../../core/src/vault/frontmatter";
import { openLedger } from "../../../core/src/ledger/db";
import { putEvent } from "../../../core/test/claims/helpers";
import { createHelpers } from "../helpers";

const h = createHelpers();
afterEach(h.cleanup);

function page(id: string, sources: unknown, status = "active"): Record<string, unknown> {
  return { id, title: "Synthetic provenance note", type: "fact", status,
    sensitivity: "private", taint: "clean", sources };
}

function seed(vault: string, name: string, data: Record<string, unknown>) {
  const path = join(vault, "facts", `${name}.md`);
  const bytes = serializePage({ data, body: "Private synthetic body is never a doctor diagnostic.\n" });
  writeFileSync(path, bytes);
  return { path, bytes };
}

test("doctor JSON reports source shape and resolution failures with nonzero exit and preserves owner files", () => {
  const setup = h.tempVault();
  const missing = page("missing", []);
  delete missing["sources"];
  const seeds = [
    seed(setup.vault, "missing", missing),
    seed(setup.vault, "empty", page("empty", [])),
    seed(setup.vault, "unresolved", page("unresolved", ["synthetic-event-not-for-output"])),
    seed(setup.vault, "archived", page("archived", [], "archived")),
  ];
  const result = h.runCli(setup.env, "doctor", "--json");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout);
  expect(report.status).toBe("error");
  expect(report.data.ok).toBe(false);
  const sourceProblems = report.data.problems.filter((item: { error: string }) => item.error.includes("sources:"));
  expect(sourceProblems).toEqual([
    { page: "facts/empty.md", error: "sources: must name at least one event unless archived" },
    { page: "facts/missing.md", error: "sources: is required" },
    { page: "facts/unresolved.md", error: "sources: one or more event IDs do not resolve in the ledger" },
  ]);
  expect(result.stdout).not.toContain("synthetic-event-not-for-output");
  expect(result.stdout).not.toContain("Private synthetic body");
  for (const file of seeds) expect(readFileSync(file.path, "utf8")).toBe(file.bytes);
});

test("doctor accepts current ledger provenance without inventing owner authorship", () => {
  const setup = h.tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const eventId = putEvent(db);
  const before = db.query("SELECT * FROM native_owner_evidence").all();
  db.close();
  const file = seed(setup.vault, "grounded", page("grounded", [eventId]));
  const result = h.runCli(setup.env, "doctor", "--json");
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout);
  expect(report.data.problems.filter((item: { error: string }) => item.error.includes("sources:"))).toEqual([]);
  expect(readFileSync(file.path, "utf8")).toBe(file.bytes);
  const reopened = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try { expect(reopened.query("SELECT * FROM native_owner_evidence").all()).toEqual(before); }
  finally { reopened.close(); }
});

test("doctor diagnoses every nested page while preserving root doctrine and archive history", () => {
  const setup = h.tempVault();
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  const eventId = putEvent(db);
  db.close();
  mkdirSync(join(setup.vault, "facts", "archive"));
  const missing = page("nested-canon", []);
  delete missing["sources"];
  const files = [
    seed(setup.vault, "CANON", missing),
    seed(setup.vault, "SCHEMA", page("nested-schema", [])),
    seed(setup.vault, "archive/item", page("nested-archive", [eventId, "synthetic-unresolved-nested-event"])),
  ];
  for (const name of ["CANON.md", "SCHEMA.md"]) {
    const path = join(setup.vault, name);
    files.push({ path, bytes: readFileSync(path, "utf8") });
  }
  const history = join(setup.vault, "archive", "history.md");
  const bytes = "Historical bytes outside live page discovery.\n";
  writeFileSync(history, bytes);
  files.push({ path: history, bytes });
  const result = h.runCli(setup.env, "doctor", "--json");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout);
  expect(report.status).toBe("error");
  expect(report.data.ok).toBe(false);
  expect(report.data.problems.filter((item: { error: string }) => item.error.includes("sources:"))).toEqual([
    { page: "facts/CANON.md", error: "sources: is required" },
    { page: "facts/SCHEMA.md", error: "sources: must name at least one event unless archived" },
    { page: "facts/archive/item.md", error: "sources: one or more event IDs do not resolve in the ledger" },
  ]);
  expect(report.data.problems.some((item: { page?: string }) => item.page === "archive/history.md")).toBe(false);
  expect(result.stdout).not.toContain("synthetic-unresolved-nested-event");
  expect(result.stdout).not.toContain("Private synthetic body");
  for (const file of files) expect(readFileSync(file.path, "utf8")).toBe(file.bytes);
});
