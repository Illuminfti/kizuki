import { afterEach, expect, setDefaultTimeout, setSystemTime, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OWNER,
  OWNER_AGENT_GRANT,
  addAgent,
  authenticate,
  type Grant,
} from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { initSearch } from "../../src/search/schema";
import * as canon from "../../src/serving/canon";
import { CanonAccessPhase } from "../../src/serving/canon-access";
import { dispatchServeTool } from "../../src/serving/dispatch";
import {
  CallDecisions,
  graphServingScope,
} from "../../src/serving/graph-scope";
import type { ServeContext } from "../../src/serving/types";
import { serializePage } from "../../src/vault/frontmatter";
import { referenceScope } from "../../src/world/ref-kinds/common";
import {
  eventRawSubjectRefs,
  issueRawSubjectRef,
  prepareEventRawSubjects,
} from "../../src/world/ref-kinds/raw-subject";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { seedLivePages } from "../helpers/bulk-pages";
import { checkNoninterference, hiddenScene } from "../helpers/noninterference";
import type {
  NoninterferenceScene,
  ReadCase,
} from "../helpers/noninterference";
import { tempVault } from "../helpers/vault";
import { enrollSource } from "../helpers/world-seed";
import { serveFixture } from "./helpers";
import * as chunks from "../../src/serving/v2/chunks";

setDefaultTimeout(120_000);
afterEach(() => setSystemTime());
const CONNECTOR = "subjects.fixture";
/** A recall packet of the captures in a fixed window. */
const WINDOW = { purpose: "recall", include: ["timeline"], since: "2026-01-01T00:00:00Z", until: "2100-01-01T00:00:00Z" };

/** One public source whose captures name overlapping subjects, and readers with identical grants. */
function subjectScene() {
  const vault = tempVault();
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  initSearch(db);
  const source = enrollSource(db, CONNECTOR, "public");
  const capture = (
    subjects: readonly string[],
    sensitivity: "public" | "private" = "public",
  ): string => {
    const id = ulid();
    const stored = accept(
      db,
      {
        ...validEvent(),
        connector_id: CONNECTOR,
        source_record_id: id,
        kind: "note",
        text: `note ${id}`,
        sensitivity_hint: sensitivity,
        subjects: subjects.map((subject_id) => ({ subject_id, role: "about" })),
      },
      { source: { source_key: source, expected_revision: 1 } },
    );
    if (stored.status !== "stored")
      throw new Error(`capture: ${stored.status}`);
    return stored.event.event_id;
  };
  const reader = (name: string): ServeContext => {
    const agent = addAgent(db, name, {
      ...OWNER_AGENT_GRANT,
      ceiling: "public",
    });
    return {
      db,
      vaultPath: vault.path,
      principal: authenticate(db, agent.token)!,
    };
  };
  return {
    db,
    source,
    capture,
    reader,
    dispose() {
      db.close();
      vault.dispose();
    },
  };
}

/** Each issued subject of a namespace with the exact membership rows behind it. */
function issuedMembers(db: Database, reader: ServeContext) {
  return db
    .transaction(() => {
      const ns = referenceScope(reader).ns.id;
      const rows = db
        .query<
          { raw_key: string; event_id: string; source_key: string },
          [string]
        >(
          `
      SELECT t.raw_key, m.event_id, m.source_key FROM world_wire_raw_subject_targets t
      JOIN world_wire_raw_subject_members m ON m.namespace_id=t.namespace_id AND m.wire_ref=t.wire_ref
      WHERE t.namespace_id=? ORDER BY t.raw_key, m.event_id`,
        )
        .all(ns);
      const targets = db
        .query<{ raw_key: string }, [string]>(
          "SELECT raw_key FROM world_wire_raw_subject_targets WHERE namespace_id=? ORDER BY raw_key",
        )
        .all(ns);
      return { targets: targets.map((row) => row.raw_key), rows };
    })
    .immediate();
}

