import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editInEditor, pickEditor } from "../src/app";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeEditor(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-editor-"));
  temporary.push(dir);
  const file = join(dir, "editor.sh");
  writeFileSync(file, `#!/bin/sh\n${script}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

describe("editor", () => {
  test("pickEditor prefers VISUAL, then EDITOR, then a known binary", () => {
    expect(pickEditor({ VISUAL: "code -w", EDITOR: "vim" })).toBe("code -w");
    expect(pickEditor({ EDITOR: "nano" })).toBe("nano");
    const fallback = pickEditor({});
    expect(fallback === null || ["vim", "nano", "vi"].includes(fallback)).toBe(
      true,
    );
  });

  test("editInEditor returns the saved file and cleans up", () => {
    const result = editInEditor(
      fakeEditor('printf "changed" > "$1"'),
      "original",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    expect(result).toBe("changed");
  });

  test("a failing editor is reported, not swallowed", () => {
    expect(() => editInEditor(fakeEditor("exit 3"), "x", "id")).toThrow(
      "exited with 3",
    );
  });
});
