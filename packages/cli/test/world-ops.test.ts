import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { withWorldOps } from "@kizuki/core/testing";
import { WORLD_OPS, worldOpInputKeys } from "@kizuki/core/world";
import { openLedger } from "../../core/src/ledger/db";
import { startServeHttp } from "../../core/src/serve/http";
import { PING_INPUT, PING_SCHEMA, pingOp } from "../../core/test/serving/world-test-op";
import { MCP_WORLD_OPS } from "../../mcp/src/world/ops";
import { createAppHost, appWorldRouteKeys } from "../src/app/host";
import { UsageError } from "../src/args";
import type { CliIo } from "../src/commands";
import { createWorldCommand } from "../src/commands/world";
import type { WorldCliEntry } from "../src/commands/world/ops";
import { WORLD_CLI_OPS } from "../src/commands/world/ops";
import { createHelpers } from "./helpers";

setDefaultTimeout(60_000);

const h = createHelpers();
afterEach(h.cleanup);

const pingEntry: WorldCliEntry = {
  name: "ping",
  cli: {
    usage: "--text TEXT",
    options: ["--text"],
    bounds: { "--text": "up to 40 characters" },
    buildInput: (options) => {
      const text = options.get("--text");
      return text === undefined ? null : { text, valid: { kind: "all" }, knownAt: { kind: "current" } };
    },
    render: (data) => [`ping ${String(data["echo"])}`],
  },
};

function session() {
  const setup = h.tempVault();
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env: setup.env,
    vaultOverride: setup.vault,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    prompt: async () => "",
  };
  return { setup, io, out, err };
}

describe("every registered operation reaches every surface", () => {
  test("the registry, the MCP fragments, the CLI entries and the App keys enumerate the same operations", () => {
    const names = WORLD_OPS.map((op) => op.name);
    expect(MCP_WORLD_OPS.map((op) => op.name)).toEqual(names);
    expect(WORLD_CLI_OPS.map((entry) => entry.name)).toEqual(names);
    for (const entry of WORLD_CLI_OPS) {
      if (entry.cli === null) expect(entry.reason.length, entry.name).toBeGreaterThan(10);
      else expect(entry.cli.options.every((option) => option.startsWith("--"))).toBe(true);
    }
    const keys = new Set(appWorldRouteKeys());
    for (const op of WORLD_OPS) for (const key of worldOpInputKeys(op)) expect(keys.has(key), `${op.name}.${key}`).toBe(true);
  });
});

describe("a test-only operation with one core file, one fragment and one spec", () => {
  test("is answered by kizuki world, generated usage and bounds included", async () => {
    await withWorldOps([pingOp], async () => {
      const { io, out } = session();
      const command = createWorldCommand([...WORLD_CLI_OPS, pingEntry]);
      expect(command.usage).toContain("ping --text TEXT");
      expect(command.schema?.options).toContain("--text");
      expect(command.schema?.bounds?.["--operation"]).toContain("ping");
      expect(await command.run(io, ["--operation", "ping", "--text", "hi"])).toBe(0);
      expect(out).toEqual(["ping hi"]);
      out.length = 0;
      expect(await command.run(io, ["--operation", "ping", "--text", "hi", "--json"])).toBe(0);
      const body = JSON.parse(out.join("")) as { data: { data: { result: { data: { echo: string } } } } };
      expect(body.data.data.result.data.echo).toBe("hi");
      await expect(command.run(io, ["--operation", "ping"])).rejects.toBeInstanceOf(UsageError);
      await expect(command.run(io, ["--operation", "ping", "--text", "hi", "--label", "x"])).rejects.toBeInstanceOf(UsageError);
    });
  });

  test("is answered by the loopback endpoint", async () => {
    const { setup } = session();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const token = "test-token-not-a-secret-fixture";
    const handle = startServeHttp({ db, vaultPath: setup.vault, host: "127.0.0.1", token });
    try {
      await withWorldOps([pingOp], async () => {
        const response = await fetch(`${handle.url}/v1/world_view`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(PING_INPUT),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { value: { data: { result: { data: { echo: string; schema: string } } } } };
        expect(body.value.data.result.data).toMatchObject({ schema: PING_SCHEMA, echo: "hello" });
      });
    } finally {
      await handle.stop();
      db.close();
    }
  });

  test("is answered by the App host route, which takes the keys the registry names", async () => {
    const { io } = session();
    const host = createAppHost(io);
    const call = async (body: unknown) =>
      (await host.handle(new Request("http://127.0.0.1/app/v1/world_view", { method: "POST", body: JSON.stringify(body) }))).json() as Promise<any>;
    try {
      expect((await call(PING_INPUT)).error.code).toBe("invalid_request");
      await withWorldOps([pingOp], async () => {
        const answered = await call(PING_INPUT);
        expect(answered.ok, JSON.stringify(answered)).toBe(true);
        expect(answered.data.result.data.echo).toBe("hello");
        expect((await call({ ...PING_INPUT, extra: true })).error.code).toBe("invalid_request");
      });
    } finally {
      await host.close();
    }
  });
});

describe("describe on the command line", () => {
  test("prints the catalogue in plain lines and as the envelope with --json", async () => {
    const { io, out } = session();
    const command = createWorldCommand(WORLD_CLI_OPS);
    expect(await command.run(io, ["--operation", "describe"])).toBe(0);
    expect(out).toContain("concept  shipped  typed_extraction");
    expect(out).toContain("situation  shipped  typed_extraction");
    expect(out.some((line) => line.startsWith("describe"))).toBe(true);
    out.length = 0;
    expect(await command.run(io, ["--operation", "describe", "--json"])).toBe(0);
    const body = JSON.parse(out.join("")) as { data: { data: { result: { data: { schema: string } } } } };
    expect(body.data.data.result.data.schema).toBe("kizuki.world-describe/v1");
    await expect(command.run(io, ["--operation", "describe", "--label", "x"])).rejects.toBeInstanceOf(UsageError);
  });
});
