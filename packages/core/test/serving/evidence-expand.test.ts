import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sha256 } from "../../src/agents/hash";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { serveContextPacket } from "../../src/serving/packet";
import { serveTimeline } from "../../src/serving/timeline";
import { ServeError } from "../../src/serving/types";
import { serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";

const OMITTED = "ERR-9f3a-OMITTED";
const PAGE_BODY = "The kettle note points at [[Grace]] and at [[Nowhere]].";

let fixture: Fixture;
let eventId: string;
let fullText: string;

beforeAll(async () => {
  fixture = await serveFixture();
  fullText = `🙂${"n".repeat(180)} ${OMITTED}`;
  eventId = storeEvent(
    fixture.db,
    "rec-omitted-detail",
    "2026-02-28T15:00:00Z",
    fullText,
    "person:ada",
    "public",
  );
});

afterAll(() => {
  fixture.dispose();
});

function refusal(run: () => unknown): ServeError {
  try {
    run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

describe("omitted evidence expansion", () => {
  test("a packet keeps the evidence id and drops the exact tail", async () => {
    const packet = await serveContextPacket(fixture.owner(), {
      include: ["timeline"],
      since: "2026-02-28T00:00:00Z",
      until: "2026-02-28T23:59:59Z",
      budget_tokens: 2_000,
      purpose: "recall",
    });
    expect(packet.data?.packet_md).toContain(eventId);
    expect(packet.data?.packet_md).not.toContain(OMITTED);
  });

  test("the evidence id expands that omitted tail with integrity markers", async () => {
    const envelope = await dispatchServeTool(fixture.owner(), "timeline", {
      event_id: eventId,
      offset: 182,
      span: 16,
    });
    if (!("quoted" in envelope)) throw new Error("expected a timeline envelope");
    expect(envelope.quoted).toHaveLength(1);
    expect(envelope.quoted.find(chunk => "event_id" in chunk)?.text).toBe(OMITTED);
    expect(envelope.quoted[0]?.tainted).toBe(true);
    expect(envelope.data).toEqual({
      integrity: sha256(fullText),
      slice_integrity: sha256(OMITTED),
      offset: 182,
      returned: 16,
      total: Array.from(fullText).length,
      truncated: false,
    });
  });

  test("a short window marks truncation and does not split a code point", () => {
    const envelope = serveTimeline(fixture.owner(), {
      event_id: eventId,
      offset: 0,
      span: 1,
    });
    expect(envelope.quoted.find(chunk => "event_id" in chunk)?.text).toBe("🙂");
    expect(envelope.data?.truncated).toBe(true);
    expect(envelope.data?.returned).toBe(1);
  });

  test("a mismatched pin, a missing id, and a vault path return no captured text", () => {
    const pinned = serveTimeline(fixture.owner(), {
      event_id: eventId,
      integrity: "a".repeat(64),
    });
    expect(pinned.quoted).toEqual([]);
    expect(pinned.data).toBeUndefined();
    expect(JSON.stringify(pinned)).not.toContain(OMITTED);
    expect(JSON.stringify(pinned)).not.toContain(sha256(fullText));

    const missing = serveTimeline(fixture.owner(), { event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(missing.quoted).toEqual([]);
    expect(JSON.stringify(missing)).not.toContain(OMITTED);

    const retracted = serveTimeline(fixture.owner(), {
      event_id: fixture.events["tombstoned"] as string,
    });
    expect(retracted.quoted).toEqual([]);
    expect(JSON.stringify(retracted)).not.toContain("retracted kettle");

    const path = serveTimeline(fixture.owner(), { event_id: "facts/linked.md" });
    expect(path.quoted).toEqual([]);
    expect(JSON.stringify(path)).not.toContain(PAGE_BODY);
    expect(JSON.stringify(path)).not.toContain("Nowhere");
  });

  test("a narrowed grant fails closed and does not fall back to the file", () => {
    const above = serveTimeline(fixture.agent("reader-public"), {
      event_id: fixture.events["private"] as string,
    });
    expect(above.quoted).toEqual([]);
    expect(above.denied).toEqual([]);
    expect(JSON.stringify(above)).not.toContain("private kettle");

    const outside = serveTimeline(fixture.agent("windowed"), {
      event_id: fixture.events["public"] as string,
    });
    expect(outside.quoted).toEqual([]);
    expect(JSON.stringify(outside)).not.toContain("public kettle");

    expect(
      refusal(() =>
        serveTimeline(fixture.agent("search-only"), { event_id: eventId }),
      ).code,
    ).toBe("tool_not_granted");
    expect(
      refusal(() =>
        serveTimeline(fixture.owner(), { event_id: eventId, day: "2026-02-28" }),
      ).code,
    ).toBe("invalid_arguments");
  });
});
