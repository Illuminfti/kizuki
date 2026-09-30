import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent, authenticate, setGrant } from "../../src/agents";
import type { EventClass, Grant } from "../../src/agents";
import { validateAgentGrant } from "../../src/agents/identity";
import { getClaim, insertClaim } from "../../src/claims/store";
import { rebuildDerived } from "../../src/derived";
import { registerConnection } from "../../src/ledger/connections";
import { accept } from "../../src/ledger/ledger";
import { setSourceGrant, sourcePolicyEpoch } from "../../src/ledger/source-grants";
import { searchAuditCandidates } from "../../src/search/query";
import { timeline } from "../../src/query/timeline";
import { claimReader } from "../../src/serving/claims";
import { serveCorrect } from "../../src/serving/correct";
import { ServeError } from "../../src/serving/types";
import { serveContextPacket } from "../../src/serving/packet";
import { serveGetPage } from "../../src/serving/page";
import { serveSearch } from "../../src/serving/search";
import { serveTimeline } from "../../src/serving/timeline";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { claimInput, eventFacts } from "../claims/helpers";
import { recordedPage, serveFixture, storeEvent } from "./helpers";
import type { Fixture } from "./helpers";

setDefaultTimeout(30_000);

let fixture: Fixture;
let secret: string;
let plain: string;

const PRIVATE_READER: Grant = {
  ...OWNER_AGENT_GRANT,
  tools: [...OWNER_AGENT_GRANT.tools],
};

function addReader(name: string, patch: Partial<Grant> = {}): void {
  fixture.tokens[name] = addAgent(fixture.db, name, {
    ...PRIVATE_READER,
    ...patch,
  }).token;
}

beforeAll(async () => {
  fixture = await serveFixture();
  secret = storeEvent(
    fixture.db,
    "rec-secret",
    "2026-02-28T15:00:00Z",
    "the vault password = hunter2hunter2 lives in the kettle drawer",
    "person:ada",
    "personal",
  );
  plain = storeEvent(
    fixture.db,
    "rec-plain",
    "2026-02-28T15:30:00Z",
    "the plain kettle note",
    "person:ada",
    "personal",
  );
  await recordedPage(
    fixture.db,
    fixture.vaultPath,
    "facts/secret-page.md",
    {
      id: "fact:secret",
      title: "Vault kettle note",
      type: "fact",
      status: "active",
      sensitivity: "personal",
      taint: "clean",
      subjects: ["person:ada"],
      sources: [secret],
    },
    "The vault kettle note.",
  );
  await recordedPage(
    fixture.db,
    fixture.vaultPath,
    "facts/plain-page.md",
    {
      id: "fact:plain",
      title: "Plain kettle note",
      type: "fact",
      status: "active",
      sensitivity: "personal",
      taint: "clean",
      subjects: ["person:ada"],
      sources: [plain],
    },
    "The plain kettle page.",
  );
  rebuildDerived(fixture.db, fixture.vaultPath);
  addReader("cred-default");
  addReader("cred-open", { deny_classes: [] });
  addReader("cred-and-machine", {
    deny_classes: ["credential", "machine_exhaust"],
  });
});

afterAll(() => {
  fixture.dispose();
});


