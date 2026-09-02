import { describe, expect, test } from "bun:test";
import { parseFrontmatter, validatePage } from "@kizuki/core";
import { fileProposal, pageRelPath, renderPage } from "@kizuki/core/staging";
import type { ProposalInput, StagedProposal } from "@kizuki/core/staging";
import {
  CONFIDENCE_CAPS,
  claimsDraft,
  entityDrafts,
  entityTarget,
  slugify,
  summaryDraft,
  targetRelPath,
} from "../src/drafts";
import { PROMPT_VERSION } from "../src/prompt";
import { event, memoryDb } from "./helpers";

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ctx = { event: event(), model: "fixture-model" };

const SUMMARY = {
  title: "A note about the library",
  summary: "ada met grace at the acme library.",
  confidence: 1,
};

const CANDIDATE = {
  name: "acme",
  type: "org" as const,
  aliases: ["the acme library"],
  evidence: "ada met grace at the acme library",
  confidence: 1,
};

const ENTITIES = { entities: [CANDIDATE] };

const CLAIMS = {
  claims: [
    { statement: "ada met grace.", subject_id: "person:ada", confidence: 0.8 },
    { statement: "the library is acme's.", subject_id: null, confidence: 0.4 },
  ],
};

function stored(input: ProposalInput): StagedProposal {
  const db = memoryDb();
  try {
    const filed = fileProposal(db, input);
    if (filed.outcome !== "stored") throw new Error(filed.outcome);
    return filed.proposal;
  } finally {
    db.close();
  }
}

function promotable(input: ProposalInput): Record<string, unknown> {
  const proposal = stored(input);
  const rendered = renderPage(proposal, "personal", proposal.body);
  const page = parseFrontmatter(rendered);
  expect(validatePage(page.data)).toEqual([]);
  return page.data;
}

describe("slugify", () => {
  test.each([
    ["Ada Lovelace", "ada-lovelace"],
    ["acme", "acme"],
    ["ACME Corp.", "acme-corp"],
    ["a_b.c-d", "a_b.c-d"],
    ["  spaced   out  ", "spaced-out"],
  ])("slugs %j as %j", (name, expected) => {
    expect(slugify(name)).toBe(expected);
  });

  test.each([["日本"], ["--..--"], ["   "], [""]])(
    "falls back to a stable hash for %j",
    (name) => {
      const slug = slugify(name);
      expect(slug).toMatch(/^x[0-9a-f]{12}$/);
      expect(slugify(name)).toBe(slug);
    },
  );

  test("different unslugabble names get different slugs", () => {
    expect(slugify("日本")).not.toBe(slugify("中国"));
  });

  test("caps at 64 code points", () => {
    expect(slugify("a".repeat(65))).toHaveLength(64);
  });

  test("a name with diacritics becomes ascii", () => {
    const slug = slugify("Ærøskøbing café");
    expect(slug).toMatch(PATH_SEGMENT);
    expect(slug).toBe(slug.toLowerCase());
    expect(/^[\x20-\x7E]*$/.test(slug)).toBe(true);
  });

  test("every slug is a usable path segment", () => {
    const alphabet = "aZ0 .-_/:\\é日[]{}*?\"'<>|\t\n#%&$@!~`^()+=,;";
    for (let index = 0; index < 200; index += 1) {
      let name = "";
      const length = 1 + ((index * 7) % 20);
      for (let position = 0; position < length; position += 1) {
        const pick = (index * 31 + position * 17) % alphabet.length;
        name += alphabet[pick] ?? "";
      }
      expect(slugify(name)).toMatch(PATH_SEGMENT);
    }
  });
});

describe("targets", () => {
  test("an entity target is the type and the slug", () => {
    expect(entityTarget("org", "ACME Corp.")).toBe("org:acme-corp");
  });

  test("the relative path matches what promote would choose", () => {
    const target = entityTarget("person", "Ada Lovelace");
    const proposal = stored(
      entityDrafts(ctx, {
        entities: [
          {
            name: "Ada Lovelace",
            type: "person",
            aliases: [],
            evidence: "ada met grace",
            confidence: 1,
          },
        ],
      })[0] as ProposalInput,
    );
    expect(targetRelPath(target)).toBe("person/ada-lovelace.md");
    expect(pageRelPath(proposal)).toBe(targetRelPath(target));
  });
});

describe("summaryDraft", () => {
  const draft = summaryDraft(ctx, SUMMARY);

  test("files a claim the owner still has to promote", () => {
    expect(draft.kind).toBe("claim");
    expect(draft.target).toBeNull();
    expect(draft.producer).toBe("llm");
    expect(draft.provenance).toEqual([ctx.event.event_id]);
    expect(draft.subjects).toEqual(["person:ada", "person:grace"]);
  });

  test("never outranks the deterministic floor", () => {
    expect(draft.confidence).toBe(CONFIDENCE_CAPS.summary);
    expect(summaryDraft(ctx, { ...SUMMARY, confidence: 0.2 }).confidence).toBe(
      0.2,
    );
  });

  test("says in the page that it is an unreviewed model draft", () => {
    expect(draft.frontmatter).toEqual({
      type: "fact",
      title: "A note about the library",
      "x-producer": "llm",
      "x-model": "fixture-model",
      "x-prompt-version": PROMPT_VERSION,
      "x-connector": "markdown-folder",
      "x-capture-kind": "note",
    });
    expect(draft.body).toContain("unreviewed");
    expect(draft.body).toContain("ada met grace at the acme library.");
    expect(draft.body).toContain(`Sources: (ev:${ctx.event.event_id})`);
  });

  test("promotes to a valid page", () => {
    const data = promotable(draft);
    expect(data["x-producer"]).toBe("llm");
    expect(data["type"]).toBe("fact");
  });
});

