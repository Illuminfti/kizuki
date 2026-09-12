import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { accept } from "../../src/ledger/ledger";
import { registerConnection } from "../../src/ledger/connections";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { serveTimeline } from "../../src/serving/timeline";
import { ServeError } from "../../src/serving/types";
import type { Envelope } from "../../src/serving/types";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await serveFixture();
});

afterAll(() => {
  fixture.dispose();
});

function eventIds(envelope: Envelope): string[] {
  return envelope.quoted.map((chunk) => chunk.event_id);
}

function refusal(run: () => unknown): ServeError {
  try {
    run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

describe("serveTimeline", () => {
  test("a day window quotes the live events of that day in order", () => {
    const envelope = serveTimeline(fixture.owner(), { day: "2026-02-28" });
    expect(eventIds(envelope)).toEqual([
      fixture.events["public"] as string,
      fixture.events["personal"] as string,
      fixture.events["private"] as string,
    ]);
    expect(envelope.quoted.every((chunk) => chunk.tainted === true)).toBe(true);
  });

  test("a tombstoned record is dropped, and an unhinted one is counted", () => {
    const envelope = serveTimeline(fixture.owner(), { day: "2026-02-28" });
    expect(eventIds(envelope)).not.toContain(
      fixture.events["tombstoned"] as string,
    );
    expect(envelope.denied).toEqual([
      { reason: "missing_sensitivity", count: 1 },
    ]);
  });

  test("the ceiling decides which events exist", () => {
    const envelope = serveTimeline(fixture.agent("reader-public"), {
      day: "2026-02-28",
    });
    expect(eventIds(envelope)).toEqual([fixture.events["public"] as string]);
    expect(envelope.denied).toEqual([]);
  });

  test("a subject outside a scoped grant is refused", () => {
    expect(
      refusal(() =>
        serveTimeline(fixture.agent("subjected"), {
          day: "2026-02-28",
          subject: "person:grace",
        }),
      ).code,
    ).toBe("subject_out_of_scope");
  });

  test("a scoped grant with no subject argument still filters every entry", () => {
    const envelope = serveTimeline(fixture.agent("subjected"), {
      day: "2026-02-28",
    });
    expect(eventIds(envelope)).toEqual([
      fixture.events["public"] as string,
      fixture.events["personal"] as string,
    ]);
    expect(envelope.denied).toEqual([]);
  });

  test("a types-scoped grant restricts ledger events by kind", () => {
    const ctx = fixture.agent("typed");
    expect(
      refusal(() => serveTimeline(ctx, { day: "2026-02-28", kind: "message" }))
        .code,
    ).toBe("type_out_of_scope");
    const envelope = serveTimeline(ctx, { day: "2026-02-28" });
    expect(envelope.quoted).toEqual([]);
    expect(envelope.denied).toEqual([]);
  });

  test("a connector filter and an explicit subject both narrow the answer", () => {
    const envelope = serveTimeline(fixture.owner(), {
      day: "2026-02-28",
      connector_id: "fixture",
      subject: "person:grace",
    });
    expect(eventIds(envelope)).toEqual([fixture.events["private"] as string]);
  });

  test("a day that is not a real calendar day is refused", () => {
    expect(
      refusal(() => serveTimeline(fixture.owner(), { day: "2026-02-30" })).code,
    ).toBe("invalid_arguments");
    expect(
      refusal(() => serveTimeline(fixture.owner(), { limit: 201 })).code,
    ).toBe("invalid_arguments");
  });
});

function recallPolicy(purposes: string[]) {
  return {
    purposes,
    allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked" as const,
    egress: "local_only" as const,
    sensitivity_floor: "public" as const,
  };
}

function grantSource(live: Fixture, sourceKey: string, operation: string, purposes: string[]) {
  registerConnection(live.db, "fixture", sourceKey);
  setSourceGrant(live.db, {
    source_key: sourceKey,
    expected_revision: 0,
    operation_id: operation,
    policy: recallPolicy(purposes),
  });
}

function boundEvent(
  live: Fixture,
  sourceKey: string,
  sourceRecordId: string,
  occurredAt: string,
) {
  const result = accept(
    live.db,
    {
      ...validEvent(),
      source_record_id: sourceRecordId,
      occurred_at: occurredAt,
      sensitivity_hint: "public",
    },
    { source: { source_key: sourceKey, expected_revision: 1 } },
  );
  if (result.status !== "stored") {
    throw new Error(`expected stored event, got ${result.status}`);
  }
  return result.event.event_id;
}

describe("serveTimeline authorization starvation", () => {
  test("a subject grant at limit 1 returns the later in-scope row", async () => {
    const live = await serveFixture();
    try {
      const denied = storeEvent(
        live.db,
        "rec-grace-early",
        "2026-02-28T08:00:00Z",
        "the grace kettle is early",
        "person:grace",
        "public",
      );
      const allowed = live.events["public"] as string;
      const envelope = serveTimeline(live.agent("subjected"), {
        day: "2026-02-28",
        limit: 1,
      });
      expect(eventIds(envelope)).toEqual([allowed]);
      expect(envelope.denied).toEqual([]);
      expect(JSON.stringify(envelope)).not.toContain(denied);
    } finally {
      live.dispose();
    }
  });

  test("source-policy at limit 1 returns the later authorized row and keeps denials private", async () => {
    const live = await serveFixture();
    try {
      const deniedKey = ulid();
      const allowedKey = ulid();
      grantSource(live, deniedKey, "grant-denied-source", ["capture"]);
      grantSource(live, allowedKey, "grant-allowed-source", [
        "capture",
        "recall",
        "session",
      ]);
      const denied = boundEvent(live, deniedKey, "rec-denied-first", "2026-02-28T07:00:00Z");
      const allowed = boundEvent(live, allowedKey, "rec-allowed-later", "2026-02-28T16:00:00Z");
      const envelope = serveTimeline(live.agent("reader-private"), {
        day: "2026-02-28",
        limit: 1,
      });
      expect(eventIds(envelope)).toEqual([allowed]);
      expect(envelope.denied).toEqual([]);
      expect(JSON.stringify(envelope)).not.toContain(denied);
    } finally {
      live.dispose();
    }
  });
});
