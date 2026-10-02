import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_AGENT_GRANT, addAgent } from "../../src/agents";
import type { Grant } from "../../src/agents";
import { validateAgentGrant } from "../../src/agents/identity";
import { rebuildDerived } from "../../src/derived";
import { serveGetPage } from "../../src/serving/page";
import { serveHealth } from "../../src/serving/health";
import { serveSearch } from "../../src/serving/search";
import { serveTimeline } from "../../src/serving/timeline";
import { ServeError } from "../../src/serving/types";
import { page, recordedPage, serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";

setDefaultTimeout(30_000);

let fixture: Fixture;

function addReader(name: string, patch: Partial<Grant>): void {
  fixture.tokens[name] = addAgent(fixture.db, name, {
    ...OWNER_AGENT_GRANT,
    tools: [...OWNER_AGENT_GRANT.tools],
    ...patch,
  }).token;
}

beforeAll(async () => {
  fixture = await serveFixture();
});

afterAll(() => {
  fixture.dispose();
});

describe("time-scoped grants read canon whose sources fall inside the window", () => {
  // The windowed fixture agent reads 10:30 to 13:30 on 2026-02-28. The personal
  // event is at 11:00, the private one at 12:00, the public one at 10:00.

  beforeAll(async () => {
    await recordedPage(
      fixture.db,
      fixture.vaultPath,
      "facts/in-window.md",
      {
        id: "fact:in-window",
        title: "In window kettle",
        type: "fact",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
        sources: [
          fixture.events["personal"] as string,
          fixture.events["private"] as string,
        ],
      },
      "A kettle page whose sources are both inside the window.",
    );
    await recordedPage(
      fixture.db,
      fixture.vaultPath,
      "facts/straddles.md",
      {
        id: "fact:straddles",
        title: "Straddling kettle",
        type: "fact",
        status: "active",
        sensitivity: "personal",
        taint: "clean",
        sources: [
          fixture.events["personal"] as string,
          fixture.events["public"] as string,
        ],
      },
      "A kettle page with one source before the window opens.",
    );
    rebuildDerived(fixture.db, fixture.vaultPath);
  });

  test("get_page reads a page when every source is inside the window and not otherwise", async () => {
    const windowed = fixture.agent("windowed");
    expect(
      serveGetPage(windowed, { id: "fact:in-window" }).canon.map(
        (chunk) => chunk.page_id,
      ),
    ).toEqual(["fact:in-window"]);
    expect(serveGetPage(windowed, { id: "fact:straddles" }).canon).toEqual([]);
    const audited = fixture.db
      .query<{ denied: string }, []>(
        "SELECT denied FROM agent_audit WHERE tool = 'get_page' ORDER BY at DESC, audit_id DESC LIMIT 1",
      )
      .get();
    expect(audited?.denied).toContain("time_out_of_scope");
  });

  test("a grant with no window still reads both, and the window still clamps events", () => {
    expect(
      serveGetPage(fixture.agent("reader-private"), { id: "fact:straddles" })
        .canon,
    ).toHaveLength(1);
    const events = serveTimeline(fixture.agent("windowed"), {
      day: "2026-02-28",
    }).quoted.map((chunk) => chunk.event_id);
    expect(events).toEqual([
      fixture.events["personal"] as string,
      fixture.events["private"] as string,
    ]);
  });
});

describe("subject ids that importer mappings produce", () => {
  const spaced = "legacy-wiki:tessa vale";

  test("a grant may name an id with spaces and unicode, and nothing looser", () => {
    const base = {
      ...OWNER_AGENT_GRANT,
      tools: [...OWNER_AGENT_GRANT.tools],
    } as Grant;
    for (const id of [
      spaced,
      "legacy-wiki:o'brien, ann-marie",
      "legacy-events:café müller",
      "person:ada",
    ]) {
      expect(validateAgentGrant({ ...base, subjects: [id] }).subjects).toEqual([
        id,
      ]);
    }
    for (const id of [
      "legacy-wiki:tessa  vale",
      "legacy-wiki: tessa",
      "legacy-wiki:tessa ",
      "legacy-wiki:tessa\tvale",
      "legacy-wiki:tessa\nvale",
      "legacy-wiki:tessa\u0000vale",
      "legacy-wiki:tessa vale",
      "Legacy-Wiki:tessa",
      "tessa vale",
      "legacy-wiki:",
      `legacy-wiki:${"a".repeat(200)}`,
    ]) {
      expect(() => validateAgentGrant({ ...base, subjects: [id] })).toThrow(
        /subjects/,
      );
    }
  });

  test("a grant scoped to such an id sees that subject's events and no one else's", () => {
    const own = storeEvent(
      fixture.db,
      "rec-tessa",
      "2026-02-28T09:30:00Z",
      "tessa kettle log",
      spaced,
      "personal",
    );
    storeEvent(
      fixture.db,
      "rec-other",
      "2026-02-28T09:40:00Z",
      "other kettle log",
      "legacy-wiki:someone else",
      "personal",
    );
    addReader("tessa-reader", { subjects: [spaced], since: null, until: null });
    const seen = serveTimeline(fixture.agent("tessa-reader"), {
      day: "2026-02-28",
    }).quoted.map((chunk) => chunk.event_id);
    expect(seen).toContain(own);
    expect(seen).toHaveLength(1);
  });
});

describe("one unreadable canon page is skipped with a named problem", () => {
  let outside: string;

  beforeAll(() => {
    outside = mkdtempSync(join(tmpdir(), "kizuki-outside-"));
    writeFileSync(join(outside, "target.md"), "not a page\n");
  });

  afterAll(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  test("a symlinked page no longer fails every canon read", async () => {
    symlinkSync(
      join(outside, "target.md"),
      join(fixture.vaultPath, "entities", "zz-link.md"),
    );
    try {
      for (const name of ["reader-private", "reader-public"]) {
        const found = await serveSearch(fixture.agent(name), {
          query: "kettle",
          scope: "canon",
        });
        expect(found.canon.length).toBeGreaterThan(0);
      }
      expect(
        serveGetPage(fixture.owner(), { id: "person:ada" }).canon,
      ).toHaveLength(1);

      const owner = serveHealth(fixture.owner()).data;
      expect(owner?.pages.withheld).toBe(1);
      expect(owner?.withheld_pages).toEqual([
        {
          path: "entities/zz-link.md",
          problem: "unreadable: not a regular file",
        },
      ]);

      // Unreadable page diagnostics belong to the owner, including counts.
      const agent = serveHealth(fixture.agent("reader-private")).data;
      expect(agent?.pages).not.toHaveProperty("withheld");
      expect(agent).not.toHaveProperty("withheld_pages");
    } finally {
      rmSync(join(fixture.vaultPath, "entities", "zz-link.md"), {
        force: true,
      });
    }
    expect(serveHealth(fixture.owner()).data?.pages.withheld).toBe(0);
  });

  test("a page file the process cannot read is skipped the same way", async () => {
    const path = join(fixture.vaultPath, "entities", "zz-locked.md");
    page(
      fixture.vaultPath,
      "entities/zz-locked.md",
      {
        id: "fact:locked",
        title: "Locked",
        type: "fact",
        status: "active",
        sensitivity: "public",
        taint: "clean",
      },
      "Locked kettle page.",
    );
    chmodSync(path, 0o000);
    try {
      if (process.getuid?.() === 0) return; // root reads through the mode bits
      const found = await serveSearch(fixture.agent("reader-private"), {
        query: "kettle",
        scope: "canon",
      });
      expect(found.canon.length).toBeGreaterThan(0);
      expect(
        serveHealth(fixture.owner()).data?.withheld_pages?.map(
          (entry) => entry.path,
        ),
      ).toEqual(["entities/zz-locked.md"]);
    } finally {
      chmodSync(path, 0o600);
      rmSync(path, { force: true });
    }
  });

  test("a directory that cannot be listed still refuses the read", async () => {
    const directory = join(fixture.vaultPath, "zz-locked-dir");
    mkdirSync(directory);
    chmodSync(directory, 0o000);
    try {
      if (process.getuid?.() === 0) return;
      let error: unknown;
      try {
        await serveSearch(fixture.agent("reader-private"), {
          query: "kettle",
          scope: "canon",
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ServeError);
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
