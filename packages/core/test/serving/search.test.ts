import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MAX_RETRIEVAL_LIMIT } from "../../src/contracts/retrieval";
import { rebuildDerived } from "../../src/derived";
import { stampDerived } from "../../src/derived-meta";
import { registerConnection } from "../../src/ledger/connections";
import { accept } from "../../src/ledger/ledger";
import { revokeSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { search, searchAuditCandidates } from "../../src/search/query";
import { serveGetPage } from "../../src/serving/page";
import { serveSearch } from "../../src/serving/search";
import type { SearchData } from "../../src/serving/search";
import { ServeError } from "../../src/serving/types";
import type { Envelope } from "../../src/serving/types";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { recordedPage } from "../helpers/recorded-page";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await serveFixture();
});

afterAll(() => {
  fixture.dispose();
});

function pageIds(envelope: Envelope<SearchData>): string[] {
  return envelope.canon.map((chunk) => chunk.page_id).sort();
}

function eventIds(envelope: Envelope<SearchData>): string[] {
  return envelope.quoted.map((chunk) => chunk.event_id).sort();
}

async function refusal(run: () => unknown): Promise<ServeError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error("expected a ServeError");
}

describe("serveSearch enforces the grant below the prompt layer", () => {
  test("the sensitivity ceiling decides which canon pages exist", async () => {
    const personal = (await serveSearch(fixture.agent("reader-personal"), {
      query: "kettle",
    }));
    expect(pageIds(personal)).not.toContain("fact:kettle");
    expect(personal.denied).toEqual([]);
    expect("has_withheld" in personal).toBe(false);

    const priv = (await serveSearch(fixture.agent("reader-private"), {
      query: "kettle",
    }));
    expect(pageIds(priv)).toContain("fact:kettle");
    // The shared fixture keeps unlabeled and unstamped notes so those
    // withhold paths stay covered; the scan reports them and search names
    // the incomplete index instead of pretending the walk was clean.
    expect(priv.data).toEqual({ degraded: ["index-degraded"] });
  });

  test("an unlabeled page is withheld from every principal, owner included", async () => {
    for (const ctx of [
      fixture.owner(),
      fixture.agent("reader-private"),
      fixture.agent("reader-public"),
    ]) {
      const envelope = (await serveSearch(ctx, { query: "kettle" }));
      expect(pageIds(envelope)).not.toContain("fact:unlabeled");
      expect(envelope.denied).not.toContainEqual({
        reason: "missing_sensitivity",
        count: 1,
      });
    }
  });

  test("held and archived pages are never served", async () => {
    const envelope = (await serveSearch(fixture.owner(), { query: "kettle" }));
    expect(pageIds(envelope)).not.toContain("fact:archived");
    expect(
      envelope.canon.some((chunk) => chunk.path === fixture.heldPath),
    ).toBe(false);
  });

  test("a withheld page leaks neither its id nor its title", async () => {
    const envelope = (await serveSearch(fixture.agent("reader-personal"), {
      query: "kettle",
    }));
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("fact:kettle");
    expect(json).not.toContain("Kettle protocol");
    expect(envelope.denied).toEqual([]);
  });

  test("ledger hits arrive as quoted capture stamped tainted", async () => {
    const envelope = (await serveSearch(fixture.agent("reader-private"), {
      query: "kettle",
      scope: "ledger",
    }));
    expect(envelope.quoted.length).toBeGreaterThan(0);
    expect(envelope.quoted.every((chunk) => chunk.tainted === true)).toBe(true);
    expect(envelope.canon).toEqual([]);
    expect(eventIds(envelope)).toContain(fixture.events["public"] as string);
  });

  test("a tombstoned record is never quoted", async () => {
    const envelope = (await serveSearch(fixture.owner(), {
      query: "retracted",
      scope: "all",
    }));
    expect(eventIds(envelope)).not.toContain(
      fixture.events["tombstoned"] as string,
    );
  });

  test("an unhinted event is counted as missing_sensitivity", async () => {
    const envelope = (await serveSearch(fixture.agent("reader-private"), {
      query: "unhinted",
      scope: "ledger",
    }));
    expect(envelope.quoted).toEqual([]);
    expect(envelope.denied).toEqual([]);
    expect("has_withheld" in envelope).toBe(false);

    const owner = (await serveSearch(fixture.owner(), {
      query: "unhinted",
      scope: "ledger",
    }));
    expect(owner.has_withheld).toBe(true);
    expect(owner.denied).toEqual([
      { reason: "missing_sensitivity", count: 1 },
    ]);
  });

  test("a types-scoped grant sees only its own page type", async () => {
    const ctx = fixture.agent("typed");
    const envelope = (await serveSearch(ctx, { query: "kettle" }));
    expect(envelope.canon.every((chunk) => chunk.type === "person")).toBe(true);
    expect(
      (await refusal(async () => (await serveSearch(ctx, { query: "kettle", types: ["fact"] }))))
        .code,
    ).toBe("type_out_of_scope");
  });

  test("a subjects-scoped grant only sees pages about its subject", async () => {
    const envelope = (await serveSearch(fixture.agent("subjected"), {
      query: "kettle",
    }));
    expect(
      envelope.canon.every((chunk) => chunk.subjects.includes("person:ada")),
    ).toBe(true);
    expect(pageIds(envelope)).not.toContain("person:grace");
    expect(
      (await refusal(async () =>
        (await serveSearch(fixture.agent("subjected"), {
          query: "kettle",
          subjects: ["person:grace"],
        })),
      )).code,
    ).toBe("subject_out_of_scope");
  });

  test("the served window is the intersection of grant and request", async () => {
    const envelope = (await serveSearch(fixture.agent("windowed"), {
      query: "kettle",
      scope: "ledger",
    }));
    expect(eventIds(envelope)).toEqual(
      [
        fixture.events["personal"] as string,
        fixture.events["private"] as string,
      ].sort(),
    );
  });

  test("out-of-range arguments are refused before any read", async () => {
    const ctx = fixture.agent("reader-private");
    expect(
      (await refusal(async () => (await serveSearch(ctx, { query: "kettle", limit: 51 })))).code,
    ).toBe("invalid_arguments");
    expect(
      (await refusal(async () => (await serveSearch(ctx, { query: "k".repeat(513) })))).code,
    ).toBe("invalid_arguments");
  });

  test("a query with no usable token is an empty answer, not an error", async () => {
    const envelope = (await serveSearch(fixture.agent("reader-private"), {
      query: "***",
    }));
    expect(envelope.canon).toEqual([]);
    expect(envelope.quoted).toEqual([]);
    expect(envelope.denied).toEqual([]);
    expect(envelope.data).toEqual({ degraded: ["query-empty"] });
  });

  test("a degraded search index is named on the envelope", async () => {
    const isolated = await serveFixture();
    try {
      isolated.db.exec("DROP TABLE search_docs");
      stampDerived(isolated.db, {
        layer: "search",
        generation: "schema-v10",
        rebuilt_at: "2026-03-01T00:00:00.000Z",
        doc_count: 0,
        source_count: 0,
        skipped_count: 0,
        status: "degraded",
      });
      const envelope = (await serveSearch(isolated.owner(), { query: "kettle" }));
      expect(envelope.canon).toEqual([]);
      expect(envelope.quoted).toEqual([]);
      expect(envelope.data).toEqual({
        degraded: ["index-degraded"],
      });
    } finally {
      isolated.dispose();
    }
  });

  test("a page carrying capture is served as canon, stamped as capture", async () => {
    const envelope = (await serveSearch(fixture.agent("reader-public"), {
      query: "disregard",
    }));
    // The page is produced canon that quotes a record, so it stays in the
    // canon field; the stamp is what tells a reader the body holds capture.
    expect(pageIds(envelope)).toEqual(["fact:quoted"]);
    expect(envelope.canon[0]?.taint).toBe("quoted");
    expect(envelope.quoted).toEqual([]);

    const prose = (await serveSearch(fixture.agent("reader-public"), {
      query: "kettles",
    }));
    expect(pageIds(prose)).toEqual(["org:acme"]);
    expect(prose.canon[0]?.taint).toBe("clean");
  });

  test("a page with no taint stamp is served to nobody, the owner included", async () => {
    for (const ctx of [fixture.owner(), fixture.agent("reader-private")]) {
      const envelope = (await serveSearch(ctx, { query: "nobody stamped" }));
      expect(pageIds(envelope)).toEqual([]);
      expect(envelope.denied).toEqual([]);
    }
    // Named directly it is absent: the scan withheld it before serving.
    expect(serveGetPage(fixture.owner(), { id: "fact:untainted" }).denied).toEqual(
      [],
    );
    expect(serveGetPage(fixture.owner(), { id: "fact:untainted" }).canon).toEqual(
      [],
    );
  });

  test("a withheld match past the limit stays unnamed on the agent envelope", async () => {
    const isolated = await serveFixture();
    try {
      const source = isolated.events["public"] as string;
      const token = "zzzwalltoken";
      await recordedPage(
        isolated.db,
        isolated.vaultPath,
        "facts/zzza.md",
        {
          sources: [source],
          id: "fact:zzza",
          title: "Aaa zzzwalltoken",
          type: "fact",
          status: "active",
          sensitivity: "public",
          taint: "clean",
          subjects: ["person:ada"],
        },
        token,
      );
      await recordedPage(
        isolated.db,
        isolated.vaultPath,
        "facts/zzzb.md",
        {
          sources: [source],
          id: "fact:zzzb",
          title: "Bbb zzzwalltoken",
          type: "fact",
          status: "active",
          sensitivity: "private",
          taint: "clean",
          subjects: ["person:ada"],
        },
        token,
      );
      await recordedPage(
        isolated.db,
        isolated.vaultPath,
        "facts/zzzc.md",
        {
          sources: [source],
          id: "fact:zzzc",
          title: "Ccc zzzwalltoken",
          type: "fact",
          status: "active",
          sensitivity: "public",
          taint: "clean",
          subjects: ["person:ada"],
        },
        token,
      );
      rebuildDerived(isolated.db, isolated.vaultPath);

      const envelope = await serveSearch(isolated.agent("reader-public"), {
        query: token,
        limit: 1,
      });
      expect(pageIds(envelope)).toEqual(["fact:zzza"]);
      expect(envelope.denied).toEqual([]);
      expect("has_withheld" in envelope).toBe(false);
      expect(JSON.stringify(envelope)).not.toContain("fact:zzzb");
      expect(JSON.stringify(envelope)).not.toContain("Bbb zzzwalltoken");
    } finally {
      isolated.dispose();
    }
  });
});

