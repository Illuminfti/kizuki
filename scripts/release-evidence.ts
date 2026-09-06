/** Shared v3 evidence reader, receipt identity, and the surface-inventory family. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { COMMANDS } from "../packages/cli/src/commands/index";
import { RETIRED_OWNER_GATE_VERBS } from "../packages/cli/src/retired";
import { defaultConnectorRegistry } from "@kizuki/connectors";
import { TOOL_DESCRIPTIONS } from "@kizuki/mcp";

export type GateStatus = "PASS" | "FAIL" | "MISSING" | "UNVERIFIABLE" | "NOT_IMPLEMENTED";
export class EvidenceError extends Error { constructor(readonly reason: string) { super(reason); } }
export function reject(reason: string): never { throw new EvidenceError(reason); }
export const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export const TARGETS = ["bun-linux-x64-baseline", "bun-darwin-arm64"] as const;
export const JOURNEYS = ["connect-resume", "correct-belief", "revoke-purge", "retrieve-trustworthily", "import-estate-slice", "daily-loop", "useful-insight", "install-recover"] as const;
/** Acceptance obligations, never a claim that a connector is implemented. */
export const CONNECTORS = [
  { id: "telegram", connector_id: "kizuki.telegram", evidence: "live-account" },
  { id: "gmail", connector_id: "kizuki.gmail", evidence: "live-account" },
  { id: "google-calendar", connector_id: "kizuki.google-calendar", evidence: "live-account" },
  { id: "imap", connector_id: "kizuki.imap", evidence: "live-account" },
  { id: "ics", connector_id: "kizuki.ics", evidence: "file-import" },
  { id: "whoop", connector_id: "kizuki.whoop", evidence: "live-account" },
  { id: "x-api", connector_id: null, evidence: "live-account" },
  { id: "screenpipe", connector_id: "kizuki.screenpipe", evidence: "local-source" },
  { id: "markdown-folder", connector_id: "kizuki.markdown-folder", evidence: "file-import" },
  { id: "chatgpt-export", connector_id: "kizuki.import-chatgpt", evidence: "file-import" },
  { id: "claude-export", connector_id: "kizuki.import-claude", evidence: "file-import" },
  { id: "x-archive", connector_id: "kizuki.import-x-archive", evidence: "file-import" },
  { id: "whatsapp-export", connector_id: "kizuki.import-whatsapp", evidence: "file-import" },
  { id: "pocket", connector_id: "kizuki.import-pocket", evidence: "file-import" },
  { id: "omnivore", connector_id: "kizuki.import-omnivore", evidence: "file-import" },
] as const;
export const EVIDENCE_LIMITS = { index: 16384, index_v3: 32768, family_receipt: 65536, journey_connector_receipt: 262144, depth: 32 } as const;
export const SURFACE_PRODUCER = "kizuki.surface-inventory/v1";
export const SURFACE_GATE = "surface.capabilities-and-docs";
export const SURFACE_PRODUCER_FILES = ["scripts/capability-proof.ts", "scripts/release-evidence.ts"] as const;
export const CAPABILITY_PROOF_FILE = "scripts/capability-proof.ts";
export const SURFACE_DOC_FILES = ["README.md", "SECURITY.md", "docs/CURRENT.md", "docs/cli.md"] as const;
export const SOURCE_CLASSES = [
  "synthetic-fixture", "local-operator-custody", "native-host-attestation", "candidate-tree-inventory",
  "exact-candidate-ci-snapshot", "independent-reviewer", "findings-snapshot", "live-account-operator",
  "file-import-operator", "local-source-operator", "non-author-participant", "independent-witness",
  "supervised-owner-observation", "paired-estate-observation", "owner-operational-authority",
] as const;
export const ACTOR_CLASSES = [
  "automated-producer", "retained-ci-snapshot", "enrolled-reviewer", "authorized-operator",
  "independent-witness", "owner-or-delegated-maintainer",
] as const;
const PRODUCERS = [
  "kizuki.native-attestation/v1", "kizuki.native-lifecycle/v1", "kizuki.required-checks/v1",
  "kizuki.independent-review/v1", "kizuki.p0-disposition/v1", SURFACE_PRODUCER, "kizuki.journey-proof/v1",
  "kizuki.connector-evidence/v1", "kizuki.unfamiliar-user/v1", "kizuki.owner-rails-observation/v1",
  "kizuki.estate-parity-observation/v1", "kizuki.cutover-authority/v1",
] as const;
/** Help group order from packages/cli/src/help.ts, then live COMMANDS not listed there. */
const CLI_HELP_GROUPS = [
  ["app", "init", "import", "doctor"], ["query", "context"], ["connect", "backfill", "sync"],
  ["tell", "undo", "audit"], ["serve", "models", "agent"], ["purge", "export", "restore"], ["version"],
] as const;

