import { afterEach, describe, expect, test } from "bun:test";
import { extractVault, parseArguments } from "../src/args";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli } = createHelpers();
afterEach(cleanup);

const spec = { options: ["--source"], flags: ["--json"] };

describe("option grammar", () => {
  test("preserves explicit values beginning with options and containing equals", () => {
    const parsed = parseArguments(["--source=--vault=notes", "--json"], spec);
    expect(parsed.options.get("--source")).toBe("--vault=notes");
    expect(parsed.flags.has("--json")).toBe(true);
    expect(parsed.positionals).toEqual([]);
  });

  test("keeps explicit empty values and ordinary separated values", () => {
    expect(parseArguments(["--source="], spec).options.get("--source")).toBe("");
    expect(parseArguments(["--source", "notes"], spec).options.get("--source")).toBe("notes");
  });

  test("terminator makes every remaining token literal", () => {
    expect(parseArguments(["--", "--source=x", "--json", "--"], spec).positionals)
      .toEqual(["--source=x", "--json", "--"]);
  });

  test("refuses repeated options across both spellings", () => {
    for (const tokens of [["--source=a", "--source", "b"], ["--source", "a", "--source=b"]]) {
      expect(() => parseArguments(tokens, spec)).toThrow("repeated option --source");
    }
    expect(() => parseArguments(["--json", "--json"], spec)).toThrow("repeated flag --json");
  });

  test("does not infer missing values or accept values on flags", () => {
    expect(() => parseArguments(["--source", "--json"], spec)).toThrow("missing value for --source");
    expect(() => parseArguments(["--json=false"], spec)).toThrow("flag --json does not take a value");
    expect(() => parseArguments(["--unknown=private-value"], spec)).toThrow("unknown option --unknown");
  });

  test("global vault extraction preserves command values and terminator", () => {
    expect(extractVault(["query", "--vault=--notes", "--", "--vault=literal"]))
      .toEqual({ vault: "--notes", rest: ["query", "--", "--vault=literal"] });
    expect(extractVault(["import", "--source=--vault=notes"]))
      .toEqual({ vault: null, rest: ["import", "--source=--vault=notes"] });
  });

  test("global vault rejects repetition across spellings", () => {
    expect(() => extractVault(["--vault=a", "--vault", "b"]))
      .toThrow("repeated option --vault");
    expect(() => extractVault(["--vault", "a", "--vault=b"]))
      .toThrow("repeated option --vault");
  });

  test("the public CLI accepts inline global values without stealing command data", () => {
    const result = runCli(isolatedEnv(), "version", "--vault=--literal");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0.1.0\n");
    expect(result.stderr).toBe("");
    const literal = runCli(isolatedEnv(), "version", "--", "--vault=literal");
    expect(literal.exitCode).toBe(2);
    expect(literal.stderr).toContain("usage: kizuki version");
    expect(literal.stderr).not.toContain("unknown option");
  });

  test("the public CLI reports global option failures without printing values", () => {
    for (const [args, diagnostic] of [
      [["version", "--vault"], "missing value for --vault"],
      [["version", "--vault=private-a", "--vault=private-b"], "repeated option --vault"],
    ] as const) {
      const result = runCli(isolatedEnv(), ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(result.stderr).not.toContain("private-a");
      expect(result.stderr).not.toContain("private-b");
    }
  });
});
