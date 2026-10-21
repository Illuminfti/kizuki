import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { classesOfPage, initPageClasses } from "../../src/canon/page-classes";
import { credentialShaped } from "../../src/ledger/event-classes";
import * as scrub from "../../src/producer/scrub";

const canary = ["synthetic", "fixture", "only"].join("-");
const secretText = () => `${"pass" + "word"}=${canary}`;

for (const count of [401, 801]) test(`unchanged content is scanned once across repeated decisions for ${count} pages`, () => {
  const scan = spyOn(scrub, "scrubText");
  try {
    const pages = Array.from({ length: count }, (_, id) => ({ text: `a plain note ${id}`, metadata: { title: `note ${id}` } }));
    for (let pass = 0; pass < 4; pass++) {
      for (const page of pages) expect(credentialShaped(page.text, page.metadata)).toBe(false);
    }
    expect(scan).toHaveBeenCalledTimes(count * 2);
  } finally { scan.mockRestore(); }
});

test("body and nested metadata changes invalidate the exact content result", () => {
  const metadata = { nested: { note: "plain" }, values: ["plain"] };
  expect(credentialShaped("plain text", metadata)).toBe(false);
  expect(credentialShaped(secretText(), metadata)).toBe(true);
  expect(credentialShaped("plain text", metadata)).toBe(false);
  metadata.nested.note = secretText();
  expect(credentialShaped("plain text", metadata)).toBe(true);
  metadata.nested.note = "plain";
  expect(credentialShaped("plain text", metadata)).toBe(false);
  metadata.values.push(secretText());
  expect(credentialShaped("plain text", metadata)).toBe(true);
  metadata.values.pop();
  expect(credentialShaped("plain text", metadata)).toBe(false);
});

test("container-key changes and truncated metadata never reuse a clean result", () => {
  const metadata: Record<string, unknown> = { note: {} };
  expect(credentialShaped("plain text", metadata)).toBe(false);
  metadata[secretText()] = {};
  expect(credentialShaped("plain text", metadata)).toBe(true);
  delete metadata[secretText()];
  metadata.values = Array.from({ length: 1_001 }, () => "plain");
  expect(credentialShaped("plain text", metadata)).toBe(true);
  delete metadata.values;
  expect(credentialShaped("plain text", metadata)).toBe(false);
  metadata.note = Array.from({ length: 18 }).reduce<unknown>((child) => ({ child }), {});
  expect(credentialShaped("plain text", metadata)).toBe(true);
});

test("metadata is read on every clean-text call and secret text still short circuits it", () => {
  let value = "plain", reads = 0;
  const metadata = { get note() { reads++; return value; } };
  expect(credentialShaped("plain text", metadata)).toBe(false);
  value = secretText();
  expect(credentialShaped("plain text", metadata)).toBe(true);
  expect(reads).toBe(2);
  const hostile = { get note(): string { throw new Error("fixture getter"); } };
  expect(credentialShaped(secretText(), hostile)).toBe(true);
  expect(() => credentialShaped("plain text", hostile)).toThrow("fixture getter");
});

test("credential-bearing metadata and oversized inputs are not memoized", () => {
  const scan = spyOn(scrub, "scrubText");
  try {
    const metadata = { note: secretText() };
    expect(credentialShaped("plain text", metadata)).toBe(true);
    expect(credentialShaped("plain text", metadata)).toBe(true);
    expect(scan).toHaveBeenCalledTimes(4);
    scan.mockClear();
    scan.mockImplementation(() => ({ text: "", redactions: [] }));
    const large = "X".repeat(1_048_577), plain = {};
    expect(credentialShaped(large, plain)).toBe(false);
    expect(credentialShaped(large, plain)).toBe(false);
    expect(scan).toHaveBeenCalledTimes(4);
  } finally { scan.mockRestore(); }
});

test("aggregate cache admission is bounded even while metadata objects remain live", () => {
  const scan = spyOn(scrub, "scrubText").mockImplementation(() => ({ text: "", redactions: [] }));
  try {
    const sentinel = {};
    expect(credentialShaped("plain", sentinel)).toBe(false);
    const text = "X".repeat(1_048_576);
    const retained = Array.from({ length: 33 }, () => ({}));
    for (const metadata of retained) expect(credentialShaped(text, metadata)).toBe(false);
    scan.mockClear();
    expect(credentialShaped("plain", sentinel)).toBe(false);
    expect(scan).toHaveBeenCalledTimes(2);
  } finally { scan.mockRestore(); }
});

test("current database stamps take precedence and missing stamps recheck changed content", () => {
  const db = new Database(":memory:");
  try {
    initPageClasses(db);
    const page = { id: "page", contentHash: "fixture-hash", body: "plain text", data: { title: "plain" } };
    expect(classesOfPage(db, page)).toEqual([]);
    db.query("INSERT INTO canon_page_classes VALUES (?, ?, ?)").run(page.id, page.contentHash, 1);
    expect(classesOfPage(db, page)).toEqual(["credential"]);
    db.query("UPDATE canon_page_classes SET credential=0").run();
    expect(classesOfPage(db, page)).toEqual([]);
    db.query("DELETE FROM canon_page_classes").run();
    page.body = secretText();
    expect(classesOfPage(db, page)).toEqual(["credential"]);
    page.body = "plain text";
    page.data.title = secretText();
    expect(classesOfPage(db, page)).toEqual(["credential"]);
  } finally { db.close(); }
});
