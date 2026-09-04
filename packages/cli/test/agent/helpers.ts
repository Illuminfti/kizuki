import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initSearch, openLedger, serializePage } from "@kizuki/core";

/** Same shape `context.ts#openVaultDb` builds; a second connection to the
 * same vault after the CLI process that minted the agent has closed its own.
 * `openLedger`'s migration already applies the claims schema `initStaging`
 * used to add by hand; `@kizuki/core/staging` is no longer a published
 * subpath (see #410). */
export function openVaultDb(vaultPath: string): Database {
  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  initSearch(db);
  return db;
}

/** A minimal, valid canon page at a given sensitivity, written the way a
 * receipted write would leave one on disk (synthetic fixture, no real page). */
export function writeFixturePage(
  vaultPath: string,
  relPath: string,
  id: string,
  sensitivity: "public" | "personal" | "private",
  body: string,
): void {
  const absolute = join(vaultPath, ...relPath.split("/"));
  writeFileSync(
    absolute,
    serializePage({
      data: {
        id,
        title: id,
        type: "fact",
        status: "active",
        sensitivity,
        taint: "clean",
        subjects: [],
      },
      body,
    }),
    "utf8",
  );
}

/** Pulls the one token line a `agent add`/`agent rotate` call prints. */
export function onlyTokenLine(stdout: string): string {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new Error(`expected exactly one stdout line, got ${lines.length}: ${stdout}`);
  }
  const line = lines[0];
  if (line === undefined) throw new Error("expected a token line");
  return line;
}