test("issuing a projection's subjects ahead, per source, equals issuing each subject alone", () => {
  const f = subjectScene();
  try {
    const shared = f.capture(["topic:a", "topic:b"]);
    const second = f.capture(["topic:b", "topic:c"]);
    // Private captures are above both readers' ceiling: `topic:d` has no
    // permitted member and `topic:c` keeps only the public one.
    const hidden = f.capture(["topic:c", "topic:d"], "private");
    const fourth = f.capture(["topic:a"]);
    const items = [
      { eventId: shared, ids: ["topic:a", "topic:b"] },
      { eventId: second, ids: ["topic:b", "topic:c"] },
      { eventId: hidden, ids: ["topic:c", "topic:d"] },
      { eventId: fourth, ids: ["topic:a", "topic:absent"] },
    ];
    const ahead = f.reader("reader-ahead"),
      alone = f.reader("reader-alone");
    const query = spyOn(f.db, "query");
    let scans = 0,
      probes = 0;
    const answersAhead = f.db
      .transaction(() => {
        const scope = referenceScope(ahead);
        const before = query.mock.calls.length;
        prepareEventRawSubjects(scope, items);
        const answers = items.map(
          (item) => eventRawSubjectRefs(scope, item.eventId, item.ids).length,
        );
        const sql = query.mock.calls
          .slice(before)
          .map(([text]) => String(text));
        scans = sql.filter((text) =>
          text.includes("INSERT OR IGNORE INTO world_wire_raw_subject_members"),
        ).length;
        probes = sql.filter((text) =>
          text.startsWith("SELECT 1 FROM events WHERE events.connector_id=?"),
        ).length;
        return answers;
      })
      .immediate();
    query.mockRestore();
    const answersAlone = f.db
      .transaction(() => {
        const scope = referenceScope(alone);
        return items.map(
          (item) =>
            item.ids.filter(
              (id) =>
                issueRawSubjectRef(scope, {
                  kind: "supplied",
                  id,
                  namespace: { connector_id: CONNECTOR, source_key: f.source },
                }) !== null,
            ).length,
        );
      })
      .immediate();
    expect(answersAhead).toEqual(answersAlone);
    expect(answersAhead).toEqual([2, 2, 1, 1]);
    expect(issuedMembers(f.db, ahead)).toEqual(issuedMembers(f.db, alone));
    expect(
      issuedMembers(f.db, ahead).rows.some((row) => row.event_id === hidden),
    ).toBe(false);
    // Three issued subjects from one source: one membership write and no
    // per-subject probe, where issuing alone costs a probe and a write each.
    expect(scans).toBe(1);
    expect(probes).toBe(0);
  } finally {
    f.dispose();
  }
});

test("a subject answered earlier in the transaction is asked again after any write", () => {
  const f = subjectScene();
  try {
    f.capture(["topic:a"]);
    const reader = f.reader("reader-memo");
    const raw = {
      kind: "supplied",
      id: "topic:late",
      namespace: { connector_id: CONNECTOR, source_key: f.source },
    } as const;
    const answers = f.db
      .transaction(() => {
        const scope = referenceScope(reader);
        const first = issueRawSubjectRef(scope, raw);
        const repeated = issueRawSubjectRef(scope, raw);
        f.capture(["topic:late"]);
        return [first, repeated, issueRawSubjectRef(scope, raw)];
      })
      .immediate();
    expect(answers[0]).toBeNull();
    expect(answers[1]).toBeNull();
    expect(answers[2]?.kind).toBe("raw_subject");
  } finally {
    f.dispose();
  }
});

