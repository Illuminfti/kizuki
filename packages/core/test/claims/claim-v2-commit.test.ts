import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { CLAIM_V2_SCHEMA } from "../../src/contracts/claim-v2";
import type { SensitivityHint } from "../../src/contracts/event";
import { CLAIM_SCHEMA } from "../../src/contracts/proposal";
import {
  commitClaimV2,
  readClaimRecord,
  readClaimV2Semantic,
} from "../../src/claims/claim-v2-commit";
import type { ClaimV2SupportAdmission } from "../../src/claims/claim-v2-commit";
import { ClaimError } from "../../src/claims/errors";
import { getClaim, prepareClaimInsert } from "../../src/claims/store";
import { registerConnection } from "../../src/ledger/connections";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import type { SourceReadScope } from "../../src/ledger/source-grants";
import {
  revokeSourceGrant,
  setSourceGrant,
} from "../../src/ledger/source-grants";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";
import { claimInput, claimsDb } from "./helpers";

/** The writer admits evidence on behalf of a reader with an ordinary derive scope. */
const SCOPE: SourceReadScope = { owner: true, purpose: "derive" };

/** A consented source: enrolled connection plus an active grant at revision 1. */
function grantedSource(
  db: Database,
  floor: SensitivityHint = "personal",
  connectorId = "fixture",
): string {
  const sourceKey = ulid();
  registerConnection(db, connectorId, sourceKey);
  seedConnectorSensitivity(
    db,
    { connector_id: connectorId, source_key: sourceKey },
    { default_sensitivity: floor, sensitivity_floor: floor },
  );
  setSourceGrant(db, {
    source_key: sourceKey,
    expected_revision: 0,
    operation_id: `grant-${sourceKey}`,
    policy: {
      purposes: ["capture", "derive", "recall", "correction", "session"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: floor,
    },
  });
  return sourceKey;
}

function grantedEvent(
  db: Database,
  sourceKey: string,
  options: { revision?: number; connectorId?: string; text?: string } = {},
): string {
  const accepted = accept(
    db,
    {
      ...validEvent(),
      connector_id: options.connectorId ?? "fixture",
      source_record_id: `rec-${crypto.randomUUID()}`,
      text: options.text ?? "Grace runs partnerships at Acme.",
    },
    {
      source: {
        source_key: sourceKey,
        expected_revision: options.revision ?? 1,
      },
    },
  );
  if (accepted.status !== "stored") {
    throw new Error(`fixture event refused: ${JSON.stringify(accepted)}`);
  }
  return accepted.event.event_id;
}

/** One consented source with one event already admitted from it. */
function granted(db: Database, floor: SensitivityHint = "personal") {
  const sourceKey = grantedSource(db, floor);
  return { sourceKey, eventId: grantedEvent(db, sourceKey) };
}

function assertion(eventId: string): ClaimV2Assertion {
  return {
    schema: CLAIM_V2_SCHEMA,
    discriminator: "assertion",
    subject: { kind: "occurrence", id: "occ-grace" },
    predicate: "role.holds",
    object: { kind: "literal", value: "partnerships lead" },
    perspective: {
      holder: { kind: "occurrence", id: "occ-grace" },
      speaker: null,
      addressee: null,
      mode: "asserted",
      interpretation: "explicit",
      anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: 5 }],
    },
    context: [{ kind: "supplied", id: "ctx-work" }],
    polarity: "positive",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    temporal_basis: "explicit",
    anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: 12 }],
  };
}

function eventHash(db: Database, eventId: string): string {
  return db
    .query<{ content_hash: string }, [string]>(
      "SELECT content_hash FROM events WHERE event_id = ?",
    )
    .get(eventId)!.content_hash;
}

function supportFor(
  db: Database,
  sourceKey: string,
  eventId: string,
  anchors: ClaimV2Assertion["anchors"],
): ClaimV2SupportAdmission {
  const event_content_hash = eventHash(db, eventId);
  return {
    source_key: sourceKey,
    grant_revision: 1,
    events: [{ event_id: eventId, event_content_hash }],
    anchors,
    admission: { authority: "connector_evidence", confidence: 0.5 },
    admitted_at: "2026-01-01T00:00:00.000Z",
  };
}

