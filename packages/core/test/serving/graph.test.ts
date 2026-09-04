import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildGraph } from "../../src/graph/graph";
import { serveGraph } from "../../src/serving/graph";
import type { GraphArgs, GraphData } from "../../src/serving/graph";
import { ServeError } from "../../src/serving/types";
import type { Envelope } from "../../src/serving/types";
import { serializePage } from "../../src/vault/frontmatter";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeAll(() => {
  fixture = serveFixture();
});

afterAll(() => {
  fixture.dispose();
});

function targets(envelope: Envelope<GraphData>): string[] {
  return (envelope.data?.edges ?? []).map((edge) => edge.dst).sort();
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

describe("serveGraph", () => {
  test("a resolved wikilink to a withheld page is dropped and counted", () => {
    const owner = serveGraph(fixture.owner(), {
      id: "fact:linked",
      kinds: ["wikilink"],
    });
    expect(targets(owner)).toEqual(["Nowhere", "person:grace"]);
    expect(owner.denied).toEqual([]);

    const limited = serveGraph(fixture.agent("reader-public"), {
      id: "fact:linked",
      kinds: ["wikilink"],
    });
    expect(targets(limited)).toEqual(["Nowhere"]);
    expect(limited.denied).toEqual([{ reason: "above_ceiling", count: 1 }]);
    expect(JSON.stringify(limited)).not.toContain("person:grace");
  });

  test("a subject id is a usable root and a hidden source page is counted", () => {
    const owner = serveGraph(fixture.owner(), {
      id: "person:ada",
      kinds: ["subject"],
    });
    expect(owner.data?.edges.map((edge) => edge.src).sort()).toEqual([
      "fact:kettle",
      "fact:linked",
      "fact:quoted",
      "org:acme",
      "person:ada",
    ]);

    const limited = serveGraph(fixture.agent("reader-public"), {
      id: "person:ada",
      kinds: ["subject"],
    });
    expect(limited.data?.edges.map((edge) => edge.src)).not.toContain(
      "fact:kettle",
    );
    expect(limited.denied).toEqual([{ reason: "above_ceiling", count: 1 }]);
  });

  test("a source edge to a retracted record is dropped, a live one kept", () => {
    const envelope = serveGraph(fixture.owner(), {
      id: "fact:sourced",
      kinds: ["source"],
    });
    expect(targets(envelope)).toEqual([fixture.events["public"] as string]);
    expect(envelope.denied).toEqual([]);
  });

  test("a withheld root answers with no edges and a single count", () => {
    const envelope = serveGraph(fixture.agent("reader-public"), {
      id: "fact:kettle",
    });
    expect(envelope.data).toEqual({
      id: "fact:kettle",
      edges: [],
      truncated: false,
    });
    expect(envelope.denied).toEqual([{ reason: "above_ceiling", count: 1 }]);
  });

  test("a retracted root is absent rather than denied", () => {
    const envelope = serveGraph(fixture.owner(), { id: "fact:archived" });
    expect(envelope.data?.edges).toEqual([]);
    expect(envelope.denied).toEqual([]);
  });

  test("depth two reaches the neighbours of the first ring", () => {
    const envelope = serveGraph(fixture.owner(), {
      id: "person:ada",
      depth: 2,
    });
    expect(envelope.data?.edges).toContainEqual({
      src: "fact:linked",
      dst: "person:grace",
      kind: "wikilink",
    });
  });

  test("bad depth and repeated kinds are refused before any read", () => {
    const ctx = fixture.owner();
    // A typed caller cannot write `depth: 3` at all: this assignment stops
    // compiling the moment the public type widens back to `number`.
    type OutOfBound = 3 extends NonNullable<GraphArgs["depth"]> ? true : false;
    const typedCallerRefused: OutOfBound = false;
    expect(typedCallerRefused).toBe(false);

    const untyped: unknown = 3;
    expect(
      refusal(() =>
        serveGraph(ctx, {
          id: "person:ada",
          depth: untyped as NonNullable<GraphArgs["depth"]>,
        }),
      ).code,
    ).toBe("invalid_arguments");
    expect(
      refusal(() =>
        serveGraph(ctx, { id: "person:ada", kinds: ["subject", "subject"] }),
      ).code,
    ).toBe("invalid_arguments");
  });

  test("the edge list is capped and reports the truncation", () => {
    const links = Array.from(
      { length: 520 },
      (_value, index) => `[[target-${index}]]`,
    ).join(" ");
    writeFileSync(
      join(fixture.vaultPath, "facts/many.md"),
      serializePage({
        data: {
          id: "fact:many",
          title: "Many kettle links",
          type: "fact",
          status: "active",
          sensitivity: "public",
          taint: "clean",
        },
        body: links,
      }),
      "utf8",
    );
    rebuildGraph(fixture.db, fixture.vaultPath);

    const envelope = serveGraph(fixture.owner(), {
      id: "fact:many",
      kinds: ["wikilink"],
    });
    expect(envelope.data?.edges).toHaveLength(100);
    expect(envelope.data?.truncated).toBe(true);
  });
});
