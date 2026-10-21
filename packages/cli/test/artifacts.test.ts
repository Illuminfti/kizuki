import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../core/src/ledger/db";
import { artifactFixture, ART_WHEN } from "../../core/test/helpers/artifact-fixture";
import { serveWorldView, type WorldReadResult } from "@kizuki/core/world";
import { createAppHost } from "../src/app/host";
import type { CliIo } from "../src/commands";
import { createHelpers } from "./helpers";
const h = createHelpers();
afterEach(h.cleanup);
function payload(body: WorldReadResult) { if (!("result" in body) || !("data" in body.result))
  throw new Error("missing payload"); return body.result.data; }
test("real CLI processes and App route preserve exact artifact metadata and feedback", async () => {
  const setup = h.tempVault(), db = openLedger(join(setup.vault, ".kizuki/kizuki.db")), f = await artifactFixture(db);
  const ctx = { ...f.ctx, vaultPath: setup.vault };
  const io: CliIo = { env: setup.env, vaultOverride: setup.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, out: () => { }, err: () => { }, prompt: async () => "" };
  const app = createAppHost(io);
  try {
    const item = await f.capture("Captured artifact bytes"), ref = item.ref();
    await item.feedback("Feedback stays with this version");
    for (const [operation, input, args] of [
      ["artifact_version", { artifact: ref }, ["--ref", ref.token]],
      ["find_artifacts", { label: "" }, ["--label", ""]],
    ] as const) {
      const request = { operation, ...input, ...ART_WHEN }, expected = payload(serveWorldView(ctx, request).data);
      const cli = h.runCli(setup.env, "world", "--operation", operation, ...args, "--json");
      expect(cli.exitCode, cli.stderr).toBe(0);
      expect(cli.stderr).toBe("");
      expect(payload(JSON.parse(cli.stdout).data.data)).toEqual(expected);
      const response = await app.handle(new Request("http://127.0.0.1/app/v1/world_view", { method: "POST", body: JSON.stringify(request) }));
      const result = await response.json() as {
        ok: boolean;
        data: WorldReadResult;
      };
      expect(result.ok).toBe(true);
      expect(payload(result.data)).toEqual(expected);
    }
    const plain = h.runCli(setup.env, "world", "--operation", "artifact_version", "--ref", ref.token);
    expect(plain.exitCode, plain.stderr).toBe(0);
    expect(plain.stdout).toContain(item.metadata.sha256);
    expect(plain.stdout).toContain("Original: unavailable");
    expect(plain.stdout).toContain("does not provide or visually inspect");
    expect(h.runCli(setup.env, "world", "--operation", "artifact_version", "--ref", "bad").exitCode).toBe(2);
  }
  finally {
    await app.close();
    f.dispose();
    db.close();
  }
}, 120000);
