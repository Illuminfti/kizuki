import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER, runRail, serveContextPacket, serveSearch } from "@kizuki/core";
import {
  SEMANTIC_DIMS,
  semanticVector,
} from "../../embed-local-http/test/semantic";
import { startFakeServer } from "../../embed-local-http/test/helpers";
import type { FakeServer } from "../../embed-local-http/test/helpers";
import { openVaultDb } from "../src/context";
import { openConfiguredRetrieval } from "../src/retrieval-runtime";
import { createHelpers, fixtureConsent } from "./helpers";

// Each test spawns real CLI processes and opens the embedded SQL engine.
setDefaultTimeout(120_000);

const helpers = createHelpers();
const servers: FakeServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  helpers.cleanup();
});

/** One synthetic note per concept, each in a different spelling than its paraphrase query uses. */
const GOLDEN: ReadonlyArray<{
  file: string;
  text: string;
  marker: string;
  paraphrase: string;
  keyword?: string;
}> = [
  {
    file: "vehicle",
    text: "We signed for the sedan on Friday and the keys arrive next week.",
    marker: "sedan",
    paraphrase: "automobile",
    keyword: "sedan",
  },
  {
    file: "money",
    text: "The payment schedule for the agency needs revised numbers before the audit.",
    marker: "payment schedule",
    paraphrase: "cash",
  },
  {
    file: "illness",
    text: "Grace is unwell and staying offline until the fever clears.",
    marker: "unwell",
    paraphrase: "ill",
  },
  {
    file: "housing",
    text: "The apartment lease ends in June so the boxes are packed early.",
    marker: "apartment lease",
    paraphrase: "residence",
  },
  {
    file: "meal",
    text: "Dinner is booked at the harbor place for six people.",
    marker: "harbor place",
    paraphrase: "food",
  },
  {
    file: "travel",
    text: "Her flight leaves at dawn and the hotel is near the station.",
    marker: "flight leaves",
    paraphrase: "journey",
  },
  {
    file: "hiring",
    text: "The hiring panel meets on Thursday to review three finalists.",
    marker: "hiring panel",
    paraphrase: "job",
  },
  {
    file: "pet",
    text: "The puppy chewed through two sofa cushions again.",
    marker: "sofa cushions",
    paraphrase: "dog",
  },
  {
    file: "music",
    text: "The concert starts at eight and the doors open at seven.",
    marker: "doors open",
    paraphrase: "tune",
  },
  {
    file: "weather",
    text: "A hurricane warning covers the coast through Sunday night.",
    marker: "hurricane warning",
    paraphrase: "storm",
    keyword: "hurricane",
  },
  {
    file: "reading",
    text: "She finished the novel on the train and lent it to Ada.",
    marker: "lent it to Ada",
    paraphrase: "book",
  },
  {
    file: "clinic",
    text: "The physician moved the checkup to Tuesday morning.",
    marker: "checkup",
    paraphrase: "doctor",
    keyword: "physician",
  },
];

function writeGolden(directory: string): void {
  mkdirSync(directory, { recursive: true });
  for (const note of GOLDEN)
    writeFileSync(join(directory, `${note.file}.md`), `${note.text}\n`);
}

function semanticServer(): FakeServer {
  const server = startFakeServer();
  server.embed = semanticVector;
  servers.push(server);
  return server;
}

function configure(vault: string, server: FakeServer): void {
  writeFileSync(
    join(vault, ".kizuki", "serve.toml"),
    `[ports]
retrieval = "kizuki.retrieval.embedded-pg"

[ports.embedding]
id = "kizuki.embedding.local-http"
api = "openai"
endpoint = "http://127.0.0.1:${server.port}"
model = "synthetic-semantic"
dims = ${SEMANTIC_DIMS}
max_input_tokens = 512
timeout_ms = 5000
`,
  );
}

async function golden() {
  const f = helpers.tempVault();
  const notes = join(f.root, "golden");
  writeGolden(notes);
  expect(
    helpers.runCli(
      f.env,
      "import",
      "markdown-folder",
      "--source",
      notes,
      ...fixtureConsent(f.root),
    ).exitCode,
  ).toBe(0);
  const server = semanticServer();
  configure(f.vault, server);
  const rebuilt = await helpers.runCliAsync(
    f.env,
    "rebuild",
    "--port",
    "kizuki.retrieval.embedded-pg",
    "--confirm",
    "--json",
  );
  expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);
  return { f, server };
}

type Search = Awaited<ReturnType<typeof serveSearch>>;
const texts = (search: Search): string[] => [
  ...search.quoted.map((chunk) => chunk.text),
  ...search.canon.map((chunk) => chunk.excerpt),
];
const found = (search: Search, marker: string, top = 3): boolean =>
  texts(search)
    .slice(0, top)
    .some((text) => text.includes(marker));