describe("credential-classed evidence", () => {
  test("is stamped, and the stamp is not part of the event", () => {
    const rows = fixture.db
      .query<{ event_id: string; class: string }, []>(
        "SELECT event_id, class FROM event_classes",
      )
      .all();
    expect(rows).toContainEqual({ event_id: secret, class: "credential" });
    expect(rows.some((row) => row.event_id === plain)).toBe(false);
  });

  test("search never returns it to a grant that did not opt in, and returns it to the owner", async () => {
    const seenBy = async (ctx: ReturnType<Fixture["agent"]>) => {
      const envelope = await serveSearch(ctx, {
        query: "kettle",
        scope: "all",
      });
      return {
        events: envelope.quoted.map((chunk) => chunk.event_id),
        pages: envelope.canon.map((chunk) => chunk.page_id),
      };
    };
    const byDefault = await seenBy(fixture.agent("cred-default"));
    expect(byDefault.events).toContain(plain);
    expect(byDefault.events).not.toContain(secret);
    expect(byDefault.pages).toContain("fact:plain");
    expect(byDefault.pages).not.toContain("fact:secret");

    for (const ctx of [fixture.agent("cred-open"), fixture.owner()]) {
      const seen = await seenBy(ctx);
      expect(seen.events).toContain(secret);
      expect(seen.pages).toContain("fact:secret");
    }
  });

  test("timeline, get_page and packet counts agree with search", async () => {
    const window = {
      since: "2026-02-28T15:00:00Z",
      until: "2026-02-28T16:00:00Z",
    };
    const ids = (envelope: { quoted: { event_id: string }[] }) =>
      envelope.quoted.map((chunk) => chunk.event_id);

    const timeline = serveTimeline(fixture.agent("cred-default"), window);
    expect(ids(timeline)).toEqual([plain]);
    expect(ids(serveTimeline(fixture.agent("cred-open"), window))).toEqual([
      secret,
      plain,
    ]);
    expect(ids(serveTimeline(fixture.owner(), window))).toEqual([
      secret,
      plain,
    ]);

    const packet = await serveContextPacket(fixture.agent("cred-default"), {
      ...window,
      budget_tokens: 2_000,
      include: ["timeline"],
    });
    expect(ids(packet)).toEqual([plain]);
    expect(packet.data?.sections.timeline).toBe(1);
    const open = await serveContextPacket(fixture.agent("cred-open"), {
      ...window,
      budget_tokens: 2_000,
      include: ["timeline"],
    });
    expect(open.data?.sections.timeline).toBe(2);

    expect(
      serveGetPage(fixture.agent("cred-default"), { id: "fact:secret" }).canon,
    ).toEqual([]);
    const audited = fixture.db
      .query<{ denied: string }, []>(
        "SELECT denied FROM agent_audit WHERE tool = 'get_page' ORDER BY at DESC, audit_id DESC LIMIT 1",
      )
      .get();
    expect(audited?.denied).toContain("class_denied");
    expect(
      serveGetPage(fixture.agent("cred-open"), { id: "fact:secret" }).canon,
    ).toHaveLength(1);
    expect(
      serveGetPage(fixture.owner(), { id: "fact:secret" }).canon,
    ).toHaveLength(1);
    expect(
      serveGetPage(fixture.agent("cred-default"), { id: "fact:plain" }).canon,
    ).toHaveLength(1);
  });

  test("a claim citing it inherits the class", async () => {
    const stored = await insertClaim(
      { db: fixture.db },
      claimInput(secret, {
        body: "The vault password lives in the drawer.",
        object: "drawer",
        events: [eventFacts(secret)],
      }),
    );
    if (stored.outcome !== "stored")
      throw new Error(`fixture claim: ${stored.outcome}`);
    const readable = (name: string) =>
      claimReader(fixture.db, fixture.agent(name).principal.grant).canRead(
        stored.claim,
      );
    expect(readable("cred-default")).toBe(false);
    expect(readable("cred-open")).toBe(true);
    expect(
      claimReader(fixture.db, fixture.owner().principal.grant).canRead(
        stored.claim,
      ),
    ).toBe(true);
  });

  test("a grant stored before classes existed keeps working and tightens only by the credential default", async () => {
    addReader("old-grant");
    fixture.db
      .query(
        "UPDATE agent_grants SET deny_classes = NULL WHERE agent_id = (SELECT agent_id FROM agents WHERE name = 'old-grant')",
      )
      .run();
    const principal = authenticate(
      fixture.db,
      fixture.tokens["old-grant"] as string,
    );
    expect(principal?.grant.deny_classes).toBeUndefined();
    const envelope = await serveSearch(fixture.agent("old-grant"), {
      query: "kettle",
      scope: "ledger",
    });
    const events = envelope.quoted.map((chunk) => chunk.event_id);
    expect(events).toContain(plain);
    expect(events).not.toContain(secret);
    // Other classes were never denied to it.
    expect(envelope.quoted.length).toBeGreaterThan(1);
  });
});

describe("class denial at the query layer", () => {
  const window = {
    since: "2026-02-28T15:00:00Z",
    until: "2026-02-28T16:00:00Z",
  };

  test("timeline rows are filtered in SQL, so a LIMIT counts only readable rows", () => {
    // The credential event is the earliest, so it would fill a LIMIT of one.
    const denied = timeline(fixture.db, {
      ceiling: "private",
      ...window,
      limit: 1,
      source: { owner: false, deny_classes: ["credential"] },
    });
    expect(denied.map((entry) => entry.event_id)).toEqual([plain]);
    const open = timeline(fixture.db, {
      ceiling: "private",
      ...window,
      limit: 1,
      source: { owner: false, deny_classes: [] },
    });
    expect(open.map((entry) => entry.event_id)).toEqual([secret]);
  });

  test("search rows are filtered in SQL, so a LIMIT counts only readable rows", () => {
    const ids = (deny: EventClass[], limit = 50) =>
      searchAuditCandidates(fixture.db, "kettle", {
        scope: "ledger",
        limit,
        source: { owner: false, deny_classes: deny },
      }).candidates.map((hit) => hit.doc_id);
    const held = ids(["credential"]);
    expect(held.some((id) => id.includes(secret))).toBe(false);
    expect(held.some((id) => id.includes(plain))).toBe(true);
    expect(ids([]).some((id) => id.includes(secret))).toBe(true);
    const one = ids(["credential"], 1);
    expect(one).toHaveLength(1);
    expect(one[0]).toContain(plain);
  });
});