test("a token packet issues each source's subjects with one membership write per transaction", async () => {
  const f = subjectScene();
  try {
    const subjects = ["topic:a", "topic:b", "topic:c", "topic:d"];
    for (let index = 0; index < 6; index += 1)
      f.capture(subjects.slice(index % 2, (index % 2) + 3));
    const reader = f.reader("reader-packet");
    // The reader's first packet, so every reference is allocated in this call.
    const query = spyOn(f.db, "query");
    try {
      const envelope = await dispatchServeTool(
        reader,
        "context_packet",
        { budget_tokens: 2_000, ...WINDOW },
        { response_contract: "kizuki.envelope/v2" },
      );
      const quoted = envelope.quoted as readonly {
        subjects: readonly unknown[];
      }[];
      expect(quoted.length).toBeGreaterThan(1);
      expect(quoted.every((chunk) => chunk.subjects.length === 3)).toBe(true);
      const sql = query.mock.calls.map(([text]) => String(text));
      // Pieces, the served view and the sealed envelope: one transaction each.
      expect(
        sql.filter((text) =>
          text.includes("INSERT OR IGNORE INTO world_wire_raw_subject_members"),
        ).length,
      ).toBeLessThanOrEqual(3);
      expect(
        sql.filter((text) => text.startsWith("SELECT 1 FROM events WHERE events.connector_id=?"))
          .length,
      ).toBe(0);
    } finally {
      query.mockRestore();
    }
  } finally {
    f.dispose();
  }
});

function pagesScene(count: number) {
  const vault = tempVault();
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  const seeded = seedLivePages(db, vault.path, count);
  db.exec("CREATE TABLE graph_fixture_writes(value TEXT)");
  const ctx: ServeContext = { db, vaultPath: vault.path, principal: OWNER };
  return { db, vault, seeded, ctx, grant: structuredClone(OWNER_AGENT_GRANT) as Grant, dispose() { db.close(); vault.dispose(); } };
}

test("the class-scoped graph pass reuses the call's decisions only for unchanged pages in an unchanged ledger", () => {
  const f = pagesScene(6);
  const decide = spyOn(canon, "pageDecision");
  try {
    const index = canon.loadCanon(f.ctx);
    const calls = new CallDecisions(index, f.grant);
    for (const page of index.pages) calls.decide(page);
    expect(decide).toHaveBeenCalledTimes(6);

    decide.mockClear();
    const live = canon.loadCanon(f.ctx);
    const reused = calls.graphScope(live, f.grant);
    expect(decide).toHaveBeenCalledTimes(0);
    expect(reused).toEqual(graphServingScope(live, f.grant));

    // A page rewritten on disk with bytes that no receipt records is decided
    // again, and withheld; the other five keep their decisions.
    const edited = f.seeded[2]!;
    writeFileSync(
      join(f.vault.path, edited.relPath),
      serializePage({
        data: {
          id: edited.id,
          title: "Edited",
          type: "fact",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
          sources: [edited.sourceId],
        },
        body: "Edited outside the writer.",
      }),
    );
    decide.mockClear();
    const changed = canon.loadCanon(f.ctx);
    const partly = calls.graphScope(changed, f.grant);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(partly).toEqual(graphServingScope(changed, f.grant));
    expect(partly.excludedPageIds).toContain(edited.id);

    // Any ledger write after the first decision: every page is decided afresh.
    f.db.query("INSERT INTO graph_fixture_writes(value) VALUES ('unrelated')").run();
    decide.mockClear();
    const after = canon.loadCanon(f.ctx);
    const fresh = calls.graphScope(after, f.grant);
    expect(decide.mock.calls.length).toBeGreaterThanOrEqual(after.pages.length);
    expect(fresh).toEqual(graphServingScope(after, f.grant));
  } finally {
    decide.mockRestore();
    f.dispose();
  }
});

test("phase reuse compares page bodies as strings and decides a changed body again", () => {
  const vault = tempVault();
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  try {
    seedLivePages(db, vault.path, 2, {
      body: (index) => `Distinctive body ${index} for the phase key.`,
    });
    const ctx: ServeContext = { db, vaultPath: vault.path, principal: OWNER };
    const index = canon.loadCanon(ctx);
    const grant = structuredClone(OWNER_AGENT_GRANT);
    const access = new CanonAccessPhase(index, grant);
    const page = index.pages[0]!;
    const stringify = spyOn(JSON, "stringify");
    let serializedBody = false;
    try {
      expect(access.decision(page)).toEqual(
        canon.pageDecision(index, grant, page),
      );
      expect(access.decision(page).allow).toBe(true);
      serializedBody = stringify.mock.calls.some(
        ([value]) => Array.isArray(value) && value.includes(page.body),
      );
    } finally {
      stringify.mockRestore();
    }
    expect(serializedBody).toBe(false);
    // The class fallback reads body bytes: a body that now carries a
    // credential is decided again rather than served from the earlier key.
    page.body = "api_key = sk-test-000000000000000000000000000000";
    expect(access.decision(page)).toEqual(
      canon.pageDecision(index, grant, page),
    );
  } finally {
    db.close();
    vault.dispose();
  }
});

