import { describe, expect, test } from "bun:test";
import { machinePathViolations, machinePathsIn } from "./verify-machine-paths";

const record = (path: string, line: number, text: string) => `${path}\0${line}\0${text}\n`;

describe("machine path scanner", () => {
  test.each([
    "cd /home/ubuntu/project",
    "see /Users/jane/Documents/notes.md",
    "worktree at /data/agent-worktrees/main",
    "\"/home/deploy/.config/app\"",
    "C:\\Users\\jane\\AppData",
    "(/home/jane/notes)",
  ])("flags %s", (text) => {
    expect(machinePathsIn(text).length).toBeGreaterThan(0);
  });

  test.each([
    "/home/user/kizuki",
    "/home/ada/notes/todo.md",
    "/home/stranger/o'neil vault",
    "/Users/Example/Library",
    "archive/data/account.js",
    "~/home/ubuntu/x",
    "$HOME/data/x",
    "mount kizuki:/data",
    "/home/<user>/vault",
    "/home/$USER/vault",
    "file:///home/",
    "the /home and /data directories",
  ])("allows %s", (text) => {
    expect(machinePathsIn(text)).toEqual([]);
  });

  test("violations name the file and line but never echo the path", () => {
    const failures = machinePathViolations(
      record("docs/a.md", 3, "clean line") +
        record("docs/b.md", 12, "run in /home/ubuntu/private") +
        record("with\nnewline.md", 1, "at /data/worktrees/x"),
    );
    expect(failures).toEqual([
      "\"docs/b.md\":12: machine-specific absolute path",
      "\"with\\nnewline.md\":1: machine-specific absolute path",
    ]);
    expect(failures.join("\n")).not.toContain("ubuntu");
  });

  test("malformed producer records fail closed", () => {
    expect(() => machinePathViolations("")).toThrow();
    expect(() => machinePathViolations("file\0notanumber\0text\n")).toThrow();
  });
});