describe("correct honours class denial on a ledger with no source grants", () => {
  let claimId: string;
  let claimKey: string;

  beforeAll(async () => {
    const stored = await insertClaim(
      { db: fixture.db },
      claimInput(secret, {
        subject: "person:heron",
        subjects: ["person:heron"],
        predicate: "employment.works_at",
        object: "the drawer",
        body: "Heron keeps the vault password in the drawer.",
        events: [eventFacts(secret)],
      }),
    );
    if (stored.outcome !== "stored")
      throw new Error(`fixture claim: ${stored.outcome}`);
    claimId = stored.claim.claim_id;
    claimKey = stored.claim.claim_key as string;
  });

  async function outcome(
    name: string,
    target: Record<string, string>,
    dry_run: boolean,
  ) {
    try {
      const envelope = await serveCorrect(fixture.agent(name), {
        statement: "Heron works at the workshop.",
        target,
        dry_run,
      });
      return { ok: true as const, superseded: envelope.data?.superseded ?? [] };
    } catch (error) {
      if (error instanceof ServeError)
        return { ok: false as const, code: error.code, message: error.message };
      throw error;
    }
  }

  test("the ledger really has no source policy", () => {
    expect(sourcePolicyEpoch(fixture.db)).toBe(0);
  });

  test("a default-deny agent gets the unknown-target refusal for every target form, dry run or not", async () => {
    const unknownTargets = {
      subject: "person:nobody",
      claim_id: ulid(),
      claim_key: "0".repeat(64),
    };
    const before = fixture.db.query("SELECT COUNT(*) AS count FROM events").get();
    const cases: [Record<string, string>, boolean][] = [
      [{ subject: "person:heron" }, true],
      [{ subject: "person:heron" }, false],
      [{ claim_id: claimId }, true],
      [{ claim_id: claimId }, false],
      [{ claim_key: claimKey }, true],
      [{ claim_key: claimKey }, false],
    ];
    for (const [target, dry] of cases) {
      const result = await outcome("cred-default", target, dry);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const field = Object.keys(target)[0] as keyof typeof unknownTargets;
      const unknown = await outcome("cred-default", { [field]: unknownTargets[field] }, dry);
      expect(unknown.ok).toBe(false);
      if (unknown.ok) continue;
      expect(result).toEqual(unknown);
      expect(result.message).not.toContain(claimId);
      expect(result.message).not.toContain(claimKey);
    }
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM events").get()).toEqual(before);
    // Nothing was retired by the refused real calls.
    expect(
      fixture.db
        .query<{ status: string }, [string]>("SELECT status FROM claims WHERE claim_id = ?")
        .get(claimId)?.status,
    ).toBe("live");
  });

  test("an agent that opted out of the denial and the owner still see and can correct it", async () => {
    const result = await outcome("cred-open", { claim_id: claimId }, true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.superseded.map((entry) => entry.claim_id)).toEqual([claimId]);
    const owner = await serveCorrect(fixture.owner(), {
      statement: "Heron works at the workshop.",
      target: { subject: "person:heron" },
      dry_run: true,
    });
    expect(owner.data?.superseded.map((entry) => entry.claim_id)).toEqual([claimId]);
  });

  test("an opted-in agent and the owner can retire credential-derived claims", async () => {
    for (const [name, subject] of [["cred-open", "person:ibis"], ["owner", "person:egret"]] as const) {
      const stored = await insertClaim({ db: fixture.db }, claimInput(secret, {
        subject, subjects: [subject], body: `${subject} works at the depot.`,
        object: "depot", events: [eventFacts(secret)],
      }));
      if (stored.outcome !== "stored") throw new Error("fixture claim");
      const ctx = name === "owner" ? fixture.owner() : fixture.agent(name);
      const result = await serveCorrect(ctx, {
        statement: `${subject} works at the workshop.`,
        target: { claim_id: stored.claim.claim_id },
      });
      expect(result.data?.superseded.map((entry) => entry.claim_id)).toEqual([stored.claim.claim_id]);
      expect(getClaim(fixture.db, stored.claim.claim_id)?.status).toBe("superseded");
    }
  });
});

