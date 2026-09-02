import { describe, expect, test } from "bun:test";
import {
  HONESTY_FILES,
  STATUS_HEADINGS,
  checkDocument,
  checkProof,
  parseProofTokens,
} from "./verify-docs";
import type { DocsContext } from "./verify-docs";

function context(
  files: Record<string, string>,
  scripts: string[] = ["verify", "test"],
): DocsContext {
  return {
    tracked: new Set(Object.keys(files)),
    scripts: new Set(scripts),
    readFile: (path: string): string | null => files[path] ?? null,
  };
}

const REASONS = (problems: { reason: string }[]): string =>
  problems.map((problem) => problem.reason).join(" | ");

describe("links", () => {
  test("accepts a tracked relative target and a real anchor", () => {
    const ctx = context({
      "docs/x.md": "",
      "docs/architecture.md": "## Serving\n",
    });
    const md = "see [design](architecture.md#serving)\n";
    expect(checkDocument("docs/x.md", md, ctx)).toEqual([]);
  });

  test("rejects a relative target that is not tracked", () => {
    const ctx = context({ "docs/x.md": "" });
    const problems = checkDocument("docs/x.md", "[x](gone.md)\n", ctx);
    expect(problems.length).toBe(1);
    expect(REASONS(problems)).toContain("not tracked");
  });

  test("rejects a target that escapes the repository", () => {
    const ctx = context({ "docs/connectors.md": "" });
    const problems = checkDocument(
      "docs/connectors.md",
      "[x](../../x.md)\n",
      ctx,
    );
    expect(REASONS(problems)).toContain("escapes the repository");
  });

  test("rejects an insecure http link", () => {
    const ctx = context({ "docs/x.md": "" });
    const problems = checkDocument("docs/x.md", "[x](http://example.com)\n", ctx);
    expect(REASONS(problems)).toContain("insecure link");
  });

  test("rejects an anchor with no matching heading", () => {
    const ctx = context({
      "docs/x.md": "",
      "docs/architecture.md": "## Serving\n",
    });
    const problems = checkDocument(
      "docs/x.md",
      "[x](architecture.md#proactive)\n",
      ctx,
    );
    expect(REASONS(problems)).toContain("anchor");
  });

  test("accepts an in-file anchor and a directory target", () => {
    const ctx = context({ "docs/x.md": "", "rfcs/0000-constraints.md": "" });
    const md = "## Pledges\n\n[here](#pledges) and [rfcs](../rfcs/)\n";
    expect(checkDocument("docs/x.md", md, ctx)).toEqual([]);
  });

  test("leaves an external https link unchecked", () => {
    const ctx = context({ "docs/x.md": "" });
    const md = "[bun](https://bun.sh)\n";
    expect(checkDocument("docs/x.md", md, ctx)).toEqual([]);
  });
});

describe("mermaid", () => {
  const ctx = context({ "docs/x.md": "" });
  const fence = (body: string): string => "```mermaid\n" + body + "\n```\n";

  test("accepts a flowchart with a quoted label and balanced subgraphs", () => {
    const md = fence(
      'flowchart LR\n  subgraph shipped\n    a["Ledger (append-only)"]\n  end\n  a --> b',
    );
    expect(checkDocument("docs/x.md", md, ctx)).toEqual([]);
  });

  test("rejects an unclosed fence", () => {
    const md = "```mermaid\nflowchart LR\n  a --> b\n";
    expect(REASONS(checkDocument("docs/x.md", md, ctx))).toContain("unclosed");
  });

  test("rejects a diagram type the gate does not allow", () => {
    const md = fence("pie title Sources\n  a : 1");
    expect(REASONS(checkDocument("docs/x.md", md, ctx))).toContain(
      "first line",
    );
  });

  test("rejects an init directive", () => {
    const md = fence("%%{init: {'theme':'dark'}}%%\nflowchart LR\n  a --> b");
    expect(REASONS(checkDocument("docs/x.md", md, ctx))).toContain("directive");
  });

  test("rejects an HTML label", () => {
    const md = fence("flowchart LR\n  a[<b>bold</b>] --> c");
    expect(REASONS(checkDocument("docs/x.md", md, ctx))).toContain("HTML");
  });

  test("rejects an unbalanced subgraph", () => {
    const md = fence("flowchart LR\n  subgraph shipped\n    a --> b");
    expect(REASONS(checkDocument("docs/x.md", md, ctx))).toContain("subgraph");
  });

  test("rejects a click handler and a tab", () => {
    const clicks = fence("flowchart LR\n  a --> b\n  click a href");
    expect(REASONS(checkDocument("docs/x.md", clicks, ctx))).toContain("click");
    const tabbed = fence("flowchart LR\n\ta --> b");
    expect(REASONS(checkDocument("docs/x.md", tabbed, ctx))).toContain("tab");
  });
});

