/** Synthetic fixture construction is explicit; every evaluated consumer uses a child CLI or MCP. */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as core from "../packages/core/src/index";
import { EvidenceError, hash, reject } from "./native-proof-evidence";
import { openNativeMcp, runNativeCommand } from "./native-proof-process";
import type { NativeMcpSession, ProcessObservation } from "./native-proof-process";
import { RECOVERY_RECIPE, RETRIEVAL_CASES, SOURCE_TITLES, MODEL_NAME, JOURNAL_FIELDS, validateObservedCheck } from "./recovery-proof-recipe";
import type { ObservedCheck, ScenarioId } from "./recovery-proof-recipe";

import type { FixtureClaim, JournalRow, PendingFixture, ReplayState } from "./recovery-proof-fixtures";
type ScenarioRecipe = typeof RECOVERY_RECIPE.scenarios[number];
type Sequenced<T> = T & { sequence: number };
export interface ScenarioObservation {
  id: ScenarioId; fixtures: Sequenced<{ id: string; action: string | null; target: string; observation: ProcessObservation | null }>[];
  commands: Sequenced<{ id: string; template: string[]; target: string | null; observation: ProcessObservation }>[];
  tools: Sequenced<{ id: string; session: number; request_id: number; name: string; arguments: Record<string, unknown>; response_sha256: string }>[];
  sessions: Sequenced<{ ordinal: number; request_ids: number[]; observation: ProcessObservation }>[];
  checks: Sequenced<ObservedCheck>[]; failure: string | null;
}
function requireFact(value: unknown): asserts value { if (!value) reject("recovery-fixture-or-consumer-invalid"); }
function data<T>(stdout: string): T { const envelope = JSON.parse(stdout) as { status?: string; data?: T }; requireFact(envelope.status !== "error" && envelope.data !== undefined); return envelope.data; }
function occurrences(value: unknown, title: string): number { return (JSON.stringify(value).match(new RegExp(title, "g")) ?? []).length; }
const configureRetrieval = (vault: string) => writeFileSync(join(vault, ".kizuki/serve.toml"), '[ports]\nretrieval="kizuki.retrieval.embedded-pg"\n', { mode: 0o600 });