export interface GateReceiptReference {
  producer: string; gate_id: string; target: string | null; path: string; sha256: string;
}
export interface VerifierEntry { file: string; sha256: string | null; status?: "MISSING" | "PRESENT" }
export interface SurfaceDisagreement { code: string; path: string }
export interface SurfaceEvaluation {
  status: "PASS" | "FAIL" | "UNVERIFIABLE"; reason: string; creditDigest: boolean;
}

export function exact(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.split(",").sort().join()) reject("invalid-schema");
  return value as Record<string, unknown>;
}
export function text(value: unknown, limit = 4096): string {
  if (typeof value !== "string" || value.length < 1 || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) reject("invalid-string");
  return value;
}
export function digest(value: unknown, length = 64): string {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/.test(value)) reject("invalid-digest");
  return value;
}
export function absolute(value: unknown): string {
  const path = text(value);
  if (!isAbsolute(path) || resolve(path) !== path) reject("noncanonical-path");
  return path;
}
function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT");
}
function kebab(value: unknown, limit = 64): string {
  const code = text(value, limit);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code)) reject("invalid-schema");
  return code;
}
function uuidV4(value: unknown): string {
  const id = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) reject("invalid-identity");
  return id;
}
export function recordedAt(value: unknown): string {
  const raw = text(value, 24);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(raw)) reject("invalid-recorded-at");
  const date = new Date(raw);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== raw) reject("invalid-recorded-at");
  return raw;
}
function relativePosix(value: unknown): string {
  const path = text(value, 256);
  if (!/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(path)) reject("invalid-identity");
  return path;
}
function strictlySorted(items: readonly string[]): boolean {
  return items.every((item, index) => index === 0 || items[index - 1]! < item);
}
function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Reject static symlinks and detect identity changes during the read. The local
 * operator must retain exclusive custody; this is not hostile-host attestation. */
export function parents(path: string) {
  const rows: { path: string; dev: bigint; ino: bigint }[] = [];
  let current = parse(path).root;
  for (const part of dirname(path).slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part); const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject("unsafe-path");
    rows.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return () => { for (const row of rows) { const stat = lstatSync(row.path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== row.dev || stat.ino !== row.ino) reject("path-changed"); } };
}
export function read(path: string, limit: number, retain = true) {
  absolute(path); const checkParents = parents(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) reject("unsafe-file-or-size");
    const size = Number(before.size), buffer = Buffer.alloc(Math.min(size + 1, 65536));
    const chunks: Buffer[] = [], state = createHash("sha256"); let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!count) reject("file-changed");
      const chunk = buffer.subarray(0, count); state.update(chunk); if (retain) chunks.push(Buffer.from(chunk)); offset += count;
    }
    if (readSync(fd, buffer, 0, 1, offset) !== 0) reject("file-changed");
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino) reject("file-changed");
    const unchanged = () => {
      checkParents(); const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs || stat.nlink !== 1n) reject("file-changed");
    };
    unchanged(); return { sha256: state.digest("hex"), bytes: retain ? Buffer.concat(chunks) : Buffer.alloc(0), unchanged };
  } finally { closeSync(fd); }
}

export function parseGateReceipts(value: unknown): GateReceiptReference[] {
  if (!Array.isArray(value) || value.length > 40) reject("invalid-index");
  return value.map(raw => {
    const row = exact(raw, "producer,gate_id,target,path,sha256");
    const producer = text(row.producer, 128), gate_id = text(row.gate_id);
    if (row.target !== null && typeof row.target !== "string") reject("invalid-index");
    const target = row.target === null ? null : text(row.target, 64);
    return { producer, gate_id, target, path: absolute(row.path), sha256: digest(row.sha256) };
  });
}