describe("proof tokens", () => {
  test("parses file and run tokens", () => {
    const tokens = parseProofTokens(
      "`packages/core/test/vault.test.ts::self-ignores`, `run: bun run verify`",
    );
    expect(tokens.map((token) => token.kind)).toEqual(["file", "run"]);
    expect(tokens[0]?.path).toBe("packages/core/test/vault.test.ts");
    expect(tokens[0]?.needle).toBe("self-ignores");
    expect(tokens[1]?.command).toBe("bun run verify");
  });

  test("accepts a tracked path whose needle is present", () => {
    const ctx = context({ "a/b.test.ts": 'test("keeps the gate", () => {})' });
    const [token] = parseProofTokens("`a/b.test.ts::keeps the gate`");
    expect(token && checkProof(token, ctx)).toBeNull();
  });

  test("rejects an untracked path and an absent needle", () => {
    const ctx = context({ "a/b.test.ts": "nothing here" });
    const [missing] = parseProofTokens("`a/gone.test.ts`");
    expect(missing && checkProof(missing, ctx)).toContain("not tracked");
    const [absent] = parseProofTokens("`a/b.test.ts::keeps the gate`");
    expect(absent && checkProof(absent, ctx)).toContain("needle");
  });

  test("accepts the four permitted run forms", () => {
    const ctx = context({
      "scripts/verify.sh": "",
      "scripts/verify-network.ts": "",
      "packages/cli/src/main.ts": "",
    });
    for (const command of [
      "bun run verify",
      "bash scripts/verify.sh",
      "bun scripts/verify-network.ts",
      "bun packages/cli/src/main.ts version",
    ]) {
      const [token] = parseProofTokens("`run: " + command + "`");
      expect(token && checkProof(token, ctx)).toBeNull();
    }
  });

  test("rejects an unknown script and an arbitrary command", () => {
    const ctx = context({ "scripts/verify.sh": "" });
    const [unknown] = parseProofTokens("`run: bun run nope`");
    expect(unknown && checkProof(unknown, ctx)).toContain("script");
    const [arbitrary] = parseProofTokens("`run: curl https://example.com`");
    expect(arbitrary && checkProof(arbitrary, ctx)).toContain("permitted");
  });

  test("a Proof cell with no backticked token is a problem", () => {
    const ctx = context({ "docs/x.md": "" });
    const md = "| Capability | Proof |\n| --- | --- |\n| a thing | none |\n";
    expect(REASONS(checkDocument("docs/x.md", md, ctx))).toContain("no proof");
  });

  test("a table without a Proof column is not inspected for proofs", () => {
    const ctx = context({ "docs/x.md": "" });
    const md = "| Upstream | Role |\n| --- | --- |\n| Bun | runtime |\n";
    expect(checkDocument("docs/x.md", md, ctx)).toEqual([]);
  });
});

describe("README status headings", () => {
  const ctx = context({ "README.md": "" });

  test("requires all three status headings", () => {
    const md = "# Kizuki\n\n## What runs today\n\n## Direction\n";
    expect(REASONS(checkDocument("README.md", md, ctx))).toContain(
      "Accepted design",
    );
  });

  test("requires the status headings in order", () => {
    const md =
      "# Kizuki\n\n## Direction\n\n## What runs today\n\n## Accepted design\n";
    expect(REASONS(checkDocument("README.md", md, ctx))).toContain("order");
  });

  test("requires a Proof column on every table under What runs today", () => {
    const md =
      "# Kizuki\n\n## What runs today\n\n| Capability | Meaning |\n| --- | --- |\n| a | b |\n\n## Accepted design\n\n## Direction\n";
    expect(REASONS(checkDocument("README.md", md, ctx))).toContain("Proof");
  });

  test("exports the three status headings in serving order", () => {
    expect([...STATUS_HEADINGS]).toEqual([
      "What runs today",
      "Accepted design",
      "Direction",
    ]);
  });
});

describe("honesty phrases", () => {
  test("rejects a placeholder word in a shipped document", () => {
    const ctx = context({ "SECURITY.md": "" });
    const md = "# Security\n\nThe encryption seam is TBD.\n";
    expect(REASONS(checkDocument("SECURITY.md", md, ctx))).toContain("TBD");
  });

  test("allows the same word inside a code fence", () => {
    const ctx = context({ "SECURITY.md": "" });
    const md = "# Security\n\n```\ngrep -n TBD README.md\n```\n";
    expect(checkDocument("SECURITY.md", md, ctx)).toEqual([]);
  });

  test("does not police a document that is not shipped prose", () => {
    const ctx = context({ "docs/x.md": "" });
    expect(checkDocument("docs/x.md", "TODO: decide\n", ctx)).toEqual([]);
    expect(HONESTY_FILES).toContain("SECURITY.md");
  });
});

describe("fences", () => {
  test("rejects an unclosed fence of any language", () => {
    const ctx = context({ "docs/x.md": "" });
    expect(
      REASONS(checkDocument("docs/x.md", "```ts\nconst a = 1;\n", ctx)),
    ).toContain("unclosed");
  });
});
