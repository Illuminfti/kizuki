import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildPageIndex } from "../src/canon/store";
import { ownerEdited } from "../src/canon/arbiter";
import { openLedger } from "../src/ledger/db";
import { registerConnection } from "../src/ledger/connections";
import { setSourceGrant, sourcePolicyEpoch } from "../src/ledger/source-grants";
import { ulid } from "../src/util/ulid";
import { doctorVault } from "../src/vault/doctor";
import { serializePage } from "../src/vault/frontmatter";
import { listCanonPagesReport } from "../src/vault/pages";
import { pageProvenanceErrors } from "../src/vault/provenance";
import { parsePageSources, validatePage } from "../src/vault/schema";
import { putEvent } from "./claims/helpers";
import { tempVault } from "./helpers/vault";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function fixture() {
  const vault = tempVault("kizuki-page-provenance-");
  const db = openLedger(":memory:");
  cleanup.push(() => { db.close(); vault.dispose(); });
  return { db, vault: vault.path };
}

function data(id: string, sources: unknown, status = "active") {
  return { id, title: "Synthetic owner note", type: "fact", status,
    sensitivity: "private", taint: "clean", sources };
}

function seed(vault: string, name: string, frontmatter: Record<string, unknown>) {
  const path = join(vault, "facts", `${name}.md`);
  const bytes = serializePage({ data: frontmatter, body: "Owner-controlled synthetic prose.\n" });
  writeFileSync(path, bytes);
  return { path, bytes };
}

test("source shape requires a bounded nonempty list while archived history may be empty", () => {
  const missing: Record<string, unknown> = data("missing", []);
  delete missing["sources"];
  expect(parsePageSources(missing)).toEqual({ ok: false, errors: ["sources: is required"] });
  expect(parsePageSources(data("empty", []))).toEqual({
    ok: false, errors: ["sources: must name at least one event unless archived"],
  });
  for (const sources of [[""], ["   "], ["event-a", ""]]) {
    expect(parsePageSources(data("blank", sources))).toEqual({ ok: false,
      errors: ["sources: event IDs must be non-empty strings"] });
  }
  expect(parsePageSources(data("mixed", ["event-a", 3]))).toEqual({ ok: false,
    errors: ["sources: must be a string array"] });
  expect(parsePageSources(data("large", Array(101).fill("event-a")))).toEqual({ ok: false,
    errors: ["sources: exceeds 100 items"] });
  expect(validatePage(data("valid", ["event-a"]))).toEqual([]);
  expect(validatePage(data("archived", [], "archived"))).toEqual([]);
});

test("doctor identifies unrecorded owner pages while the existing scanner and target index preserve them", () => {
  const f = fixture();
  const missing: Record<string, unknown> = data("owner-missing", []);
  delete missing["sources"];
  missing["x-subject-id"] = "person:owner-note";
  const seeds = [
    seed(f.vault, "missing", missing),
    seed(f.vault, "empty", data("owner-empty", [])),
    seed(f.vault, "archived", data("archived", [], "archived")),
  ];
  const report = listCanonPagesReport(f.vault);
  expect(report.pages.map(page => page.id)).toEqual(["archived", "owner-empty", "owner-missing"]);
  expect(report.skipped).toEqual([]);
  const io = { db: f.db, vault_path: f.vault };
  rebuildPageIndex(io);
  expect(f.db.query("SELECT page_id,subject_key FROM page_index WHERE page_id='owner-missing'").get())
    .toEqual({ page_id: "owner-missing", subject_key: "person:owner-note" });
  expect(ownerEdited(io, "facts/missing.md")).toBe(true);
  expect(doctorVault(f.vault, f.db).counts).toEqual({ total: 3, valid: 1, invalid: 2 });
  for (const page of seeds) expect(readFileSync(page.path, "utf8")).toBe(page.bytes);
});

test("doctor resolves every source at epoch zero and reports stable diagnostics without evidence content", () => {
  const f = fixture();
  const first = putEvent(f.db, { text: "First benign fixture record." });
  const second = putEvent(f.db, { text: "Second benign fixture record." });
  seed(f.vault, "resolved", data("resolved", [first, second]));
  const privateId = "unresolved-synthetic-id-not-for-diagnostics";
  const unresolved = seed(f.vault, "unresolved", data("unresolved", [first, privateId]));
  expect(sourcePolicyEpoch(f.db)).toBe(0);
  expect(doctorVault(f.vault).counts).toEqual({ total: 2, valid: 2, invalid: 0 });
  const report = doctorVault(f.vault, f.db);
  expect(report.counts).toEqual({ total: 2, valid: 1, invalid: 1 });
  expect(report.pages).toEqual([
    { page: "facts/resolved.md", errors: [] },
    { page: "facts/unresolved.md", errors: ["sources: one or more event IDs do not resolve in the ledger"] },
  ]);
  expect(JSON.stringify(report)).not.toContain(privateId);
  expect(JSON.stringify(report)).not.toContain("Owner-controlled synthetic prose");
  expect(readFileSync(unresolved.path, "utf8")).toBe(unresolved.bytes);
});

test("resolution stays independent of consent epoch and does not grant source authority", () => {
  const f = fixture();
  const eventId = putEvent(f.db);
  const source = ulid();
  registerConnection(f.db, "kizuki.fixture", source);
  setSourceGrant(f.db, { source_key: source, expected_revision: 0, operation_id: "page-provenance-fixture",
    policy: { purposes: ["capture"], allowed_fields: ["text"], retention: "persistent_owned_until_revoked",
      egress: "local_only", sensitivity_floor: "private" } });
  expect(sourcePolicyEpoch(f.db)).toBeGreaterThan(0);
  seed(f.vault, "resolved", data("resolved", [eventId]));
  seed(f.vault, "unresolved", data("unresolved", [eventId, "missing-event"]));
  const before = f.db.query("SELECT * FROM source_grants").all();
  expect(doctorVault(f.vault, f.db).counts).toEqual({ total: 2, valid: 1, invalid: 1 });
  expect(f.db.query("SELECT * FROM source_grants").all()).toEqual(before);
});

test("archived history and owner-edited doctrine need no surviving ledger event", () => {
  const f = fixture();
  const archived = seed(f.vault, "history", data("history", ["erased-historical-event"], "archived"));
  seed(f.vault, "empty-history", data("empty-history", [], "archived"));
  const doctrine = join(f.vault, "CANON.md");
  writeFileSync(doctrine, "Owner-edited doctrine.\n");
  const report = doctorVault(f.vault, f.db);
  expect(report.counts).toEqual({ total: 2, valid: 2, invalid: 0 });
  expect(report.doctrine).toContainEqual({ file: "CANON.md", state: "owner-edited" });
  expect(readFileSync(doctrine, "utf8")).toBe("Owner-edited doctrine.\n");
  expect(readFileSync(archived.path, "utf8")).toBe(archived.bytes);
});

test("a ledger that cannot answer provenance produces a fixed failure without database details", () => {
  const db = new Database(":memory:");
  try {
    expect(pageProvenanceErrors(db, data("unavailable", ["event-a"]))).toEqual([
      "sources: ledger provenance could not be checked",
    ]);
  } finally { db.close(); }
});
