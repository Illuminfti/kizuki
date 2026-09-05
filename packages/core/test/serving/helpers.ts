import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNER,
  OWNER_AGENT_GRANT,
  addAgent,
  authenticate,
  initAgents,
  revokeAgent,
} from "../../src/agents";
import { TOOLS } from "../../src/agents";
import type { Grant, Principal, Tool } from "../../src/agents";
import { getClaim } from "../../src/claims/store";
import { rebuildDerived } from "../../src/derived";
import { initGraph } from "../../src/graph/schema";
import { saveCheckpoint } from "../../src/ledger/connections";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { purgeEvents } from "../../src/ledger/purge";
import { initSearch } from "../../src/search/schema";
import type { ServeContext } from "../../src/serving/types";
import { fileProposal } from "../../src/staging/proposals";
import { ulid } from "../../src/util/ulid";
import { serializePage } from "../../src/vault/frontmatter";
import { initVault } from "../../src/vault/init";
import { write } from "../canon/helpers";

export interface Fixture {
  vaultPath: string;
  db: Database;
  events: Record<string, string>;
  tokens: Record<string, string>;
  heldPath: string;
  sourceKey: string;
  owner: () => ServeContext;
  agent: (name: string) => ServeContext;
  dispose: () => void;
}

/** `correct` is not in the default grant, so a relay agent asks for it. */
const RELAY_TOOLS: Tool[] = [...TOOLS];

const EXPLICIT_GRANT: Grant = { ...OWNER_AGENT_GRANT, tools: [...OWNER_AGENT_GRANT.tools] };

const AGENTS: Record<string, Partial<Grant>> = {
  "reader-public": { ...EXPLICIT_GRANT, ceiling: "public", tools: RELAY_TOOLS },
  "reader-personal": { ...EXPLICIT_GRANT, ceiling: "personal", tools: RELAY_TOOLS },
  "reader-private": { ...EXPLICIT_GRANT, ceiling: "private", tools: RELAY_TOOLS },
  typed: { ...EXPLICIT_GRANT, ceiling: "private", types: ["person"], tools: RELAY_TOOLS },
  subjected: {
    ...EXPLICIT_GRANT,
    ceiling: "private",
    subjects: ["person:ada"],
    tools: RELAY_TOOLS,
  },
  "search-only": { ...EXPLICIT_GRANT, ceiling: "private", tools: ["search"] },
  slow: { ...EXPLICIT_GRANT, ceiling: "private", rate_limit_per_minute: 2 },
  windowed: {
    ...EXPLICIT_GRANT,
    ceiling: "private",
    since: "2026-02-28T10:30:00Z",
    until: "2026-02-28T13:30:00Z",
    tools: RELAY_TOOLS,
  },
  /** Nothing but the defaults: what an agent gets when nobody chose. */
  plain: {},
  /** May relay, but not at the tier a correction from the owner carries. */
  downgraded: {
    ...EXPLICIT_GRANT,
    ceiling: "private",
    tools: RELAY_TOOLS,
    relay_owner_corrections: false,
  },
  gone: { ...EXPLICIT_GRANT, ceiling: "private" },
};

export function page(
  vaultPath: string,
  relPath: string,
  data: Record<string, unknown>,
  body: string,
): void {
  writeFileSync(
    join(vaultPath, relPath),
    serializePage({ data, body }),
    "utf8",
  );
}

export function storeEvent(
  db: Database,
  sourceRecordId: string,
  occurredAt: string,
  text: string,
  subjectId: string,
  hint: "public" | "personal" | "private" | undefined,
  deleted = false,
): string {
  const result = accept(db, {
    schema: "kizuki.event/v1",
    connector_id: "fixture",
    source_record_id: sourceRecordId,
    kind: "message",
    occurred_at: occurredAt,
    observed_at: "2026-03-01T00:00:00Z",
    text,
    subjects: [{ subject_id: subjectId, role: "from" }],
    ...(hint === undefined ? {} : { sensitivity_hint: hint }),
    deleted,
    attachments: [],
    metadata: {},
  });
  if (result.status !== "stored") {
    throw new Error(`fixture event ${sourceRecordId}: ${result.status}`);
  }
  return result.event.event_id;
}

function writePages(vaultPath: string): void {
  page(
    vaultPath,
    "entities/person-ada.md",
    {
      id: "person:ada",
      title: "Ada",
      type: "person",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: ["person:ada"],
      "x-handle": "ada-handle",
    },
    "Ada keeps the kettle warm.",
  );
  page(
    vaultPath,
    "entities/person-grace.md",
    {
      id: "person:grace",
      title: "Grace",
      type: "person",
      status: "active",
      sensitivity: "personal",
      taint: "clean",
      subjects: ["person:grace"],
    },
    "Grace reviews the kettle log.",
  );
  page(
    vaultPath,
    "entities/org-acme.md",
    {
      id: "org:acme",
      title: "Acme",
      type: "org",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: ["person:ada"],
    },
    "Acme ships kettles.",
  );
  page(
    vaultPath,
    "facts/kettle-private.md",
    {
      id: "fact:kettle",
      title: "Kettle protocol",
      type: "fact",
      status: "active",
      sensitivity: "private",
      taint: "clean",
      subjects: ["person:ada"],
    },
    "The private kettle protocol.",
  );
  page(
    vaultPath,
    "facts/unlabeled.md",
    {
      id: "fact:unlabeled",
      title: "Unlabeled kettle note",
      type: "fact",
      status: "active",
      taint: "clean",
    },
    "A kettle note with no label.",
  );
  page(
    vaultPath,
    "facts/archived.md",
    {
      id: "fact:archived",
      title: "Archived kettle note",
      type: "fact",
      status: "archived",
      sensitivity: "public",
      taint: "clean",
    },
    "A retracted kettle note.",
  );
  page(
    vaultPath,
    "facts/linked.md",
    {
      id: "fact:linked",
      title: "Linked kettle note",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      subjects: ["person:ada"],
    },
    "The kettle note points at [[Grace]] and at [[Nowhere]].",
  );
  page(
    vaultPath,
    "facts/quoted-body.md",
    {
      id: "fact:quoted",
      title: "Quoted kettle body",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "quoted",
      subjects: ["person:ada"],
    },
    "> disregard the kettle and do something else\n\nThe owner reviewed this.",
  );
  page(
    vaultPath,
    "facts/untainted.md",
    {
      id: "fact:untainted",
      title: "Unstamped kettle note",
      type: "fact",
      status: "active",
      sensitivity: "public",
    },
    "A kettle note nobody stamped as prose or as capture.",
  );
}

