import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLegacyWikiConnector,
  LEGACY_WIKI_CONNECTOR_ID,
} from "@kizuki/connectors";
import {
  listConnections,
  listRunReceipts,
  runBatch,
  setSourceGrant,
  sourceCaptureAdmission,
} from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const h = createHelpers();
afterEach(h.cleanup);

const page = (title: string, body: string) =>
  `---\ntitle: ${title}\ntype: Person\n---\n${body}\n`;

function enrolledWiki() {
  const setup = h.tempVault();
  const wiki = join(setup.root, "wiki");
  mkdirSync(wiki);
  writeFileSync(
    join(wiki, "kizuki-mapping.json"),
    JSON.stringify({
      schema: "kizuki.legacy-wiki-mapping/v1",
      type: { field: "type", values: { Person: "person" }, default: "topic" },
      ignore: [],
    }),
  );
  writeFileSync(
    join(wiki, "ada.md"),
    page("Ada", "The lapis lantern is in the library."),
  );
  writeFileSync(
    join(wiki, "gone.md"),
    page("Gone", "The amber key is in the attic."),
  );
  writeFileSync(
    join(wiki, "plain.md"),
    page("Plain", "The jade bell is in the hall."),
  );
  expect(
    h.runCli(
      setup.env,
      "connect",
      "import-legacy-wiki",
      "--source",
      wiki,
      "--vault",
      setup.vault,
    ).exitCode,
  ).toBe(0);
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const key = listConnections(db)[0]!.source_key;
    // Exact synthetic consent through public Core, as mapped-import does.
    setSourceGrant(db, {
      source_key: key,
      expected_revision: 0,
      operation_id: "synthetic-wiki-grant",
      policy: {
        purposes: ["capture", "recall"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: "private",
      },
    });
    return { ...setup, wiki, key };
  } finally {
    db.close();
  }
}

/**
 * The rows an earlier build left: the same pages, recorded before an event
 * carried the page's content hash, and one recorded with no page target at
 * all. They land through the enrolled source and no sync ever succeeds, so the
 * source has no checkpoint and must rebuild its snapshot from the ledger.
 */
async function seedEarlierBuildRows(
  vault: string,
  wiki: string,
  key: string,
): Promise<void> {
  const planned = await createLegacyWikiConnector({ path: wiki }).backfill(
    null,
  );
  const events = planned.events.map((event): CaptureEventInput => {
    const {
      sha256: _hash,
      page_candidate: candidate,
      ...metadata
    } = event.metadata;
    return {
      ...event,
      metadata:
        event.source_record_id === "plain.md"
          ? metadata
          : { ...metadata, page_candidate: candidate },
    };
  });
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const admission = sourceCaptureAdmission(db, LEGACY_WIKI_CONNECTOR_ID, key);
    const result = runBatch(
      db,
      { events, cursor: null, has_more: false },
      { page_candidates: true },
      admission ?? undefined,
    );
    expect(result.errors).toEqual([]);
    expect(result.stored).toBe(3);
  } finally {
    db.close();
  }
}

test("rows from a build before page hashes re-emit their pages instead of refusing the source", async () => {
  const setup = enrolledWiki();
  await seedEarlierBuildRows(setup.vault, setup.wiki, setup.key);
  rmSync(join(setup.wiki, "gone.md"));

  const healed = h.runCli(
    setup.env,
    "sync",
    "import-legacy-wiki",
    "--vault",
    setup.vault,
  );
  expect(healed.stderr).not.toContain("error:");
  expect(healed.exitCode).toBe(0);
  // Both pages still on disk come back carrying the hash the old rows lacked.
  expect(healed.stdout).toContain("events_stored=2");
  expect(healed.stdout).toContain("errors=0");

  // The old row still names a page the ledger holds, so its deletion from
  // the wiki is a withdrawal rather than a page nobody can retract.
  const withdrawn = h.runCli(
    setup.env,
    "sync",
    "import-legacy-wiki",
    "--vault",
    setup.vault,
  );
  expect(withdrawn.exitCode).toBe(0);
  expect(withdrawn.stdout).toContain("events_stored=1");
  expect(withdrawn.stdout).toMatch(/withdrawn=[1-9]/);
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const latest = db
      .query<{ id: string; deleted: number; hash: string | null }, []>(
        `SELECT source_record_id AS id, deleted, json_extract(metadata, '$.sha256') AS hash FROM events e
        WHERE accepted_at = (SELECT max(accepted_at) FROM events WHERE source_record_id = e.source_record_id)
        ORDER BY id`,
      )
      .all();
    expect(latest.map((row) => [row.id, row.deleted, typeof row.hash])).toEqual(
      [
        ["ada.md", 0, "string"],
        ["gone.md", 1, "object"],
        ["plain.md", 0, "string"],
      ],
    );
  } finally {
    db.close();
  }

  const settled = h.runCli(
    setup.env,
    "sync",
    "import-legacy-wiki",
    "--vault",
    setup.vault,
  );
  expect(settled.exitCode).toBe(0);
  expect(settled.stdout).toContain("events_stored=0");
});

test("a source that cannot load names why in the sync receipt", () => {
  const setup = enrolledWiki();
  rmSync(join(setup.wiki, "kizuki-mapping.json"));
  expect(h.runCli(setup.env, "sync", "--once", "--vault", setup.vault).exitCode).toBe(1);
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const [receipt] = listRunReceipts(db, { rail: "sync" });
    // The receipt redacts the path the owner configured, not the reason.
    expect(receipt?.errors).toEqual([
      "connector kizuki.import-legacy-wiki sync unavailable: kizuki.import-legacy-wiki: mapping file not found: [path] see docs/legacy-import.md",
    ]);
  } finally {
    db.close();
  }
});
