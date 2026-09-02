import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openLedger } from "@kizuki/core";
import { initStaging } from "@kizuki/core/staging";
import { writeLlmConfig } from "../src/config";
import { runEnrichment } from "../src/run";
import type { ChatTransport } from "../src/transport";
import { llmConfig, tempVault } from "./helpers";

const repoRoot = resolve(import.meta.dir, "../../..");

interface Vault {
  path: string;
  db: Database;
  dispose: () => void;
}

const vaults: Vault[] = [];

afterEach(() => {
  while (vaults.length > 0) vaults.pop()?.dispose();
});

function vault(): Vault {
  const temporary = tempVault();
  const dbPath = join(temporary.path, ".kizuki", "kizuki.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openLedger(dbPath);
  initStaging(db);
  const built: Vault = {
    path: temporary.path,
    db,
    dispose: () => {
      db.close();
      temporary.dispose();
    },
  };
  vaults.push(built);
  return built;
}

const explode: ChatTransport = () => {
  throw new Error("the transport must not be reached");
};

function schemaNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master ORDER BY name")
    .all()
    .map((row) => row.name);
}

describe("nothing happens without a configured endpoint", () => {
  test("no transport call and no schema change", async () => {
    const built = vault();
    const before = schemaNames(built.db);
    const receipt = await runEnrichment(built.db, built.path, {
      transport: explode,
    });
    expect(receipt.status).toBe("unconfigured");
    expect(schemaNames(built.db)).toEqual(before);
  });

  test("the global fetch is never called either", async () => {
    const built = vault();
    const real = globalThis.fetch;
    let called = false;
    try {
      globalThis.fetch = Object.assign(
        (): never => {
          called = true;
          throw new Error("fetch must not be called");
        },
        { preconnect: real.preconnect.bind(real) },
      );
      const receipt = await runEnrichment(built.db, built.path, {});
      expect(receipt.status).toBe("unconfigured");
    } finally {
      globalThis.fetch = real;
    }
    expect(called).toBe(false);
  });

  test("a dry run against a configured endpoint contacts nothing", async () => {
    const built = vault();
    writeLlmConfig(built.path, llmConfig());
    const receipt = await runEnrichment(built.db, built.path, {
      transport: explode,
      dry_run: true,
    });
    expect(receipt.status).toBe("dry_run");
  });
});

describe("the package opens no other kind of socket", () => {
  test("no server, socket or resolver anywhere in the source", () => {
    const result = Bun.spawnSync({
      cmd: ["git", "ls-files", "-z", "--", "packages/llm/src"],
      cwd: repoRoot,
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const files = result.stdout.toString().split("\0").filter((file) => file.length > 0);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(repoRoot, file), "utf8");
      for (const forbidden of [
        "Bun.serve",
        "WebSocket",
        "node:http",
        "node:https",
        "node:net",
        "node:dns",
        "node:tls",
      ]) {
        expect(`${file}: ${source.includes(forbidden)}`).toBe(`${file}: false`);
      }
    }
  });
});
