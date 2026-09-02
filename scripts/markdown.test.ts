import { describe, expect, test } from "bun:test";
import {
  extractFences,
  extractHeadings,
  extractLinks,
  extractTables,
  fenceLineNumbers,
  sections,
  slugify,
  stripCodeSpans,
} from "./markdown";

describe("slugify", () => {
  test("matches the GitHub anchor for a plain heading", () => {
    expect(slugify("What runs today")).toBe("what-runs-today");
  });

  test("drops punctuation that GitHub drops", () => {
    expect(slugify("kizuki.markdown-folder")).toBe("kizukimarkdown-folder");
    expect(slugify("Try it (pre-alpha)")).toBe("try-it-pre-alpha");
    expect(slugify("Accepted for 1.0, not in the tree")).toBe(
      "accepted-for-10-not-in-the-tree",
    );
  });

  test("keeps unicode letters", () => {
    expect(slugify("気づき and awareness")).toBe("気づき-and-awareness");
  });
});

describe("extractHeadings", () => {
  test("reads level, text, slug, and line for ATX headings", () => {
    const headings = extractHeadings("# Title\n\ntext\n\n## Second level\n");
    expect(headings).toEqual([
      { level: 1, text: "Title", slug: "title", line: 1 },
      { level: 2, text: "Second level", slug: "second-level", line: 5 },
    ]);
  });

  test("removes backticks but keeps the code text", () => {
    const [heading] = extractHeadings("### `kizuki.markdown-folder`\n");
    expect(heading?.text).toBe("kizuki.markdown-folder");
    expect(heading?.slug).toBe("kizukimarkdown-folder");
  });

  test("ignores a comment line inside a fence", () => {
    expect(extractHeadings("```sh\n# not a heading\n```\n")).toEqual([]);
  });
});

describe("extractLinks", () => {
  test("finds inline links with their line numbers", () => {
    const links = extractLinks(
      "see [the plan](docs/architecture.md#serving)\n",
    );
    expect(links).toEqual([
      { target: "docs/architecture.md#serving", line: 1 },
    ]);
  });

  test("skips links inside code spans and fences", () => {
    const md = "`[not](a/link.md)` and\n\n```\n[nor](this/one.md)\n```\n";
    expect(extractLinks(md)).toEqual([]);
  });

  test("reads a link whose text is entirely code", () => {
    const links = extractLinks("[`SECURITY.md`](SECURITY.md)\n");
    expect(links).toEqual([{ target: "SECURITY.md", line: 1 }]);
  });
});

describe("extractFences", () => {
  test("captures info string, body, line, and closure", () => {
    expect(extractFences("```mermaid\nflowchart LR\n  a --> b\n```\n")).toEqual(
      [
        {
          info: "mermaid",
          body: "flowchart LR\n  a --> b",
          line: 1,
          closed: true,
        },
      ],
    );
  });

  test("reports an unclosed fence", () => {
    const [fence] = extractFences("```ts\nconst a = 1;\n");
    expect(fence?.closed).toBe(false);
  });

  test("a longer closing run closes a shorter opening run", () => {
    const [fence] = extractFences("```\ninner\n````\n");
    expect(fence?.closed).toBe(true);
  });
});

describe("fenceLineNumbers", () => {
  test("covers the delimiters and everything between them", () => {
    expect([...fenceLineNumbers("a\n```\nb\n```\nc\n")].sort()).toEqual([
      2, 3, 4,
    ]);
  });
});

describe("extractTables", () => {
  test("reads the header and rows of a pipe table", () => {
    const md = "| A | B |\n| --- | --- |\n| one | two |\n";
    const [table] = extractTables(md);
    expect(table?.header).toEqual(["A", "B"]);
    expect(table?.rows).toEqual([{ cells: ["one", "two"], line: 3 }]);
    expect(table?.line).toBe(1);
  });

  test("honours an escaped pipe inside a cell", () => {
    const md = "| A | B |\n| --- | --- |\n| a \\| b | two |\n";
    const [table] = extractTables(md);
    expect(table?.rows[0]?.cells).toEqual(["a | b", "two"]);
  });

  test("stops at a blank line and finds a second table", () => {
    const md = "| A |\n| --- |\n| one |\n\ntext\n\n| B |\n| --- |\n| two |\n";
    const tables = extractTables(md);
    expect(tables.length).toBe(2);
    expect(tables[1]?.line).toBe(7);
  });

  test("ignores a table inside a fence", () => {
    expect(extractTables("```\n| A |\n| --- |\n| one |\n```\n")).toEqual([]);
  });
});

describe("sections", () => {
  test("splits on H2 and carries everything to the next H2", () => {
    const md = "# T\n\nintro\n\n## One\n\nbody one\n\n## Two\n\nbody two\n";
    const found = sections(md);
    expect(found.map((section) => section.heading.text)).toEqual([
      "One",
      "Two",
    ]);
    expect(found[0]?.text).toContain("body one");
    expect(found[0]?.text).not.toContain("body two");
  });
});

describe("stripCodeSpans", () => {
  test("blanks a code span without moving later columns", () => {
    const line = "a `code` b";
    expect(stripCodeSpans(line)).toBe("a        b");
    expect(stripCodeSpans(line).length).toBe(line.length);
  });

  test("leaves an unmatched backtick alone", () => {
    expect(stripCodeSpans("a ` b")).toBe("a ` b");
  });
});
