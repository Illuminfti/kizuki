import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOwnerObservation, writeWorldModelPersonCard } from "./people-intel.ts";
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

  test("POST /api/docs/save with cross-origin text/plain returns 403 and does not write owner-notes.md", async () => {
    const notesPath = join(tmpVault, "owner-notes.md");
    rmSync(notesPath, { force: true });
    const res = await app!.fetch(
      new Request(`${baseUrl}/api/docs/save`, {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "text/plain",
        },
        body: JSON.stringify({ path: "owner-notes.md", content: "# Pwned\n" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(existsSync(notesPath)).toBe(false);
  });

  test("POST /api/docs/save with Sec-Fetch-Site: cross-site returns 403", async () => {
    const notesPath = join(tmpVault, "owner-notes.md");
    rmSync(notesPath, { force: true });
    const res = await app!.fetch(
      new Request(`${baseUrl}/api/docs/save`, {
        method: "POST",
        headers: {
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "owner-notes.md", content: "# Cross-site\n" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(existsSync(notesPath)).toBe(false);
  });

  test("POST /api/docs/save with text/plain (no Origin) returns 415 and does not write owner-notes.md", async () => {
    const notesPath = join(tmpVault, "owner-notes.md");
    rmSync(notesPath, { force: true });
    const res = await app!.fetch(
      new Request(`${baseUrl}/api/docs/save`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
        },
        body: JSON.stringify({ path: "owner-notes.md", content: "# Text plain\n" }),
      }),
    );
    expect(res.status).toBe(415);
    expect(existsSync(notesPath)).toBe(false);
  });

  test("Dynamic route module POST /api/ontology/compile with cross-origin Origin returns 403 before dispatch", async () => {
    const res = await app!.fetch(
      new Request(`${baseUrl}/api/ontology/compile`, {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "X-Kizuki-Request": "1",
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect((body.error || "").toLowerCase()).toContain("cross-origin");
  });

  test("Same-origin POST /api/docs/save with application/json writes owner-notes.md", async () => {
    const notesPath = join(tmpVault, "owner-notes.md");
    rmSync(notesPath, { force: true });
    const res = await app!.fetch(
      new Request(`${baseUrl}/api/docs/save`, {
        method: "POST",
        headers: {
          Origin: baseUrl,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-Kizuki-Request": "1",
        },
        body: JSON.stringify({ path: "owner-notes.md", content: "# Owner Notes\n\nVerified same-origin save.\n" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(existsSync(notesPath)).toBe(true);
    expect(readFileSync(notesPath, "utf8")).toContain("Verified same-origin save.");
  });

  test("POST /api/docs/save targeting canonical world/people/alex-rivera.md returns 403 and leaves file unchanged", async () => {
    const canonPath = join(tmpVault, "world", "people", "alex-rivera.md");
    const before = readFileSync(canonPath, "utf8");
    const res = await app!.fetch(
      new Request(`${baseUrl}/api/docs/save`, {
        method: "POST",
        headers: {
          Origin: baseUrl,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-Kizuki-Request": "1",
        },
        body: JSON.stringify({
          path: "world/people/alex-rivera.md",
          content: "# Overwritten canonical card\n",
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(readFileSync(canonPath, "utf8")).toBe(before);
  });

  test("writeWorldModelPersonCard and appendOwnerObservation write strictly to .kizuki/drafts/people/ with status draft", async () => {
    const canonPath = join(tmpVault, "world", "people", "alex-rivera.md");
    const canonBefore = readFileSync(canonPath, "utf8");

    const written = await writeWorldModelPersonCard(
      tmpVault,
      "alex-rivera",
      [
        "---",
        'title: "Alex Rivera"',
        'status: "canonical"',
        "---",
        "# Alex Rivera",
        "",
        "## Current read",
        "- Engineering partner leading Atlas indexing work.",
      ].join("\n"),
    );

    expect(written.card_path).toBe(".kizuki/drafts/people/alex-rivera.md");
    expect(written.draft).toBe(true);
    expect(written.target_canon_path).toBe("world/people/alex-rivera.md");
    expect(written.content).toContain('status: "draft"');
    expect(written.content).not.toContain('status: "canonical"');
    expect(written.content).toContain('target_canon_path: "world/people/alex-rivera.md"');
    expect(written.content).toContain('promotion_via: "kizuki-receipted-writer"');

    const draftPath = join(tmpVault, ".kizuki", "drafts", "people", "alex-rivera.md");
    expect(existsSync(draftPath)).toBe(true);
    expect(readFileSync(draftPath, "utf8")).toContain('status: "draft"');
    expect(readFileSync(canonPath, "utf8")).toBe(canonBefore);

    const noted = await appendOwnerObservation(tmpVault, "alex-rivera", "Alex Rivera", canonBefore, {
      kind: "insight",
      text: "Prefers falsifiable benchmark receipts before architectural rewrites.",
    });
    expect(noted.card_path).toBe(".kizuki/drafts/people/alex-rivera.md");
    expect(noted.draft).toBe(true);
    expect(noted.target_canon_path).toBe("world/people/alex-rivera.md");
    expect(readFileSync(draftPath, "utf8")).toContain("Prefers falsifiable benchmark receipts");
    expect(readFileSync(draftPath, "utf8")).toContain('status: "draft"');
    expect(readFileSync(canonPath, "utf8")).toBe(canonBefore);
  });
});