function counts(db: Database, table: string): number {
  return db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
    .get()!.n;
}

test("commitClaimV2 refuses to run outside a transaction", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const stored = await prepareClaimInsert({ db }, claimInput(eventId));
    const applied = db.transaction(() => stored.apply()).immediate();
    expect(applied.outcome).toBe("stored");
    if (applied.outcome !== "stored") throw new Error("expected stored");
    const semantic = assertion(eventId);
    expect(() =>
      commitClaimV2(db, applied.claim.claim_id, {
        semantic,
        support: supportFor(db, sourceKey, eventId, semantic.anchors),
        scope: SCOPE,
      }),
    ).toThrow("prepared claim requires a transaction");
  } finally {
    db.close();
  }
});

test("the shared writer commits v2 children in the same transaction", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    const committed = db.transaction(() => {
      const stored = prepared.apply();
      if (stored.outcome !== "stored") throw new Error("expected stored");
      const v2 = commitClaimV2(db, stored.claim.claim_id, {
        semantic,
        support: supportFor(db, sourceKey, eventId, semantic.anchors),
        scope: SCOPE,
      });
      return { stored, v2 };
    }).immediate();

    expect(committed.v2.duplicate_support).toBe(false);
    expect(readClaimV2Semantic(db, committed.stored.claim.claim_id)).toEqual(
      semantic,
    );
    const record = readClaimRecord(db, committed.stored.claim.claim_id);
    expect(record?.schema).toBe(CLAIM_V2_SCHEMA);
    if (record?.schema !== CLAIM_V2_SCHEMA) throw new Error("expected v2");
    expect(record.semantic).toEqual(semantic);
    expect(record.claim.claim_id).toBe(committed.stored.claim.claim_id);
    expect(counts(db, "claim_v2_support")).toBe(1);
    expect(counts(db, "claim_v2_support_events")).toBe(1);
  } finally {
    db.close();
  }
});

test("duplicate support collides and does not add a second observation", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    const claimId = db.transaction(() => {
      const stored = prepared.apply();
      if (stored.outcome !== "stored") throw new Error("expected stored");
      const input = {
        semantic,
        support: supportFor(db, sourceKey, eventId, semantic.anchors),
        scope: SCOPE,
      };
      const first = commitClaimV2(db, stored.claim.claim_id, input);
      const second = commitClaimV2(db, stored.claim.claim_id, input);
      expect(first.duplicate_support).toBe(false);
      expect(second.duplicate_support).toBe(true);
      expect(second.support_key).toBe(first.support_key);
      return stored.claim.claim_id;
    }).immediate();
    expect(counts(db, "claim_v2_support")).toBe(1);
    expect(counts(db, "claim_v2_support_events")).toBe(1);
    expect(readClaimRecord(db, claimId)?.schema).toBe(CLAIM_V2_SCHEMA);
  } finally {
    db.close();
  }
});

/**
 * A duplicate is read as a row that is already there, never inferred from a
 * write that did not land: a refused support row must abort the commit instead
 * of reporting an already-recorded sighting whose evidence chain is empty.
 */
test("a support row the ledger refuses aborts the whole commit", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    db.exec(
      `CREATE TRIGGER refuse_support BEFORE INSERT ON claim_v2_support
       BEGIN SELECT RAISE(IGNORE); END;`,
    );
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic,
          support: supportFor(db, sourceKey, eventId, semantic.anchors),
          scope: SCOPE,
        });
      }).immediate(),
    ).toThrow(/refused by the ledger/);
    for (const table of [
      "claims",
      "claim_v2_semantics",
      "claim_v2_support",
      "claim_v2_support_events",
    ]) {
      expect({ table, rows: counts(db, table) }).toEqual({ table, rows: 0 });
    }
  } finally {
    db.close();
  }
});

test("a rejected v2 payload rolls back the shared claims write", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic: { schema: "kizuki.claim/v1" },
          support: supportFor(db, sourceKey, eventId, semantic.anchors),
          scope: SCOPE,
        });
      }).immediate(),
    ).toThrow(ClaimError);
    expect(counts(db, "claims")).toBe(0);
    expect(counts(db, "claim_v2_semantics")).toBe(0);
  } finally {
    db.close();
  }
});