const SOURCE_STARVE_TOKEN = "sourcewalltoken";
const CANON_STARVE_TOKEN = "canonwalltoken";
const MIXED_STARVE_TOKEN = "mixedwalltoken";

function recallPolicy(purposes: string[]) {
  return {
    purposes,
    allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked" as const,
    egress: "local_only" as const,
    sensitivity_floor: "public" as const,
  };
}

function grantSource(live: Fixture, sourceKey: string, operation: string, purposes: string[]) {
  registerConnection(live.db, "fixture", sourceKey);
  setSourceGrant(live.db, {
    source_key: sourceKey,
    expected_revision: 0,
    operation_id: operation,
    policy: recallPolicy(purposes),
  });
}

async function recordedStarvePage(
  live: Fixture,
  relPath: string,
  id: string,
  title: string,
  sourceId: string,
  token: string,
) {
  await recordedPage(
    live.db,
    live.vaultPath,
    relPath,
    {
      sources: [sourceId],
      id,
      title,
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: ["person:ada"],
    },
    token,
  );
}

function boundEvent(
  live: Fixture,
  sourceKey: string,
  sourceRecordId: string,
  occurredAt: string,
) {
  const result = accept(
    live.db,
    {
      ...validEvent(),
      source_record_id: sourceRecordId,
      occurred_at: occurredAt,
      text: SOURCE_STARVE_TOKEN,
      sensitivity_hint: "public",
    },
    { source: { source_key: sourceKey, expected_revision: 1 } },
  );
  if (result.status !== "stored") {
    throw new Error(`expected stored event, got ${result.status}`);
  }
  return result.event.event_id;
}