function producerAllows(producer: string, gate_id: string, target: string | null): boolean {
  switch (producer) {
    case "kizuki.native-attestation/v1":
      return target !== null && (TARGETS as readonly string[]).includes(target) && gate_id === `native.${target}`;
    case "kizuki.native-lifecycle/v1":
      return target !== null && (TARGETS as readonly string[]).includes(target) && gate_id === `lifecycle.${target}`;
    case "kizuki.required-checks/v1":
      return target === null && gate_id === "candidate.required-checks";
    case "kizuki.independent-review/v1":
      return target === null && gate_id === "candidate.independent-review";
    case "kizuki.p0-disposition/v1":
      return target === null && gate_id === "candidate.current-p0-disposition";
    case SURFACE_PRODUCER:
      return target === null && gate_id === SURFACE_GATE;
    case "kizuki.journey-proof/v1":
      return target === null && gate_id.startsWith("journey.") && (JOURNEYS as readonly string[]).includes(gate_id.slice(8));
    case "kizuki.connector-evidence/v1":
      return target === null && gate_id.startsWith("connector.") && CONNECTORS.some(item => item.id === gate_id.slice(10));
    case "kizuki.unfamiliar-user/v1":
      return target === null && gate_id === "human.unfamiliar-user";
    case "kizuki.owner-rails-observation/v1":
      return target === null && gate_id === "owner.seven-day-rails";
    case "kizuki.estate-parity-observation/v1":
      return target === null && gate_id === "estate.fourteen-day-parity";
    case "kizuki.cutover-authority/v1":
      return target === null && gate_id === "owner.final-cutover";
    default:
      return false;
  }
}

export function gateReceiptMappingError(rows: readonly GateReceiptReference[]): string | null {
  const ids = rows.map(row => row.gate_id);
  if (new Set(ids).size !== ids.length) return "duplicate-gate";
  for (const row of rows) {
    if (!(PRODUCERS as readonly string[]).includes(row.producer)) return "unknown-producer";
    if (!producerAllows(row.producer, row.gate_id, row.target)) return "mismatched-gate-or-target";
  }
  return null;
}

export function inspectOptionalVerifier(root: string, file: string): VerifierEntry {
  const path = resolve(root, file);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (isEnoent(error)) return { file, sha256: null, status: "MISSING" };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) reject("verifier-file-unreadable");
  return { file, sha256: hash(readFileSync(path)), status: "PRESENT" };
}

export function producerRevision(root: string, files: readonly string[]): string {
  const entries = files.map(path => ({ path, sha256: hash(readFileSync(resolve(root, path))) }));
  return hash(JSON.stringify({ files: entries }));
}

export function checkoutSha(root: string): string {
  const proc = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) reject("candidate-sha-unreadable");
  return digest(proc.stdout.toString().trim(), 40);
}

function readCandidateBytes(root: string, relative: string): Buffer {
  try { return readFileSync(resolve(root, relative)); }
  catch { reject("surface-unenumerable"); }
}

export function cliVerbSequence(): string[] {
  const live = COMMANDS.map(command => command.name);
  if (live.length < 1 || live.length > 64 || new Set(live).size !== live.length) reject("surface-unenumerable");
  const known = new Set(live), grouped: string[] = [];
  for (const group of CLI_HELP_GROUPS) for (const name of group) if (known.has(name)) grouped.push(name);
  const listed = new Set(grouped);
  for (const name of live) if (!listed.has(name)) grouped.push(name);
  return grouped;
}

function connectorsRegistered(): Record<string, unknown>[] {
  const ids = defaultConnectorRegistry.ids();
  const descriptors = new Map(defaultConnectorRegistry.list().map(item => [item.id, item]));
  if (ids.length < 1 || ids.length > 64 || descriptors.size !== ids.length) reject("surface-unenumerable");
  return ids.map(connector_id => {
    const port_id = connector_id.replace(/^kizuki\./, "kizuki.connector.");
    const item = descriptors.get(port_id);
    if (!item) reject("surface-unenumerable");
    return {
      connector_id, port_id: item.id, kind: item.kind, contract: item.contract, contract_minor: item.contract_minor,
      supports: [...item.supports], requires_lease: item.requires_lease, optional_package: item.optional_package,
    };
  });
}

export function connectorsC3(): { id: string; connector_id: string | null; evidence: string }[] {
  return CONNECTORS.map(item => ({ id: item.id, connector_id: item.connector_id, evidence: item.evidence }));
}

