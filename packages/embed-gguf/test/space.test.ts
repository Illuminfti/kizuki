import { describe, expect, test } from "bun:test";
import { buildFixtureTable } from "../src/fixture";
import { formatDoc, formatQuery, spaceFromTable } from "../src/space";

describe("prompt framing", () => {
  const space = spaceFromTable(buildFixtureTable());

  test("keeps dollar sequences in query and document text literal", () => {
    const query = formatQuery("price is $$100 and $& more $'", space);
    expect(query).toBe("price is $$100 and $& more $'");

    const doc = formatDoc("cost $&", "paid $$ then $'", space);
    expect(doc).toBe("cost $&\npaid $$ then $'");
  });

  test("adds no words of its own to a table embedder's input", () => {
    for (const framed of [formatQuery("grace", space), formatDoc("acme", "grace", space)]) {
      expect(framed.toLowerCase()).not.toMatch(/\b(?:task|search|result|query|title|text)\b/);
    }
  });

  test("fills each slot once, so a slot spelled inside a title stays literal", () => {
    expect(formatDoc("the {text} slot", "body", space)).toBe("the {text} slot\nbody");
    expect(formatQuery("what is {q}", space)).toBe("what is {q}");
  });
});
