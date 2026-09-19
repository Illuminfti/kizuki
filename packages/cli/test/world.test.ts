import { afterEach, describe, expect, test } from "bun:test";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli, tempVault } = createHelpers();
afterEach(cleanup);

function token(fill: number): string {
  return Buffer.from(Uint8Array.from({ length: 32 }, () => fill)).toString(
    "base64url",
  );
}

const OBJECT = token(1);

describe("world", () => {
  test("situation lookup of an absent anchor is not found", () => {
    const setup = tempVault();
    const result = runCli(
      setup.env,
      "world",
      "--operation",
      "situation",
      "--ref",
      OBJECT,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("not found");
  });

  test("json names the not_found result", () => {
    const setup = tempVault();
    const result = runCli(
      setup.env,
      "world",
      "--operation",
      "concept",
      "--ref",
      OBJECT,
      "--json",
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      schema: string;
      status: string;
      data: { status: string };
    };
    expect(body.schema).toBe("kizuki.cli.world/v1");
    expect(body.status).toBe("ok");
    expect(body.data).toEqual({ status: "not_found" });
  });

  test("missing vault is a runtime error before lookup", () => {
    const result = runCli(
      isolatedEnv(),
      "world",
      "--operation",
      "situation",
      "--ref",
      OBJECT,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no vault configured");
  });

  test("usage errors stay on stderr and exit 2", () => {
    const env = isolatedEnv();
    for (const [args, message] of [
      [["world"], "usage: kizuki world"],
      [["world", "--operation", "situation"], "usage: kizuki world"],
      [["world", "--operation", "situation", "--ref"], "missing value for --ref"],
      [["world", "--operation", "history", "--ref", OBJECT], "usage: kizuki world"],
      [["world", "--operation", "situation", "--ref", "nope"], "usage: kizuki world"],
      [["world", "--operation", "situation", "--ref", OBJECT, "extra"], "usage: kizuki world"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(message);
    }
  }, 15_000);
});