export function expectedSurfaceInventory(candidateRoot: string, candidateSha: string) {
  const bun_version = readCandidateBytes(candidateRoot, ".bun-version").toString("utf8").trim();
  if (!bun_version) reject("surface-unenumerable");
  const docs = SURFACE_DOC_FILES.map(path => ({ path, sha256: hash(readCandidateBytes(candidateRoot, path)) }));
  const mcp_tools = Object.keys(TOOL_DESCRIPTIONS);
  if (mcp_tools.length < 1 || mcp_tools.length > 64 || new Set(mcp_tools).size !== mcp_tools.length) reject("surface-unenumerable");
  return {
    head_sha: digest(candidateSha, 40),
    bun_version,
    cli_verbs: cliVerbSequence(),
    retired_verbs: [...RETIRED_OWNER_GATE_VERBS],
    mcp_tools,
    connectors_registered: connectorsRegistered(),
    connectors_c3: connectorsC3(),
    docs: { files: docs },
    producer_files: [...SURFACE_PRODUCER_FILES],
    producer_revision: producerRevision(candidateRoot, SURFACE_PRODUCER_FILES),
    checkout_sha: checkoutSha(candidateRoot),
  };
}

function stringList(value: unknown, bound: number, limit = 256): string[] {
  if (!Array.isArray(value) || value.length > bound) reject("invalid-schema");
  const items = value.map(item => text(item, limit));
  if (new Set(items).size !== items.length) reject("invalid-schema");
  return items;
}
function failureList(value: unknown): { code: string }[] {
  if (!Array.isArray(value) || value.length > 32) reject("invalid-schema");
  return value.map(item => ({ code: kebab(exact(item, "code").code) }));
}
function disagreementList(value: unknown): SurfaceDisagreement[] {
  if (!Array.isArray(value) || value.length > 64) reject("invalid-schema");
  const rows = value.map(item => {
    const row = exact(item, "code,path");
    return { code: kebab(row.code), path: text(row.path, 256) };
  });
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!, next = rows[i]!;
    if (prev.code > next.code || (prev.code === next.code && prev.path >= next.path)) reject("invalid-schema");
  }
  return rows;
}

function parseSharedIdentity(value: unknown, producer: string, candidateSha: string) {
  const row = exact(value, "candidate_source_sha,producer,producer_revision,producer_files,source_class,actor_class,attempt_id,recorded_at");
  if (digest(row.candidate_source_sha, 40) !== candidateSha) reject("candidate-mismatch");
  if (text(row.producer, 128) !== producer) reject("invalid-identity");
  const producer_revision = digest(row.producer_revision);
  if (!Array.isArray(row.producer_files) || row.producer_files.length < 1 || row.producer_files.length > 32) reject("invalid-identity");
  const producer_files = row.producer_files.map(relativePosix);
  if (new Set(producer_files).size !== producer_files.length || !strictlySorted(producer_files)) reject("invalid-identity");
  const source_class = text(row.source_class, 64), actor_class = text(row.actor_class, 64);
  if (!(SOURCE_CLASSES as readonly string[]).includes(source_class) || !(ACTOR_CLASSES as readonly string[]).includes(actor_class)) reject("invalid-identity");
  return { candidate_source_sha: candidateSha, producer, producer_revision, producer_files, source_class, actor_class, attempt_id: uuidV4(row.attempt_id), recorded_at: recordedAt(row.recorded_at) };
}

function registeredRow(value: unknown) {
  const row = exact(value, "connector_id,port_id,kind,contract,contract_minor,supports,requires_lease,optional_package");
  if (typeof row.contract_minor !== "number" || !Number.isSafeInteger(row.contract_minor) || row.contract_minor < 0) reject("invalid-schema");
  if (typeof row.requires_lease !== "boolean") reject("invalid-schema");
  const optional_package = row.optional_package === null ? null : text(row.optional_package, 256);
  return {
    connector_id: text(row.connector_id, 128), port_id: text(row.port_id, 128), kind: text(row.kind, 64),
    contract: text(row.contract, 128), contract_minor: row.contract_minor, supports: stringList(row.supports, 64, 128),
    requires_lease: row.requires_lease, optional_package,
  };
}
function c3Row(value: unknown) {
  const row = exact(value, "id,connector_id,evidence");
  const connector_id = row.connector_id === null ? null : text(row.connector_id, 128);
  return { id: text(row.id, 64), connector_id, evidence: text(row.evidence, 64) };
}

