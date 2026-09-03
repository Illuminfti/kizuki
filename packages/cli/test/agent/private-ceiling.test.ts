import { afterEach, describe, expect, test } from "bun:test";
import { startServeHttp } from "@kizuki/core";
import type { ServeHttpHandle } from "@kizuki/core";
import { createHelpers } from "../helpers";
import { onlyTokenLine, openVaultDb, writeFixturePage } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();

let handle: ServeHttpHandle | null = null;
afterEach(async () => {
  if (handle !== null) await handle.stop();
  handle = null;
  cleanup();
});

describe("5.3 owner-agent ceiling", () => {
  test("a private page is returned to the owner agent and withheld from the default agent", async () => {
    const setup = tempVault();
    writeFixturePage(
      setup.vault,
      "facts/kettle-private.md",
      "fact:kettle",
      "private",
      "The private kettle protocol.",
    );

    const adaAdd = runCli(setup.env, "agent", "add", "ada");
    expect(adaAdd.exitCode).toBe(0);
    const adaToken = onlyTokenLine(adaAdd.stdout);

    const graceAdd = runCli(setup.env, "agent", "add", "grace", "--owner-agent");
    expect(graceAdd.exitCode).toBe(0);
    const graceToken = onlyTokenLine(graceAdd.stdout);

    const db = openVaultDb(setup.vault);
    handle = startServeHttp({ db, vaultPath: setup.vault, host: "127.0.0.1" });

    async function getPage(token: string): Promise<{
      ok: boolean;
      value: { canon: unknown[]; denied: { reason: string; count: number }[] };
    }> {
      const response = await fetch(`${handle?.url}/v1/mcp/get_page`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "fact:kettle" }),
      });
      return (await response.json()) as {
        ok: boolean;
        value: { canon: unknown[]; denied: { reason: string; count: number }[] };
      };
    }

    const asGrace = await getPage(graceToken);
    expect(asGrace.ok).toBe(true);
    expect(asGrace.value.canon).toHaveLength(1);
    expect(asGrace.value.denied).toEqual([]);

    const asAda = await getPage(adaToken);
    expect(asAda.ok).toBe(true);
    expect(asAda.value.canon).toHaveLength(0);
    expect(asAda.value.denied).toEqual([{ reason: "above_ceiling", count: 1 }]);

    await handle.stop();
    handle = null;
    db.close();
  });
});
