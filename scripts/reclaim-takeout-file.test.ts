import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distillTakeoutActivity } from "./reclaim-takeout-spike";
import { distillTakeoutActivityFile } from "./reclaim-takeout-file";

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "reclaim-file-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("local Takeout file spike", () => {
  test("projects one selected file with the same receipt as its exact text", () => {
    withDirectory((directory) => {
      const path = join(directory, "activity.json");
      const source = JSON.stringify([{ title: "Garden 🌱", time: "2026-09-01T12:00:00Z", products: ["Search"] }]);
      writeFileSync(path, source);
      expect(distillTakeoutActivityFile(path)).toEqual(distillTakeoutActivity(source));
      writeFileSync(path, "[]");
      expect(distillTakeoutActivityFile(path).receipt.records).toBe(0);
    });
  });

  test("refuses oversized files and invalid UTF-8 without replacing evidence", () => {
    withDirectory((directory) => {
      const path = join(directory, "activity.json");
      writeFileSync(path, " ".repeat(1_048_577));
      expect(() => distillTakeoutActivityFile(path)).toThrow("byte limit");
      writeFileSync(path, Buffer.from([0xff]));
      expect(() => distillTakeoutActivityFile(path)).toThrow("lossless UTF-8");
      writeFileSync(path, "[]" + " ".repeat(1_048_574));
      expect(distillTakeoutActivityFile(path).receipt.input_bytes).toBe(1_048_576);
    });
  });

  test("refuses directories, final symlinks and missing files with path-free errors", () => {
    withDirectory((directory) => {
      const path = join(directory, "private-export.json");
      writeFileSync(path, "[]");
      const link = join(directory, "link.json");
      symlinkSync(path, link);
      for (const selected of [directory, link, join(directory, "missing-private.json")]) {
        expect(() => distillTakeoutActivityFile(selected)).toThrow("Takeout activity file must be a readable regular file");
      }
    });
  });
});