class Scenario {
  readonly vault: string; readonly restored: string; readonly backup: string;
  readonly values: Record<string, unknown>; readonly result: ScenarioObservation;
  private sequence = 0; private session: NativeMcpSession | null = null;
  constructor(readonly recipe: ScenarioRecipe, readonly root: string, readonly cliExecutable: string[], readonly mcpExecutable: string[]) {
    mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "home"), { mode: 0o700 });
    this.vault = join(root, "vault"); this.restored = join(root, "restored"); this.backup = join(root, "backup");
    this.values = { vault: this.vault, restored: this.restored, backup: this.backup, "missing-backup": join(root, "missing-backup"), "missing-target": join(root, "missing-target"), "legacy-backup": join(root, "legacy-backup") };
    this.result = { id: recipe.id, fixtures: [], commands: [], tools: [], sessions: [], checks: [], failure: null };
  }
  private env() { return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(this.root, "home"), XDG_CONFIG_HOME: join(this.root, "home/config"), KIZUKI_CONFIG: join(this.root, "config.toml"), KIZUKI_SUPERVISOR: "none", LANG: "C.UTF-8" }; }
  private resolve(value: unknown): unknown {
    if (typeof value === "string" && value.startsWith("$")) { const found = this.values[value.slice(1)]; requireFact(found !== undefined); return found; }
    if (Array.isArray(value)) return value.map(item => this.resolve(item));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolve(item)]));
    return value;
  }
  async cli(id: string) {
    const recipe = this.recipe.commands[this.result.commands.length]; requireFact(recipe?.id === id);
    const args = recipe.args.map(arg => { const value = this.resolve(arg); requireFact(typeof value === "string"); return value; });
    const result = await runNativeCommand([...this.cliExecutable, ...args, ...(recipe.target === null ? [] : ["--vault", recipe.target === "vault" ? this.vault : this.restored])], { cwd: this.root, env: this.env() });
    this.result.commands.push({ sequence: ++this.sequence, id, template: recipe.args, target: recipe.target, observation: result.observation });
    if (result.observation.fault !== null || result.observation.exit_code !== recipe.expected_exit) throw new Error("recovery-native-command-failed", { cause: result });
    return result;
  }
  fixture(id: string) {
    const recipe = this.recipe.fixtures[this.result.fixtures.length]; requireFact(recipe?.id === id && recipe.action === null);
    this.result.fixtures.push({ sequence: ++this.sequence, id, action: null, target: recipe.target, observation: null });
  }
  async coreFixture<T>(id: string, input: Record<string, unknown>): Promise<T> {
    const recipe = this.recipe.fixtures[this.result.fixtures.length]; requireFact(recipe?.id === id && recipe.action !== null);
    const target = recipe.target === "vault" ? this.vault : this.restored;
    const result = await runNativeCommand([process.execPath, join(import.meta.dir, "recovery-proof-fixtures.ts"), recipe.action, target, JSON.stringify(input)], { cwd: this.root, env: this.env() });
    this.result.fixtures.push({ sequence: ++this.sequence, id, action: recipe.action, target: recipe.target, observation: result.observation });
    if (result.observation.fault !== null || result.observation.exit_code !== 0) throw new Error("recovery-fixture-child-failed", { cause: result });
    return JSON.parse(result.stdout) as T;
  }
  check(id: string, observed: unknown) {
    requireFact(this.recipe.checks[this.result.checks.length]?.id === id);
    this.result.checks.push({ sequence: ++this.sequence, id, observed });
    validateObservedCheck(this.recipe, { id, observed });
  }
  async startMcp() {
    requireFact(this.session === null && this.result.sessions.length === 0);
    this.session = await openNativeMcp([...this.mcpExecutable, "--vault", this.vault, "--owner", "--retrieval", "kizuki.retrieval.embedded-pg"], { cwd: this.root, env: this.env() });
  }
  async tool<T>(id: string): Promise<core.Envelope<T>> {
    const recipe = this.recipe.tools[this.result.tools.length]; requireFact(recipe?.id === id && this.session !== null);
    const response = await this.session.call(recipe.name, this.resolve(recipe.arguments) as Record<string, unknown>) as { isError?: boolean; structuredContent?: core.Envelope<T> };
    const request = this.session.requests.at(-1)!;
    this.result.tools.push({ sequence: ++this.sequence, id, session: 1, request_id: request.request_id, name: recipe.name, arguments: recipe.arguments, response_sha256: request.response_sha256 });
    requireFact(response.isError !== true && response.structuredContent !== undefined);
    return response.structuredContent;
  }
  async closeMcp() {
    if (this.session === null) return;
    const session = this.session; this.session = null;
    const observation = await session.close();
    this.result.sessions.push({ sequence: ++this.sequence, ordinal: 1, request_ids: session.requests.map(row => row.request_id), observation });
    requireFact(observation.exit_code === 0 && observation.fault === null);
  }
}

function fixtureMap(rows: FixtureClaim[]) { return rows.map(row => ({ case_id: row.title, event_sha256: hash(row.event), claim_sha256: hash(row.claim), identity_sha256: hash(row.identity) })); }
async function retrieval(c: Scenario) {
  await c.cli("init");
  const rows = await c.coreFixture<FixtureClaim[]>("source-model-canon", {});
  for (const row of rows) c.values[`claim.${row.title}`] = row.claim;
  c.check("fixture-map", fixtureMap(rows));
  const ownerReceipts: string[] = [];
  for (const item of RETRIEVAL_CASES.filter(row => row.correction)) {
    const receipt = data<{ receipt_id: string }>((await c.cli(`owner.${item.title}`)).stdout).receipt_id; requireFact(typeof receipt === "string"); ownerReceipts.push(receipt);
  }
  c.check("owner-receipts", new Set(ownerReceipts).size);
  async function evaluate(stage: string) {
    const result = [];
    for (const item of rows) {
      const hits = data<{ hits: core.SearchHit[] }>((await c.cli(`${stage}.${item.title}`)).stdout).hits;
      const index = hits.findIndex(hit => hit.doc_id === `page:${item.identity}`);
      result.push({ case_id: item.title, rank: index + 1, authority: index < 0 ? null : hits[index]!.authority });
    }
    c.check(stage, result);
  }
  await c.cli("floor-rebuild"); await evaluate("floor-exact"); await evaluate("floor-typos");
  configureRetrieval(c.vault); c.fixture("embedded-retrieval-selection"); await c.cli("engine-rebuild"); await evaluate("engine-typos");
  const corrected = data<{ receipt_id: string }>((await c.cli("correct")).stdout); c.values["correction-receipt"] = corrected.receipt_id;
  c.check("correction-receipts", typeof corrected.receipt_id === "string" ? 1 : 0);
  const authority = (stdout: string) => data<{ hits: core.SearchHit[] }>(stdout).hits.find(hit => hit.doc_id === `page:${rows[0]!.identity}`)?.authority ?? null;
  c.check("corrected-authority", authority((await c.cli("corrected-query")).stdout)); await c.cli("undo");
  c.check("undo-bytes", { before_sha256: rows[0]!.beforeHash, after_sha256: hash(readFileSync(join(c.vault, rows[0]!.path!))) });
  c.check("undone-authority", authority((await c.cli("undone-query")).stdout));
  await c.cli("engine-rebuild-repeat"); await evaluate("engine-after-undo"); await c.cli("export"); await c.cli("restore");
  configureRetrieval(c.restored); c.fixture("restored-retrieval-selection"); await c.cli("restored-rebuild"); await evaluate("restored-engine");
}

