import { describe, expect, test } from "bun:test";
import { INVOCATION, IS_COMPILED, serveArgs } from "../src/runtime";

describe("CLI runtime commands", () => {
  test("source checkout keeps its documented invocation", () => {
    expect(IS_COMPILED).toBe(false);
    expect(INVOCATION).toBe("bun packages/cli/src/main.ts");
  });

  test("keeps a hostile vault path as one supervisor argument", () => {
    const vault = "/tmp/owner's vault; never-a-command";
    expect(serveArgs(vault)).toEqual([
      process.execPath,
      expect.stringContaining("/packages/cli/src/main.ts"),
      "serve",
      "--vault",
      vault,
    ]);
  });
});
