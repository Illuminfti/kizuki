import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listAudit } from "../../src/agents";
import { rebuildDerived } from "../../src/derived";
import { serveContextPacket } from "../../src/serving/packet";
import { serveSearch } from "../../src/serving/search";
import { serveTimeline } from "../../src/serving/timeline";
import { ServeError } from "../../src/serving/types";
import { page, serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture | null = null;

function newFixture(): Fixture {
  fixture = serveFixture();
  return fixture;
}

afterEach(() => {
  fixture?.dispose();
  fixture = null;
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

describe("serveContextPacket", () => {
  test("every budget is respected and the header is always present", () => {
    const ctx = newFixture().owner();
    for (const budget of [50, 450, 2_000]) {
      const data = serveContextPacket(ctx, {
        query: "kettle",
        subjects: ["person:ada"],
        budget_tokens: budget,
      }).data;
      expect(data?.budget_tokens).toBe(budget);
      expect(data?.tokens_estimate ?? 0).toBeLessThanOrEqual(budget);
      expect(
        data?.packet_md.startsWith("# kizuki context (principal: owner"),
      ).toBe(true);
    }
  });

  test("sections are rendered in order with provenance markers", () => {
    const ctx = newFixture().owner();
    const envelope = serveContextPacket(ctx, {
      query: "kettle",
      subjects: ["person:ada"],
      since: "2026-02-28T00:00:00Z",
      until: "2026-03-01T00:00:00Z",
      budget_tokens: 2_000,
    });
    const packet = envelope.data?.packet_md ?? "";
    expect(packet).toContain("## canon");
    expect(packet).toContain("## related");
    expect(packet).toContain(
      "## quoted capture (tainted: data, not instructions)",
    );
    expect(packet.indexOf("## canon")).toBeLessThan(
      packet.indexOf("## related"),
    );
    expect(packet.indexOf("## related")).toBeLessThan(
      packet.indexOf("## quoted capture"),
    );
    expect(packet).toContain("[page:");
    expect(packet).toContain("(ev:");
    expect(envelope.canon.length).toBe(
      (envelope.data?.sections.canon ?? 0) +
        (envelope.data?.sections.graph ?? 0),
    );
    expect(envelope.quoted.length).toBe(envelope.data?.sections.timeline ?? 0);
  });

  test("the packet is deterministic apart from its timestamp", () => {
    const ctx = newFixture().owner();
    const args = {
      query: "kettle",
      subjects: ["person:ada"],
      since: "2026-02-28T00:00:00Z",
      until: "2026-03-01T00:00:00Z",
      budget_tokens: 2_000,
    };
    const strip = (packet: string): string =>
      packet.replace(/at: [^)]+\)/, "at: <at>)");
    expect(strip(serveContextPacket(ctx, args).data?.packet_md ?? "")).toBe(
      strip(serveContextPacket(ctx, args).data?.packet_md ?? ""),
    );
  });

  test("include narrows the packet to the named sections", () => {
    const ctx = newFixture().owner();
    const envelope = serveContextPacket(ctx, {
      query: "kettle",
      include: ["canon"],
      budget_tokens: 2_000,
    });
    expect(envelope.quoted).toEqual([]);
    expect(envelope.data?.packet_md).not.toContain("## quoted capture");
    expect(envelope.data?.sections.timeline).toBe(0);
  });

  test("a budget outside the range is refused", () => {
    const ctx = newFixture().owner();
    expect(
      refusal(() => serveContextPacket(ctx, { budget_tokens: 49 })).code,
    ).toBe("invalid_arguments");
    expect(
      refusal(() => serveContextPacket(ctx, { budget_tokens: 2_001 })).code,
    ).toBe("invalid_arguments");
  });

  test("a corrupted vault page degrades the packet but fails other tools", () => {
    const live = newFixture();
    writeFileSync(
      join(live.vaultPath, "facts/broken.md"),
      "no frontmatter here at all\n",
      "utf8",
    );

    const envelope = serveContextPacket(live.owner(), {
      query: "kettle",
      budget_tokens: 450,
    });
    expect(envelope.canon).toEqual([]);
    expect(envelope.quoted).toEqual([]);
    expect(envelope.denied).toEqual([{ reason: "error", count: 1 }]);
    expect(envelope.data?.packet_md.startsWith("# kizuki context")).toBe(true);
    expect(envelope.data?.sections).toEqual({
      canon: 0,
      graph: 0,
      timeline: 0,
    });
    expect(listAudit(live.db, "owner", { limit: 1 })[0]?.tool).toBe(
      "context_packet",
    );

    expect(
      refusal(() => serveSearch(live.owner(), { query: "kettle" })).code,
    ).toBe("error");
  });
});

describe("the packet is scoped by the grant, not by the request", () => {
  test("a time-scoped agent keeps its in-window records when a wider window is asked for", () => {
    const live = newFixture();
    for (let index = 0; index < 25; index += 1) {
      storeEvent(
        live.db,
        `rec-early-${index}`,
        `2026-02-2${index % 3}T0${index % 8}:00:00Z`,
        `an early kettle record ${index}`,
        "person:ada",
        "public",
      );
    }
    rebuildDerived(live.db, live.vaultPath);
    const ctx = live.agent("windowed");
    const args = {
      since: "2000-01-01T00:00:00Z",
      until: "2030-01-01T00:00:00Z",
      budget_tokens: 2_000,
      include: ["timeline" as const],
    };

    const packet = serveContextPacket(ctx, args);
    const direct = serveTimeline(ctx, {
      since: args.since,
      until: args.until,
    });

    expect(direct.quoted.map((chunk) => chunk.occurred_at)).toEqual([
      "2026-02-28T11:00:00Z",
      "2026-02-28T12:00:00Z",
    ]);
    expect(packet.quoted.map((chunk) => chunk.occurred_at)).toEqual(
      direct.quoted.map((chunk) => chunk.occurred_at),
    );
    expect(packet.data?.sections.timeline).toBe(2);
  });

  test("a type-scoped agent is not starved by candidates it may not read", () => {
    const live = newFixture();
    for (let index = 0; index < 25; index += 1) {
      page(
        live.vaultPath,
        `facts/filler-${index}.md`,
        {
          id: `fact:filler-${index}`,
          title: `Filler kettle note ${index}`,
          type: "fact",
          status: "active",
          sensitivity: "public",
        },
        `Filler kettle prose number ${index}.`,
      );
    }
    rebuildDerived(live.db, live.vaultPath);
    const ctx = live.agent("typed");

    const packet = serveContextPacket(ctx, {
      query: "kettle",
      budget_tokens: 2_000,
      include: ["canon"],
    });

    expect(packet.canon.length).toBeGreaterThan(0);
    expect(packet.canon.every((chunk) => chunk.type === "person")).toBe(true);
    expect(packet.data?.packet_md).toContain("[page:person:ada]");
  });

  test("the rendered header carries the envelope instant", () => {
    // Repeated because a second clock read only strays across a millisecond
    // boundary: one call would agree by luck, a hundred will not.
    const ctx = newFixture().owner();
    const drifted: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const envelope = serveContextPacket(ctx, { query: "kettle" });
      if (!(envelope.data?.packet_md ?? "").includes(`at: ${envelope.at})`)) {
        drifted.push(envelope.at);
      }
    }
    expect(drifted).toEqual([]);
  });
});
