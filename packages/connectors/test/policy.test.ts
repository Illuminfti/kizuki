import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Importers emit evidence into the append-only ledger; the receipted writer
 * downstream decides what becomes canon, and the owner's leverage is
 * correction and undo. A queue the owner works through, or an approval an
 * import waits for, is a superseded policy, and prose is where it creeps back
 * in — so the package's own source and documentation are scanned for it.
 */
const PACKAGE = join(import.meta.dir, "..");

const SUPERSEDED = [
  /review queue/i,
  /owner reviews/i,
  /owner review\b/i,
  /owner approval/i,
  /approval step/i,
  /owner-invoked promotion/i,
];

function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFiles(full));
    else if (/\.(ts|md)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

const scanned = [
  ...textFiles(join(PACKAGE, "src")),
  join(PACKAGE, "README.md"),
];

test("the scan actually covers the package's source and its README", () => {
  expect(scanned.length).toBeGreaterThan(10);
  expect(scanned).toContain(join(PACKAGE, "README.md"));
  expect(scanned).toContain(
    join(PACKAGE, "src", "import-whatsapp", "grammar.ts"),
  );
});

test("no source file or document restates the superseded owner gate", () => {
  const offenders: string[] = [];
  for (const file of scanned) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (SUPERSEDED.some((pattern) => pattern.test(line))) {
        offenders.push(`${relative(PACKAGE, file)}:${index + 1}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});
