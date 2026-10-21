import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type {
  Connector,
  HealthReport,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "../../src/contracts/connector";
import type { CaptureEventInput } from "../../src/contracts/event";
import { openLedger } from "../../src/ledger/db";
import { registerConnection } from "../../src/ledger/connections";
import { readSince } from "../../src/ledger/ledger";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { runBackfill } from "../../src/ingest/run";
import { insertClaim } from "../../src/claims/store";
import { policyForConnector } from "../../src/sensitivity/policy";
import {
  applyConnectionSensitivity,
  getConnectorSensitivity,
  labelClaimSensitivity,
} from "../../src/sensitivity/store";
import { claimInput, eventFacts } from "../claims/helpers";
import { validEvent } from "../fixtures";

const WIKI = "kizuki.import-legacy-wiki";
const SOURCE_A = "01JJ0000000000000000000011";
const SOURCE_B = "01JJ0000000000000000000012";

class FixtureConnector implements Connector {
  constructor(
    private readonly connectorId: string,
    private readonly events: CaptureEventInput[],
  ) {}

  manifest(): Manifest {
    return {
      schema: "kizuki.connector/v1",
      connector_id: this.connectorId,
      version: "1.0.0",
      kinds: ["page"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: true,
        purge: true,
        fixture: true,
      },
      required_secrets: [],
      emits_sensitivity_hint: true,
      ...policyForConnector(this.connectorId),
      auth_modes: ["none"],
    };
  }

  health(): Promise<HealthReport> {
    return Promise.reject(new Error("unused"));
  }
  connect(_resolve: SecretResolver): Promise<void> {
    return Promise.resolve();
  }
  backfill(_cursor: string | null): Promise<SyncBatch> {
    return Promise.resolve({ events: this.events, cursor: null });
  }
  sync(_cursor: string | null): Promise<SyncBatch> {
    return Promise.resolve({ events: this.events, cursor: null });
  }
  revoke(): Promise<void> {
    return Promise.resolve();
  }
  purgeSource(_subjectId: string): Promise<PurgePlan> {
    return Promise.resolve({
      subject_id: "subject",
      source_record_ids: [],
      unreachable_source_record_ids: [],
    });
  }
  fixture(): Promise<CaptureEventInput[]> {
    return Promise.resolve(this.events);
  }
}

function page(
  id: string,
  hint: "personal" | "private" | undefined,
): CaptureEventInput {
  const event: CaptureEventInput = {
    ...validEvent(),
    connector_id: WIKI,
    source_record_id: id,
    kind: "page",
    text: `synthetic page ${id}`,
    attachments: [],
    metadata: {},
  };
  if (hint === undefined) delete event.sensitivity_hint;
  else event.sensitivity_hint = hint;
  return event;
}

function policy(extra: Record<string, unknown> = {}, floor = "personal") {
  return {
    purposes: ["capture", "recall", "derive"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked",
    egress: "local_only",
    sensitivity_floor: floor,
    ...extra,
  };
}

function enroll(db: Database, sourceKey: string, connectorId = WIKI): void {
  const connection = registerConnection(db, connectorId, sourceKey);
  applyConnectionSensitivity(db, connection, policyForConnector(connectorId));
}

function grant(
  db: Database,
  sourceKey: string,
  revision: number,
  policyValue: unknown,
  id: string,
): void {
  setSourceGrant(db, {
    source_key: sourceKey,
    expected_revision: revision,
    operation_id: id,
    policy: policyValue,
  });
}

function tiers(db: Database): Record<string, string | null | undefined> {
  return Object.fromEntries(
    readSince(db, null, 50).events.map((event) => [
      event.source_record_id,
      event.sensitivity_hint,
    ]),
  );
}

const PAGES = [
  page("labelled-personal.md", "personal"),
  page("labelled-private.md", "private"),
  page("unlabelled.md", undefined),
];

describe("owner-attested importer labels", () => {
  test("without sensitivity_default every page stays private, as before", async () => {
    const db = openLedger(":memory:");
    enroll(db, SOURCE_A);
    grant(db, SOURCE_A, 0, policy(), "grant-plain");
    const result = await runBackfill(
      db,
      new FixtureConnector(WIKI, PAGES),
      WIKI,
      SOURCE_A,
    );
    expect(result.errors).toEqual([]);
    expect(tiers(db)).toEqual({
      "labelled-personal.md": "private",
      "labelled-private.md": "private",
      "unlabelled.md": "private",
    });
    db.close();
  });

  test("after a regrant with sensitivity_default the labelled page is personal and the rest stay private", async () => {
    const db = openLedger(":memory:");
    enroll(db, SOURCE_A);
    grant(db, SOURCE_A, 0, policy(), "grant-plain");
    grant(
      db,
      SOURCE_A,
      1,
      policy({ sensitivity_default: "personal" }),
      "grant-labels",
    );
    expect(getConnectorSensitivity(db, WIKI, SOURCE_A)).toMatchObject({
      default_sensitivity: "personal",
      floor: "personal",
      set_by: "grant",
    });
    const result = await runBackfill(
      db,
      new FixtureConnector(WIKI, PAGES),
      WIKI,
      SOURCE_A,
    );
    expect(result.errors).toEqual([]);
    expect(tiers(db)).toEqual({
      "labelled-personal.md": "personal",
      "labelled-private.md": "private",
      // The importer reports a page it cannot read as private; an event that
      // arrives with no label at all is unknown, and unknown is private.
      "unlabelled.md": "private",
    });
    db.close();
  });

  test("a regrant that leaves sensitivity_default out takes the labels away again", () => {
    const db = openLedger(":memory:");
    enroll(db, SOURCE_A);
    grant(
      db,
      SOURCE_A,
      0,
      policy({ sensitivity_default: "personal" }),
      "grant-labels",
    );
    grant(db, SOURCE_A, 1, policy(), "grant-plain");
    expect(getConnectorSensitivity(db, WIKI, SOURCE_A)).toMatchObject({
      default_sensitivity: "private",
      set_by: "manifest",
    });
    db.close();
  });

  test("the default may not be below the connector floor or set on a connector that is not owner-mapped", () => {
    const db = openLedger(":memory:");
    enroll(db, SOURCE_A);
    expect(() =>
      grant(
        db,
        SOURCE_A,
        0,
        policy({ sensitivity_default: "public" }, "public"),
        "grant-public",
      ),
    ).toThrow("sensitivity_default_below_floor");
    expect(() =>
      grant(
        db,
        SOURCE_A,
        0,
        policy({ sensitivity_default: "bogus" }),
        "grant-bogus",
      ),
    ).toThrow("invalid_source_policy");

    enroll(db, SOURCE_B, "kizuki.markdown-folder");
    expect(() =>
      grant(
        db,
        SOURCE_B,
        0,
        policy({ sensitivity_default: "personal" }),
        "grant-folder",
      ),
    ).toThrow("invalid_source_policy");
    db.close();
  });

  test("a refused regrant leaves the connection default alone", () => {
    const db = openLedger(":memory:");
    enroll(db, SOURCE_A);
    expect(() =>
      grant(
        db,
        SOURCE_A,
        0,
        policy({ sensitivity_default: "public" }, "public"),
        "grant-public",
      ),
    ).toThrow();
    expect(
      getConnectorSensitivity(db, WIKI, SOURCE_A)?.default_sensitivity,
    ).toBe("private");
    db.close();
  });
});

describe("claims take their tier from their own sources", () => {
  async function twoSources() {
    const db = openLedger(":memory:");
    enroll(db, SOURCE_A);
    enroll(db, SOURCE_B);
    grant(
      db,
      SOURCE_A,
      0,
      policy({ sensitivity_default: "personal" }),
      "grant-a",
    );
    grant(db, SOURCE_B, 0, policy(), "grant-b");
    await runBackfill(
      db,
      new FixtureConnector(WIKI, [page("a.md", "personal")]),
      WIKI,
      SOURCE_A,
    );
    await runBackfill(
      db,
      new FixtureConnector(WIKI, [page("b.md", "personal")]),
      WIKI,
      SOURCE_B,
    );
    const byRecord = Object.fromEntries(
      readSince(db, null, 10).events.map((event) => [
        event.source_record_id,
        event.event_id,
      ]),
    );
    return { db, a: byRecord["a.md"]!, b: byRecord["b.md"]! };
  }

  test("one private source no longer raises the claims of another source of the same connector", async () => {
    const { db, a, b } = await twoSources();
    const label = (ids: string[]) =>
      labelClaimSensitivity(db, {
        events: ids.map((event_id) => ({ event_id, connector_id: WIKI })),
        event_hints: ids.map(
          (id) =>
            readSince(db, null, 10).events.find((e) => e.event_id === id)
              ?.sensitivity_hint,
        ),
      }).sensitivity;
    expect(label([a])).toBe("personal");
    expect(label([b])).toBe("private");
    expect(label([a, b])).toBe("private");
    db.close();
  });

  test("insertClaim labels a claim citing only the personal source as personal", async () => {
    const { db, a } = await twoSources();
    const stored = await insertClaim(
      { db },
      claimInput(a, {
        producer: "model",
        sensitivity: "personal",
        events: [eventFacts(a, { connector_id: WIKI })],
      }),
    );
    expect(stored.outcome).toBe("stored");
    if (stored.outcome !== "stored") return;
    expect(stored.claim.sensitivity).toBe("personal");
    db.close();
  });

  test("events with no source binding keep the connector-wide label", () => {
    const db = openLedger(":memory:");
    enroll(db, SOURCE_A);
    enroll(db, SOURCE_B);
    const label = labelClaimSensitivity(db, {
      events: [{ event_id: "01JJ0000000000000000000099", connector_id: WIKI }],
    });
    expect(label.sensitivity).toBe("private");
    db.close();
  });
});
