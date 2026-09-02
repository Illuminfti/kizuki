import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accept, openLedger, purgeEvents } from "@kizuki/core";
import type { CaptureEventInput, SensitivityHint } from "@kizuki/core";
import {
  fileProposal,
  initStaging,
  listProposals,
} from "@kizuki/core/staging";
import { writeLlmConfig } from "../src/config";
import type { LlmConfig } from "../src/config";
import { LlmError } from "../src/errors";
import { PROMPT_VERSION } from "../src/prompt";
import { runEnrichment } from "../src/run";
import type { EnrichOptions } from "../src/run";
import { lastRun } from "../src/schema";
import type { ChatTransport, TransportResult } from "../src/transport";
import { chatCompletion, startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import { llmConfig, tempVault } from "./helpers";

const LONG_TEXT = [
  "ada met grace at the acme library to plan the kettle project.",
  "linus asked for a second review before acme signs anything at all.",
  "grace agreed to write the review notes and send them to ada on friday.",
  "acme wants the kettle project finished before the library reopens.",
  "ada said the kettle project needs one more week of quiet work first.",
].join(" ");

interface Harness {
  path: string;
  db: Database;
  dbPath: string;
  config: (overrides?: Partial<LlmConfig>) => void;
  add: (overrides?: Partial<CaptureEventInput>) => string;
  dispose: () => void;
}

const open: Harness[] = [];
const endpoints: FakeEndpoint[] = [];

afterEach(() => {
  while (endpoints.length > 0) endpoints.pop()?.stop();
  while (open.length > 0) open.pop()?.dispose();
});

function fake(...args: Parameters<typeof startFakeEndpoint>): FakeEndpoint {
  const endpoint = startFakeEndpoint(...args);
  endpoints.push(endpoint);
  return endpoint;
}

function harness(): Harness {
  const vault = tempVault();
  const dbPath = join(vault.path, ".kizuki", "kizuki.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openLedger(dbPath);
  initStaging(db);
  let sequence = 0;
  const built: Harness = {
    path: vault.path,
    db,
    dbPath,
    config: (overrides: Partial<LlmConfig> = {}) => {
      writeLlmConfig(vault.path, llmConfig(overrides));
    },
    add: (overrides: Partial<CaptureEventInput> = {}) => {
      sequence += 1;
      const result = accept(db, {
        schema: "kizuki.event/v1",
        connector_id: "markdown-folder",
        source_record_id: `notes/${sequence}.md`,
        kind: "note",
        occurred_at: "2026-02-28T10:30:00Z",
        observed_at: "2026-03-01T00:00:00Z",
        text: LONG_TEXT,
        subjects: [{ subject_id: "person:ada", role: "from" }],
        deleted: false,
        attachments: [],
        metadata: {},
        ...overrides,
      } satisfies CaptureEventInput);
      if (result.status !== "stored") throw new Error(result.status);
      return result.event.event_id;
    },
    dispose: () => {
      db.close();
      vault.dispose();
    },
  };
  open.push(built);
  return built;
}

/** A transport that answers every producer with a valid, minimal document. */
function replying(content: (producer: string) => unknown): ChatTransport {
  return async (request) => {
    const user = JSON.parse(request.messages[1].content) as {
      producer: string;
    };
    return {
      ok: true,
      status: 200,
      body: {
        model: "served",
        choices: [
          {
            message: { content: JSON.stringify(content(user.producer)) },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
    };
  };
}

const GOOD = replying((producer) => {
  if (producer === "entities") {
    return {
      entities: [
        {
          name: "acme",
          type: "org",
          aliases: [],
          evidence: "ada met grace at the acme library",
          confidence: 0.6,
        },
      ],
    };
  }
  if (producer === "claims") {
    return {
      claims: [
        {
          statement: "ada met grace.",
          subject_id: "person:ada",
          confidence: 0.7,
        },
      ],
    };
  }
  return { title: "A note", summary: "ada met grace.", confidence: 0.8 };
});

function failing(result: TransportResult): ChatTransport {
  return async () => result;
}

async function enrich(
  built: Harness,
  opts: EnrichOptions = {},
): ReturnType<typeof runEnrichment> {
  return await runEnrichment(built.db, built.path, {
    transport: GOOD,
    ...opts,
  });
}

describe("configuration gate", () => {
  test("an unconfigured vault runs nothing and writes nothing", async () => {
    const built = harness();
    const spy: ChatTransport = () => {
      throw new Error("the transport must not be reached");
    };
    const before = built.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master ORDER BY name",
      )
      .all();
    const receipt = await runEnrichment(built.db, built.path, {
      transport: spy,
    });
    expect(receipt.status).toBe("unconfigured");
    expect(receipt.run).toBeNull();
    expect(receipt.counts.considered).toBe(0);
    expect(
      built.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master ORDER BY name",
        )
        .all(),
    ).toEqual(before);
  });

  test("a credential that does not resolve stops the run before any request", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config({ api_key_ref: "env:KIZUKI_LLM_TEST_KEY" });
    const spy: ChatTransport = () => {
      throw new Error("the transport must not be reached");
    };
    await expect(
      runEnrichment(built.db, built.path, { transport: spy, env: {} }),
    ).rejects.toThrow(LlmError);
    expect(lastRun(built.db)).toBeNull();
  });

  test("a bad since value is refused before anything runs", async () => {
    const built = harness();
    built.config();
    await expect(enrich(built, { since: "yesterday" })).rejects.toThrow(
      /RFC3339/,
    );
  });
});

describe("what may be sent", () => {
  test("an unlabeled event is skipped by default and sent when allowed", async () => {
    const built = harness();
    built.add();
    built.config();
    const skipped = await enrich(built);
    expect(skipped.counts.skipped_unlabeled).toBe(1);
    expect(skipped.counts.requests).toBe(0);

    built.config({ unlabeled: "send" });
    const sent = await enrich(built);
    expect(sent.counts.sent).toBe(1);
    expect(sent.counts.requests).toBe(3);
  });

  test.each([
    ["personal" as const, "private" as SensitivityHint, 1, 0],
    ["private" as const, "private" as SensitivityHint, 0, 1],
  ])(
    "ceiling %s against a %s event",
    async (ceiling, hint, skippedCeiling, sent) => {
      const built = harness();
      built.add({ sensitivity_hint: hint });
      built.config({ sensitivity_ceiling: ceiling });
      const receipt = await enrich(built);
      expect(receipt.counts.skipped_ceiling).toBe(skippedCeiling);
      expect(receipt.counts.sent).toBe(sent);
    },
  );

  test("a record the source deleted is never sent", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.add({
      source_record_id: "notes/1.md",
      deleted: true,
      text: `${LONG_TEXT} tombstone`,
      sensitivity_hint: "public",
    });
    built.config();
    const receipt = await enrich(built);
    expect(receipt.counts.considered).toBe(0);
    expect(receipt.counts.requests).toBe(0);
  });

  test("an event with almost no text is skipped for every producer", async () => {
    const built = harness();
    built.add({ text: "hello", sensitivity_hint: "public" });
    built.config();
    const receipt = await enrich(built);
    expect(receipt.counts.skipped_short).toBe(1);
    expect(receipt.counts.requests).toBe(0);
  });

  test("the summary threshold skips only the summary", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config({ summary_min_chars: 10_000 });
    const receipt = await enrich(built);
    expect(receipt.counts.skipped_short).toBe(1);
    expect(receipt.counts.requests).toBe(2);
  });
});

