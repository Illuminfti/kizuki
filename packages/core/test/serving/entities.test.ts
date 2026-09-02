import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serveEntities } from "../../src/serving/entities";
import type { Envelope } from "../../src/serving/types";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeAll(() => {
  fixture = serveFixture();
});

afterAll(() => {
  fixture.dispose();
});

function titles(envelope: Envelope): string[] {
  return envelope.canon.map((chunk) => chunk.title);
}

describe("serveEntities", () => {
  test("only entity pages are candidates and the type narrows them", () => {
    const all = serveEntities(fixture.agent("reader-private"), {});
    expect(titles(all)).toEqual(["Acme", "Ada", "Grace"]);

    const people = serveEntities(fixture.agent("reader-private"), {
      type: "person",
    });
    expect(titles(people)).toEqual(["Ada", "Grace"]);
  });

  test("name matches the title or the handle, folding case", () => {
    const ctx = fixture.agent("reader-private");
    expect(titles(serveEntities(ctx, { name: "AD" }))).toEqual(["Ada"]);
    expect(titles(serveEntities(ctx, { name: "ada-han" }))).toEqual(["Ada"]);
    expect(titles(serveEntities(ctx, { name: "nobody" }))).toEqual([]);
  });

  test("the limit applies after authorization", () => {
    const envelope = serveEntities(fixture.agent("reader-private"), {
      limit: 1,
    });
    expect(titles(envelope)).toEqual(["Acme"]);
  });

  test("a match above the ceiling is counted, never named", () => {
    const envelope = serveEntities(fixture.agent("reader-public"), {
      type: "person",
    });
    expect(titles(envelope)).toEqual(["Ada"]);
    expect(envelope.denied).toEqual([{ reason: "above_ceiling", count: 1 }]);
    expect(JSON.stringify(envelope)).not.toContain("Grace");
  });

  test("the excerpt is collapsed prose from the page body", () => {
    const chunk = serveEntities(fixture.agent("reader-public"), {
      name: "acme",
    }).canon[0];
    expect(chunk?.excerpt).toBe("Acme ships kettles.");
    expect(chunk?.truncated).toBe(false);
  });
});
