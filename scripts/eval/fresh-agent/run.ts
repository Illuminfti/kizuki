import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveContextPacket, serveSearch, OWNER, ServeError } from "../../../packages/core/src/index";
import type { ServeContext } from "../../../packages/core/src/index";
import { PACKET_TOKENIZER_ID } from "../../../packages/core/src/serving/packet-tokenizer";
import { runSessionStart } from "../../../packages/cli/src/hook/session-start";
import { AS_OF } from "./persona";
import type { PersonaSize, PrincipalName, Question, Surface } from "./persona";
import { discoveredCards, generateVault } from "./vault";
import { markdownAtoms, rate, scoreObservation, worldAtoms } from "./score";
import type { Observation, Score } from "./score";

export const SURFACES: Surface[] = ["session_hook", "context_packet", "search", "world_view"];
export const PRINCIPALS: PrincipalName[] = ["owner", "scoped_agent"];
const BUDGET = 2000;

async function observe(fixture: Awaited<ReturnType<typeof generateVault>>, principal: PrincipalName, surface: Surface, question: Question, root: string): Promise<Observation> {
  const ctx: ServeContext = { db: fixture.db, vaultPath: fixture.vaultPath, principal: principal === "owner" ? OWNER : fixture.principal };
  switch (surface) {
    case "session_hook": {
      const result = await runSessionStart({ env: { KIZUKI_CONFIG: join(root, "unused-config.toml"), KIZUKI_EVAL_TOKEN: fixture.token },
        vaultOverride: fixture.vaultPath, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
        out: () => {}, err: () => {}, prompt: async () => { throw new Error("fixture cannot prompt"); },
        readStdin: async () => JSON.stringify({ cwd: `/projects/${question.query.replaceAll(" ", "-")}` }),
      }, { direct: true, harness: "generic", budget: BUDGET, timeoutMs: 60_000,
        tokenRef: principal === "owner" ? undefined : "env:KIZUKI_EVAL_TOKEN" });
      const output = "output" in result ? result.output : "";
      return { output, atoms: markdownAtoms(output), status: "output" in result ? "ok" : `skip:${result.skip}` };
    }
    case "context_packet": {
      const envelope = await serveContextPacket(ctx, { query: question.query, purpose: "recall", budget_tokens: BUDGET });
      return { output: JSON.stringify(envelope), atoms: markdownAtoms(envelope.data?.packet_md ?? ""),
        status: envelope.data?.truncated ? "truncated" : "ok" };
    }
    case "search": {
      const envelope = await serveSearch(ctx, { query: question.query, scope: "all", limit: 20 });
      return { output: JSON.stringify(envelope), status: "ok", atoms: [
        ...envelope.canon.map(chunk => ({ text: chunk.excerpt, cited: chunk.sources.length > 0 })),
        ...envelope.quoted.map(chunk => ({ text: chunk.text, cited: chunk.event_id.length > 0 })),
      ] };
    }
    case "world_view": {
      const envelopes = discoveredCards(ctx, question.world.kind, question.world.label);
      const unavailable = envelopes.some(envelope => "result" in envelope.data && envelope.data.result.status === "unavailable");
      const incomplete = envelopes.some(envelope => "result" in envelope.data && envelope.data.result.status === "incomplete");
      return { output: JSON.stringify(envelopes), atoms: worldAtoms(envelopes), status: unavailable ? "skip:unavailable" : incomplete ? "incomplete" : "ok" };
    }
  }
}

export function summarize(rows: Score[]) {
  return PRINCIPALS.flatMap(principal => SURFACES.map(surface => {
    const selected = rows.filter(row => row.principal === principal && row.surface === surface);
    const sum = (key: "expected" | "recalled" | "returned" | "stale" | "leak_count" | "cited" | "tokens_used") => selected.reduce((total, row) => total + row[key], 0);
    return { principal, surface, questions: selected.length, expected: sum("expected"), recalled: sum("recalled"),
      fact_recall: rate(sum("recalled"), sum("expected")), returned: sum("returned"), stale: sum("stale"),
      stale_fact_rate: rate(sum("stale"), sum("returned")), leak_count: sum("leak_count"), cited: sum("cited"),
      provenance_rate: rate(sum("cited"), sum("returned")), tokens_used: sum("tokens_used"),
      failures: selected.filter(row => row.status.startsWith("skip:") || row.status.startsWith("error:")).length };
  }));
}

