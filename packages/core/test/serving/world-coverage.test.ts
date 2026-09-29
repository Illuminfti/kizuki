import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  OWNER_AGENT_GRANT,
  addAgent,
  authenticate,
} from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { advanceExtractCheckpoint } from "../../src/serve/extract-checkpoint";
import { readWorldView, WorldViewError } from "../../src/serving/world-view";
import type { ServeContext } from "../../src/serving/types";
import { worldFixture } from "./world-fixture";

type Page = {
  schema: string;
  matches: { ref: { kind: "object"; token: string }; labels: string[] }[];
  cursor: string | null;
  coverage: { status: string; gaps: string[] };
};

function find(
  ctx: ServeContext,
  label: string,
  extra: Record<string, unknown> = {},
  operation = "find_concepts",
) {
  const result = readWorldView(ctx, {
    operation,
    label,
    ...extra,
    valid: { kind: "all" },
    knownAt: { kind: "current" },
  });
  if ("status" in result || result.result.status === "unavailable")
    throw new Error("discovery unavailable");
  return {
    status: result.result.status,
    page: result.result.data as unknown as Page,
  };
}

function card(ctx: ServeContext, ref: { kind: "object"; token: string }) {
  const result = readWorldView(ctx, {
    operation: "concept",
    concept: ref,
    valid: { kind: "all" },
    knownAt: { kind: "current" },
  });
  if ("status" in result || result.result.status === "unavailable")
    throw new Error("card unavailable");
  return {
    status: result.result.status,
    coverage: (result.result.data as unknown as Page).coverage,
  };
}

function checkpoint(
  db: Database,
  connector: string,
  sourceKey: string,
  state: { backfillComplete: boolean; errors?: string[] },
) {
  const now = new Date().toISOString();
  const result = JSON.stringify({
    stored: 1,
    duplicates: 0,
    errors: state.errors ?? [],
    proposals_created: 0,
    withdrawn: 0,
    retractions_filed: 0,
    cursor: null,
  });
  db.query(
    `INSERT INTO checkpoints
       (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result, backfill_complete, backfill_cursor, sync_cursor)
     VALUES (?, ?, NULL, 'sync', ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT (connector_id, source_key) DO UPDATE SET last_result = excluded.last_result,
       backfill_complete = excluded.backfill_complete`,
  ).run(connector, sourceKey, now, now, result, state.backfillComplete ? 1 : 0);
}

function allowExtraction(db: Database, sourceKey: string, revision: number) {
  setSourceGrant(db, {
    source_key: sourceKey,
    expected_revision: revision,
    operation_id: `extract-${sourceKey}-${revision}`,
    policy: {
      purposes: [
        "capture",
        "derive",
        "recall",
        "correction",
        "export",
        "extract",
      ],
      allowed_fields: ["text", "subjects", "metadata", "attachments"],
      retention: "persistent_owned_until_revoked",
      egress: "local_only",
      sensitivity_floor: "public",
    },
  });
}

test("label discovery folds case and Unicode consistently", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db);
    const strasse = await worldFixture(db, {
      sourceKey: f.sourceKey,
      subject: "topic:street",
      label: "Straße",
    });
    for (const query of ["Bayesian", "bayesian", "BAYESIAN", "aYeS"])
      expect(find(f.ctx, query).page.matches.map((m) => m.ref.token)).toEqual([
        f.ref.token,
      ]);
    expect(find(f.ctx, "STRASSE").page.matches.map((m) => m.ref.token)).toEqual(
      [strasse.ref.token],
    );
    expect(find(f.ctx, "strasse").page.matches).toHaveLength(1);
    expect(find(f.ctx, "frequentist").page.matches).toEqual([]);
    expect(find(f.ctx, "").page.matches).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("label discovery pages past the first page with an opaque cursor", async () => {
  const db = openLedger(":memory:");
  try {
    const first = await worldFixture(db, {
      label: "Topic 00",
      subject: "topic:0",
    });
    for (let i = 1; i < 35; i += 1)
      await worldFixture(db, {
        sourceKey: first.sourceKey,
        label: `Topic ${String(i).padStart(2, "0")}`,
        subject: `topic:${i}`,
      });
    const one = find(first.ctx, "topic");
    expect(one.page.matches).toHaveLength(32);
    expect(one.page.cursor).not.toBeNull();
    expect(one.status).toBe("incomplete");
    expect(one.page.coverage.gaps).toContain("traversal_limit");
    const two = find(first.ctx, "TOPIC", { cursor: one.page.cursor });
    expect(two.page.matches).toHaveLength(3);
    expect(two.page.cursor).toBeNull();
    expect(two.status).toBe("current");
    const tokens = [...one.page.matches, ...two.page.matches].map(
      (m) => m.ref.token,
    );
    expect(new Set(tokens).size).toBe(35);
    expect(JSON.stringify(one.page.cursor)).not.toContain(first.sourceKey);
  } finally {
    db.close();
  }
});

test("a cursor is bound to the principal that received it and to discovery", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db);
    const cursor = find(f.ctx, "bayes").page.matches[0]!.ref.token;
    const agent = addAgent(db, "cursor-reader", { ...OWNER_AGENT_GRANT });
    const ctx = { ...f.ctx, principal: authenticate(db, agent.token)! };
    expect(() => find(ctx, "bayes", { cursor })).toThrow(WorldViewError);
    expect(() => find(f.ctx, "bayes", { cursor: "not-a-token" })).toThrow(
      WorldViewError,
    );
    expect(() =>
      readWorldView(f.ctx, {
        operation: "concept",
        concept: f.ref,
        cursor,
        valid: { kind: "all" },
        knownAt: { kind: "current" },
      }),
    ).toThrow(WorldViewError);
  } finally {
    db.close();
  }
});