describe("entityDrafts", () => {
  const drafts = entityDrafts(ctx, ENTITIES);

  test("one entity proposal per candidate, targeted at its page", () => {
    expect(drafts).toHaveLength(1);
    const draft = drafts[0] as ProposalInput;
    expect(draft.kind).toBe("entity");
    expect(draft.target).toBe("org:acme");
    expect(draft.frontmatter["type"]).toBe("org");
    expect(draft.frontmatter["title"]).toBe("acme");
    expect(draft.frontmatter["x-aliases"]).toEqual(["the acme library"]);
    expect(draft.confidence).toBe(CONFIDENCE_CAPS.entity);
  });

  test("omits the alias key when the model named none", () => {
    const [draft] = entityDrafts(ctx, {
      entities: [{ ...CANDIDATE, aliases: [] }],
    });
    expect(draft?.frontmatter).not.toHaveProperty("x-aliases");
  });

  test("quotes the evidence instead of asserting it", () => {
    const draft = drafts[0] as ProposalInput;
    expect(draft.body).toContain(
      "Evidence (captured text as quoted by the model):",
    );
    expect(draft.body).toContain("> ada met grace at the acme library");
    expect(draft.body).toContain(`Sources: (ev:${ctx.event.event_id})`);
  });

  test("collapses two candidates that would land on the same page", () => {
    const collapsed = entityDrafts(ctx, {
      entities: [
        { ...CANDIDATE, name: "ACME" },
        { ...CANDIDATE, name: "acme", confidence: 0.1 },
      ],
    });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.confidence).toBe(CONFIDENCE_CAPS.entity);
  });

  test("promotes to a valid page", () => {
    const data = promotable(drafts[0] as ProposalInput);
    expect(data["type"]).toBe("org");
    expect(data["x-aliases"]).toEqual(["the acme library"]);
  });
});

describe("claimsDraft", () => {
  const draft = claimsDraft(ctx, CLAIMS);

  test("files one claim page listing every atom", () => {
    expect(draft.kind).toBe("claim");
    expect(draft.target).toBeNull();
    expect(draft.frontmatter["type"]).toBe("fact");
    expect(draft.frontmatter["x-claim-count"]).toBe(2);
    expect(draft.frontmatter["title"]).toBe(
      "Claims from markdown-folder at 2026-02-28T10:30:00Z",
    );
  });

  test("takes the least confident atom, capped", () => {
    expect(draft.confidence).toBe(0.4);
    expect(
      claimsDraft(ctx, {
        claims: [{ statement: "s.", subject_id: null, confidence: 1 }],
      }).confidence,
    ).toBe(CONFIDENCE_CAPS.claims);
  });

  test("marks each atom with its subject and its evidence", () => {
    expect(draft.body).toContain(
      `- ada met grace. (subject: person:ada; ev:${ctx.event.event_id})`,
    );
    expect(draft.body).toContain(
      `- the library is acme's. (ev:${ctx.event.event_id})`,
    );
  });

  test("unions the event subjects with the ones the atoms named", () => {
    const wider = claimsDraft(
      { event: event({ subjects: [] }), model: "fixture-model" },
      CLAIMS,
    );
    expect(wider.subjects).toEqual(["person:ada"]);
    expect(draft.subjects).toEqual(["person:ada", "person:grace"]);
  });

  test("promotes to a valid page", () => {
    expect(promotable(draft)["x-claim-count"]).toBe(2);
  });
});

describe("every draft", () => {
  test("keeps the keys promote reserves for itself out of frontmatter", () => {
    const drafts: ProposalInput[] = [
      summaryDraft(ctx, SUMMARY),
      ...entityDrafts(ctx, ENTITIES),
      claimsDraft(ctx, CLAIMS),
    ];
    for (const draft of drafts) {
      for (const reserved of ["id", "status", "sensitivity", "sources"]) {
        expect(draft.frontmatter).not.toHaveProperty(reserved);
      }
      expect(draft.producer).toBe("llm");
      expect(draft.provenance).toEqual([ctx.event.event_id]);
      expect(draft.frontmatter["x-prompt-version"]).toBe(PROMPT_VERSION);
      expect(draft.confidence).toBeLessThanOrEqual(0.9);
    }
  });

  test("a hostile title cannot break out of the page it renders into", () => {
    const draft = summaryDraft(ctx, {
      ...SUMMARY,
      title: "---\nid: stolen\n---",
      summary: "---\nsensitivity: public\n---\n\nprose",
    });
    const data = promotable(draft);
    expect(data["id"]).not.toBe("stolen");
    expect(data["sensitivity"]).toBe("personal");
    expect(String(data["title"])).not.toContain("\n");
  });
});