describe("serveSearch authorization starvation", () => {
  test("source-policy is not starved by more than 100 earlier denied ledger hits", async () => {
    const live = await serveFixture();
    try {
      const deniedKey = ulid();
      const allowedKey = ulid();
      grantSource(live, deniedKey, "grant-denied-source", ["capture"]);
      grantSource(live, allowedKey, "grant-allowed-source", [
        "capture",
        "recall",
        "session",
      ]);
      const denied: string[] = [];
      for (let index = 0; index < MAX_RETRIEVAL_LIMIT + 1; index += 1) {
        denied.push(
          boundEvent(
            live,
            deniedKey,
            `rec-denied-${index}`,
            `2026-02-28T${String(7 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
          ),
        );
      }
      const allowed = boundEvent(
        live,
        allowedKey,
        "rec-allowed-later",
        "2026-02-28T16:00:00Z",
      );
      rebuildDerived(live.db, live.vaultPath);

      const prefix = searchAuditCandidates(live.db, SOURCE_STARVE_TOKEN, {
        scope: "ledger",
        limit: MAX_RETRIEVAL_LIMIT,
      });
      expect(prefix.candidates).toHaveLength(MAX_RETRIEVAL_LIMIT);
      expect(
        prefix.candidates.some((hit) => hit.doc_id === `event:${allowed}`),
      ).toBe(false);
      expect(
        search(live.db, SOURCE_STARVE_TOKEN, {
          ceiling: "private",
          scope: "ledger",
          limit: 1,
        })[0]?.doc_id,
      ).not.toBe(`event:${allowed}`);

      const ranked = searchAuditCandidates(live.db, SOURCE_STARVE_TOKEN, {
        scope: "ledger",
        limit: MAX_RETRIEVAL_LIMIT,
        source: { owner: false, purpose: "recall" },
      });
      expect(ranked.candidates.map((hit) => hit.doc_id)).toEqual([
        `event:${allowed}`,
      ]);

      const envelope = await serveSearch(live.agent("reader-private"), {
        query: SOURCE_STARVE_TOKEN,
        scope: "all",
        limit: 1,
      });
      expect(eventIds(envelope)).toEqual([allowed]);
      expect(envelope.canon).toEqual([]);
      expect(envelope.denied).toEqual([]);
      const rendered = JSON.stringify(envelope);
      expect(rendered).toContain(allowed);
      for (const id of denied) {
        expect(rendered).not.toContain(id);
      }
    } finally {
      live.dispose();
    }
  }, 20_000);

  test("source-policy is not starved by exactly 101 earlier denied canon pages", async () => {
    const live = await serveFixture();
    try {
      const deniedKey = ulid();
      const allowedKey = ulid();
      grantSource(live, deniedKey, "grant-denied-canon-source", ["capture", "derive"]);
      grantSource(live, allowedKey, "grant-allowed-canon-source", [
        "capture",
        "recall",
        "session",
        "derive",
      ]);
      const deniedEvent = boundEvent(
        live,
        deniedKey,
        "rec-denied-canon",
        "2026-02-28T07:00:00Z",
      );
      const allowedEvent = boundEvent(
        live,
        allowedKey,
        "rec-allowed-canon",
        "2026-02-28T16:00:00Z",
      );
      const denied: string[] = [];
      for (let index = 0; index < MAX_RETRIEVAL_LIMIT + 1; index += 1) {
        const label = String(index).padStart(3, "0");
        const id = `fact:canonstarve-${label}`;
        denied.push(id);
        await recordedStarvePage(
          live,
          `facts/canonstarve-${label}.md`,
          id,
          `${CANON_STARVE_TOKEN} ${CANON_STARVE_TOKEN} Aaa`,
          deniedEvent,
          CANON_STARVE_TOKEN,
        );
      }
      const allowedId = "fact:canonstarve-allowed";
      await recordedStarvePage(
        live,
        "facts/canonstarve-allowed.md",
        allowedId,
        `${CANON_STARVE_TOKEN} Zzz`,
        allowedEvent,
        CANON_STARVE_TOKEN,
      );
      rebuildDerived(live.db, live.vaultPath);

      const prefix = searchAuditCandidates(live.db, CANON_STARVE_TOKEN, {
        scope: "canon",
        limit: MAX_RETRIEVAL_LIMIT,
      });
      expect(prefix.candidates).toHaveLength(MAX_RETRIEVAL_LIMIT);
      expect(prefix.candidates.some((hit) => hit.doc_id === `page:${allowedId}`)).toBe(false);
      expect(
        search(live.db, CANON_STARVE_TOKEN, {
          ceiling: "private",
          scope: "canon",
          limit: 1,
        })[0]?.doc_id,
      ).not.toBe(`page:${allowedId}`);

      const ranked = searchAuditCandidates(live.db, CANON_STARVE_TOKEN, {
        scope: "canon",
        limit: MAX_RETRIEVAL_LIMIT,
        source: { owner: false, purpose: "recall" },
      });
      expect(ranked.candidates).toHaveLength(MAX_RETRIEVAL_LIMIT);
      expect(ranked.candidates.some((hit) => hit.doc_id === `page:${allowedId}`)).toBe(false);

      const continued = searchAuditCandidates(live.db, CANON_STARVE_TOKEN, {
        scope: "canon",
        limit: MAX_RETRIEVAL_LIMIT,
        offset: MAX_RETRIEVAL_LIMIT,
        source: { owner: false, purpose: "recall" },
      });
      expect(continued.candidates.some((hit) => hit.doc_id === `page:${allowedId}`)).toBe(true);

      const envelope = await serveSearch(live.agent("reader-private"), {
        query: CANON_STARVE_TOKEN,
        scope: "canon",
        limit: 1,
      });
      expect(pageIds(envelope)).toEqual([allowedId]);
      expect(envelope.quoted).toEqual([]);
      expect(envelope.denied).toEqual([]);
      expect("has_withheld" in envelope).toBe(false);
      const rendered = JSON.stringify(envelope);
      expect(rendered).toContain(allowedId);
      expect(rendered).not.toContain(deniedEvent);
      for (const id of denied) {
        expect(rendered).not.toContain(id);
      }

      const owner = await serveSearch(live.owner(), {
        query: CANON_STARVE_TOKEN,
        scope: "canon",
        limit: 1,
      });
      expect(pageIds(owner)).toEqual([allowedId]);
      expect(owner.has_withheld).toBe(true);
      expect(owner.denied).toEqual([{ reason: "held", count: MAX_RETRIEVAL_LIMIT + 1 }]);
      const ownerJson = JSON.stringify(owner);
      expect(ownerJson).not.toContain(deniedEvent);
      for (const id of denied) {
        expect(ownerJson).not.toContain(id);
      }
    } finally {
      live.dispose();
    }
  }, 120_000);

  test("mixed allowed and revoked live provenance never leaks even when FTS looks allowed", async () => {
    const live = await serveFixture();
    try {
      const allowedKey = ulid();
      const revokedKey = ulid();
      grantSource(live, allowedKey, "grant-mixed-allowed", [
        "capture",
        "recall",
        "session",
        "derive",
      ]);
      grantSource(live, revokedKey, "grant-mixed-revoked", [
        "capture",
        "recall",
        "session",
        "derive",
      ]);
      const allowedEvent = boundEvent(
        live,
        allowedKey,
        "rec-mixed-allowed",
        "2026-02-28T07:00:00Z",
      );
      const revokedEvent = boundEvent(
        live,
        revokedKey,
        "rec-mixed-revoked",
        "2026-02-28T08:00:00Z",
      );
      const mixedId = "fact:mixedwall-aaa";
      const allowedId = "fact:mixedwall-zzz";
      await recordedPage(
        live.db,
        live.vaultPath,
        "facts/mixedwall-aaa.md",
        {
          sources: [allowedEvent, revokedEvent],
          id: mixedId,
          title: `${MIXED_STARVE_TOKEN} ${MIXED_STARVE_TOKEN} Aaa`,
          type: "fact",
          status: "active",
          sensitivity: "public",
          taint: "clean",
          subjects: ["person:ada"],
        },
        MIXED_STARVE_TOKEN,
      );
      await recordedStarvePage(
        live,
        "facts/mixedwall-zzz.md",
        allowedId,
        `${MIXED_STARVE_TOKEN} Zzz`,
        allowedEvent,
        MIXED_STARVE_TOKEN,
      );
      rebuildDerived(live.db, live.vaultPath);
      revokeSourceGrant(live.db, {
        source_key: revokedKey,
        expected_revision: 1,
        operation_id: "revoke-mixed-source",
      });
      const mixedDoc = `page:${mixedId}`;
      const stale = JSON.stringify([allowedEvent]);
      const columns = `doc_id, scope, title, body, path, page_type, sensitivity,
       taint, authority, occurred_at, connector_id, subjects, provenance`;
      live.db.query("UPDATE search_documents SET provenance = ? WHERE doc_id = ?").run(stale, mixedDoc);
      live.db.query("DELETE FROM search_docs WHERE doc_id = ?").run(mixedDoc);
      live.db.query(
        `INSERT INTO search_docs (${columns}) SELECT ${columns} FROM search_documents WHERE doc_id = ?`,
      ).run(mixedDoc);

      const ranked = searchAuditCandidates(live.db, MIXED_STARVE_TOKEN, {
        scope: "canon",
        limit: MAX_RETRIEVAL_LIMIT,
        source: { owner: false, purpose: "recall" },
      });
      expect(ranked.candidates.some((hit) => hit.doc_id === mixedDoc)).toBe(true);

      for (const ctx of [live.agent("reader-private"), live.owner()]) {
        const envelope = await serveSearch(ctx, {
          query: MIXED_STARVE_TOKEN,
          scope: "all",
          limit: 2,
        });
        expect(pageIds(envelope)).toEqual([allowedId]);
        expect(envelope.quoted).toEqual([]);
        if (ctx.principal.kind === "agent") {
          expect(envelope.denied).toEqual([]);
          expect("has_withheld" in envelope).toBe(false);
        }
        const rendered = JSON.stringify(envelope);
        expect(rendered).toContain(allowedId);
        expect(rendered).not.toContain(mixedId);
        expect(rendered).not.toContain(revokedEvent);
      }
    } finally {
      live.dispose();
    }
  }, 20_000);
});