test("a v1-only claim reads as the v1 discriminator", async () => {
  const db = claimsDb();
  try {
    const { eventId } = granted(db);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    const stored = db.transaction(() => prepared.apply()).immediate();
    expect(stored.outcome).toBe("stored");
    if (stored.outcome !== "stored") throw new Error("expected stored");
    expect(readClaimV2Semantic(db, stored.claim.claim_id)).toBeNull();
    const record = readClaimRecord(db, stored.claim.claim_id);
    expect(record).toEqual({ schema: CLAIM_SCHEMA, claim: stored.claim });
    expect(getClaim(db, stored.claim.claim_id)).toEqual(stored.claim);
    expect(readClaimRecord(db, "missing-claim")).toBeNull();
  } finally {
    db.close();
  }
});

test("support that cites a hash the ledger does not hold is refused", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic,
          support: {
            ...supportFor(db, sourceKey, eventId, semantic.anchors),
            events: [
              { event_id: eventId, event_content_hash: "a".repeat(64) },
            ],
          },
          scope: SCOPE,
        });
      }).immediate(),
    ).toThrow(/does not match the stored event/);
  } finally {
    db.close();
  }
});

test("support that cites an event the ledger does not hold is refused", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic,
          support: {
            ...supportFor(db, sourceKey, eventId, semantic.anchors),
            events: [
              {
                event_id: "evt-absent-from-ledger",
                event_content_hash: eventHash(db, eventId),
              },
            ],
            anchors: [],
          },
          scope: SCOPE,
        });
      }).immediate(),
    ).toThrow(/cites an unknown event/);
    expect(counts(db, "claims")).toBe(0);
    expect(counts(db, "claim_v2_support")).toBe(0);
  } finally {
    db.close();
  }
});

/**
 * `source_key` and `grant_revision` are the verified source identity at
 * admission, so evidence from one source must never be recorded as admitted
 * under another source's consent: the first source's revocation sweep is keyed
 * on `source_key` and would miss it.
 */
test("support that cites another source's event is refused", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const otherSource = grantedSource(db, "personal", "other-fixture");
    const otherEvent = grantedEvent(db, otherSource, {
      connectorId: "other-fixture",
    });
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic,
          support: {
            ...supportFor(db, sourceKey, eventId, semantic.anchors),
            events: [
              {
                event_id: otherEvent,
                event_content_hash: eventHash(db, otherEvent),
              },
            ],
            anchors: [{ event_id: otherEvent, start_utf16: 0, end_utf16: 4 }],
          },
          scope: SCOPE,
        });
      }).immediate(),
    ).toThrow(/its named source did not supply/);
    expect(counts(db, "claims")).toBe(0);
    expect(counts(db, "claim_v2_support")).toBe(0);
  } finally {
    db.close();
  }
});

/**
 * Anchors are the one part of an admission that names a location inside an
 * event, so an anchor on an event the support does not cite would publish that
 * event's id and its exact offsets under this claim's label while every
 * consent check runs on the cited events alone.
 */
test("support that anchors an event outside its cited set is refused", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const closedSource = grantedSource(db, "private", "closed-anchor-fixture");
    const closedEvent = grantedEvent(db, closedSource, {
      connectorId: "closed-anchor-fixture",
    });
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert(
      { db },
      claimInput(eventId, { sensitivity: "personal" }),
    );
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic,
          support: {
            ...supportFor(db, sourceKey, eventId, semantic.anchors),
            anchors: [
              { event_id: closedEvent, start_utf16: 0, end_utf16: 9 },
            ],
          },
          scope: SCOPE,
        });
      }).immediate(),
    ).toThrow(/anchors an event its support does not cite/);
    expect(counts(db, "claims")).toBe(0);
    expect(counts(db, "claim_v2_support")).toBe(0);
  } finally {
    db.close();
  }
});