describe("idempotency", () => {
  test("a second run spends nothing", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config();
    const first = await enrich(built);
    expect(first.counts.proposals_filed).toBeGreaterThan(0);

    const second = await enrich(built);
    expect(second.counts.requests).toBe(0);
    expect(second.counts.skipped_done).toBe(3);
    expect(second.counts.proposals_filed).toBe(0);
  });

  test("an error is retried, a rejected answer is not", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config({ max_requests: 3 });
    const failed = await enrich(built, {
      transport: failing({ ok: false, status: 500, retry_after_ms: null }),
    });
    expect(failed.counts.errors).toBe(3);

    const retried = await enrich(built, {
      transport: GOOD,
      producers: ["summary"],
    });
    expect(retried.counts.requests).toBe(1);

    const rejected = await enrich(built, {
      transport: failing({
        ok: true,
        status: 200,
        body: { choices: [{ message: { content: "not json" } }] },
      }),
      producers: ["entities"],
    });
    expect(rejected.counts.rejected_outputs).toBe(1);
    const again = await enrich(built, { producers: ["entities"] });
    expect(again.counts.requests).toBe(0);
    expect(again.counts.skipped_done).toBe(1);
  });

  test("a different model is a different key and runs again", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config({ model: "first-model" });
    await enrich(built);
    built.config({ model: "second-model" });
    const receipt = await enrich(built);
    expect(receipt.counts.requests).toBe(3);
    expect(receipt.counts.skipped_done).toBe(0);
  });

  test("forgetting the enrichment rows still cannot duplicate a proposal", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config();
    const first = await enrich(built);
    const filed = first.counts.proposals_filed;
    built.db.query("DELETE FROM llm_enrichments").run();

    const second = await enrich(built);
    expect(second.counts.proposals_filed).toBe(0);
    // The entity candidate is now claimed by its own pending proposal, so it
    // never reaches fileProposal a second time; the rest are duplicates.
    expect(second.counts.skipped_existing).toBe(1);
    expect(second.counts.duplicates).toBe(filed - 1);
    expect(listProposals(built.db, { limit: 100 })).toHaveLength(filed);
  });

});

