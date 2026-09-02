import { describe, expect, test } from "bun:test";
import { parseLegacyFrontmatter } from "../src/import-legacy-wiki/frontmatter";

function fence(block: string, body = "the body\n"): string {
  return `---\n${block}---\n${body}`;
}

function parsed(block: string): Record<string, unknown> {
  const result = parseLegacyFrontmatter(fence(block));
  if (result.status !== "parsed") {
    throw new Error(
      `expected parsed, got ${result.status}: ${result.problems.join(", ")}`,
    );
  }
  return result.data;
}

function refused(markdown: string): string[] {
  const result = parseLegacyFrontmatter(markdown);
  expect(result.status).toBe("unparsed");
  expect(result.data).toEqual({});
  return result.problems;
}

describe("block detection", () => {
  test("no fence at all is absent, and the whole file is the body", () => {
    const result = parseLegacyFrontmatter("# Title\n\nprose\n");
    expect(result).toEqual({
      status: "absent",
      data: {},
      body: "# Title\n\nprose\n",
      problems: [],
    });
  });

  test("a leading byte order mark does not hide the fence", () => {
    const result = parseLegacyFrontmatter("\uFEFF---\ntitle: Ada\n---\nbody\n");
    expect(result.status).toBe("parsed");
    expect(result.data["title"]).toBe("Ada");
    expect(result.body).toBe("body\n");
  });

  test("CRLF line endings parse and leave the body intact", () => {
    const result = parseLegacyFrontmatter(
      "---\r\ntitle: Ada\r\nborn: 1815\r\n---\r\nbody\r\n",
    );
    expect(result.status).toBe("parsed");
    expect(result.data).toEqual({ title: "Ada", born: 1815 });
    expect(result.body).toBe("body\r\n");
  });

  test("a dot-dot-dot line closes the block", () => {
    const result = parseLegacyFrontmatter("---\ntitle: Ada\n...\nbody\n");
    expect(result.status).toBe("parsed");
    expect(result.body).toBe("body\n");
  });

  test("no closing fence keeps the whole file as body", () => {
    const source = "---\ntitle: Ada\n\nstill going\n";
    const result = parseLegacyFrontmatter(source);
    expect(result.status).toBe("unparsed");
    expect(result.problems).toEqual(["no closing fence"]);
    expect(result.body).toBe(source);
  });

  test("a body that starts with a rule stays body", () => {
    const result = parseLegacyFrontmatter("---\ntitle: Ada\n---\n---\nbody\n");
    expect(result.status).toBe("parsed");
    expect(result.body).toBe("---\nbody\n");
  });

  test("a second document is refused rather than half-read", () => {
    expect(
      refused("---\ntitle: Ada\n...\n---\ntitle: Grace\n---\nbody\n"),
    ).toEqual(["a second document"]);
  });

  test("a block over 64 KiB is refused without allocating a parse", () => {
    const huge = `pad: ${"a".repeat(64 * 1024)}\n`;
    expect(refused(fence(huge))).toEqual(["frontmatter exceeds 64 KiB"]);
  });
});