test("unfinished history import or a failed last run makes discovery and cards partial", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db);
    expect(find(f.ctx, "bayes").page.coverage).toMatchObject({
      status: "complete_for_query",
      gaps: [],
    });
    checkpoint(db, "world.fixture", f.sourceKey, { backfillComplete: false });
    const discovery = find(f.ctx, "bayes");
    expect(discovery.status).toBe("incomplete");
    expect(discovery.page.coverage).toMatchObject({
      status: "partial",
      gaps: ["coverage"],
    });
    expect(card(f.ctx, f.ref)).toMatchObject({
      status: "incomplete",
      coverage: { status: "partial", gaps: ["coverage"] },
    });
    checkpoint(db, "world.fixture", f.sourceKey, {
      backfillComplete: true,
      errors: ["provider unavailable"],
    });
    expect(card(f.ctx, f.ref).coverage.gaps).toEqual(["coverage"]);
    checkpoint(db, "world.fixture", f.sourceKey, { backfillComplete: true });
    expect(card(f.ctx, f.ref).coverage).toMatchObject({
      status: "complete_for_query",
      gaps: [],
    });
    expect(find(f.ctx, "bayes").status).toBe("current");
  } finally {
    db.close();
  }
});

test("an unconsumed extraction backlog is pending consolidation, even when discovery is empty", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db);
    allowExtraction(db, f.sourceKey, 1);
    const empty = find(f.ctx, "no such label");
    expect(empty.page.matches).toEqual([]);
    expect(empty.status).toBe("incomplete");
    expect(empty.page.coverage).toMatchObject({
      status: "partial",
      gaps: ["pending_consolidation"],
    });
    expect(card(f.ctx, f.ref).coverage.gaps).toEqual(["pending_consolidation"]);
    const event = db
      .query<{ accepted_at: string; event_id: string }, []>(
        "SELECT accepted_at,event_id FROM events ORDER BY accepted_at DESC, event_id DESC LIMIT 1",
      )
      .get()!;
    db.transaction(() =>
      advanceExtractCheckpoint(
        db,
        "extract",
        `${event.accepted_at}\t${event.event_id}`,
      ),
    ).immediate();
    expect(find(f.ctx, "no such label")).toMatchObject({
      status: "current",
      page: { coverage: { status: "complete_for_query", gaps: [] } },
    });
    db.query(
      "INSERT INTO extract_deferred_inputs (event_id,source_key,checked_revision,checked_binding_digest) VALUES (?,?,?,?)",
    ).run(event.event_id, f.sourceKey, 2, "0".repeat(64));
    expect(card(f.ctx, f.ref).coverage.gaps).toEqual(["pending_consolidation"]);
  } finally {
    db.close();
  }
});

test("a source that does not grant extraction is not an extraction backlog", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db);
    expect(find(f.ctx, "no such label").page.coverage.gaps).toEqual([]);
  } finally {
    db.close();
  }
});

test("a hidden source's backlog, failures and unfinished import change neither output nor error text", async () => {
  const db = openLedger(":memory:");
  try {
    const seen = await worldFixture(db, {
      subject: "topic:seen",
      label: "Seen idea",
    });
    const hidden = await worldFixture(db, {
      connector: "world.hidden",
      subject: "topic:hidden",
      label: "Hidden idea",
    });
    const agent = addAgent(db, "scoped-reader", {
      ...OWNER_AGENT_GRANT,
      subjects: ["topic:seen"],
    });
    const ctx = { ...seen.ctx, principal: authenticate(db, agent.token)! };
    const view = () => {
      const discovery = find(ctx, "idea"),
        empty = find(ctx, "nothing"),
        token = discovery.page.matches[0]!.ref;
      let error = "";
      try {
        card(ctx, { kind: "object", token: hidden.ref.token });
      } catch (caught) {
        error = String(caught);
      }
      return JSON.stringify([discovery, empty, card(ctx, token), error]);
    };
    const before = view();
    expect(JSON.parse(before)[0].page.matches).toHaveLength(1);
    checkpoint(db, "world.hidden", hidden.sourceKey, {
      backfillComplete: false,
      errors: ["hidden failure"],
    });
    allowExtraction(db, hidden.sourceKey, 1);
    expect(view()).toBe(before);
    expect(find(hidden.ctx, "nothing").page.coverage.gaps).toEqual([
      "coverage",
      "pending_consolidation",
    ]);
    // The visible source's own state still counts for the scoped reader.
    checkpoint(db, "world.fixture", seen.sourceKey, {
      backfillComplete: false,
    });
    expect(find(ctx, "nothing").page.coverage.gaps).toEqual(["coverage"]);
  } finally {
    db.close();
  }
});

test("situation discovery reports the same coverage gaps", async () => {
  const db = openLedger(":memory:");
  try {
    const f = await worldFixture(db, {
      kind: "situation",
      subject: "project:launch",
      label: "Launch",
    });
    checkpoint(db, "world.fixture", f.sourceKey, { backfillComplete: false });
    expect(
      find(f.ctx, "launch", {}, "find_situations").page.coverage.gaps,
    ).toEqual(["coverage"]);
    const read = JSON.stringify(
      readWorldView(f.ctx, {
        operation: "situation",
        situation: f.ref,
        valid: { kind: "all" },
        knownAt: { kind: "current" },
      }),
    );
    expect(read).toContain('"status":"incomplete"');
    expect(read).toContain('"gaps":["coverage"]');
  } finally {
    db.close();
  }
});