describe("machine-exhaust class under source policy", () => {
  test("an owner-declared path glob withholds matching evidence in the same SQL as the source policy", async () => {
    const sourceKey = ulid();
    registerConnection(fixture.db, "kizuki.import-legacy-wiki", sourceKey);
    const receipt = setSourceGrant(fixture.db, {
      source_key: sourceKey,
      expected_revision: 0,
      operation_id: "exhaust-grant",
      policy: {
        purposes: ["capture", "recall", "derive"],
        allowed_fields: ["text", "subjects", "attachments", "metadata"],
        retention: "persistent_owned_until_revoked",
        egress: "local_only",
        sensitivity_floor: "personal",
        class_rules: [
          { path_glob: "06-execution/**", class: "machine_exhaust" },
        ],
      },
    });
    const capture = (recordId: string, text: string) => {
      const stored = accept(
        fixture.db,
        {
          ...validEvent(),
          connector_id: "kizuki.import-legacy-wiki",
          source_record_id: recordId,
          kind: "page",
          occurred_at: "2026-02-28T17:00:00Z",
          text,
          attachments: [],
          metadata: {},
          sensitivity_hint: "personal",
        },
        {
          source: {
            source_key: sourceKey,
            expected_revision: receipt.revision,
          },
        },
      );
      if (stored.status !== "stored") throw new Error("fixture");
      return stored.event.event_id;
    };
    const exhaust = capture(
      "06-execution/run-9.md",
      "build log about the kettle firmware",
    );
    const note = capture(
      "notes/kettle-firmware.md",
      "human note about the kettle firmware",
    );
    rebuildDerived(fixture.db, fixture.vaultPath);

    const window = {
      since: "2026-02-28T17:00:00Z",
      until: "2026-02-28T18:00:00Z",
    };
    const ids = (envelope: { quoted: { event_id: string }[] }) =>
      envelope.quoted.map((chunk) => chunk.event_id).sort();
    // The default denial is credential only: exhaust stays readable until a grant names it.
    expect(ids(serveTimeline(fixture.agent("cred-default"), window))).toEqual(
      [exhaust, note].sort(),
    );
    expect(
      ids(serveTimeline(fixture.agent("cred-and-machine"), window)),
    ).toEqual([note]);
    const search = await serveSearch(fixture.agent("cred-and-machine"), {
      query: "firmware",
      scope: "ledger",
    });
    expect(ids(search)).toEqual([note]);
    expect(ids(serveTimeline(fixture.owner(), window))).toEqual(
      [exhaust, note].sort(),
    );
  });
});

describe("grant contract", () => {
  const base: Grant = {
    ...OWNER_AGENT_GRANT,
    tools: [...OWNER_AGENT_GRANT.tools],
  };

  test("deny_classes is optional and validated", () => {
    expect(validateAgentGrant(base)).not.toHaveProperty("deny_classes");
    expect(
      validateAgentGrant({ ...base, deny_classes: [] }).deny_classes,
    ).toEqual([]);
    expect(
      validateAgentGrant({ ...base, deny_classes: ["machine_exhaust"] })
        .deny_classes,
    ).toEqual(["machine_exhaust"]);
    for (const bad of [
      ["nope"],
      "credential",
      null,
      ["credential", "credential"],
      [1],
    ]) {
      expect(() =>
        validateAgentGrant({ ...base, deny_classes: bad as never }),
      ).toThrow(/deny_classes/);
    }
  });

  test("a partial grant patch keeps the classes an agent already has", () => {
    const created = addAgent(fixture.db, "class-keeper", { ...base, deny_classes: ["machine_exhaust"] });
    setGrant(fixture.db, "class-keeper", { rate_limit_per_minute: 5 });
    expect(authenticate(fixture.db, created.token)?.grant.deny_classes).toEqual(["machine_exhaust"]);
    setGrant(fixture.db, "class-keeper", { deny_classes: [] });
    expect(authenticate(fixture.db, created.token)?.grant.deny_classes).toEqual([]);
  });

  test("the inert public grant is unchanged", () => {
    const created = addAgent(fixture.db, "inert-agent");
    const principal = authenticate(fixture.db, created.token);
    expect(principal?.grant).toEqual({
      ceiling: "public",
      types: [],
      subjects: [],
      since: null,
      until: null,
      tools: [],
      rate_limit_per_minute: 60,
      relay_owner_corrections: false,
    });
  });
});