describe("scalars", () => {
  test("quoted, bare, boolean, null and numeric forms", () => {
    expect(
      parsed(
        [
          'double: "a \\"quoted\\" line"',
          "single: 'it''s here'",
          "bare: Ada Lovelace",
          "yes: TRUE",
          "no: False",
          "nothing: null",
          "tilde: ~",
          "empty:",
          "int: 1815",
          "negative: -3",
          "decimal: 1.5",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      double: 'a "quoted" line',
      single: "it's here",
      bare: "Ada Lovelace",
      yes: true,
      no: false,
      nothing: null,
      tilde: null,
      empty: null,
      int: 1815,
      negative: -3,
      decimal: 1.5,
    });
  });

  test("anything the number rule rejects stays a verbatim string", () => {
    expect(
      parsed(
        [
          "date: 2026-01-01",
          "hex: 0x1f",
          "exp: 1e3",
          "pad: 007",
          "time: 10:30\n",
        ].join("\n"),
      ),
    ).toEqual({
      date: "2026-01-01",
      hex: "0x1f",
      exp: "1e3",
      pad: "007",
      time: "10:30",
    });
  });

  test("comments are stripped outside quotes only", () => {
    expect(
      parsed('a: value # trailing\nb: "keeps # inside"\n# whole line\n'),
    ).toEqual({
      a: "value",
      b: "keeps # inside",
    });
  });
});

describe("collections", () => {
  test("a block sequence indented under its key", () => {
    expect(parsed("tags:\n  - math\n  - acme\n")).toEqual({
      tags: ["math", "acme"],
    });
  });

  test("a block sequence at its key's own column", () => {
    expect(parsed("tags:\n- math\n- acme\n")).toEqual({
      tags: ["math", "acme"],
    });
  });

  test("a nested mapping", () => {
    expect(
      parsed("links:\n  home: acme\n  work:\n    role: analyst\n"),
    ).toEqual({
      links: { home: "acme", work: { role: "analyst" } },
    });
  });

  test("a sequence of mappings", () => {
    expect(
      parsed("people:\n  - name: Ada\n    role: from\n  - name: Grace\n"),
    ).toEqual({
      people: [{ name: "Ada", role: "from" }, { name: "Grace" }],
    });
  });

  test("single-line flow sequences and mappings", () => {
    expect(
      parsed("tags: [math, \"acme\", 'x']\nmeta: {a: 1, b: true}\n"),
    ).toEqual({
      tags: ["math", "acme", "x"],
      meta: { a: 1, b: true },
    });
    expect(parsed("tags: []\nmeta: {}\n")).toEqual({ tags: [], meta: {} });
  });

  test("nested and multi-line flow are refused", () => {
    expect(refused(fence("tags: [a, [b]]\n"))).toEqual([
      "nested flow collections are not supported",
    ]);
    expect(refused(fence("tags: [a,\n  b]\n"))).toEqual([
      "multi-line flow is not supported",
    ]);
  });
});

describe("block scalars", () => {
  test("literal keeps line breaks and clips to one trailing newline", () => {
    expect(parsed("text: |\n  one\n  two\n\n")).toEqual({ text: "one\ntwo\n" });
  });

  test("literal strip and keep honour their chomping indicator", () => {
    expect(parsed("text: |-\n  one\n  two\n")).toEqual({ text: "one\ntwo" });
    expect(parsed("text: |+\n  one\n\n\n")).toEqual({ text: "one\n\n\n" });
  });

  test("folded joins lines with a space and blank lines with a break", () => {
    expect(parsed("text: >\n  one\n  two\n\n  three\n")).toEqual({
      text: "one two\nthree\n",
    });
    expect(parsed("text: >-\n  one\n  two\n")).toEqual({ text: "one two" });
    expect(parsed("text: >+\n  one\n\n")).toEqual({ text: "one\n\n" });
  });

  test("a block scalar ends where the indentation drops back", () => {
    expect(parsed("text: |\n  one\nafter: true\n")).toEqual({
      text: "one\n",
      after: true,
    });
  });
});

describe("refusals and bounds", () => {
  test("tabs in indentation", () => {
    expect(refused(fence("links:\n\tname: Ada\n"))).toEqual([
      "tab in indentation",
    ]);
  });

  test("anchors, aliases, tags, directives and complex keys", () => {
    expect(refused(fence("&anchor\ntitle: Ada\n"))).toEqual([
      "anchors are not supported",
    ]);
    expect(refused(fence("title: *alias\n"))).toEqual([
      "aliases are not supported",
    ]);
    expect(refused(fence("title: !!str Ada\n"))).toEqual([
      "tags are not supported",
    ]);
    expect(refused(fence("%YAML 1.2\ntitle: Ada\n"))).toEqual([
      "directives are not supported",
    ]);
    expect(refused(fence("? complex\n: value\n"))).toEqual([
      "complex keys are not supported",
    ]);
  });

  test("more than 500 keys", () => {
    const many = Array.from({ length: 501 }, (_, i) => `k${i}: v`).join("\n");
    expect(refused(fence(`${many}\n`))).toEqual(["more than 500 keys"]);
  });

  test("nesting deeper than 8", () => {
    let block = "";
    for (let depth = 0; depth < 9; depth += 1) {
      block += `${" ".repeat(depth * 2)}k${depth}:\n`;
    }
    expect(refused(fence(`${block}${" ".repeat(18)}leaf: v\n`))).toEqual([
      "nesting deeper than 8",
    ]);
  });

  test("a line that is not a key: value pair", () => {
    expect(refused(fence("just a sentence\n"))).toEqual([
      "expected a key: value line",
    ]);
  });

  test("a duplicate key keeps the first value and records the rule", () => {
    const result = parseLegacyFrontmatter(fence("title: Ada\ntitle: Grace\n"));
    expect(result.status).toBe("parsed");
    expect(result.data["title"]).toBe("Ada");
    expect(result.problems).toEqual(['duplicate key "title"']);
  });

  test("a sequence item's mapping keeps the first value too", () => {
    const result = parseLegacyFrontmatter(
      fence("people:\n  - name: Ada\n    name: Grace\n"),
    );
    expect(result.data["people"]).toEqual([{ name: "Ada" }]);
    expect(result.problems).toEqual(['duplicate key "name"']);
  });

  test("a flow mapping keeps the first value too", () => {
    const result = parseLegacyFrontmatter(fence("meta: {a: 1, a: 2}\n"));
    expect(result.data["meta"]).toEqual({ a: 1 });
    expect(result.problems).toEqual(['duplicate key "a"']);
  });

  test("a flow mapping obeys the key grammar and the key budget", () => {
    expect(refused(fence("meta: {: 1}\n"))).toEqual([
      "flow mapping needs key: value pairs",
    ]);
    expect(refused(fence("meta: {a: 1, : 2}\n"))).toEqual(["unusable key"]);
    const wide = Array.from({ length: 501 }, (_, i) => `k${i}: ${i}`).join(", ");
    expect(refused(fence(`meta: {${wide}}\n`))).toEqual([
      "more than 500 keys",
    ]);
  });
});

describe("hostile input", () => {
  test("never throws on random byte strings", () => {
    // A fixed generator: a failure here has to be reproducible.
    let seed = 20260902;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const alphabet = [
      ...`---\n\t "':#|>&*!%?[]{},.~`,
      "\u0000",
      "\u001b",
      "\u{1F600}",
      "a",
      "1",
    ];
    for (let round = 0; round < 200; round += 1) {
      let source = "";
      const length = next() % 120;
      for (let i = 0; i < length; i += 1) {
        source += alphabet[next() % alphabet.length] as string;
      }
      const result = parseLegacyFrontmatter(source);
      expect(["parsed", "absent", "unparsed"]).toContain(result.status);
      expect(typeof result.body).toBe("string");
    }
  });
});