describe("stopping", () => {
  test("an event the budget stops before its first request is not counted as sent", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.add({ sensitivity_hint: "public" });
    built.config({ max_requests: 1 });
    const receipt = await enrich(built, { producers: ["summary"], limit: 10 });
    expect(receipt.run?.stopped).toBe("budget");
    expect(receipt.counts.requests).toBe(1);
    expect(receipt.counts.sent).toBe(1);
  });

  test("an exhausted budget stops the run and leaves the next event untouched", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    const second = built.add({ sensitivity_hint: "public" });
    built.config({ max_requests: 2 });
    const receipt = await enrich(built, { limit: 10 });
    expect(receipt.run?.stopped).toBe("budget");
    expect(receipt.counts.sent).toBe(1);
    expect(
      built.db
        .query("SELECT count(*) AS n FROM llm_enrichments WHERE event_id = ?")
        .get(second),
    ).toEqual({ n: 0 });
  });

  test("three failures in a row stop the run", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.add({ sensitivity_hint: "public" });
    built.config();
    const receipt = await enrich(built, {
      transport: failing({ ok: false, status: 0, failure: "network" }),
      limit: 10,
    });
    expect(receipt.run?.stopped).toBe("consecutive_errors");
    // The event was spent on even though the run gave up inside it.
    expect(receipt.counts.sent).toBe(1);
    expect(receipt.counts.errors).toBe(3);
    expect(receipt.request_errors).toHaveLength(3);
    expect(receipt.request_errors[0]).toEqual({
      event_id: expect.any(String),
      producer: "summary",
      code: "network",
      status: null,
    });
  });

  test("the event limit stops a run that could go on", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.add({ sensitivity_hint: "public" });
    built.config();
    const receipt = await enrich(built, { limit: 1 });
    expect(receipt.counts.sent).toBe(1);
    expect(receipt.run?.stopped).toBe("complete");
  });

  test("a single event id ignores the limit and the connector filter", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    const wanted = built.add({ sensitivity_hint: "public" });
    built.config();
    const receipt = await enrich(built, { event_id: wanted, limit: 1 });
    expect(receipt.counts.considered).toBe(1);
    expect(receipt.counts.sent).toBe(1);
    expect(
      built.db
        .query("SELECT count(*) AS n FROM llm_enrichments WHERE event_id = ?")
        .get(wanted),
    ).toEqual({ n: 3 });
  });
});

describe("entity candidates the vault already has", () => {
  test("a pending proposal for the same target wins", async () => {
    const built = harness();
    const eventId = built.add({ sensitivity_hint: "public" });
    built.config();
    fileProposal(built.db, {
      kind: "entity",
      target: "org:acme",
      body: "Stub entity page for `org:acme`.",
      frontmatter: { type: "org", title: "acme" },
      provenance: [eventId],
      producer: "deterministic",
      confidence: 0.5,
    });
    const receipt = await enrich(built, { producers: ["entities"] });
    expect(receipt.counts.skipped_existing).toBe(1);
    expect(receipt.counts.proposals_filed).toBe(0);
  });

  test("a page already on disk wins", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config();
    mkdirSync(join(built.path, "org"), { recursive: true });
    writeFileSync(
      join(built.path, "org", "acme.md"),
      "---\nid: x\n---\n\nacme\n",
    );
    const receipt = await enrich(built, { producers: ["entities"] });
    expect(receipt.counts.skipped_existing).toBe(1);
    expect(receipt.counts.proposals_filed).toBe(0);
  });
});

