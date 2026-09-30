import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializePage } from "../../src/vault/frontmatter";
import { listCanonPagesReport, scanCanonPages } from "../../src/vault/pages";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("header diagnostics preserve full-scan identities, skips, ordering and duplicate withholding", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-scan-"));
  roots.push(root);
  mkdirSync(join(root, "facts"));
  const page = (id: string, extra = "") => serializePage({
    data: { id, title: "Neutral synthetic title", type: "fact", status: "active", sensitivity: "private", taint: "clean", "x-long": extra },
    body: "Neutral body.\n--- not a closing fence\n".repeat(100),
  });
  writeFileSync(join(root, "facts", "a.md"), page("same"));
  writeFileSync(join(root, "facts", "b.md"), page("same"));
  writeFileSync(join(root, "facts", "c.md"), page("unique").replaceAll("\n", "\r\n"));
  writeFileSync(join(root, "facts", "d.md"), "---\nid: \"broken\n---\nbody");
  writeFileSync(join(root, "facts", "e.md"), page("large-header", "x".repeat(5000)));
  writeFileSync(join(root, "facts", "f.md"), page("hostile").replace('id:', '__proto__: inert\nid:'));
  symlinkSync(join(root, "facts", "c.md"), join(root, "facts", "link.md"));
  const full = listCanonPagesReport(root);
  const scan = scanCanonPages(root);
  expect(scan).toEqual({
    pages: full.pages.map(({ id, path, relPath }) => ({ id, path, relPath })),
    skipped: full.skipped,
    truncated: full.truncated,
  });
  expect(JSON.stringify(scan)).not.toContain("Neutral body");
});
