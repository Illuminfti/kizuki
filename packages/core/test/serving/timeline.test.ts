import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serveTimeline } from "../../src/serving/timeline";
import { ServeError } from "../../src/serving/types";
import type { Envelope } from "../../src/serving/types";
import { serveFixture } from "./helpers";
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
    expect(envelope.denied).toContainEqual({
      reason: "above_ceiling",
      count: 2,
    });
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
    expect(envelope.denied).toContainEqual({
      reason: "subject_out_of_scope",
      count: 1,
    });
  });

  test("a types-scoped grant restricts ledger events by kind", () => {
    const ctx = fixture.agent("typed");
    expect(
      refusal(() => serveTimeline(ctx, { day: "2026-02-28", kind: "message" }))
        .code,
    ).toBe("type_out_of_scope");
    const envelope = serveTimeline(ctx, { day: "2026-02-28" });
    expect(envelope.quoted).toEqual([]);
    expect(envelope.denied).toContainEqual({
      reason: "type_out_of_scope",
      count: 3,
    });
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