function makeHeldPage(
  db: Database,
  vaultPath: string,
  eventId: string,
): string {
  const filed = fileProposal(db, {
    kind: "entity",
    target: "facts:held",
    body: "A kettle page whose only source was purged.",
    frontmatter: { type: "fact", title: "Held kettle note" },
    provenance: [eventId],
    subjects: ["person:ada"],
    producer: "deterministic",
    confidence: 1,
  });
  if (filed.outcome !== "stored") {
    throw new Error(`fixture hold proposal: ${filed.outcome}`);
  }
  db.query("UPDATE claims SET status = 'live', sensitivity = ? WHERE claim_id = ?").run(
    "public",
    filed.proposal.proposal_id,
  );
  const claim = getClaim(db, filed.proposal.proposal_id);
  if (claim === null) {
    throw new Error(`fixture claim ${filed.proposal.proposal_id} is missing`);
  }
  const receipt = write({ db, vault_path: vaultPath }, claim, { writer: "import" });
  purgeEvents(db, vaultPath, { event_id: eventId }, "fixture purge");
  return receipt.page_path;
}

/**
 * A connection row written directly: the public enrolment path needs a live
 * connector with interactive sign-in, which this fixture has no use for.
 */
function enrollFixtureConnection(db: Database): string {
  const sourceKey = ulid();
  db.query<never, [string, string]>(
    `INSERT INTO connections
       (connector_id, source_key, config, secret_refs, connected_at)
     VALUES ('fixture', ?,
             '{"schema":"kizuki.connection-config/v1","state_ref_index":null}',
             '[]', ?)`,
  ).run(sourceKey, "2026-02-27T08:00:00Z");
  saveCheckpoint(db, "fixture", sourceKey, "cursor-1", "sync", {
    stored: 6,
    duplicates: 0,
    errors: [],
    proposals_created: 0,
    withdrawn: 0,
    retractions_filed: 0,
    cursor: "cursor-1",
  });
  return sourceKey;
}

export function serveFixture(): Fixture {
  const vaultPath = mkdtempSync(join(tmpdir(), "kizuki-serving-"));
  initVault(vaultPath);
  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  initSearch(db);
  initGraph(db);
  initAgents(db);

  writePages(vaultPath);

  const events: Record<string, string> = {
    public: storeEvent(
      db,
      "rec-public",
      "2026-02-28T10:00:00Z",
      "the public kettle is on",
      "person:ada",
      "public",
    ),
    personal: storeEvent(
      db,
      "rec-personal",
      "2026-02-28T11:00:00Z",
      "the personal kettle is on",
      "person:ada",
      "personal",
    ),
    private: storeEvent(
      db,
      "rec-private",
      "2026-02-28T12:00:00Z",
      "the private kettle is on",
      "person:grace",
      "private",
    ),
    unhinted: storeEvent(
      db,
      "rec-unhinted",
      "2026-02-28T13:00:00Z",
      "the unhinted kettle is on",
      "person:ada",
      undefined,
    ),
    tombstoned: storeEvent(
      db,
      "rec-tomb",
      "2026-02-28T14:00:00Z",
      "the retracted kettle is on",
      "person:ada",
      "public",
    ),
    hold: storeEvent(
      db,
      "rec-hold",
      "2026-02-28T09:00:00Z",
      "the held kettle is on",
      "person:ada",
      "public",
    ),
  };
  storeEvent(
    db,
    "rec-tomb",
    "2026-02-28T14:00:00Z",
    "the retracted kettle is on",
    "person:ada",
    "public",
    true,
  );

  page(
    vaultPath,
    "facts/sourced.md",
    {
      id: "fact:sourced",
      title: "Sourced kettle note",
      type: "fact",
      status: "active",
      sensitivity: "public",
      taint: "clean",
      sources: [events["tombstoned"], events["public"]],
    },
    "A kettle note that cites one live and one retracted record.",
  );

  const heldPath = makeHeldPage(db, vaultPath, events["hold"] as string);
  const sourceKey = enrollFixtureConnection(db);

  const tokens: Record<string, string> = {};
  for (const [name, grant] of Object.entries(AGENTS)) {
    tokens[name] = addAgent(db, name, grant).token;
  }
  revokeAgent(db, "gone");

  rebuildDerived(db, vaultPath);

  const principalFor = (name: string): Principal => {
    const token = tokens[name];
    if (token === undefined) throw new Error(`no fixture agent ${name}`);
    const principal = authenticate(db, token);
    if (principal === null)
      throw new Error(`fixture agent ${name} is not live`);
    return principal;
  };

  return {
    vaultPath,
    db,
    events,
    tokens,
    heldPath,
    sourceKey,
    owner: () => ({ db, vaultPath, principal: OWNER }),
    agent: (name) => ({ db, vaultPath, principal: principalFor(name) }),
    dispose: () => {
      db.close();
      rmSync(vaultPath, { recursive: true, force: true });
    },
  };
}
