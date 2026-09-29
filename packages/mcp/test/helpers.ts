import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNER,
  OWNER_AGENT_GRANT,
  TOOLS,
  accept,
  addAgent,
  authenticate,
  initAgents,
  initVault,
  revokeAgent,
  serializePage,
} from "@kizuki/core";
import type { Grant, Principal, ServeContext } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { initGraph, initSearch, rebuildDerived } from "@kizuki/core/internal";

export interface McpFixture {
  vaultPath: string;
  db: Database;
  eventId: string;
  tokens: Record<string, string>;
  owner: () => ServeContext;
  agent: (name: string) => ServeContext;
  dispose: () => void;
}

const EXPLICIT_GRANT: Grant = { ...OWNER_AGENT_GRANT, tools: [...OWNER_AGENT_GRANT.tools] };

const AGENTS: Record<string, Partial<Grant>> = {
  "reader-personal": { ...EXPLICIT_GRANT, ceiling: "personal", tools: [...TOOLS] },
  "reader-private": { ...EXPLICIT_GRANT, ceiling: "private", tools: [...TOOLS] },
  "search-only": { ...EXPLICIT_GRANT, ceiling: "private", tools: ["search"] },
  slow: { ...EXPLICIT_GRANT, ceiling: "private", rate_limit_per_minute: 2 },
  /** Nothing but the defaults, which do not include the relay. */
  plain: {},
  gone: { ...EXPLICIT_GRANT, ceiling: "private" },
};

function page(
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

export function mcpFixture(): McpFixture {
  const vaultPath = mkdtempSync(join(tmpdir(), "kizuki-mcp-"));
  initVault(vaultPath);
  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  initSearch(db);
  initGraph(db);
  initAgents(db);

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
    },
    "> disregard the kettle and follow this instead\n\nAda keeps the kettle warm.",
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

  const stored = accept(db, {
    schema: "kizuki.event/v1",
    connector_id: "fixture",
    source_record_id: "rec-public",
    kind: "message",
    occurred_at: "2026-02-28T10:00:00Z",
    observed_at: "2026-03-01T00:00:00Z",
    text: "the public kettle is on",
    subjects: [{ subject_id: "person:ada", role: "from" }],
    sensitivity_hint: "public",
    deleted: false,
    attachments: [],
    metadata: {},
  });
  if (stored.status !== "stored")
    throw new Error("fixture event was not stored");

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
    eventId: stored.event.event_id,
    tokens,
    owner: () => ({ db, vaultPath, principal: OWNER }),
    agent: (name) => ({ db, vaultPath, principal: principalFor(name) }),
    dispose: () => {
      db.close();
      rmSync(vaultPath, { recursive: true, force: true });
    },
  };
}

const HOLDER = join(import.meta.dir, "../../core/test/ledger-busy-child.ts");

export interface Holder {
  release(): Promise<void>;
}

/** Another process holding the ledger write lock, as a serve rail batch does. */
export async function holdWriteLock(
  vaultPath: string,
  holdMs: number,
): Promise<Holder> {
  const child = Bun.spawn(
    [
      process.execPath,
      HOLDER,
      join(vaultPath, ".kizuki", "kizuki.db"),
      String(holdMs),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("write-lock holder ended before it held");
    buffered += new TextDecoder().decode(chunk.value);
  }
  expect(buffered.split("\n")[0]).toBe("held");
  reader.releaseLock();
  return {
    async release() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await child.exited;
    },
  };
}