interface RevocationData { purge: string; grant: core.SourceGrant }
interface Packet { packet_md: string; packet_hash: string; claims_epoch: number; delivery?: string }
async function revocation(c: Scenario) {
  await c.cli("init"); const rows: FixtureClaim[] = [];
  for (const title of SOURCE_TITLES) {
    const source = join(c.root, title); mkdirSync(source, { mode: 0o700 });
    writeFileSync(join(source, "note.md"), `${title} works at the synthetic conservatory.\n`, { mode: 0o600 }); c.values[`notes.${title}`] = source;
    const enrolled = await c.cli(`enroll.${title}`), sourceKey = enrolled.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)?.[1]; requireFact(sourceKey); c.values[`source.${title}`] = sourceKey;
    const denied = await c.cli(`denied.${title}`);
    const grant = await c.coreFixture<{ captured: number }>(`grant.${title}`, { title, source_key: sourceKey });
    c.check(`denied.${title}`, { reason: denied.stderr.includes("source_capture_denied") ? "source_capture_denied" : "unexpected-refusal", captured: grant.captured });
    await c.cli(`capture.${title}`); await c.cli(`retry.${title}`);
    const seeded = await c.coreFixture<{ captured: number; row: FixtureClaim }>(`claim.${title}`, { title, source_key: sourceKey });
    c.check(`capture.${title}`, seeded.captured);
    rows.push({ ...seeded.row, source, originalHash: hash(readFileSync(join(source, "note.md"))) });
  }
  c.check("fixture-map", fixtureMap(rows)); await c.cli("floor-rebuild");
  const positive = await c.coreFixture<number[]>("historical-separate-fts", { rows });
  c.check("historical-fts-positive", positive);
  const first = rows[0]!, keep = rows[1]!;
  configureRetrieval(c.vault); c.fixture("embedded-retrieval-selection"); await c.cli("engine-rebuild");
  const hits = (stdout: string) => data<{ hits: core.SearchHit[] }>(stdout).hits;
  c.check("cli-positive-revoked", occurrences(hits((await c.cli("positive-revoked")).stdout), first.title));
  c.check("cli-positive-independent", occurrences(hits((await c.cli("positive-independent")).stdout), keep.title));
  c.check("cli-positive-context", occurrences(data<Packet>((await c.cli("positive-context")).stdout), first.title));
  await c.startMcp();
  c.check("mcp-positive-revoked", occurrences(await c.tool("positive-search"), first.title));
  c.check("mcp-positive-independent", occurrences(await c.tool("positive-independent"), keep.title));
  const before = (await c.tool<Packet>("positive-context")).data; requireFact(before !== undefined); c.check("mcp-positive-context", occurrences(before.packet_md, first.title));
  c.values["prefix.hash"] = before.packet_hash; c.values["prefix.epoch"] = before.claims_epoch;
  c.check("revocation-state", data<RevocationData>((await c.cli("revoke")).stdout).purge);
  c.check("cli-denied-query", hits((await c.cli("denied-query")).stdout).length);
  c.check("cli-denied-context", occurrences(data<Packet>((await c.cli("denied-context")).stdout), first.title));
  c.check("recapture-reason", (await c.cli("denied-recapture")).stderr.includes("source_capture_denied") ? "source_capture_denied" : "unexpected-refusal");
  c.check("cli-retained-independent", occurrences(hits((await c.cli("retained-independent")).stdout), keep.title));
  c.check("mcp-denied-query", occurrences(await c.tool("denied-search"), first.title));
  const after = (await c.tool<Packet>("denied-context")).data; requireFact(after !== undefined); c.check("prefix-delivery", after.delivery);
  c.check("prefix-hash", { before_sha256: before.packet_hash, after_sha256: after.packet_hash }); c.check("mcp-denied-context", occurrences(after.packet_md, first.title));
  c.check("mcp-retained-independent", occurrences(await c.tool("retained-independent"), keep.title));
  const busy = data<RevocationData>((await c.cli("resume-busy")).stdout);
  c.check("busy-store", { purge: busy.purge, postgres: busy.grant.owned_retrieval.find(store => store.store_id === "local:kizuki.retrieval.embedded-pg")?.status ?? "missing" });
  c.check("mcp-pending-query", occurrences(await c.tool("pending-search"), first.title)); await c.closeMcp();
  const complete = data<RevocationData>((await c.cli("resume-fresh")).stdout);
  c.check("completed-stores", { purge: complete.purge, blockers: complete.grant.purge_blockers.length, stores: complete.grant.owned_retrieval.map(store => `${store.store_id}:${store.status}`).sort(),
    existing_generations: ["kizuki.retrieval.fts5", "kizuki.retrieval.embedded-pg"].filter(engine => existsSync(join(c.vault, ".kizuki/retrieval", engine, "store"))).length });
  c.check("retry-state", data<RevocationData>((await c.cli("resume-retry")).stdout).purge);
  c.check("core-inspection", await c.coreFixture("owned-ledger-claim-inspection", { claim_id: first.claim }));
  await c.cli("rebuild-after-purge"); c.check("rebuilt-denied", hits((await c.cli("purged-query")).stdout).length);
  c.check("rebuilt-independent", occurrences(hits((await c.cli("purged-independent")).stdout), keep.title));
  c.check("external-original", { before_sha256: first.originalHash, after_sha256: hash(readFileSync(join(first.source!, "note.md"))) }); await c.cli("export");
}

