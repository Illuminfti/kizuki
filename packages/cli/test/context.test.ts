import { afterEach, describe, expect, test } from "bun:test";
import { createHelpers, fixtureConsent } from "./helpers";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { cleanup, runCli, tempVault, isolatedEnv } = createHelpers();
afterEach(cleanup);

const ATLAS_SINCE = "2020-01-01T00:00:00.000Z";
const ATLAS_UNTIL = "2030-01-01T00:00:00.000Z";
const ATLAS_MTIME = new Date("2020-06-15T12:00:00.000Z");

describe("context", () => {
  test("prints a purpose-scoped packet with the machine header", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "context", "--purpose", "session", "--budget", "80");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("KIZUKI CONTEXT v1");
    expect(result.stdout).toContain("purpose=session");
    expect(result.stdout).toContain("budget=80");
    expect(result.stdout).toContain("rules=canon lines are produced prose");
  });

  test("help lists the context verb", () => {
    const result = runCli(tempVault().env, "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("context");
  });

  test("invalid budgets are usage errors before a vault is opened", () => {
    for (const budget of ["no", "49", "2001", "1.5"]) {
      const result = runCli(isolatedEnv(), "context", "--budget", budget);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("invalid --budget");
      expect(result.stderr).not.toContain("no vault configured");
    }
  });

  test("empty context keeps stdout usable and offers a next step on stderr", () => {
    const result = runCli(tempVault().env, "context");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("KIZUKI CONTEXT v1");
    expect(result.stderr).toContain("No matching context");
    expect(result.stderr).toContain("--query");
    expect(result.stderr).toContain("--budget");
    expect(result.stderr).toContain("--since");
    expect(result.stderr).toContain("--until");
    expect(result.stderr).toContain("window");
    expect(result.stderr).not.toContain("--include");
    expect(result.stderr).not.toContain("--subject");
  });

  test("a 2020 markdown note stays outside the session profile until an explicit window is passed", () => {
    const setup = tempVault();
    const notes = join(setup.root, "atlas-notes");
    mkdirSync(notes);
    const atlas = join(notes, "atlas.md");
    writeFileSync(atlas, "# Project Atlas\nMira leads Project Atlas.\n");
    utimesSync(atlas, ATLAS_MTIME, ATLAS_MTIME);
    const imported = runCli(
      setup.env,
      "import",
      "markdown-folder",
      "--source",
      notes,
      ...fixtureConsent(setup.root),
    );
    expect(imported.exitCode, imported.stderr).toBe(0);

    const session = runCli(setup.env, "context", "--purpose", "session", "--query", "Atlas", "--json");
    expect(session.exitCode).toBe(0);
    const sessionBody = JSON.parse(session.stdout) as {
      data: { quoted: unknown[]; data: { sections: Record<string, number>; packet_md: string } };
    };
    expect(sessionBody.data.data.sections).toEqual({
      canon: 0,
      graph: 0,
      timeline: 0,
      claims: 0,
    });
    expect(sessionBody.data.quoted).toEqual([]);
    expect(session.stderr).toContain("No matching context");

    const widened = runCli(
      setup.env,
      "context",
      "--since",
      ATLAS_SINCE,
      "--until",
      ATLAS_UNTIL,
      "--query",
      "Atlas",
      "--json",
    );
    expect(widened.exitCode).toBe(0);
    const widenedBody = JSON.parse(widened.stdout) as {
      data: {
        quoted: Array<{ text: string; occurred_at: string }>;
        data: { sections: { timeline: number }; packet_md: string };
      };
    };
    expect(widenedBody.data.data.sections.timeline).toBeGreaterThan(0);
    expect(widenedBody.data.data.packet_md).toContain("Atlas");
    expect(
      widenedBody.data.quoted.some(
        (chunk) => chunk.text.includes("Atlas") && chunk.occurred_at.startsWith("2020-"),
      ),
    ).toBe(true);
  });

  test("malformed timestamps and inverted windows fail before vault effects", () => {
    const cases = [
      [["context", "--since", "not-a-time"], "invalid arguments: since: must be an RFC3339 timestamp"],
      [["context", "--until", "2026-02-30T00:00:00Z"], "invalid arguments: until: must be an RFC3339 timestamp"],
      [
        ["context", "--since", "2021-01-01T00:00:00.000Z", "--until", "2020-01-01T00:00:00.000Z"],
        "invalid arguments: since: must not be after until",
      ],
    ] as const;
    for (const [args, diagnostic] of cases) {
      const isolated = runCli(isolatedEnv(), ...args);
      expect(isolated.exitCode).toBe(2);
      expect(isolated.stdout).toBe("");
      expect(isolated.stderr).toContain(`error: ${diagnostic}`);
      expect(isolated.stderr).not.toContain("no vault configured");
    }

    const setup = tempVault();
    const dbPath = join(setup.vault, ".kizuki", "kizuki.db");
    const beforeBytes = readFileSync(dbPath);
    for (const [args, diagnostic] of cases) {
      const result = runCli(setup.env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`error: ${diagnostic}`);
      expect(readFileSync(dbPath)).toEqual(beforeBytes);
    }
  });

  test("corrupt canon is reported as degraded with a failing exit status", () => {
    const setup = tempVault();
    mkdirSync(join(setup.vault, "facts"), { recursive: true });
    writeFileSync(join(setup.vault, "facts", "broken.md"), "no frontmatter here\n");
    const result = runCli(setup.env, "context", "--json");
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.status).toBe("degraded");
    expect(result.stderr).toContain("could not be gathered completely");
    expect(output.data.data.packet_md).toStartWith("KIZUKI CONTEXT v1");
  });

  test("per-command help works without opening a vault", () => {
    const result = runCli(isolatedEnv(), "connect", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("connect beeper --token-ref");
    expect(result.stdout).toContain("connect status --json");
  });
});
