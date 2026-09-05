import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { editInEditor, parseEditorCommand, pickEditor } from "../src/editor";

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

  test("editor buffers have explicit owner-only modes and are removed after failure", () => {
    const record = join(mkdtempSync(join(tmpdir(), "kizuki-editor-record-")), "path");
    temporary.push(dirname(record));
    const editor = fakeEditor(`printf '%s' "$1" > '${record}'; test "$(stat -c %a \"$1\")" = 600; test "$(stat -c %a \"$(dirname \"$1\")\")" = 700; exit 3`);
    expect(() => editInEditor(editor, "private", "mode-check")).toThrow("exited with 3");
    const file = readFileSync(record, "utf8");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dirname(file))).toBe(false);
  });

  test("a failing editor is reported, not swallowed", () => {
    expect(() => editInEditor(fakeEditor("exit 3"), "x", "id")).toThrow(
      "exited with 3",
    );
  });

  test("parseEditorCommand keeps quoted paths with spaces as one argument", () => {
    expect(parseEditorCommand('"/tmp/Visual Studio Code/code" -w')).toEqual([
      "/tmp/Visual Studio Code/code",
      "-w",
    ]);
    expect(parseEditorCommand("'/tmp/my editor' +1")).toEqual(["/tmp/my editor", "+1"]);
    expect(parseEditorCommand("code\\ -w")).toEqual(["code -w"]);
    expect(() => parseEditorCommand('"unclosed')).toThrow("unclosed quote");
  });

  test("editInEditor invokes an executable whose path contains a space", () => {
    const dir = mkdtempSync(join(tmpdir(), "kizuki-editor-space-"));
    temporary.push(dir);
    const file = join(dir, "my editor.sh");
    writeFileSync(file, '#!/bin/sh\nprintf "changed" > "$1"\n', "utf8");
    chmodSync(file, 0o755);
    expect(editInEditor(`"${file}"`, "original", "spaced")).toBe("changed");
  });
});
