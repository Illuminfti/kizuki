import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLegacyWikiConnector,
  LEGACY_WIKI_CONNECTOR_ID,
} from "@kizuki/connectors";
import {
  accept,
  getCheckpoint,
  isPlainObject,
  listConnections,
  listRunReceipts,
  MAX_PROPOSAL_BODY_CHARS,
  runBatch,
  setSourceGrant,
  sourceCaptureAdmission,
} from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { wikiCommittedIdentities } from "../src/connections";
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

/** This build's event for a page, as a build before `body_truncated` planned it. */
function asEarlierBuild(event: CaptureEventInput): CaptureEventInput {
  const { body_truncated: _marked, migration, ...metadata } = event.metadata;
  if (!isPlainObject(migration) || !Array.isArray(migration["notes"])) {
    throw new Error("expected a migration record");
  }
  return {
    ...event,
    metadata: {
      ...metadata,
      migration: {
        ...migration,
        notes: migration["notes"].filter((note) => note !== "body_truncated"),
      },
    },
  };
}

/** Recorded through the enrolled source and never staged. */
function recordUnstaged(
  db: ReturnType<typeof openLedger>,
  key: string,
  events: CaptureEventInput[],
): void {
  const admission = sourceCaptureAdmission(db, LEGACY_WIKI_CONNECTOR_ID, key);
  for (const event of events) {
    expect(accept(db, event, admission === null ? {} : { source: admission }).status).toBe(
      "stored",
    );
  }
}

/**
 * What an earlier build left for a page longer than a proposal body: the
 * event stored with the whole page and no staged page, because staging
 * refused the body and the retry that let the cursor advance stored the page
 * as a duplicate.
 */
async function seedUnstagedPage(
  vault: string,
  wiki: string,
  key: string,
  relpath: string,
): Promise<void> {
  const planned = await createLegacyWikiConnector({ path: wiki }).backfill(
    null,
  );
  const event = planned.events.find((entry) => entry.source_record_id === relpath);
  if (event === undefined) throw new Error("expected the page to be planned");
  expect(event.metadata["body_truncated"]).toBe(true);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    recordUnstaged(db, key, [asEarlierBuild(event)]);
  } finally {
    db.close();
  }
}

test("an earlier build's row is planned again only when its page is longer than a staged body", async () => {
  const setup = enrolledWiki();
  // Each body gains the newline that ends the page file.
  const bodies: Record<string, string> = {
    // 64,000 units: the longest body staging files.
    "at-bound.md": "a".repeat(MAX_PROPOSAL_BODY_CHARS - 1),
    "past-bound.md": "a".repeat(MAX_PROPOSAL_BODY_CHARS),
    // 40,001 code points, 80,001 units: long only as staging counts.
    "astral.md": "\u{1F600}".repeat(40_000),
    // 40,001 code points in 120,001 bytes, and 40,001 units.
    "wide.md": "\u6F22".repeat(40_000),
  };
  for (const [relpath, body] of Object.entries(bodies)) {
    writeFileSync(join(setup.wiki, relpath), page(relpath.slice(0, -3), body));
  }
  const planned = await createLegacyWikiConnector({ path: setup.wiki }).backfill(
    null,
  );
  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    recordUnstaged(db, setup.key, planned.events.map(asEarlierBuild));
    const emptied = () =>
      wikiCommittedIdentities(db, setup.key)
        .filter(([, identity]) => identity.hash === "")
        .map(([relpath]) => relpath)
        .sort();
    expect(emptied()).toEqual(["astral.md", "past-bound.md"]);

    // This build's record of the same page carries the flag, and settles it.
    const astral = planned.events.find((event) => event.source_record_id === "astral.md");
    if (astral === undefined) throw new Error("expected the page to be planned");
    expect(astral.metadata["body_truncated"]).toBe(true);
    recordUnstaged(db, setup.key, [astral]);
    expect(emptied()).toEqual(["past-bound.md"]);
  } finally {
    db.close();
  }
});

test("a long page an earlier build stored but never staged is staged once, then settles", async () => {
  const setup = enrolledWiki();
  // Enough pages that the snapshot no longer fits in the cursor, so every pass
  // rebuilds it from the ledger, as it does for a real estate.
  mkdirSync(join(setup.wiki, "p"));
  for (let index = 0; index < 120; index += 1) {
    writeFileSync(
      join(setup.wiki, "p", `page-${String(index).padStart(3, "0")}.md`),
      page(`Page ${index}`, "The jade bell is in the hall."),
    );
  }
  const first = h.runCli(setup.env, "sync", "import-legacy-wiki", "--vault", setup.vault);
  expect(first.exitCode).toBe(0);
  expect(first.stdout).toContain("errors=0");

  const body = "lapis lantern\n".repeat(5_000);
  writeFileSync(join(setup.wiki, "long.md"), page("Long", body));
  await seedUnstagedPage(setup.vault, setup.wiki, setup.key, "long.md");

  const staged = (db: ReturnType<typeof openLedger>) =>
    db
      .query<{ body: string; frontmatter: string }, []>(
        `SELECT body, frontmatter FROM proposals
          WHERE json_extract(frontmatter, '$."x-source-record-id"') = 'long.md'`,
      )
      .all();
  let db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const cursor = getCheckpoint(db, LEGACY_WIKI_CONNECTOR_ID, setup.key)?.cursor;
    const parsed: unknown = JSON.parse(cursor ?? "null");
    expect(isPlainObject(parsed) && parsed["exhausted"] === true).toBe(true);
    expect(isPlainObject(parsed) && Object.hasOwn(parsed, "files")).toBe(false);
    expect(staged(db)).toEqual([]);
  } finally {
    db.close();
  }

  const healed = h.runCli(setup.env, "sync", "import-legacy-wiki", "--vault", setup.vault);
  expect(healed.stderr).not.toContain("error:");
  expect(healed.exitCode).toBe(0);
  expect(healed.stdout).toContain("events_stored=1");
  expect(healed.stdout).toContain("proposals_created=1");
  expect(healed.stdout).toContain("errors=0");
  db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    const [proposal, ...extra] = staged(db);
    expect(extra).toEqual([]);
    expect(proposal?.body).toBe(body.slice(0, MAX_PROPOSAL_BODY_CHARS));
    expect(JSON.parse(proposal?.frontmatter ?? "{}")["x-body-truncated"]).toBe(true);
    // Both records keep the whole page; the newer one says its page was cut.
    const rows = db
      .query<{ chars: number; marked: number | null }, []>(
        `SELECT length(text) AS chars, json_extract(metadata, '$.body_truncated') AS marked
           FROM events WHERE source_record_id = 'long.md' ORDER BY accepted_at, event_id`,
      )
      .all();
    // The page's body is the text after the frontmatter, newline included.
    expect(rows).toEqual([
      { chars: body.length + 1, marked: null },
      { chars: body.length + 1, marked: 1 },
    ]);
  } finally {
    db.close();
  }

  const settled = h.runCli(setup.env, "sync", "import-legacy-wiki", "--vault", setup.vault);
  expect(settled.exitCode).toBe(0);
  expect(settled.stdout).toContain("events_stored=0");
  expect(settled.stdout).toContain("duplicates=0");
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