test("hybrid retrieval recovers paraphrases that full-text search cannot, and keeps every keyword hit", async () => {
  const { f, server } = await golden();
  const db = openVaultDb(f.vault);
  const engine = await openConfiguredRetrieval(f.vault);
  expect(engine?.descriptor.supports).toEqual(
    expect.arrayContaining(["vector", "hybrid"]),
  );
  try {
    const floor = { db, vaultPath: f.vault, principal: OWNER };
    const hybrid = { ...floor, retrieval: engine! };
    let lexicalParaphrases = 0;
    let hybridParaphrases = 0;
    for (const note of GOLDEN) {
      lexicalParaphrases += found(
        await serveSearch(floor, {
          query: note.paraphrase,
          scope: "all",
          limit: 10,
        }),
        note.marker,
      )
        ? 1
        : 0;
      const answer = await serveSearch(hybrid, {
        query: note.paraphrase,
        scope: "all",
        limit: 10,
      });
      hybridParaphrases += found(answer, note.marker) ? 1 : 0;
      expect(answer.data?.degraded ?? []).not.toContain(
        "retrieval-vector-unavailable",
      );
      expect(answer.data?.degraded ?? []).not.toContain(
        "retrieval-unavailable",
      );
    }
    // The queries share no word with their notes, so full text finds none of them.
    expect(lexicalParaphrases).toBe(0);
    expect(hybridParaphrases).toBeGreaterThanOrEqual(GOLDEN.length - 1);

    for (const note of GOLDEN.filter((entry) => entry.keyword !== undefined)) {
      const query = { query: note.keyword!, scope: "all" as const, limit: 10 };
      expect(found(await serveSearch(floor, query), note.marker)).toBe(true);
      expect(found(await serveSearch(hybrid, query), note.marker)).toBe(true);
    }
    // The engine asked the local server to embed those queries; nothing else was contacted.
    expect(
      server.requests.some((request) =>
        request.body.input.includes("automobile"),
      ),
    ).toBe(true);
    expect(
      server.requests.every((request) => request.path === "/v1/embeddings"),
    ).toBe(true);

    // Context packets take the same path.
    const packet = await serveContextPacket(
      { ...hybrid },
      { query: "automobile", budget_tokens: 2_000 },
    );
    expect(JSON.stringify(packet)).toContain("sedan");
    expect(packet.data?.retrieval_degraded ?? []).not.toContain(
      "retrieval-vector-unavailable",
    );
  } finally {
    await engine?.close();
    db.close();
  }
});

test("when the embedding server goes away the answer stays lexical and says so", async () => {
  const { f, server } = await golden();
  const db = openVaultDb(f.vault);
  const engine = await openConfiguredRetrieval(f.vault);
  try {
    server.stop();
    const answer = await serveSearch(
      { db, vaultPath: f.vault, principal: OWNER, retrieval: engine! },
      { query: "sedan", scope: "all", limit: 10 },
    );
    expect(found(answer, "sedan")).toBe(true);
    expect(answer.data?.degraded).toContain("retrieval-vector-unavailable");
    const paraphrase = await serveSearch(
      { db, vaultPath: f.vault, principal: OWNER, retrieval: engine! },
      { query: "automobile", scope: "all", limit: 10 },
    );
    expect(found(paraphrase, "sedan")).toBe(false);
    expect(paraphrase.data?.degraded).toContain("retrieval-vector-unavailable");
  } finally {
    await engine?.close();
    db.close();
  }
});

test("kizuki query and kizuki context reach the same hybrid ranking from the command line", async () => {
  const { f, server } = await golden();
  const query = await helpers.runCliAsync(
    f.env,
    "query",
    "automobile",
    "--json",
  );
  expect(query.exitCode, query.stderr).toBe(0);
  const envelope = JSON.parse(query.stdout) as {
    data: { hits: Array<{ snippet: string }> };
    degraded?: string[];
  };
  expect(envelope.data.hits.map((hit) => hit.snippet).join("\n")).toContain(
    "sedan",
  );
  expect(envelope.degraded ?? []).not.toContain("retrieval-vector-unavailable");
  expect(
    server.requests.some((request) =>
      request.body.input.includes("automobile"),
    ),
  ).toBe(true);

  const asked = server.requests.length;
  const context = await helpers.runCliAsync(f.env, "context", "--query", "automobile", "--json");
  expect(context.exitCode, context.stderr).toBe(0);
  // Packets ask the same engine for hybrid ranking; the notes are ledger events, so the canon section is empty.
  expect(server.requests.length).toBeGreaterThan(asked);
  expect(server.requests.at(-1)!.body.input).toEqual(["automobile"]);
  const packet = JSON.parse(context.stdout) as { degraded?: string[] };
  expect(packet.degraded ?? []).not.toContain("retrieval-vector-unavailable");
  expect(packet.degraded ?? []).not.toContain("retrieval-unavailable");

  server.stop();
  const offline = await helpers.runCliAsync(f.env, "query", "sedan", "--json");
  expect(offline.exitCode, offline.stderr).toBe(0);
  const labelled = JSON.parse(offline.stdout) as {
    data: { hits: Array<{ snippet: string }> };
    degraded?: string[];
  };
  expect(labelled.data.hits.map((hit) => hit.snippet).join("\n")).toContain(
    "sedan",
  );
  expect(labelled.degraded).toContain("retrieval-vector-unavailable");
});