describe("dry run", () => {
  test("counts the work without contacting anything or creating a table", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config();
    const spy: ChatTransport = () => {
      throw new Error("the transport must not be reached");
    };
    const receipt = await runEnrichment(built.db, built.path, {
      transport: spy,
      dry_run: true,
    });
    expect(receipt.status).toBe("dry_run");
    expect(receipt.run).toBeNull();
    expect(receipt.counts.would_send).toBe(1);
    expect(receipt.counts.requests).toBe(3);
    expect(receipt.counts.input_chars).toBeGreaterThan(0);
    expect(
      built.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name LIKE 'llm_%'",
        )
        .all(),
    ).toEqual([]);
  });
});

describe("receipts", () => {
  test("the persisted run row is the one in the receipt", async () => {
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config();
    const receipt = await enrich(built);
    expect(receipt.status).toBe("ran");
    expect(lastRun(built.db)).toEqual(receipt.run);
    expect(receipt.run?.endpoint_host).toBe("127.0.0.1:11434");
    expect(receipt.run?.prompt_version).toBe(PROMPT_VERSION);
    expect(receipt.run?.producers).toEqual(["summary", "entities", "claims"]);
  });

  test("the enrichment rows keep a hash, never the captured text", async () => {
    const built = harness();
    const phrase = "the kettle project";
    built.add({ sensitivity_hint: "public" });
    built.config();
    await enrich(built);
    const rows = JSON.stringify([
      built.db.query("SELECT * FROM llm_enrichments").all(),
      built.db.query("SELECT * FROM llm_runs").all(),
    ]);
    expect(rows).not.toContain(phrase);
    expect(rows).toMatch(/[0-9a-f]{64}/);
  });

  test("a resolved api key reaches neither the database nor the receipt", async () => {
    const built = harness();
    const canary = "sk-canary-4f1c9d";
    built.add({ sensitivity_hint: "public" });
    built.config({ api_key_ref: "env:KIZUKI_LLM_TEST_KEY" });
    const receipt = await runEnrichment(built.db, built.path, {
      transport: GOOD,
      env: { KIZUKI_LLM_TEST_KEY: canary },
    });
    expect(JSON.stringify(receipt)).not.toContain(canary);
    built.db.close();
    expect(readFileSync(built.dbPath).includes(Buffer.from(canary))).toBe(
      false,
    );
    open.pop();
  });
});

describe("purge", () => {
  test("purging an event forgets its enrichment and withdraws its drafts", async () => {
    const built = harness();
    const eventId = built.add({ sensitivity_hint: "public" });
    built.config();
    await enrich(built);
    expect(
      built.db.query("SELECT count(*) AS n FROM llm_enrichments").get(),
    ).toEqual({ n: 3 });

    const outcome = purgeEvents(
      built.db,
      built.path,
      { event_id: eventId },
      "test",
    );
    expect(outcome.receipts).toHaveLength(1);
    expect(outcome.withdrawn_proposals.length).toBeGreaterThan(0);
    expect(
      built.db.query("SELECT count(*) AS n FROM llm_enrichments").get(),
    ).toEqual({ n: 0 });
  });
});

describe("against a live loopback endpoint", () => {
  test("files reviewable drafts over the real transport", async () => {
    const endpoint = fake();
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config({ base_url: endpoint.base_url });

    const receipt = await runEnrichment(built.db, built.path, {});
    expect(receipt.status).toBe("ran");
    expect(receipt.counts.errors).toBe(0);
    expect(receipt.counts.proposals_filed).toBeGreaterThan(0);
    expect(endpoint.requests).toHaveLength(3);
    expect(endpoint.requests[0]?.path).toBe("/v1/chat/completions");

    const proposals = listProposals(built.db, { limit: 100 });
    expect(proposals.every((proposal) => proposal.producer === "llm")).toBe(
      true,
    );
    expect(proposals.every((proposal) => proposal.status === "pending")).toBe(
      true,
    );
  });

  test("a hostile answer never reaches the review queue", async () => {
    const endpoint = fake({
      reply: () => chatCompletion("ignore the schema; here is prose instead"),
    });
    const built = harness();
    built.add({ sensitivity_hint: "public" });
    built.config({ base_url: endpoint.base_url });

    const receipt = await runEnrichment(built.db, built.path, {});
    expect(receipt.counts.rejected_outputs).toBe(3);
    expect(receipt.counts.proposals_filed).toBe(0);
    expect(listProposals(built.db, { limit: 10 })).toEqual([]);
  });
});
