import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listConnections, setSourceGrant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const h = createHelpers();
afterEach(h.cleanup);

const page = (label: string | null, body: string) =>
  `---\ntitle: Note\ntype: Person\n${label === null ? "" : `sensitivity: ${label}\n`}---\n${body}\n`;

function enroll() {
  const setup = h.tempVault();
  const wiki = join(setup.root, "wiki");
  mkdirSync(join(wiki, "06-execution"), { recursive: true });
  writeFileSync(
    join(wiki, "kizuki-mapping.json"),
    JSON.stringify({
      schema: "kizuki.legacy-wiki-mapping/v1",
      type: { field: "type", values: { Person: "person" }, default: "topic" },
      sensitivity: { field: "sensitivity", values: {}, default: "private" },
      ignore: [],
    }),
  );
  writeFileSync(join(wiki, "open.md"), page("personal", "The lapis lantern is in the library."));
  writeFileSync(join(wiki, "closed.md"), page("private", "The amber key is in the attic."));
  writeFileSync(join(wiki, "unmarked.md"), page(null, "The jade bell is in the hall."));
  writeFileSync(join(wiki, "broken.md"), "---\ntitle: [unclosed\nsensitivity: personal\n---\nThe onyx ring is in the vault.\n");
  writeFileSync(join(wiki, "06-execution", "run.md"), page("personal", "Build 41 finished with no errors."));
  writeFileSync(join(wiki, "secret.md"), page("personal", "The deploy password = hunter2hunter2 stays in the shed."));
  const connected = h.runCli(setup.env, "connect", "import-legacy-wiki", "--source", wiki, "--vault", setup.vault);
  expect(connected.exitCode).toBe(0);
  return { ...setup, wiki };
}

function grant(vault: string, policy: Record<string, unknown>) {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const key = listConnections(db)[0]!.source_key;
    setSourceGrant(db, {
      source_key: key,
      expected_revision: 0,
      operation_id: "wiki-grant",
      policy: {
        purposes: ["capture", "recall"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        ...policy,
      },
    });
  } finally {
    db.close();
  }
}

function stored(vault: string) {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    const tiers = Object.fromEntries(
      db
        .query<{ id: string; tier: string }, []>("SELECT source_record_id AS id, sensitivity_hint AS tier FROM events")
        .all()
        .map((row) => [row.id, row.tier]),
    );
    const classes = Object.fromEntries(
      db
        .query<{ id: string; classes: string }, []>(
          `SELECT e.source_record_id AS id, group_concat(c.class) AS classes
             FROM events e JOIN event_classes c ON c.event_id = e.event_id GROUP BY e.source_record_id`,
        )
        .all()
        .map((row) => [row.id, row.classes]),
    );
    return { tiers, classes };
  } finally {
    db.close();
  }
}

function sync(setup: ReturnType<typeof enroll>) {
  const result = h.runCli(setup.env, "sync", "import-legacy-wiki", "--vault", setup.vault);
  expect(result.stderr).not.toContain("error:");
  expect(result.exitCode).toBe(0);
}

test("without sensitivity_default a consented wiki stays private however its pages are labelled", () => {
  const setup = enroll();
  grant(setup.vault, { sensitivity_floor: "private" });
  sync(setup);
  expect(Object.values(stored(setup.vault).tiers).every((tier) => tier === "private")).toBe(true);
});

test("with sensitivity_default the mapped labels decide the tier and everything else stays private", () => {
  const setup = enroll();
  grant(setup.vault, {
    sensitivity_floor: "personal",
    sensitivity_default: "personal",
    class_rules: [{ path_glob: "06-execution/**", class: "machine_exhaust" }],
  });
  sync(setup);
  const { tiers, classes } = stored(setup.vault);
  expect(tiers).toEqual({
    "open.md": "personal",
    "closed.md": "private",
    "unmarked.md": "private",
    "broken.md": "private",
    "06-execution/run.md": "personal",
    "secret.md": "personal",
  });
  expect(classes).toEqual({
    "06-execution/run.md": "machine_exhaust",
    "secret.md": "credential",
  });
});