/** A capture in the reader's own source that its ceiling hides, naming its subjects and one more. */
function sameSourceScene(): () => Promise<NoninterferenceScene> {
  return async () => {
    const scene = await hiddenScene();
    const { sourceKey } = scene.visible.concept;
    const stored = accept(
      scene.db,
      {
        ...validEvent(),
        connector_id: "world.fixture",
        source_record_id: ulid(),
        kind: "note",
        text: "Bayesian launch notes for the visible subjects.",
        sensitivity_hint: "public",
        subjects: [
          { subject_id: "topic:bayes", role: "about" },
          { subject_id: "project:launch", role: "about" },
        ],
      },
      { source: { source_key: sourceKey, expected_revision: 1 } },
    );
    if (stored.status !== "stored")
      throw new Error(`visible capture: ${stored.status}`);
    return scene;
  };
}

test("hidden captures in the reader's own source leave packet and search bytes and work unchanged", async () => {
  const cases = (): ReadCase[] => [
    {
      name: "context_packet",
      run: (ctx) =>
        dispatchServeTool(
          ctx,
          "context_packet",
          { query: "Bayesian", budget_tokens: 2_000 },
          { response_contract: "kizuki.envelope/v2" },
        ),
    },
    {
      name: "context_packet (timeline)",
      run: (ctx) =>
        dispatchServeTool(
          ctx,
          "context_packet",
          { budget_tokens: 2_000, ...WINDOW },
          { response_contract: "kizuki.envelope/v2" },
        ),
    },
    {
      name: "search",
      run: (ctx) =>
        dispatchServeTool(
          ctx,
          "search",
          { query: "Bayesian", scope: "all" },
          { response_contract: "kizuki.envelope/v2" },
        ),
    },
  ];
  const hiddenCapture = (subjects: readonly string[]) => ({
    name: `hidden capture naming ${subjects.join(", ")}`,
    apply(scene: NoninterferenceScene) {
      const stored = accept(
        scene.db,
        {
          ...validEvent(),
          connector_id: "world.fixture",
          source_record_id: ulid(),
          kind: "note",
          text: "Bayesian private notes.",
          sensitivity_hint: "private",
          subjects: subjects.map((subject_id) => ({
            subject_id,
            role: "about",
          })),
        },
        {
          source: {
            source_key: scene.visible.concept.sourceKey,
            expected_revision: 1,
          },
        },
      );
      if (stored.status !== "stored")
        throw new Error(`hidden capture: ${stored.status}`);
    },
  });
  setSystemTime(new Date("2026-09-30T12:00:00Z"));
  const leaks = await checkNoninterference({
    scene: sameSourceScene(),
    cases,
    mutations: [
      hiddenCapture(["topic:bayes", "project:launch", "topic:secret"]),
      hiddenCapture(["topic:secret"]),
    ],
  });
  expect(leaks).toEqual([]);
});

test("a v2 packet projects its served canon chunks against one canon load per transaction", async () => {
  const live = await serveFixture();
  const project = spyOn(chunks, "projectCanonChunk");
  try {
    const envelope = await dispatchServeTool(live.agent("reader-private"), "context_packet",
      { query: "kettle", budget_tokens: 2_000, include: ["canon"] }, { response_contract: "kizuki.envelope/v2" });
    expect(envelope.canon.length).toBeGreaterThan(0);
    expect(project.mock.calls.length).toBeGreaterThan(0);
    // Without an index each chunk would walk and load the vault again.
    expect(project.mock.calls.every(call => call[2] !== undefined)).toBe(true);
  } finally { project.mockRestore(); live.dispose(); }
});