const DEFERRED_STREAM = "serve/extract-deferred-inputs.jsonl", JOURNAL_STREAM = "serve/extract-batches.jsonl";
interface BackupManifest { files: Record<string, { count: number }>; schema_versions: { serve: number }; manifest_sha256: string }
function modifyManifest(path: string, update: (manifest: BackupManifest) => void) {
  const file = join(path, "manifest.json"), manifest = JSON.parse(readFileSync(file, "utf8")) as BackupManifest; update(manifest);
  const { manifest_sha256: _old, ...unsigned } = manifest; manifest.manifest_sha256 = hash(JSON.stringify(unsigned, null, 2) + "\n");
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 }); chmodSync(file, 0o600);
}
function journalComparison(before: JournalRow, after: JournalRow) { return Object.fromEntries(JOURNAL_FIELDS.map(field => [field, { before_sha256: hash(before[field]), after_sha256: hash(after[field]) }])); }
async function pending(c: Scenario) {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("synthetic replay must not call model", { status: 503 }); } });
  const endpoint = `http://127.0.0.1:${server.port}/v1/chat/completions`;
  try {
    await c.cli("init");
    const constructed = await c.coreFixture<PendingFixture>("constructed-pending-decision", { endpoint });
    const { journal: expectedJournal, allowed_id: allowedId, denied_id: deniedId, queued_id: queuedId } = constructed;
    c.check("constructor", constructed.constructor);
    const exported = await c.cli("export"); requireFact(exported.stdout.includes("schema=kizuki.backup/v1 complete=true"));
    const manifest = JSON.parse(readFileSync(join(c.backup, "manifest.json"), "utf8")) as BackupManifest;
    c.check("backup-streams", { serve_version: manifest.schema_versions.serve, journals: manifest.files[JOURNAL_STREAM]?.count, deferred: manifest.files[DEFERRED_STREAM]?.count });
    c.check("exported-journal", journalComparison(expectedJournal!, JSON.parse(readFileSync(join(c.backup, JOURNAL_STREAM), "utf8")) as JournalRow));
    const missing = c.values["missing-backup"] as string, legacy = c.values["legacy-backup"] as string;
    cpSync(c.backup, missing, { recursive: true, errorOnExist: true }); modifyManifest(missing, manifest => { delete manifest.files[JOURNAL_STREAM]; }); unlinkSync(join(missing, JOURNAL_STREAM)); c.fixture("missing-current-journal-copy");
    const refusal = await c.cli("missing-journal"); c.check("missing-journal-refusal", { reason: refusal.stderr.includes("backup durable extraction stream is missing") ? "backup durable extraction stream is missing" : "unexpected-refusal", target_exists: existsSync(c.values["missing-target"] as string) });
    cpSync(c.backup, legacy, { recursive: true, errorOnExist: true }); modifyManifest(legacy, manifest => { delete manifest.files[JOURNAL_STREAM]; delete manifest.files[DEFERRED_STREAM]; manifest.schema_versions.serve = 7; });
    unlinkSync(join(legacy, JOURNAL_STREAM)); unlinkSync(join(legacy, DEFERRED_STREAM)); c.fixture("simulated-v7-copy");
    c.check("legacy-warning", (await c.cli("legacy-warning")).stdout.includes("warning=backup predates durable extraction recovery") ? "backup predates durable extraction recovery" : "missing-warning");
    await c.cli("restore");
    const restored = await c.coreFixture<{ journal: JournalRow | null; queued: number }>("restored-journal-inspection", { queued_id: queuedId });
    requireFact(restored.journal !== null); c.check("restored-journal", journalComparison(expectedJournal, restored.journal)); c.check("restored-queue", restored.queued);
    writeFileSync(join(c.restored, ".kizuki/serve.toml"), `[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url="http://127.0.0.1:${server.port}/v1"\nmodel="${MODEL_NAME}"\ntimeout_ms=1000\nmax_retries=0\n`, { mode: 0o600 }); c.fixture("restored-loopback-binding");
    const inspect = (id: string) => c.coreFixture<ReplayState>(id, { allowed_id: allowedId, denied_id: deniedId, queued_id: queuedId });
    data((await c.cli("replay")).stdout); c.check("replay-model-requests", requests); const first = await inspect("replay-inspection"); c.check("replay-state", first);
    data((await c.cli("retry")).stdout); c.check("retry-model-requests", requests); const second = await inspect("retry-inspection"); c.check("retry-state", second);
    c.check("stable-claim", { before_sha256: first.claim_sha256, after_sha256: second.claim_sha256 });
    c.check("stable-receipt", { before_sha256: first.receipt_sha256, after_sha256: second.receipt_sha256 });
    c.check("stable-provenance", { before_sha256: first.provenance_sha256, after_sha256: second.provenance_sha256 });
  } finally { await server.stop(true); }
}

/** Tests may call the recipe through source children; only the strict artifact entry point issues a native receipt. */
export async function observeRecoveryScenarios(root: string, cli: string[], mcp: string[], onFailure?: (scenario: ScenarioId, error: unknown) => void): Promise<ScenarioObservation[]> {
  const results: ScenarioObservation[] = [];
  for (const recipe of RECOVERY_RECIPE.scenarios) {
    const scenario = new Scenario(recipe, join(root, recipe.id), cli, mcp);
    try { await ({ "retrieval-authority-recovery": retrieval, "revocation-retained-consumers": revocation, "pending-decision-restore": pending }[recipe.id])(scenario); }
    catch (error) {
      onFailure?.(recipe.id, error);
      scenario.result.failure = error instanceof Error && ["recovery-native-command-failed", "recovery-fixture-child-failed"].includes(error.message) ? error.message
        : error instanceof EvidenceError ? "recovery-observation-invalid" : "recovery-scenario-failed";
    }
    finally { try { await scenario.closeMcp(); } catch { scenario.result.failure ??= "recovery-session-cleanup-failed"; } }
    results.push(scenario.result);
  }
  return results;
}