function sortDisagreements(rows: SurfaceDisagreement[]): SurfaceDisagreement[] {
  return [...rows].sort((left, right) => left.code < right.code ? -1 : left.code > right.code ? 1 : left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function evaluateSurfaceReceipt(value: unknown, candidateRoot: string, candidateSha: string): SurfaceEvaluation {
  const row = exact(value, "schema,identity,outcome,failures,head_sha,bun_version,cli_verbs,retired_verbs,mcp_tools,connectors_registered,connectors_c3,docs,disagreements");
  if (row.schema !== SURFACE_PRODUCER) reject("invalid-schema");
  const identity = parseSharedIdentity(row.identity, SURFACE_PRODUCER, candidateSha);
  if (identity.source_class !== "candidate-tree-inventory" || identity.actor_class !== "automated-producer") reject("invalid-identity");
  if (!equalJson(identity.producer_files, [...SURFACE_PRODUCER_FILES])) reject("producer-files-mismatch");
  const expected = expectedSurfaceInventory(candidateRoot, candidateSha);
  if (identity.producer_revision !== expected.producer_revision) reject("producer-revision-mismatch");
  const outcome = text(row.outcome, 16);
  if (outcome !== "pass" && outcome !== "fail" && outcome !== "unresolved") reject("invalid-outcome");
  const failures = failureList(row.failures);
  if (outcome === "pass" && failures.length !== 0) reject("invalid-outcome");
  if (outcome === "fail" && failures.length === 0) reject("invalid-outcome");
  const head_sha = digest(row.head_sha, 40), bun_version = text(row.bun_version, 64);
  const cli_verbs = stringList(row.cli_verbs, 64, 64), retired_verbs = stringList(row.retired_verbs, 32, 64), mcp_tools = stringList(row.mcp_tools, 64, 64);
  if (!Array.isArray(row.connectors_registered) || row.connectors_registered.length > 64) reject("invalid-schema");
  const connectors_registered = row.connectors_registered.map(registeredRow);
  if (!connectors_registered.every((item, index) => index === 0 || connectors_registered[index - 1]!.connector_id < item.connector_id)) reject("invalid-schema");
  if (!Array.isArray(row.connectors_c3) || row.connectors_c3.length > 32) reject("invalid-schema");
  const connectors_c3 = row.connectors_c3.map(c3Row);
  const docs = exact(row.docs, "files");
  if (!Array.isArray(docs.files) || docs.files.length < 1 || docs.files.length > 32) reject("invalid-schema");
  const files = docs.files.map(item => {
    const file = exact(item, "path,sha256");
    return { path: relativePosix(file.path), sha256: digest(file.sha256) };
  });
  if (!strictlySorted(files.map(item => item.path))) reject("invalid-schema");
  const claimed = disagreementList(row.disagreements);
  const computed = sortDisagreements(([
    ["head-sha-mismatch", "head_sha", head_sha === expected.head_sha && head_sha === expected.checkout_sha],
    ["bun-version-mismatch", "bun_version", bun_version === expected.bun_version],
    ["cli-verbs-mismatch", "cli_verbs", equalJson(cli_verbs, expected.cli_verbs)],
    ["retired-verbs-mismatch", "retired_verbs", equalJson(retired_verbs, expected.retired_verbs)],
    ["mcp-tools-mismatch", "mcp_tools", equalJson(mcp_tools, expected.mcp_tools)],
    ["connectors-registered-mismatch", "connectors_registered", equalJson(connectors_registered, expected.connectors_registered)],
    ["connectors-c3-mismatch", "connectors_c3", equalJson(connectors_c3, expected.connectors_c3)],
    ["docs-mismatch", "docs.files", equalJson(files, expected.docs.files)],
  ] as const).filter(item => !item[2]).map(([code, path]) => ({ code, path })));
  if (!equalJson(claimed, computed)) reject("surface-disagreement-mismatch");
  if (outcome === "pass" && computed.length !== 0) reject("invalid-outcome");
  if (outcome === "pass") return { status: "PASS", reason: "surface-inventory-agrees", creditDigest: true };
  if (outcome === "fail") return { status: "FAIL", reason: "surface-outcome-fail", creditDigest: true };
  return { status: "UNVERIFIABLE", reason: "surface-outcome-unresolved", creditDigest: true };
}
