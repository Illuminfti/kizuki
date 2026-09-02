import { describe, expect, test } from "bun:test";
import { buildFixtureTable } from "../src/fixture";
import { formatDoc, formatQuery, spaceFromTable } from "../src/space";

describe("prompt framing", () => {
  const space = spaceFromTable(buildFixtureTable());

  test("keeps dollar sequences in query and document text literal", () => {
    const query = formatQuery("price is $$100 and $& more $'", space);
    expect(query).toBe(
      "task: search result | query: price is $$100 and $& more $'",
    );

    const doc = formatDoc("cost $&", "paid $$ then $'", space);
    expect(doc).toBe("title: cost $& | text: paid $$ then $'");
  });
});
