import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("claim release CLI refuses malformed UTF-8 without altering task history", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-claims-encoding-"));
  const path = join(dir, "tasks.jsonl");
  const old = '{"id":"old","status":"superseded","assignee":"lane-1"}\n';
  const run = () => Bun.spawnSync([
    process.execPath, join(import.meta.dir, "release-superseded-task-claims.ts"), path,
  ]);
  try {
    for (const bytes of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf4, 0x90, 0x80, 0x80]]) {
      const input = Buffer.concat([
        Buffer.from(old + '{"id":"live","status":"pending","description":"'),
        Buffer.from(bytes), Buffer.from('"}\n'),
      ]);
      writeFileSync(path, input);
      const result = run();
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toBe("Could not release task claims: input must be readable task JSONL.\n");
      expect(readFileSync(path)).toEqual(input);
    }
    const live = '{"id":"live","status":"pending","description":"日本語 café 😀 �"}\n';
    writeFileSync(path, old + live);
    const valid = run();
    expect(valid.exitCode).toBe(0);
    expect(valid.stderr.toString()).toBe("");
    expect(valid.stdout.toString()).toBe('{"id":"old","status":"superseded"}\n' + live);
    expect(readFileSync(path, "utf8")).toBe(old + live);

    // Preserve the previous rejection of a BOM attached to the first record.
    writeFileSync(path, "\ufeff" + old);
    const bom = run();
    expect(bom.exitCode).toBe(1);
    expect(bom.stdout.toString()).toBe("");
    expect(bom.stderr.toString()).toBe("Could not release task claims: input must be readable task JSONL.\n");
    expect(readFileSync(path, "utf8")).toBe("\ufeff" + old);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