test("the embed-backfill rail drains a backlog left while the embedding server was down", async () => {
  const f = helpers.tempVault();
  const server = semanticServer();
  configure(f.vault, server);
  const db = openVaultDb(f.vault);
  const engine = await openConfiguredRetrieval(f.vault);
  try {
    const doc = (id: string, title: string, text: string) => ({
      doc_id: id, kind: "page" as const, title, text, sensitivity: "public" as const, taint: "clean" as const,
      authority: "connector_evidence" as const, subjects: [], provenance: [], occurred_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
    });
    // The write is stored and searchable by keyword; its vectors wait for the server.
    server.behaviour = { kind: "status", status: 503 };
    // Not `expect(...).rejects`: it blocks the loop that also serves the fake server.
    const refused = await engine!.upsert([doc("page:sedan", "Sedan", "We signed for the sedan on Friday."), doc("page:storm", "Weather", "A hurricane warning covers the coast.")]).then(() => null, (error: unknown) => error);
    expect(refused).toMatchObject({ code: "unavailable", retryable: true });
    const before = await engine!.health();
    const backlog = before.status === "ready" ? Number(before.detail["backlog_depth"]) : -1;
    expect(backlog).toBeGreaterThan(0);

    const rails = { hooks: { claims: { db, retrieval: engine! }, embedding_configured: true } };
    const down = await runRail(db, f.vault, "embed-backfill", rails);
    expect(down.status).toBe("degraded");
    expect(down.retrieval.degraded).toEqual(["embedding-unavailable"]);
    expect(down.retrieval.pending_ops).toBe(backlog);

    server.behaviour = { kind: "ok" };
    const drained = await runRail(db, f.vault, "embed-backfill", rails);
    expect(drained.status).toBe("ok");
    expect(drained.retrieval).toEqual({ upserts: 2, removals: 0, pending_ops: 0, degraded: [] });
    const after = await engine!.health();
    expect(after.status === "ready" && after.detail["backlog_depth"]).toBe(0);

    const found = await engine!.search({ text: "automobile", mode: "hybrid", scope: { kinds: ["page"] }, ceiling: "private", limit: 5, deadline_ms: 3_000 });
    expect(found.hits[0]?.doc_id).toBe("page:sedan");
    expect(found.degraded).not.toContain("vector-backlog");
    // Nothing left to do: the next run is idle.
    expect((await runRail(db, f.vault, "embed-backfill", rails)).retrieval.upserts).toBe(0);
  } finally {
    await engine?.close();
    db.close();
  }
});

test("doctor explains an index update refused by the capacity bound without dialing the model", async () => {
  const f = helpers.tempVault();
  const server = semanticServer();
  configure(f.vault, server);
  const engine = await openConfiguredRetrieval(f.vault);
  try {
    if (engine?.rebuildFromDocuments === undefined) throw new Error("expected an authoritative rebuild-capable engine");
    const refused = await engine.rebuildFromDocuments([{
      doc_id: "page:oversized", kind: "page", title: "Synthetic capacity fixture",
      text: "synthetic text ".repeat(400_000), sensitivity: "public", taint: "clean",
      authority: "connector_evidence", subjects: [], provenance: [],
      occurred_at: null, updated_at: "2026-09-01T00:00:00.000Z",
    }]).then(() => null, (error: unknown) => error);
    expect(refused).toMatchObject({ code: "budget_exhausted" });
    expect(server.requests).toHaveLength(0);
  } finally { await engine?.close(); }
  const report = await helpers.runCliAsync(f.env, "doctor", "--json");
  const json = JSON.parse(report.stdout) as { data: { serve: { stores: { vector_layer: { state: string; detail: string } } } } };
  expect(json.data.serve.stores.vector_layer.state).toBe("refused");
  expect(json.data.serve.stores.vector_layer.detail).toContain("text_bytes");
  expect(json.data.serve.stores.vector_layer.detail).toContain("lexical floor remains available");
  expect(server.requests).toHaveLength(0);
});
