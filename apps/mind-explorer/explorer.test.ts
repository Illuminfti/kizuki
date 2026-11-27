import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExplorerApp } from "./server.ts";
import { seedSyntheticVaultDb } from "./test-vault-fixture.ts";

describe("Kizuki Mind Explorer portable server smoke suite", () => {
  let tmpVault = "";
  let app: ReturnType<typeof createExplorerApp> | null = null;
  let server: ReturnType<ReturnType<typeof createExplorerApp>["start"]> | null = null;
  let baseUrl = "";

  beforeAll(() => {
    tmpVault = mkdtempSync(join(tmpdir(), "kizuki-mind-explorer-"));
    mkdirSync(join(tmpVault, ".kizuki", "bridges"), { recursive: true });
    mkdirSync(join(tmpVault, "notes"), { recursive: true });
    mkdirSync(join(tmpVault, "world", "people"), { recursive: true });

    const dbPath = join(tmpVault, ".kizuki", "kizuki.db");
    seedSyntheticVaultDb(dbPath);

    writeFileSync(
      join(tmpVault, "owner-anchors.md"),
      [
        "# Owner Anchors",
        "",
        "- **Atlas**: Local-first knowledge workflow and architecture benchmark.",
        "- **Kizuki**: Personal memory vault and workbench.",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(tmpVault, "notes", "atlas-roadmap.md"),
      [
        "---",
        'title: "Atlas Roadmap"',
        'tags: ["atlas", "architecture"]',
        "---",
        "# Atlas Roadmap",
        "",
        "Atlas coordinates local indexing, verifiable search, and fast loopback APIs.",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(tmpVault, "world", "people", "alex-rivera.md"),
      [
        "---",
        'title: "Alex Rivera"',
        'canonical_name: "Alex Rivera"',
        'schema_version: "person-card-v2"',
        'relationship_state: "active"',
        'org: "Atlas Labs"',
        "---",
        "# Alex Rivera",
        "",
        "> **Canonical read:** Engineering partner collaborating on Atlas indexing.",
      ].join("\n"),
      "utf8",
    );

    app = createExplorerApp({
      hostname: "127.0.0.1",
      port: 0,
      publicDir: join(import.meta.dir, "public"),
      vaultConfig: {
        vaultPath: tmpVault,
        dbPath,
        bridgesDir: join(tmpVault, ".kizuki", "bridges"),
        antigravityJsonlPath: join(tmpVault, ".kizuki", "evidence.jsonl"),
        lifeosPeopleDir: null,
        relationshipsDir: null,
      },
      agentBoardConfig: {
        dbPath: join(tmpVault, ".kizuki", "agent-board.db"),
      },
    });
    server = app.start(0);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    try {
      server?.stop(true);
    } catch {
      // ignore
    }
    try {
      app?.close();
    } catch {
      // ignore
    }
    if (tmpVault) {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  test("GET / serves HTML shell on ephemeral loopback port", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct).toContain("text/html");
    const html = await res.text();
    expect(html.toLowerCase()).toContain("<!doctype html>");
    expect(html).toContain("Kizuki");
  });

  test("GET /api/health returns 200 JSON", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toBeTruthy();
    expect(typeof body).toBe("object");
  });

  test("GET /api/today returns 200 JSON from synthetic vault", async () => {
    const res = await fetch(`${baseUrl}/api/today`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toBeTruthy();
    expect(typeof body).toBe("object");
  });

  test("GET /api/box/ai-live returns 200 JSON", async () => {
    const res = await fetch(`${baseUrl}/api/box/ai-live`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toBeTruthy();
    expect(typeof body).toBe("object");
  });

  test("GET /api/search?q=atlas returns 200 and finds synthetic Atlas document", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=atlas`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toBeTruthy();
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).toContain("atlas");
  });
});
