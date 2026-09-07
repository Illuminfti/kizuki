import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { registerConnection, setSourceGrant } from "../../src/index";
import { openLedger } from "../../src/ledger/db";
import { accept, count, readSince } from "../../src/ledger/ledger";
import {
  PURGE_PREVIEW_ID_LIMIT,
  PurgeError,
  type PurgeErrorCode,
  type PurgeFilter,
  previewPurge,
  purgeEvents,
  setAfterCanonSnapshot,
} from "../../src/ledger/purge";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";

const fixtures: Array<{ dispose(): void }> = [];
const SUBJECT = "local:42";
const CONNECTOR = "kizuki.subject-fixture";

function fixture() {
  const disk = tempVault("kizuki-subject-scope-");
  const db = openLedger(":memory:");
  fixtures.push({ dispose() { db.close(); disk.dispose(); } });
  return { db, vault: disk.path };
}

function source(db: Database, connector = CONNECTOR): string {
  const key = ulid();
  registerConnection(db, connector, key);
  setSourceGrant(db, {
    source_key: key,
    expected_revision: 0,
    operation_id: `grant-${key}`,
    policy: {
      purposes: ["capture", "recall"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "private",
    },
  });
  return key;
}

function store(db: Database, record: string, options: {
  connector?: string; source?: string; subject?: string;
} = {}) {
  const result = accept(db, {
    ...validEvent(),
    connector_id: options.connector ?? CONNECTOR,
    source_record_id: record,
    subjects: [{ subject_id: options.subject ?? SUBJECT, role: "about" }],
    text: `Synthetic evidence ${record}`,
  }, options.source === undefined ? {} : {
    source: { source_key: options.source, expected_revision: 1 },
  });
  if (result.status !== "stored") throw new Error(`fixture event was not stored: ${result.status}`);
  return result.event.event_id;
}

function expectRefusal(operation: () => unknown, code: PurgeErrorCode): void {
  let failure: unknown;
  try { operation(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PurgeError);
  expect((failure as PurgeError).code).toBe(code);
}

function expectUnchanged(db: Database, ids: string[]): void {
  expect(readSince(db, null, 100).events.map(event => event.event_id).sort()).toEqual([...ids].sort());
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM event_purges").get()?.n).toBe(0);
}

afterEach(() => {
  setAfterCanonSnapshot();
  for (const item of fixtures.splice(0)) item.dispose();
});

describe("raw subject purge scope", () => {
  test("legacy unbound selection keeps the same raw id in another connector", () => {
    const { db, vault } = fixture();
    const selected = store(db, "selected");
    const otherSource = source(db, "kizuki.other-fixture");
    const retained = store(db, "retained", { connector: "kizuki.other-fixture", source: otherSource });
    const filter = { connector_id: CONNECTOR, subject_handle: SUBJECT };

    const preview = previewPurge(db, vault, filter, "synthetic subject request");
    expect(preview.filter).toEqual(filter);
    expect(preview.event_ids).toEqual([selected]);
    expect(preview.connector_ids).toEqual([CONNECTOR]);
    expectUnchanged(db, [selected, retained]);
    const outcome = purgeEvents(db, vault, filter, "synthetic subject request");
    expect(outcome.receipts.map(receipt => receipt.event_id)).toEqual(preview.event_ids);
    expect(readSince(db, null, 10).events.map(event => event.event_id)).toEqual([retained]);
  });

  test("complete connector, source and raw subject selection isolates every namespace", () => {
    const { db, vault } = fixture();
    const first = source(db);
    const second = source(db);
    const other = source(db, "kizuki.other-fixture");
    const selected = store(db, "first-account", { source: first });
    const kept = [
      store(db, "second-account", { source: second }),
      store(db, "other-connector", { source: other, connector: "kizuki.other-fixture" }),
      store(db, "other-subject", { source: first, subject: "local:43" }),
      store(db, "legacy-unbound"),
    ];
    const filter = { connector_id: CONNECTOR, subject_handle: SUBJECT, source_key: first };

    const preview = previewPurge(db, vault, filter, "synthetic subject request");
    expect(preview.filter).toEqual(filter);
    expect(preview.event_ids).toEqual([selected]);
    expect(preview.event_count).toBe(1);
    expectUnchanged(db, [selected, ...kept]);
    const outcome = purgeEvents(db, vault, filter, "synthetic subject request");
    expect(outcome.receipts.map(receipt => receipt.event_id)).toEqual([selected]);
    expect(readSince(db, null, 10).events.map(event => event.event_id).sort()).toEqual(kept.sort());
  });

  test("bare subject ids refuse planning and deletion without guessing a namespace", () => {
    const { db, vault } = fixture();
    const ids = [store(db, "first"), store(db, "second", { connector: "kizuki.other-fixture" })];
    const filter = { subject_handle: SUBJECT };
    expectRefusal(() => previewPurge(db, vault, filter, "synthetic request"), "subject_namespace_required");
    expectRefusal(() => purgeEvents(db, vault, filter, "synthetic request"), "subject_namespace_required");
    expectUnchanged(db, ids);
  });

  test("source-bound evidence requires an explicit source even when only one source matches", () => {
    const { db, vault } = fixture();
    const key = source(db);
    const ids = [store(db, "legacy"), store(db, "managed", { source: key })];
    const filter = { connector_id: CONNECTOR, subject_handle: SUBJECT };
    expectRefusal(() => previewPurge(db, vault, filter, "synthetic request"), "subject_source_required");
    expectRefusal(() => purgeEvents(db, vault, filter, "synthetic request"), "subject_source_required");
    expectUnchanged(db, ids);
  });

  test("source requirements inspect candidates beyond the bounded preview ids", () => {
    const { db, vault } = fixture();
    const ids = Array.from({ length: PURGE_PREVIEW_ID_LIMIT + 1 }, (_, index) => store(db, `legacy-${index}`));
    ids.push(store(db, "managed", { source: source(db) }));
    const filter = { connector_id: CONNECTOR, subject_handle: SUBJECT };
    expectRefusal(() => previewPurge(db, vault, filter, "synthetic request"), "subject_source_required");
    expectRefusal(() => purgeEvents(db, vault, filter, "synthetic request"), "subject_source_required");
    expectUnchanged(db, ids);
  });

  test("selection rechecks newly stored source-bound evidence inside the deletion transaction", () => {
    const { db, vault } = fixture();
    const ids = [store(db, "legacy")];
    const key = source(db);
    setAfterCanonSnapshot(() => { ids.push(store(db, "new-managed", { source: key })); });
    expectRefusal(() => purgeEvents(db, vault, {
      connector_id: CONNECTOR, subject_handle: SUBJECT,
    }, "synthetic request"), "subject_source_required");
    expectUnchanged(db, ids);
  });

  test("an explicit source never widens a different connector or raw subject", () => {
    const { db, vault } = fixture();
    const key = source(db);
    const id = store(db, "managed", { source: key });
    for (const filter of [
      { connector_id: "kizuki.other-fixture", subject_handle: SUBJECT, source_key: key },
      { connector_id: CONNECTOR, subject_handle: "local:43", source_key: key },
    ]) {
      expect(previewPurge(db, vault, filter, "synthetic request").event_count).toBe(0);
      expect(purgeEvents(db, vault, filter, "synthetic request", { allow_empty: true }).receipts).toEqual([]);
    }
    expectUnchanged(db, [id]);
  });

  test("alias expansion stays unavailable for a complete namespaced selector", () => {
    const { db, vault } = fixture();
    const key = source(db);
    const id = store(db, "managed", { source: key });
    const filter = { connector_id: CONNECTOR, subject_handle: SUBJECT, source_key: key };
    expectRefusal(() => previewPurge(db, vault, filter, "synthetic request", { include_aliases: true }), "identity_unsupported");
    expectRefusal(() => purgeEvents(db, vault, filter, "synthetic request", { include_aliases: true }), "identity_unsupported");
    expectUnchanged(db, [id]);
  });

  test("invalid subject scope refuses without changing stored evidence", () => {
    const { db, vault } = fixture();
    store(db, "legacy");
    for (const filter of [
      { connector_id: CONNECTOR, subject_handle: "" },
      { connector_id: "", subject_handle: SUBJECT },
      { connector_id: CONNECTOR, subject_handle: SUBJECT, source_key: "not-a-source-key" },
    ] satisfies PurgeFilter[]) {
      expectRefusal(() => previewPurge(db, vault, filter, "synthetic request"), "invalid_filter");
    }
    expect(count(db)).toBe(1);
  });
});
