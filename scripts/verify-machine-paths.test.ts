import { describe, expect, test } from "bun:test";
import { machinePathViolations, machinePathsIn } from "./verify-machine-paths";

// Built from parts so this file does not trip the scanner it tests.
const at = (...parts: string[]) => ["", ...parts].join("/");
const record = (path: string, line: number, text: string) => `${path}\0${line}\0${text}\n`;

describe("machine path scanner", () => {
  test.each([
    `cd ${at("home", "jane", "project")}`,
    `see ${at("Users", "jane", "Documents", "notes.md")}`,
    `worktree at ${at("data", "agent-worktrees", "main")}`,
    `"${at("home", "deploy", ".config", "app")}"`,
    ["C:", "Users", "jane", "AppData"].join("\\"),
    `(${at("home", "jane", "notes")})`,
    `open file://${at("home", "jane", "vault")}`,
    `open file:/${at("home", "jane", "vault")}`,
    `open FILE://${at("Users", "jane", "vault")}`,
    `open file://${at("data", "kizuki-x")}`,
    `run /${at("home", "jane", "vault")}`,
    `run /${at("data", "kizuki-x")}`,
  ])("flags %s", (text) => {
    expect(machinePathsIn(text).length).toBeGreaterThan(0);
  });

  test.each([
    at("home", "user", "kizuki"),
    at("home", "ada", "notes", "todo.md"),
    at("home", "stranger", "o'neil vault"),
    at("Users", "Example", "Library"),
    "archive/data/account.js",
    `~${at("home", "jane", "x")}`,
    `$HOME${at("data", "x")}`,
    "mount kizuki:/data",
    at("home", "<user>", "vault"),
    at("home", "$USER", "vault"),
    "file:///home/",
    `file://${at("home", "user", "vault")}`,
    "https://home/x and https://data/x",
    "the /home and /data directories",
  ])("allows %s", (text) => {
    expect(machinePathsIn(text)).toEqual([]);
  });

  test("violations name the file and line but never echo the path", () => {
    const failures = machinePathViolations(
      record("docs/a.md", 3, "clean line") +
        record("docs/b.md", 12, `run in ${at("home", "jane", "private")}`) +
        record("with\nnewline.md", 1, `at ${at("data", "worktrees", "x")}`),
    );
    expect(failures).toEqual([
      "\"docs/b.md\":12: machine-specific absolute path",
      "\"with\\nnewline.md\":1: machine-specific absolute path",
    ]);
    expect(failures.join("\n")).not.toContain("jane");
  });

  test("malformed producer records fail closed", () => {
    expect(() => machinePathViolations("")).toThrow();
    expect(() => machinePathViolations("file\0notanumber\0text\n")).toThrow();
  });
});
