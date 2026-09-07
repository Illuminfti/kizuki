import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildGraph } from "../../src/graph/graph";
import { serveGraph } from "../../src/serving/graph";
import type { GraphArgs, GraphData } from "../../src/serving/graph";
import { ServeError } from "../../src/serving/types";
import type { Envelope } from "../../src/serving/types";
import { serializePage } from "../../src/vault/frontmatter";
import { recordedPage, serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeEach(async () => {
  fixture = await serveFixture();
});

afterEach(() => {
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

  test("a page with a retracted source loses all positive source edges", () => {
    const envelope = serveGraph(fixture.owner(), {
      id: "fact:sourced",
      kinds: ["source"],
    });
    expect(targets(envelope)).toEqual([]);
    expect(envelope.denied).toEqual([{ reason: "held", count: 1 }]);
    const live = serveGraph(fixture.owner(), { id: "person:ada", kinds: ["source"] });
    expect(targets(live)).toContain(fixture.events["public"] as string);
  });

  test("a namespaced source dest is authorized or counted, not dropped", async () => {
    const eventId = storeEvent(
      fixture.db,
      "namespaced-source",
      "2026-03-01T00:00:00Z",
      "Namespaced kettle source",
      "person:ada",
      "private",
    );
    await recordedPage(fixture.db, fixture.vaultPath, "facts/namespaced-source.md", {
      id: "fact:namespaced-source",
      title: "Namespaced source",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
    }, "Cites a namespaced ledger record.", [fixture.events["public"] as string]);
    rebuildGraph(fixture.db, fixture.vaultPath);

    // Exercise the consumer's source check with a namespaced derived edge.
    // The public root retains its real public receipt; no receipt is fabricated.
    fixture.db.query(`UPDATE graph_edges SET dst = ?, dest_sensitivity = 'private'
      WHERE src = 'fact:namespaced-source' AND kind = 'source'`)
      .run(`event:${eventId}`);

    const owner = serveGraph(fixture.owner(), {
      id: "fact:namespaced-source",
      kinds: ["source"],
    });
    expect(owner.data?.edges).toEqual([
      {
        src: "fact:namespaced-source",
        dst: `event:${eventId}`,
        kind: "source",
      },
    ]);
    expect(owner.denied).toEqual([]);

    const limited = serveGraph(fixture.agent("reader-public"), {
      id: "fact:namespaced-source",
      kinds: ["source"],
    });
    expect(limited.data?.edges).toEqual([]);
    expect(limited.denied).toEqual([{ reason: "above_ceiling", count: 1 }]);
    expect(JSON.stringify(limited)).not.toContain(eventId);
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

  test("a public reader is not capped by private incoming edges", async () => {
    await recordedPage(fixture.db, fixture.vaultPath, "facts/cap-hub.md", {
      id: "fact:cap-hub",
      title: "Cap hub",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
    }, "A public hub.", [fixture.events["public"] as string]);
    for (let index = 0; index < 100; index += 1) {
      await recordedPage(fixture.db, fixture.vaultPath, `facts/cap-secret-${index}.md`, {
        id: `fact:aaa-secret-${index}`,
        title: `Secret ${index}`,
        type: "fact",
        status: "active",
        sensitivity: "private",
        taint: "clean",
      }, "See [[Cap hub]].", [fixture.events["public"] as string]);
    }
    await recordedPage(fixture.db, fixture.vaultPath, "facts/cap-open.md", {
      id: "fact:zzz-open",
      title: "Open neighbor",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
    }, "See [[Cap hub]].", [fixture.events["public"] as string]);
    rebuildGraph(fixture.db, fixture.vaultPath);

    const owner = serveGraph(fixture.owner(), {
      id: "fact:cap-hub",
      kinds: ["wikilink"],
    });
    const ownerSources = (owner.data?.edges ?? []).map((edge) => edge.src);
    expect(owner.data?.edges).toHaveLength(100);
    expect(owner.data?.truncated).toBe(true);
    expect(ownerSources).not.toContain("fact:zzz-open");

    const limited = serveGraph(fixture.agent("reader-public"), {
      id: "fact:cap-hub",
      kinds: ["wikilink"],
    });
    expect((limited.data?.edges ?? []).map((edge) => edge.src)).toEqual([
      "fact:zzz-open",
    ]);
    expect(limited.data?.truncated).toBe(false);
    expect(limited.denied).toEqual([{ reason: "above_ceiling", count: 100 }]);
    expect(JSON.stringify(limited)).not.toContain("aaa-secret");
  });

  test("a leftover wikilink stays prose when an archived page shares the title", async () => {
    await recordedPage(fixture.db, fixture.vaultPath, "facts/ghost-link.md", {
      id: "fact:ghost-link",
      title: "Ghost link",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
    }, "See [[Ghost]].", [fixture.events["public"] as string]);
    writeFileSync(
      join(fixture.vaultPath, "facts/ghost.md"),
      serializePage({
        data: {
          id: "fact:ghost",
          title: "Ghost",
          type: "fact",
          status: "archived",
          sensitivity: "public",
          taint: "clean",
        },
        body: "A retracted ghost.",
      }),
      "utf8",
    );
    rebuildGraph(fixture.db, fixture.vaultPath);

    const envelope = serveGraph(fixture.owner(), {
      id: "fact:ghost-link",
      kinds: ["wikilink"],
    });
    expect(envelope.data?.edges).toEqual([
      { src: "fact:ghost-link", dst: "Ghost", kind: "wikilink" },
    ]);
    expect(envelope.denied).toEqual([]);
  });

  test("a public reader is not capped by private outgoing dests", async () => {
    const destLinks = [
      ...Array.from({ length: 100 }, (_value, index) => `[[Out secret ${index}]]`),
      "[[Out open]]",
    ].join(" ");
    await recordedPage(fixture.db, fixture.vaultPath, "facts/out-hub.md", {
      id: "fact:out-hub",
      title: "Out hub",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
    }, destLinks, [fixture.events["public"] as string]);
    for (let index = 0; index < 100; index += 1) {
      await recordedPage(fixture.db, fixture.vaultPath, `facts/out-secret-${index}.md`, {
        id: `fact:aaa-out-secret-${index}`,
        title: `Out secret ${index}`,
        type: "fact",
        status: "active",
        sensitivity: "private",
        taint: "clean",
      }, "A private dest.", [fixture.events["public"] as string]);
    }
    await recordedPage(fixture.db, fixture.vaultPath, "facts/out-open.md", {
      id: "fact:zzz-out-open",
      title: "Out open",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
    }, "A public dest.", [fixture.events["public"] as string]);
    rebuildGraph(fixture.db, fixture.vaultPath);

    const owner = serveGraph(fixture.owner(), {
      id: "fact:out-hub",
      kinds: ["wikilink"],
    });
    const ownerDests = (owner.data?.edges ?? []).map((edge) => edge.dst);
    expect(owner.data?.edges).toHaveLength(100);
    expect(owner.data?.truncated).toBe(true);
    expect(ownerDests).not.toContain("fact:zzz-out-open");

    const limited = serveGraph(fixture.agent("reader-public"), {
      id: "fact:out-hub",
      kinds: ["wikilink"],
    });
    expect((limited.data?.edges ?? []).map((edge) => edge.dst)).toEqual([
      "fact:zzz-out-open",
    ]);
    expect(limited.data?.truncated).toBe(false);
    expect(limited.denied).toEqual([{ reason: "above_ceiling", count: 100 }]);
    expect(JSON.stringify(limited)).not.toContain("aaa-out-secret");
  });

  test("a public reader is not capped by private source dests", async () => {
    const eventIds: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      eventIds.push(
        storeEvent(
          fixture.db,
          `source-cap-${index}`,
          "2026-03-01T00:00:00Z",
          `Private source ${index}`,
          "person:ada",
          "private",
        ),
      );
    }
    await recordedPage(fixture.db, fixture.vaultPath, "facts/source-hub.md", {
      id: "fact:source-hub",
      title: "Source hub",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
    }, "See [[Source open]].", [fixture.events["public"] as string]);
    await recordedPage(fixture.db, fixture.vaultPath, "facts/source-open.md", {
      id: "fact:zzz-source-open",
      title: "Source open",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
    }, "A public dest.", [fixture.events["public"] as string]);
    rebuildGraph(fixture.db, fixture.vaultPath);

    // Isolate cap/filter behavior in the disposable projection. A real public
    // page cannot carry private provenance; its recorded revision stays intact.
    const publicSource = fixture.events["public"] as string;
    for (const eventId of eventIds) {
      fixture.db.query(`INSERT INTO graph_edges
        SELECT src, ?, kind, sensitivity, 'private', taint, authority, provenance, valid_from, valid_to
        FROM graph_edges WHERE src = 'fact:source-hub' AND kind = 'source' AND dst = ?`)
        .run(eventId, publicSource);
    }
    fixture.db.query(`DELETE FROM graph_edges
      WHERE src = 'fact:source-hub' AND kind = 'source' AND dst = ?`).run(publicSource);

    const owner = serveGraph(fixture.owner(), { id: "fact:source-hub" });
    expect(owner.data?.edges).toHaveLength(100);
    expect(owner.data?.truncated).toBe(true);
    expect(owner.data?.edges.every((edge) => edge.kind === "source")).toBe(true);
    expect((owner.data?.edges ?? []).map((edge) => edge.dst)).not.toContain(
      "fact:zzz-source-open",
    );

    const limited = serveGraph(fixture.agent("reader-public"), {
      id: "fact:source-hub",
    });
    expect(limited.data?.edges).toEqual([
      {
        src: "fact:source-hub",
        dst: "fact:zzz-source-open",
        kind: "wikilink",
      },
    ]);
    expect(limited.data?.truncated).toBe(false);
    expect(limited.denied).toEqual([{ reason: "above_ceiling", count: 100 }]);
    expect(JSON.stringify(limited)).not.toContain(eventIds[0]);
  });

  test("the edge list is capped and reports the truncation", async () => {
    const links = Array.from(
      { length: 520 },
      (_value, index) => `[[target-${index}]]`,
    ).join(" ");
    await recordedPage(fixture.db, fixture.vaultPath, "facts/many.md", {
      id: "fact:many",
      title: "Many kettle links",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
    }, links, [fixture.events["public"] as string]);
    rebuildGraph(fixture.db, fixture.vaultPath);

    const envelope = serveGraph(fixture.owner(), {
      id: "fact:many",
      kinds: ["wikilink"],
    });
    expect(envelope.data?.edges).toHaveLength(100);
    expect(envelope.data?.truncated).toBe(true);
  });
});
