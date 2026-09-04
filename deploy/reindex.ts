#!/usr/bin/env bun
/**
 * M1 container floor: there is no CLI verb that rebuilds the derived search
 * and graph layers from canon pages already on disk (`kizuki serve`'s writer
 * populates them as it writes, and nothing else calls
 * `@kizuki/core`'s `rebuildDerived`). Hand-authored canon pages — the ones a
 * person edits directly per `CANON.md`'s doctrine, or the ones this image
 * seeds as fixtures — need that rebuild to become searchable before a model
 * is configured. This script is pure composition over the existing public
 * `@kizuki/core` surface (the same functions `packages/cli/src/context.ts`
 * opens a vault with); it adds no new core logic and lives under `deploy/`,
 * not `packages/`. It imports by relative path rather than the `@kizuki/core`
 * specifier because this file is outside every workspace package, so bun's
 * monorepo resolution (which needs no `node_modules` symlink for a file
 * inside `packages/*`) does not apply to it.
 */
import { join } from "node:path";
import { initGraph, initSearch, openLedger, rebuildDerived } from "../packages/core/src/index";
import { initStaging } from "../packages/core/src/staging/index";

function main(): void {
  const vaultPath = process.argv[2];
  if (vaultPath === undefined || vaultPath.length === 0) {
    process.stderr.write("usage: reindex.ts <vault>\n");
    process.exit(2);
  }
  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  try {
    initStaging(db);
    initSearch(db);
    initGraph(db);
    const result = rebuildDerived(db, vaultPath);
    process.stdout.write(
      `reindexed pages=${result.search.pages} events=${result.search.events}\n`,
    );
  } finally {
    db.close();
  }
}

main();
