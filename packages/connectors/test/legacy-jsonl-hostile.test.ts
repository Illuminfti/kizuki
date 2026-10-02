import { KizukiError } from "@kizuki/core";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJsonlSource } from "../src/import-legacy-events/source";

test("JSONL source refuses a symlink instead of importing its target", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-jsonl-hostile-"));
  try {
    writeFileSync(join(root, "outside.jsonl"), '{"text":"outside-canary"}\n');
    symlinkSync(join(root, "outside.jsonl"), join(root, "linked.jsonl"));
    let source: ReturnType<typeof openJsonlSource> | undefined;
    try {
      expect(() => { source = openJsonlSource(join(root, "linked.jsonl")); }).toThrow(KizukiError);
    } finally { source?.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("JSONL source refuses directories and FIFOs without waiting for a writer", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-jsonl-types-"));
  try {
    expect(() => openJsonlSource(root)).toThrow(KizukiError);
    const fifo = join(root, "synthetic.jsonl");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    expect(made.exitCode).toBe(0);
    expect(() => openJsonlSource(fifo)).toThrow(KizukiError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("JSONL continues after an oversized hostile row and resumes by byte position", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-jsonl-resume-"));
  try {
    const file = join(root, "synthetic.jsonl");
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1) + '\n{"text":"after"}\n');
    const source = openJsonlSource(file);
    try {
      const first = source.read(0n, 1);
      expect(first[0]?.problem).toBe("line_too_long");
      expect(source.read(first[0]!.position, 1)[0]?.values).toEqual({ text: "after" });
    } finally { source.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