test("support anchors pass the same guard the semantic's anchors pass", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    const malformed: unknown[] = [
      [{ event_id: eventId, start_utf16: 0.5, end_utf16: 4 }],
      [{ event_id: eventId, start_utf16: 4, end_utf16: 4 }],
      [{ event_id: eventId, start_utf16: -1, end_utf16: 4 }],
      [{ event_id: "not-a-ulid", start_utf16: 0, end_utf16: 4 }],
      [{ event_id: eventId, start_utf16: 0, end_utf16: 4, note: "extra" }],
      [
        { event_id: eventId, start_utf16: 0, end_utf16: 2 },
        { event_id: eventId, start_utf16: 0, end_utf16: 2 },
      ],
      Array.from({ length: 9 }, (_, index) => ({
        event_id: eventId,
        start_utf16: index,
        end_utf16: index + 1,
      })),
      "not an array",
    ];
    for (const anchors of malformed) {
      const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
      expect(() =>
        db.transaction(() => {
          const stored = prepared.apply();
          if (stored.outcome !== "stored") throw new Error("expected stored");
          commitClaimV2(db, stored.claim.claim_id, {
            semantic,
            support: {
              ...supportFor(db, sourceKey, eventId, semantic.anchors),
              anchors: anchors as ClaimV2Assertion["anchors"],
            },
            scope: SCOPE,
          });
        }).immediate(),
      ).toThrow(/needs well-formed anchors/);
      expect(counts(db, "claims")).toBe(0);
      expect(counts(db, "claim_v2_support")).toBe(0);
    }
  } finally {
    db.close();
  }
});

test("support naming a source with no grant is refused", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic,
          support: {
            ...supportFor(db, sourceKey, eventId, semantic.anchors),
            source_key: ulid(),
          },
          scope: SCOPE,
        });
      }).immediate(),
    ).toThrow(/its named source did not supply/);
    expect(counts(db, "claims")).toBe(0);
  } finally {
    db.close();
  }
});

test("support snapshotting a stale grant revision is refused", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    // The grant moves on; evidence admitted under revision 1 may not be
    // recorded as though the owner's current consent covered it.
    setSourceGrant(db, {
      source_key: sourceKey,
      expected_revision: 1,
      operation_id: `regrant-${sourceKey}`,
      policy: {
        purposes: ["capture", "derive", "recall", "correction", "session"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: "personal",
      },
    });
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic,
          support: supportFor(db, sourceKey, eventId, semantic.anchors),
          scope: SCOPE,
        });
      }).immediate(),
    ).toThrow(/live grant revision/);
    expect(counts(db, "claims")).toBe(0);
    expect(counts(db, "claim_v2_support")).toBe(0);
  } finally {
    db.close();
  }
});

test("support is refused once its source grant is revoked", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    revokeSourceGrant(db, {
      source_key: sourceKey,
      expected_revision: 1,
      operation_id: `revoke-${sourceKey}`,
    });
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic,
          support: supportFor(db, sourceKey, eventId, semantic.anchors),
          scope: SCOPE,
        });
      }).immediate(),
    ).toThrow();
    expect(counts(db, "claim_v2_support")).toBe(0);
  } finally {
    db.close();
  }
});

test("a caller scope the grant does not admit cannot record support", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
    expect(() =>
      db.transaction(() => {
        const stored = prepared.apply();
        if (stored.outcome !== "stored") throw new Error("expected stored");
        commitClaimV2(db, stored.claim.claim_id, {
          semantic,
          support: supportFor(db, sourceKey, eventId, semantic.anchors),
          scope: { owner: false, model: true, purpose: "extract" },
        });
      }).immediate(),
    ).toThrow(/source_access_denied/);
    expect(counts(db, "claims")).toBe(0);
    expect(counts(db, "claim_v2_support")).toBe(0);
  } finally {
    db.close();
  }
});

/**
 * Support can bind events the v1 provenance does not carry, and a by-event
 * index makes them reachable from the claim, so the claim's label has to
 * absorb their source floors or a reader filtered on `claims.sensitivity`
 * would expand evidence it is not cleared for.
 */
