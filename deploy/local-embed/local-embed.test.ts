import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER, runRail, serveSearch } from "@kizuki/core";
import { openVaultDb } from "../../packages/cli/src/context";
import { openConfiguredRetrieval } from "../../packages/cli/src/retrieval-runtime";
import { createHelpers, fixtureConsent } from "../../packages/cli/test/helpers";

setDefaultTimeout(180_000);

const helpers = createHelpers();
let proc: ReturnType<typeof Bun.spawn> | null = null;
let serverPort = 0;

const GOLDEN: ReadonlyArray<{
  file: string;
  text: string;
  marker: string;
  paraphrase: string;
}> = [
  {
    file: "vehicle",
    text: "We signed for the sedan on Friday and the keys arrive next week.",
    marker: "sedan",
    paraphrase: "buying an automobile",
  },
  {
    file: "money",
    text: "The payment schedule for the agency needs revised numbers before the audit.",
    marker: "payment schedule",
    paraphrase: "financial cash budget",
  },
  {
    file: "illness",
    text: "Grace is unwell and staying offline until the fever clears.",
    marker: "unwell",
    paraphrase: "sick with a high temperature",
  },
  {
    file: "housing",
    text: "The apartment lease ends in June so the boxes are packed early.",
    marker: "apartment lease",
    paraphrase: "moving out of the residence",
  },
  {
    file: "pet",
    text: "The puppy chewed through two sofa cushions again.",
    marker: "sofa cushions",
    paraphrase: "a dog destroying furniture",
  },
  {
    file: "weather",
    text: "A hurricane warning covers the coast through Sunday night.",
    marker: "hurricane warning",
    paraphrase: "severe tropical storm",
  },
  {
    file: "clinic",
    text: "The physician moved the checkup to Tuesday morning.",
    marker: "checkup",
    paraphrase: "appointment with a medical doctor",
  },
];

beforeAll(async () => {
  const script = join(import.meta.dir, "server.py");
  proc = Bun.spawn(
    [
      "python3",
      script,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--model",
      "BAAI/bge-small-en-v1.5",
      "--backend",
      "auto",
      "--threads",
      "6",
      "--batch-size",
      "32",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        TOKENIZERS_PARALLELISM: "false",
      },
    },
  );
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let buffer = "";
  while (!buffer.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  const firstLine = buffer.split("\n")[0]?.trim() ?? "";
  const info = JSON.parse(firstLine) as { event: string; port: number; dims: number; rss_mib: number };
  expect(info.event).toBe("listening");
  expect(info.dims).toBe(384);
  expect(info.rss_mib).toBeLessThan(500);
  serverPort = info.port;
});

afterAll(() => {
  proc?.kill();
  helpers.cleanup();
});

test("real local CPU BAAI/bge-small-en-v1.5 server enables vector layer in doctor, embed-backfill, and zero-keyword-overlap semantic search", async () => {
  const f = helpers.tempVault();
  const notesDir = join(f.root, "notes");
  mkdirSync(notesDir, { recursive: true });
  for (const note of GOLDEN) {
    writeFileSync(join(notesDir, `${note.file}.md`), `${note.text}\n`);
  }

  const imported = helpers.runCli(
    f.env,
    "import",
    "markdown-folder",
    "--source",
    notesDir,
    ...fixtureConsent(f.root),
  );
  expect(imported.exitCode, imported.stderr).toBe(0);

  writeFileSync(
    join(f.vault, ".kizuki", "serve.toml"),
    `[ports]
retrieval = { id = "kizuki.retrieval.embedded-pg", max_text_bytes = 67108864 }

[ports.embedding]
id = "kizuki.embedding.local-http"
api = "openai"
endpoint = "http://127.0.0.1:${serverPort}"
model = "BAAI/bge-small-en-v1.5"
dims = 384
max_input_tokens = 512
chunk_tokens = 384
chunk_overlap = 56
batch_size = 32
timeout_ms = 30000
prompt_query = "Represent this sentence for searching relevant passages: {q}"
prompt_doc = "{title}\\n\\n{text}"
`,
    { mode: 0o600 },
  );

  const docBefore = await helpers.runCliAsync(f.env, "doctor", "--json");
  const docJson = JSON.parse(docBefore.stdout) as {
    data: { serve: { stores: { vector_layer: { state: string; detail: string } } } };
  };
  expect(docJson.data.serve.stores.vector_layer.state).toBe("configured");
  expect(docJson.data.serve.stores.vector_layer.detail).toBe(
    "vector layer: configured (kizuki.embedding.local-http)",
  );

  const rebuilt = await helpers.runCliAsync(
    f.env,
    "rebuild",
    "--port",
    "kizuki.retrieval.embedded-pg",
    "--confirm",
    "--json",
  );
  expect(rebuilt.exitCode, rebuilt.stdout + rebuilt.stderr).toBe(0);

  const db = openVaultDb(f.vault);
  const engine = await openConfiguredRetrieval(f.vault);
  try {
    expect(engine).toBeDefined();
    expect(engine!.descriptor.supports).toEqual(expect.arrayContaining(["vector", "hybrid"]));

    const backfill = await runRail(db, f.vault, "embed-backfill", {
      hooks: { claims: { db, retrieval: engine! }, embedding_configured: true },
    });
    expect(backfill.status).toBe("ok");
    expect(backfill.retrieval.pending_ops).toBe(0);

    const floor = { db, vaultPath: f.vault, principal: OWNER };
    const hybrid = { ...floor, retrieval: engine! };
    let lexicalHits = 0;
    let hybridTop1Hits = 0;
    for (const note of GOLDEN) {
      const lex = await serveSearch(floor, { query: note.paraphrase, scope: "all", limit: 5 });
      if (lex.quoted.some((q) => q.text.includes(note.marker))) lexicalHits += 1;

      const sem = await serveSearch(hybrid, { query: note.paraphrase, scope: "all", limit: 5 });
      expect(sem.data?.degraded ?? []).not.toContain("retrieval-vector-unavailable");
      if (sem.quoted[0]?.text.includes(note.marker)) hybridTop1Hits += 1;
    }
    expect(lexicalHits).toBe(0);
    expect(hybridTop1Hits).toBe(GOLDEN.length);
  } finally {
    await engine?.close();
    db.close();
  }
});