export async function runEvaluation(options: { size?: PersonaSize; out?: string } = {}) {
  const size = options.size ?? "full";
  // Output is a new synthetic sandbox, never an existing owner vault.
  const root = options.out ?? mkdtempSync(join(tmpdir(), "fresh-agent-"));
  if (options.out !== undefined) mkdirSync(root, { recursive: false, mode: 0o700 });
  let fixture: Awaited<ReturnType<typeof generateVault>> | undefined;
  try {
    fixture = await generateVault(root, size);
    const rows: Score[] = [];
    const observations: { principal: PrincipalName; surface: Surface; question_id: string; observation: Observation }[] = [];
    for (const principal of PRINCIPALS) for (const surface of SURFACES) for (const question of fixture.questions) {
      let observation: Observation;
      try { observation = await observe(fixture, principal, surface, question, root); }
      catch (error) {
        if (!(error instanceof ServeError)) throw error;
        observation = { output: JSON.stringify({ error: error.code }), atoms: [], status: `error:${error.code}` };
      }
      observations.push({ principal, surface, question_id: question.id, observation });
      rows.push(scoreObservation(fixture.facts, question, principal, surface, observation));
    }
    const report = { schema: "kizuki.fresh-agent-eval/v1" as const, persona: `orchard-v1:${size}`, as_of: AS_OF,
      tokenizer: PACKET_TOKENIZER_ID, packet_budget: BUDGET, model: "scripted-persona-v1", bun: Bun.version,
      questions: fixture.questions, facts: fixture.facts, build: fixture.build, observations, rows, summaries: summarize(rows) };
    if (options.out !== undefined) {
      writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
      writeFileSync(join(root, "report.md"), renderMarkdown(report));
      writeFileSync(join(root, "questions.json"), JSON.stringify(fixture.questions, null, 2) + "\n");
    }
    return report;
  } finally {
    fixture?.db.close();
    if (options.out === undefined) rmSync(root, { recursive: true, force: true });
  }
}

export type EvaluationReport = Awaited<ReturnType<typeof runEvaluation>>;
const percent = (value: number | null) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

export function renderMarkdown(report: EvaluationReport): string {
  const lines = ["# Fresh-agent retrieval benchmark", "", `Persona: ${report.persona}. Logical as-of: ${report.as_of}.`, "",
    `Scripted extraction; model-free scoring. Tokenizer: ${report.tokenizer}. Packet budget: ${report.packet_budget}.`, "",
    "| Principal | Surface | Recall | Stale exposure | Leaks | Provenance | Tokens | Failures |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.summaries.map(row => `| ${row.principal} | ${row.surface} | ${row.recalled}/${row.expected} (${percent(row.fact_recall)}) | ${row.stale}/${row.returned} (${percent(row.stale_fact_rate)}) | ${row.leak_count} | ${row.cited}/${row.returned} (${percent(row.provenance_rate)}) | ${row.tokens_used} | ${row.failures} |`),
    "", "Stale exposure includes explicitly quoted historical facts. Provenance measures local addressable citations, not verified truth. Zero expected facts gives n/a recall.", "",
    "World views use discovery plus all returned cards with all valid windows and current knowledge. Session hooks use the host project hint. Search and recall packets use the same lexical hint. Context packets count the complete envelope; their budget constrains the Markdown body. See docs/evaluation.md for limits.", "",
    "| Principal | Surface | Question | Recall | Stale | Leaks | Provenance | Tokens | Status |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...report.rows.map(row => `| ${row.principal} | ${row.surface} | ${row.question_id} | ${row.recalled}/${row.expected} | ${row.stale} | ${row.leak_count} | ${row.cited}/${row.returned} | ${row.tokens_used} | ${row.status} |`), "",
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out"), sizeIndex = args.indexOf("--size");
  const out = outIndex < 0 ? undefined : args[outIndex + 1];
  const size = sizeIndex < 0 ? "full" : args[sizeIndex + 1];
  const validFlags = args.every((arg, index) => index % 2 === 0
    ? arg === "--out" || arg === "--size"
    : !arg.startsWith("--"));
  if (!validFlags || out === undefined || out.length === 0 || (size !== "small" && size !== "full") || args.length !== 2 + (sizeIndex < 0 ? 0 : 2)) {
    console.error("Usage: bun scripts/eval/fresh-agent/run.ts --out NEW_DIRECTORY [--size small|full]");
    process.exitCode = 2;
  } else {
    try {
      const report = await runEvaluation({ out, size });
      console.log(renderMarkdown(report).split("\n| Principal | Surface | Question")[0]);
      if (report.summaries.some(row => row.leak_count > 0 || row.failures > 0)) process.exitCode = 1;
    } catch {
      console.error("Fresh-agent evaluation failed; use a new output directory and inspect the synthetic sandbox.");
      process.exitCode = 1;
    }
  }
}