test("support events raise the claim's sensitivity label", async () => {
  const db = claimsDb();
  try {
    const openSource = grantedSource(db, "public");
    const eventId = grantedEvent(db, openSource);
    const closedSource = grantedSource(db, "private", "closed-fixture");
    const closedEvent = grantedEvent(db, closedSource, {
      connectorId: "closed-fixture",
    });
    const semantic = assertion(eventId);
    const prepared = await prepareClaimInsert(
      { db },
      claimInput(eventId, { sensitivity: "personal" }),
    );
    const claimId = db.transaction(() => {
      const stored = prepared.apply();
      if (stored.outcome !== "stored") throw new Error("expected stored");
      expect(stored.claim.sensitivity).toBe("personal");
      commitClaimV2(db, stored.claim.claim_id, {
        semantic,
        support: {
          ...supportFor(db, closedSource, closedEvent, [
            { event_id: closedEvent, start_utf16: 0, end_utf16: 5 },
          ]),
          source_key: closedSource,
        },
        scope: SCOPE,
      });
      return stored.claim.claim_id;
    }).immediate();
    expect(getClaim(db, claimId)?.sensitivity).toBe("private");
  } finally {
    db.close();
  }
});

test("an admission the snapshot bound rejects is refused", async () => {
  const db = claimsDb();
  try {
    const { sourceKey, eventId } = granted(db);
    const semantic = assertion(eventId);
    for (const admission of [
      undefined,
      "not an object",
      { note: "x".repeat(4096) },
      { deep: JSON.parse("[".repeat(32) + "]".repeat(32)) as unknown },
    ]) {
      const prepared = await prepareClaimInsert({ db }, claimInput(eventId));
      expect(() =>
        db.transaction(() => {
          const stored = prepared.apply();
          if (stored.outcome !== "stored") throw new Error("expected stored");
          commitClaimV2(db, stored.claim.claim_id, {
            semantic,
            support: {
              ...supportFor(db, sourceKey, eventId, semantic.anchors),
              admission,
            },
            scope: SCOPE,
          });
        }).immediate(),
      ).toThrow(/needs a valid admission/);
      expect(counts(db, "claims")).toBe(0);
      expect(counts(db, "claim_v2_semantics")).toBe(0);
      expect(counts(db, "claim_v2_support")).toBe(0);
    }
  } finally {
    db.close();
  }
});

/**
 * Crash point: the process dies after the claims row and its v2 semantics are
 * written but before the shared transaction commits. One writer, one
 * transaction, so recovery must leave neither half.
 */
test("an interrupted commit leaves neither a claims row nor v2 semantics", async () => {
  const vault = tempVault("claim-v2-commit-");
  try {
    const dbPath = join(vault.path, ".kizuki", "kizuki.db");
    const setup = openLedger(dbPath);
    let eventId: string;
    let support: ClaimV2SupportAdmission;
    let semantic: ClaimV2Assertion;
    try {
      const fixture = granted(setup);
      eventId = fixture.eventId;
      semantic = assertion(eventId);
      support = supportFor(setup, fixture.sourceKey, eventId, semantic.anchors);
    } finally {
      setup.close();
    }
    const script = `
      import { openLedger } from ${JSON.stringify(join(import.meta.dir, "../../src/ledger/db.ts"))};
      import { prepareClaimInsert } from ${JSON.stringify(join(import.meta.dir, "../../src/claims/store.ts"))};
      import { commitClaimV2 } from ${JSON.stringify(join(import.meta.dir, "../../src/claims/claim-v2-commit.ts"))};
      import { claimInput } from ${JSON.stringify(join(import.meta.dir, "helpers.ts"))};
      const db = openLedger(${JSON.stringify(dbPath)});
      const prepared = await prepareClaimInsert({ db }, claimInput(${JSON.stringify(eventId)}));
      db.exec("BEGIN IMMEDIATE");
      const stored = prepared.apply();
      if (stored.outcome !== "stored") throw new Error("expected stored");
      commitClaimV2(db, stored.claim.claim_id, {
        semantic: ${JSON.stringify(semantic)},
        support: ${JSON.stringify(support)},
        scope: ${JSON.stringify(SCOPE)},
      });
      process.stdout.write("uncommitted\\n");
      process.kill(process.pid, "SIGKILL");
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.stdout.toString()).toBe("uncommitted\n");
    expect(child.exitCode).not.toBe(0);

    const recovered = openLedger(dbPath);
    try {
      for (const table of [
        "claims",
        "claim_v2_semantics",
        "claim_v2_support",
        "claim_v2_support_events",
      ]) {
        expect({ table, rows: counts(recovered, table) }).toEqual({
          table,
          rows: 0,
        });
      }
      expect(counts(recovered, "events")).toBe(1);
    } finally {
      recovered.close();
    }
  } finally {
    vault.dispose();
  }
});
