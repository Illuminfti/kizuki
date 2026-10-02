import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAgent, authenticate } from "../../src/agents";
import { exportVault, restoreVault } from "../../src/export";
import { initVault } from "../../src/vault/init";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import {
  credentialShaped,
  classesOfEvents,
  backfillCredentialClasses,
  restampSourceClasses,
} from "../../src/ledger/event-classes";
import { registerConnection } from "../../src/ledger/connections";
import { accept } from "../../src/ledger/ledger";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { tableColumns, tableExists } from "../../src/ledger/schema";
import { validEvent } from "../fixtures";

const SOURCE = "01JJ0000000000000000000021";
const CONNECTOR = "kizuki.import-legacy-wiki";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function policy(extra: Record<string, unknown> = {}) {
  return {
    purposes: ["capture", "recall", "derive"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked",
    egress: "local_only",
    sensitivity_floor: "personal",
    ...extra,
  };
}

function store(
  db: Database,
  recordId: string,
  text: string,
  metadata: Record<string, unknown> = {},
): string {
  const stored = accept(
    db,
    {
      ...validEvent(),
      connector_id: CONNECTOR,
      source_record_id: recordId,
      kind: "page",
      text,
      attachments: [],
      metadata,
    },
    { source: { source_key: SOURCE, expected_revision: revisionOf(db) } },
  );
  if (stored.status !== "stored")
    throw new Error(`fixture event ${recordId}: ${JSON.stringify(stored)}`);
  return stored.event.event_id;
}

function revisionOf(db: Database): number {
  return db
    .query<{ revision: number }, [string]>(
      "SELECT revision FROM source_grants WHERE source_key=?",
    )
    .get(SOURCE)!.revision;
}

function enroll(db: Database, extra: Record<string, unknown> = {}): void {
  registerConnection(db, CONNECTOR, SOURCE);
  setSourceGrant(db, {
    source_key: SOURCE,
    expected_revision: 0,
    operation_id: "grant-1",
    policy: policy(extra),
  });
}

function classesOf(db: Database, id: string): string[] {
  return classesOfEvents(db, [id]);
}

describe("credential class", () => {
  test("deep and wide accepted metadata stays protected through backfill and restamping", () => {
    const db = openLedger(":memory:");
    try {
      enroll(db);
      const deep = { a: { b: { c: { d: { password: "synthetic-canary-482" } } } } };
      const wide = { values: Array.from({ length: 1_024 }, () => "a clean note"), password: "synthetic-canary-483" };
      const keyed = { ["password=" + "synthetic-canary-484"]: {} };
      for (const [name, metadata] of Object.entries({ deep, wide, keyed })) {
        const id = store(db, name, "a clean note", metadata);
        const original = db.query("SELECT content_hash FROM events WHERE event_id = ?").get(id);
        expect(classesOf(db, id)).toEqual(["credential"]);
        db.exec("DELETE FROM event_classes");
        backfillCredentialClasses(db);
        expect(classesOf(db, id)).toEqual(["credential"]);
        restampSourceClasses(db, SOURCE, []);
        expect(classesOf(db, id)).toEqual(["credential"]);
        expect(db.query("SELECT content_hash FROM events WHERE event_id = ?").get(id)).toEqual(original);
      }
    } finally { db.close(); }
  });

  test("the shared secret patterns mark text and metadata, and nothing else", () => {
    expect(credentialShaped("the deploy password = hunter2hunter2", {})).toBe(
      true,
    );
    expect(credentialShaped("Authorization: Bearer abcdef123456", {})).toBe(
      true,
    );
    expect(
      credentialShaped(
        `-----BEGIN ${"PRIVATE"} KEY-----\nabc\n-----END ${"PRIVATE"} KEY-----`,
        {},
      ),
    ).toBe(true);
    expect(
      credentialShaped("a note about kettles", {
        api_key: "sk-abcdefghijklmnopqrstuvwx",
      }),
    ).toBe(true);
    expect(
      credentialShaped("a note about kettles", {
        relpath: "notes/kettles.md",
        size: 12,
      }),
    ).toBe(false);
    expect(credentialShaped("the password reset page was redesigned", {})).toBe(
      false,
    );
    expect(credentialShaped("a clean note", { password: 123456 })).toBe(true);
  });

  test("capture stamps a credential-shaped event and leaves the event revision alone", () => {
    const db = openLedger(":memory:");
    const plain = accept(db, {
      ...validEvent(),
      source_record_id: "plain",
      text: "kettle notes",
    });
    const secret = accept(db, {
      ...validEvent(),
      source_record_id: "secret",
      text: "the deploy password = hunter2hunter2",
    });
    if (plain.status !== "stored" || secret.status !== "stored")
      throw new Error("fixture");
    expect(classesOf(db, plain.event.event_id)).toEqual([]);
    expect(classesOf(db, secret.event.event_id)).toEqual(["credential"]);
    // The stamp sits beside the event: capturing the same secret again is a duplicate.
    expect(
      accept(db, {
        ...validEvent(),
        source_record_id: "secret",
        text: "the deploy password = hunter2hunter2",
      }).status,
    ).toBe("duplicate");
    db.close();
  });

  test("deleting an event deletes its class rows", () => {
    const db = openLedger(":memory:");
    const secret = accept(db, {
      ...validEvent(),
      text: "the deploy password = hunter2hunter2",
    });
    if (secret.status !== "stored") throw new Error("fixture");
    db.query("DELETE FROM events WHERE event_id = ?").run(
      secret.event.event_id,
    );
    expect(db.query("SELECT 1 FROM event_classes").get()).toBeNull();
    db.close();
  });
});

describe("owner-declared class rules", () => {
  test("a matching path is stamped machine_exhaust at capture, on the source record or the recorded path", () => {
    const db = openLedger(":memory:");
    enroll(db, {
      class_rules: [{ path_glob: "06-execution/**", class: "machine_exhaust" }],
    });
    const run = store(db, "06-execution/run-1.md", "build finished");
    const viaMetadata = store(db, "row-7", "log line", {
      relpath: "06-execution/logs/x.md",
    });
    const note = store(db, "notes/kettle.md", "a note");
    expect(classesOf(db, run)).toEqual(["machine_exhaust"]);
    expect(classesOf(db, viaMetadata)).toEqual(["machine_exhaust"]);
    expect(classesOf(db, note)).toEqual([]);
    db.close();
  });

  test("a regrant restamps the source's events and keeps the content class", () => {
    const db = openLedger(":memory:");
    enroll(db, {
      class_rules: [{ path_glob: "06-execution/**", class: "machine_exhaust" }],
    });
    const run = store(db, "06-execution/run-1.md", "build finished");
    const note = store(db, "notes/kettle.md", "a note");
    const secretRun = store(
      db,
      "06-execution/secret.md",
      "the deploy password = hunter2hunter2",
    );
    expect(classesOf(db, secretRun)).toEqual(["credential", "machine_exhaust"]);

    setSourceGrant(db, {
      source_key: SOURCE,
      expected_revision: 1,
      operation_id: "grant-2",
      policy: policy({
        class_rules: [{ path_glob: "notes/**", class: "machine_exhaust" }],
      }),
    });
    expect(classesOf(db, run)).toEqual([]);
    expect(classesOf(db, note)).toEqual(["machine_exhaust"]);
    expect(classesOf(db, secretRun)).toEqual(["credential"]);

    setSourceGrant(db, {
      source_key: SOURCE,
      expected_revision: 2,
      operation_id: "grant-3",
      policy: policy(),
    });
    expect(classesOf(db, note)).toEqual([]);
    expect(classesOf(db, secretRun)).toEqual(["credential"]);
    db.close();
  });

  test("malformed rules are refused and change nothing", () => {
    const db = openLedger(":memory:");
    registerConnection(db, CONNECTOR, SOURCE);
    const bad = [
      [{ path_glob: "a/**", class: "public" }],
      [{ path_glob: "/etc/**", class: "machine_exhaust" }],
      [{ path_glob: "../x", class: "machine_exhaust" }],
      [{ path_glob: "", class: "machine_exhaust" }],
      [{ path_glob: "a/**", class: "machine_exhaust", extra: 1 }],
      [
        { path_glob: "a/**", class: "machine_exhaust" },
        { path_glob: "a/**", class: "machine_exhaust" },
      ],
      [],
      "a/**",
    ];
    for (const [index, class_rules] of bad.entries()) {
      expect(() =>
        setSourceGrant(db, {
          source_key: SOURCE,
          expected_revision: 0,
          operation_id: `bad-${index}`,
          policy: policy({ class_rules }),
        }),
      ).toThrow("invalid_source_policy");
    }
    expect(db.query("SELECT 1 FROM source_grants").get()).toBeNull();
    db.close();
  });

  test("a policy without class rules or a default reads back exactly as before", () => {
    const db = openLedger(":memory:");
    enroll(db);
    const stored = db
      .query<{ policy: string }, []>("SELECT policy FROM source_grants")
      .get()!.policy;
    expect(Object.keys(JSON.parse(stored) as object).sort()).toEqual([
      "allowed_fields",
      "egress",
      "purposes",
      "retention",
      "sensitivity_floor",
    ]);
    db.close();
  });
});

describe("restore", () => {
  test("classes are recomputed from the restored events and source rules", () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-classes-restore-"));
    dirs.push(vault);
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    try {
      enroll(db, {
        purposes: ["capture", "recall", "derive", "export"],
        class_rules: [{ path_glob: "06-execution/**", class: "machine_exhaust" }],
      });
      const run = store(db, "06-execution/run-1.md", "build finished");
      const secret = store(db, "notes/secret.md", "the deploy password = hunter2hunter2");
      const note = store(db, "notes/kettle.md", "a note");
      const backup = join(vault, "..", `${SOURCE}-backup`);
      const restored = join(vault, "..", `${SOURCE}-restored`);
      dirs.push(backup, restored);
      exportVault(db, vault, backup);
      restoreVault(backup, restored);
      const copy = openLedger(join(restored, ".kizuki", "kizuki.db"));
      try {
        expect(classesOf(copy, run)).toEqual(["machine_exhaust"]);
        expect(classesOf(copy, secret)).toEqual(["credential"]);
        expect(classesOf(copy, note)).toEqual([]);
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  });
});

describe("class migration", () => {
  test("upgrading from the previous version adds the table and the grant column, stamps stored events and keeps grants", () => {
    const dir = mkdtempSync(join(tmpdir(), "kizuki-classes-migration-"));
    dirs.push(dir);
    const path = join(dir, "ledger.sqlite");
    const first = openLedger(path);
    const secret = accept(first, {
      ...validEvent(),
      source_record_id: "secret",
      text: "api_key = sk-abcdefghijklmnopqrstuvwx",
    });
    const plain = accept(first, {
      ...validEvent(),
      source_record_id: "plain",
      text: "kettle notes",
    });
    const nested = accept(first, {
      ...validEvent(), source_record_id: "nested", text: "a clean note",
      metadata: { a: { b: { c: { d: { password: "synthetic-canary-482" } } } } },
    });
    const wide = accept(first, {
      ...validEvent(), source_record_id: "wide", text: "a clean note",
      metadata: { values: Array.from({ length: 1_024 }, () => "a clean note"), password: "synthetic-canary-483" },
    });
    if (secret.status !== "stored" || plain.status !== "stored")
      throw new Error("fixture");
    if (nested.status !== "stored" || wide.status !== "stored") throw new Error("fixture metadata");
    const agent = addAgent(first, "older-agent", {
      ceiling: "private",
      tools: ["search"],
    });
    first.exec("DROP TABLE event_classes");
    first.exec("ALTER TABLE agent_grants DROP COLUMN deny_classes");
    first.query("UPDATE schema_version SET version = ?").run(LEDGER_SCHEMA_VERSION - 1);
    first.close();

    const upgraded = openLedger(path);
    try {
      expect(tableExists(upgraded, "event_classes")).toBe(true);
      expect(tableColumns(upgraded, "agent_grants")).toContain("deny_classes");
      expect(classesOf(upgraded, secret.event.event_id)).toEqual([
        "credential",
      ]);
      expect(classesOf(upgraded, plain.event.event_id)).toEqual([]);
      expect(classesOf(upgraded, nested.event.event_id)).toEqual(["credential"]);
      expect(classesOf(upgraded, wide.event.event_id)).toEqual(["credential"]);
      const principal = authenticate(upgraded, agent.token);
      expect(principal?.grant.ceiling).toBe("private");
      // Nothing was written into the old grant: it takes the default denial.
      expect(principal?.grant.deny_classes).toBeUndefined();
      expect(
        upgraded.query("SELECT deny_classes FROM agent_grants").get(),
      ).toEqual({ deny_classes: null });
    } finally {
      upgraded.close();
    }
  });

  test("a fresh ledger has the table and the column", () => {
    const fresh = openLedger(":memory:");
    expect(tableExists(fresh, "event_classes")).toBe(true);
    expect(tableColumns(fresh, "agent_grants")).toContain("deny_classes");
    fresh.close();
  });
});
