import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHelpers } from "./helpers";

setDefaultTimeout(120_000);
const { cleanup, tempVault, runCli } = createHelpers();
afterEach(cleanup);
const V1 = "kizuki.envelope/v1";
const V2 = "kizuki.envelope/v2";
const keys = ["at", "canon", "data", "principal", "quoted", "schema", "tool"];

function forbidden(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(forbidden);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(["epoch", "claims_epoch", "source_policy", "denied"].includes(key) ? [key] : []),
    ...forbidden(item),
  ]);
}

test("CLI query and context preserve explicit owner v1 and render the selected v2 envelope", () => {
  const setup = tempVault();
  for (const [command, args, tool] of [
    ["context", ["--budget", "1000"], "context_packet"],
    ["query", ["ordinary", "--degraded"], "search"],
  ] as const) {
    const legacy = runCli(setup.env, command, ...args, "--response-contract", V1, "--json");
    expect(legacy.exitCode, legacy.stderr).toBe(0);
    expect(JSON.parse(legacy.stdout).schema).toBe(`kizuki.cli.${command}/v1`);
    const run = runCli(setup.env, command, ...args, "--response-contract", V2, "--json");
    expect(run.exitCode, run.stderr).toBe(0);
    const wire = JSON.parse(run.stdout);
    expect(Object.keys(wire).sort()).toEqual(["command", "result", "schema"]);
    expect(wire).toMatchObject({ schema: "kizuki.cli-result/v2", command, result: { schema: V2, tool } });
    expect(Object.keys(wire.result).sort()).toEqual(keys);
    expect(forbidden(wire)).toEqual([]);
    if (command === "context") {
      expect(wire.result.data.schema).toBe("kizuki.context-packet/v2");
      const text = runCli(setup.env, command, ...args, "--response-contract", V2);
      expect(text.stdout).toStartWith("KIZUKI CONTEXT v2\n");
      expect(text.stdout).not.toMatch(/epoch|etag|packet_hash/);
    }
  }
});

test("unknown CLI contracts fail with an audited fixed refusal", () => {
  const setup = tempVault();
  for (const [command, args] of [["context", []], ["query", ["ordinary", "--degraded"]], ["tell", ["Use the current statement."]]] as const) {
    const result = runCli(setup.env, command, ...args, "--response-contract", "kizuki.envelope/v9", "--json");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requested contract unavailable");
    expect(JSON.parse(result.stdout)).toEqual({ schema: "kizuki.cli-result/v2", command,
      result: { ok: false, error: { code: "unsupported_contract", message: "requested contract unavailable", retryable: false } },
    });
  }
});
