/** Shared v3 evidence reader, receipt identity, and the surface-inventory family. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, parse, resolve } from "node:path";
import { releaseTarget } from "./release-targets";
import ts from "typescript";
import { COMMANDS } from "../packages/cli/src/commands/index";
import { printRootHelp } from "../packages/cli/src/help";
import { RETIRED_OWNER_GATE_VERBS } from "../packages/cli/src/retired";
import { defaultConnectorRegistry } from "../packages/connectors/src/index";
import { TOOL_DESCRIPTIONS } from "../packages/mcp/src/index";

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
  { id: "x-api", connector_id: "kizuki.x", evidence: "live-account" },
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
export const CHECKOUT_LIMITS = { files: 1024, imports: 8192, resolution_entries: 8192, syntax_nodes: 262144, file_bytes: 1_048_576, total_bytes: 4_194_304, help_lines: 256, help_line_chars: 4096 } as const;
export const SURFACE_PRODUCER = "kizuki.surface-inventory/v1";
export const SURFACE_GATE = "surface.capabilities-and-docs";
export const SURFACE_PRODUCER_FILES = ["scripts/capability-proof.ts", "scripts/release-evidence.ts"] as const;
export const CAPABILITY_PROOF_FILE = "scripts/capability-proof.ts";
export const NATIVE_ATTESTATION_PRODUCER = "kizuki.native-attestation/v1";
export const NATIVE_ATTESTATION_PRODUCER_FILES = ["scripts/native-attestation.ts", "scripts/release-evidence.ts"] as const;
export const SURFACE_DOC_FILES = ["README.md", "SECURITY.md", "docs/CURRENT.md", "docs/cli.md"] as const;
const SURFACE_MODULE_FILES = [
  "packages/cli/src/commands/index.ts", "packages/cli/src/help.ts", "packages/cli/src/retired.ts",
  "packages/mcp/src/index.ts", "packages/connectors/src/index.ts",
] as const;
export const SURFACE_OBSERVED_FILES = [
  ".bun-version", "package.json", "tsconfig.json", "bun.lock", ...SURFACE_DOC_FILES, "scripts/release-evidence.ts",
  "packages/cli/src/commands/index.ts", "packages/cli/src/help.ts", "packages/cli/src/retired.ts",
  "packages/mcp/src/index.ts", "packages/mcp/src/server.ts",
  "packages/connectors/src/index.ts", "packages/connectors/src/registry.ts",
] as const;
export const EVALUATOR_ROOT = realpathSync(resolve(import.meta.dir, ".."));
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
  NATIVE_ATTESTATION_PRODUCER, "kizuki.native-lifecycle/v1", "kizuki.required-checks/v1",
  "kizuki.independent-review/v1", "kizuki.p0-disposition/v1", SURFACE_PRODUCER, "kizuki.journey-proof/v1",
  "kizuki.connector-evidence/v1", "kizuki.unfamiliar-user/v1", "kizuki.owner-rails-observation/v1",
  "kizuki.estate-parity-observation/v1", "kizuki.cutover-authority/v1",
] as const;

export interface GateReceiptReference {
  producer: string; gate_id: string; target: string | null; path: string; sha256: string;
}
export interface VerifierEntry { file: string; sha256: string | null; status?: "MISSING" | "PRESENT" }
export interface SurfaceDisagreement { code: string; path: string }
export interface SurfaceEvaluation {
  status: "PASS" | "FAIL" | "UNVERIFIABLE"; reason: string; creditDigest: boolean;
}
export interface CheckoutFileBinding {
  path: string; mode: "100644" | "100755"; oid: string; sha256: string; bytes: Buffer;
}
export interface CheckoutCustodyFrame {
  root: string; head: string; files: readonly CheckoutFileBinding[]; unchanged: () => void;
}
export interface ExpectedSurfaceInventory {
  head_sha: string; checkout_sha: string; bun_version: string; cli_verbs: string[]; retired_verbs: string[];
  mcp_tools: string[]; connectors_registered: Record<string, unknown>[]; connectors_c3: { id: string; connector_id: string | null; evidence: string }[];
  docs: { files: { path: string; sha256: string }[] }; producer_files: string[]; producer_revision: string;
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
/** Canonical receipt instant. Observed timestamps may omit milliseconds. */
export function receiptInstant(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) reject("invalid-recorded-at");
  return recordedAt(new Date(parsed).toISOString());
}
function relativePosix(value: unknown): string {
  const path = text(value, 256);
  if (!/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(path)) reject("invalid-identity");
  // `.` and `..` match the segment character class; a receipt must never steer a
  // read outside the checkout it claims to describe.
  if (path.split("/").some(segment => segment === "." || segment === "..")) reject("invalid-identity");
  return path;
}
function strictlySorted(items: readonly string[]): boolean {
  return items.every((item, index) => index === 0 || items[index - 1]! < item);
}
function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function canonicalRoot(root: string): string {
  try { return realpathSync(absolute(resolve(root))); }
  catch (error) { if (error instanceof EvidenceError) throw error; reject("candidate-checkout-unreadable"); }
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
    case NATIVE_ATTESTATION_PRODUCER:
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
  const base = resolve(root), path = resolve(base, file);
  // No caller may read outside the checkout, whatever path a receipt names.
  if (path !== base && !path.startsWith(`${base}/`)) reject("verifier-file-outside-checkout");
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (isEnoent(error)) return { file, sha256: null, status: "MISSING" };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) reject("verifier-file-unreadable");
  return { file, sha256: hash(readFileSync(path)), status: "PRESENT" };
}

export function surfaceProducerActive(root: string): boolean {
  if (inspectOptionalVerifier(root, CAPABILITY_PROOF_FILE).status !== "PRESENT") return false;
  const proc = Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", "-C", root, "ls-files", "--error-unmatch", "--", CAPABILITY_PROOF_FILE],
    { stdout: "pipe", stderr: "pipe" },
  );
  return proc.exitCode === 0;
}

export function producerRevision(files: readonly { path: string; sha256: string }[]): string {
  return hash(JSON.stringify({ files: files.map(item => ({ path: item.path, sha256: item.sha256 })) }));
}

function git(root: string, args: readonly string[]) {
  const proc = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) reject("candidate-checkout-unreadable");
  return proc.stdout.toString();
}
function nulRecords(raw: string): string[] {
  if (raw === "") return [];
  const records = raw.split("\0");
  if (records.at(-1) === "") records.pop();
  return records;
}
function gitBlobOid(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function parseTree(raw: string): Map<string, { mode: string; oid: string }> {
  const rows = new Map<string, { mode: string; oid: string }>();
  for (const record of nulRecords(raw)) {
    const match = record.match(/^([0-7]{6}) blob ([a-f0-9]{40})\t(.+)$/);
    if (!match) reject("candidate-file-symlink-or-mode");
    if (rows.has(match[3]!)) reject("candidate-file-missing");
    rows.set(match[3]!, { mode: match[1]!, oid: match[2]! });
  }
  return rows;
}
function parseIndex(raw: string): Map<string, { mode: string; oid: string }> {
  const rows = new Map<string, { mode: string; oid: string }>();
  for (const record of nulRecords(raw)) {
    const match = record.match(/^([0-7]{6}) ([a-f0-9]{40}) ([0-3])\t(.+)$/);
    if (!match || match[3] !== "0") reject("candidate-index-dirty");
    if (rows.has(match[4]!)) reject("candidate-index-dirty");
    rows.set(match[4]!, { mode: match[1]!, oid: match[2]! });
  }
  return rows;
}

function snapshotCheckout(root: string, candidateSha: string, files: readonly string[]): { head: string; files: CheckoutFileBinding[] } {
  const toplevel = git(root, ["rev-parse", "--show-toplevel"]).trim();
  if (toplevel !== root) reject("candidate-root-mismatch");
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (head !== candidateSha) reject("candidate-head-mismatch");
  const porcelain = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (porcelain.trim() !== "") {
    const lines = porcelain.split("\n").filter(Boolean);
    if (lines.some(line => line.startsWith("??"))) reject("candidate-untracked");
    if (lines.some(line => line[0] !== " " && line[0] !== "?")) reject("candidate-index-dirty");
    reject("candidate-worktree-dirty");
  }
  const tree = parseTree(git(root, ["ls-tree", "-z", "HEAD", "--", ...files]));
  const index = parseIndex(git(root, ["ls-files", "--stage", "-z", "--", ...files]));
  if (tree.size !== files.length || index.size !== files.length) reject("candidate-file-missing");
  const bindings: CheckoutFileBinding[] = [];
  let total = 0;
  for (const file of files) {
    const entry = tree.get(file), staged = index.get(file);
    if (!entry || !staged) reject("candidate-file-missing");
    if (entry.mode !== staged.mode || entry.oid !== staged.oid) reject("candidate-index-dirty");
    if (entry.mode !== "100644" && entry.mode !== "100755") reject("candidate-file-symlink-or-mode");
    const full = resolve(root, file);
    if (!full.startsWith(`${root}/`) || full.slice(root.length + 1) !== file) reject("unsafe-path");
    let named;
    try { named = lstatSync(full, { bigint: true }); }
    catch { reject("candidate-file-missing"); }
    if (named.isSymbolicLink() || !named.isFile()) reject("candidate-file-symlink-or-mode");
    const body = read(full, CHECKOUT_LIMITS.file_bytes);
    total += body.bytes.length;
    if (total > CHECKOUT_LIMITS.total_bytes) reject("checkout-byte-bound");
    if (gitBlobOid(body.bytes) !== entry.oid) reject("candidate-byte-mismatch");
    if (((named.mode & 0o111n) !== 0n) !== (entry.mode === "100755")) reject("candidate-mode-mismatch");
    bindings.push({ path: file, mode: entry.mode, oid: entry.oid, sha256: body.sha256, bytes: body.bytes });
  }
  return { head, files: bindings };
}

export function assertCheckoutCustody(root: string, candidateSha: string, files: readonly string[]): CheckoutCustodyFrame {
  const canonical = canonicalRoot(root);
  if (files.length < 1 || files.length > CHECKOUT_LIMITS.files || new Set(files).size !== files.length) reject("checkout-file-bound");
  for (const file of files) relativePosix(file);
  digest(candidateSha, 40);
  const first = snapshotCheckout(canonical, candidateSha, files);
  return {
    root: canonical, head: first.head, files: first.files,
    unchanged: () => {
      const second = snapshotCheckout(canonical, candidateSha, files);
      if (second.head !== first.head) reject("candidate-head-mismatch");
      if (second.files.length !== first.files.length) reject("file-changed");
      for (let i = 0; i < first.files.length; i++) {
        const left = first.files[i]!, right = second.files[i]!;
        if (left.path !== right.path || left.mode !== right.mode || left.oid !== right.oid || left.sha256 !== right.sha256) reject("file-changed");
      }
    },
  };
}

/** Refuse graphs Bun's literal scanner cannot prove. This syntax check never
 * derives a command, connector, or tool inventory from source text. */
function assertLiteralModuleLoading(file: string, bytes: Buffer) {
  try {
    const tree = ts.createSourceFile(file, bytes.toString("utf8"), ts.ScriptTarget.Latest, true);
    const pending: ts.Node[] = [tree]; let count = 0;
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (++count > CHECKOUT_LIMITS.syntax_nodes) reject("candidate-imports-unenumerable");
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) reject("candidate-imports-unenumerable");
      }
      // An alias of require or createRequire can hide loading from scanImports.
      if (ts.isIdentifier(node) && (node.text === "require" || node.text === "createRequire")) {
        const parent = node.parent;
        if (node.text === "createRequire") reject("candidate-imports-unenumerable");
        const directCall = ts.isCallExpression(parent) && parent.expression === node && node.text === "require";
        const propertyName = ((ts.isPropertyAccessExpression(parent) && parent.expression.kind === ts.SyntaxKind.ThisKeyword) ||
          ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.name === node;
        if (!directCall && !propertyName) reject("candidate-imports-unenumerable");
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    reject("candidate-imports-unenumerable");
  }
}

/** Bun canonicalizes lexical aliases, including aliases above an imported
 * source directory, and consults metadata that is not itself imported. Inspect
 * the bounded candidate namespace, including ignored entries, before accepting
 * that resolution. Dependency installations retain their separate boundary. */
function resolutionMetadata(root: string): string[] {
  const pending = ["."];
  const metadata: string[] = []; let count = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!, path = resolve(root, directory);
    const checkParents = parents(join(path, ".custody"));
    const handle = opendirSync(path);
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        if (++count > CHECKOUT_LIMITS.resolution_entries) reject("checkout-resolution-bound");
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const relative = directory === "." ? entry.name : `${directory}/${entry.name}`;
        const stat = lstatSync(resolve(root, relative));
        if (stat.isSymbolicLink()) reject("candidate-file-symlink-or-mode");
        if (stat.isDirectory()) pending.push(relative);
        else if (entry.name === "package.json") {
          if (!stat.isFile()) reject("candidate-file-symlink-or-mode");
          metadata.push(relativePosix(relative));
        }
      }
    } finally { handle.closeSync(); }
    checkParents();
  }
  return metadata.sort();
}

/** Enumerate source custody, never inventory values. Bun supplies literal
 * runtime resolution; unsupported dynamic graphs are explicitly refused. */
export function collectProductSources(root: string, entrypoints: readonly string[]) {
  if (entrypoints.length < 1 || entrypoints.length > CHECKOUT_LIMITS.files) reject("checkout-file-bound");
  const canonical = canonicalRoot(root), pending = [...entrypoints];
  const files = new Map<string, string>(), resolutions: [string, string, string][] = [];
  const parsers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }),
    js: new Bun.Transpiler({ loader: "js" }), jsx: new Bun.Transpiler({ loader: "jsx" }) };
  let total = 0;
  const bindFile = (file: string) => {
    if (files.size >= CHECKOUT_LIMITS.files) reject("checkout-file-bound");
    const path = resolve(canonical, file);
    if (!path.startsWith(`${canonical}/`) || path.slice(canonical.length + 1) !== file) reject("unsafe-path");
    const body = read(path, CHECKOUT_LIMITS.file_bytes);
    total += body.bytes.length;
    if (total > CHECKOUT_LIMITS.total_bytes) reject("checkout-byte-bound");
    files.set(file, body.sha256);
    return body;
  };
  while (pending.length > 0) {
    const file = relativePosix(pending.pop());
    if (files.has(file)) continue;
    const path = resolve(canonical, file), body = bindFile(file);
    const extension = extname(file);
    const parser = extension === ".ts" || extension === ".mts" || extension === ".cts" ? parsers.ts
      : extension === ".tsx" ? parsers.tsx : extension === ".js" || extension === ".mjs" || extension === ".cjs" ? parsers.js
      : extension === ".jsx" ? parsers.jsx : null;
    // JSON and literal text/assets are bound as bytes, not executed as source.
    if (!parser) continue;
    assertLiteralModuleLoading(file, body.bytes);
    let imports;
    try { imports = parser.scanImports(body.bytes); }
    catch { reject("candidate-imports-unenumerable"); }
    for (const item of imports) {
      const specifier = item.path;
      if (isBuiltin(specifier) || specifier === "bun" || specifier.startsWith("bun:")) continue;
      if (resolutions.length >= CHECKOUT_LIMITS.imports) reject("checkout-import-bound");
      let resolved;
      try { resolved = realpathSync(Bun.resolveSync(specifier, dirname(path))); }
      catch { reject("candidate-import-unresolved"); }
      const inDependencies = resolved.includes("/node_modules/");
      if (resolved.startsWith(`${canonical}/`) && !inDependencies) {
        const dependency = relativePosix(resolved.slice(canonical.length + 1));
        resolutions.push([file, specifier, dependency]); pending.push(dependency);
      } else {
        // Existing bundled PGlite assets use relative node_modules imports.
        // Relative product imports and every @kizuki import must stay inside
        // the candidate; third-party dependency installations may live outside.
        const relativeDependency = specifier.startsWith(".") && /\/node_modules\/(?!@kizuki\/)/.test(specifier);
        const bareDependency = !specifier.startsWith(".") && !isAbsolute(specifier) && !specifier.startsWith("@kizuki/");
        if (!inDependencies || (!relativeDependency && !bareDependency)) reject("candidate-product-resolution-outside");
        resolutions.push([file, specifier, resolved]);
      }
    }
    body.unchanged();
  }
  for (const file of resolutionMetadata(canonical)) {
    if (!files.has(file)) bindFile(file).unchanged();
  }
  const bindings = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 }));
  return { bindings, fingerprint: hash(JSON.stringify({ bindings, resolutions })) };
}

export function assertProductCheckoutCustody(root: string, candidateSha: string, entrypoints: readonly string[], files: readonly string[]): CheckoutCustodyFrame {
  const canonical = canonicalRoot(root), graph = collectProductSources(canonical, entrypoints);
  const frame = assertCheckoutCustody(canonical, candidateSha, [...new Set([...files, ...graph.bindings.map(item => item.path)])]);
  const bound = new Map(frame.files.map(item => [item.path, item.sha256]));
  if (graph.bindings.some(item => bound.get(item.path) !== item.sha256)) reject("file-changed");
  return { ...frame, unchanged: () => {
    if (collectProductSources(canonical, entrypoints).fingerprint !== graph.fingerprint) reject("file-changed");
    frame.unchanged();
  } };
}

export function bindEvaluatorCheckout(root: string, candidateSha: string, files: readonly string[]): CheckoutCustodyFrame {
  if (canonicalRoot(root) !== EVALUATOR_ROOT) reject("candidate-root-mismatch");
  return assertProductCheckoutCustody(EVALUATOR_ROOT, candidateSha, SURFACE_MODULE_FILES, files);
}

export function cliVerbSequence(): string[] {
  const live = COMMANDS.map(command => command.name);
  if (live.length < 1 || live.length > 64 || new Set(live).size !== live.length) reject("surface-unenumerable");
  const width = Math.max(...COMMANDS.map(command => command.name.length));
  const rows = new Map<string, string>();
  for (const command of COMMANDS) {
    const row = `  ${command.name.padEnd(width)}  ${command.summary}`;
    if (rows.has(row)) reject("surface-unenumerable");
    rows.set(row, command.name);
  }
  if (rows.size !== COMMANDS.length) reject("surface-unenumerable");
  const lines: string[] = [];
  const write = (line: string) => {
    if (lines.length >= CHECKOUT_LIMITS.help_lines || line.length > CHECKOUT_LIMITS.help_line_chars) reject("surface-unenumerable");
    lines.push(line);
  };
  try { printRootHelp(write, COMMANDS); }
  catch (error) { if (error instanceof EvidenceError) throw error; reject("surface-unenumerable"); }
  const sequence: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const name = rows.get(line);
    if (name === undefined) continue;
    if (seen.has(name)) reject("surface-unenumerable");
    seen.add(name);
    sequence.push(name);
  }
  if (sequence.length !== COMMANDS.length) reject("surface-unenumerable");
  return sequence;
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

function frameFile(frame: CheckoutCustodyFrame, path: string): CheckoutFileBinding {
  const row = frame.files.find(item => item.path === path);
  if (!row) reject("surface-unenumerable");
  return row;
}

export function expectedSurfaceInventory(frame: CheckoutCustodyFrame): ExpectedSurfaceInventory {
  if (frame.root !== EVALUATOR_ROOT) reject("candidate-root-mismatch");
  const bun_version = frameFile(frame, ".bun-version").bytes.toString("utf8").trim();
  if (!bun_version) reject("surface-unenumerable");
  const mcp_tools = Object.keys(TOOL_DESCRIPTIONS);
  if (mcp_tools.length < 1 || mcp_tools.length > 64 || new Set(mcp_tools).size !== mcp_tools.length) reject("surface-unenumerable");
  const producer_files = [...SURFACE_PRODUCER_FILES];
  return {
    head_sha: digest(frame.head, 40),
    checkout_sha: frame.head,
    bun_version,
    cli_verbs: cliVerbSequence(),
    retired_verbs: [...RETIRED_OWNER_GATE_VERBS],
    mcp_tools,
    connectors_registered: connectorsRegistered(),
    connectors_c3: connectorsC3(),
    docs: { files: SURFACE_DOC_FILES.map(path => ({ path, sha256: frameFile(frame, path).sha256 })) },
    producer_files,
    producer_revision: producerRevision(producer_files.map(path => ({ path, sha256: frameFile(frame, path).sha256 }))),
  };
}

export function consumeSurfaceReceipt(value: unknown, root: string, candidateSha: string): SurfaceEvaluation {
  const frame = bindEvaluatorCheckout(root, candidateSha, [...SURFACE_OBSERVED_FILES, CAPABILITY_PROOF_FILE]);
  const expected = expectedSurfaceInventory(frame);
  frame.unchanged();
  const evaluated = evaluateSurfaceReceipt(value, expected);
  frame.unchanged();
  return evaluated;
}

export interface NativeAttestationExpected {
  candidate_source_sha: string; target: string; producer_files: string[]; producer_revision: string;
  package_sha256: Record<string, string> | null; evaluator_platform: string; evaluator_arch: string; bun_version: string;
}

function packageHashes(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("invalid-schema");
  const out: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    relativePosix(key);
    out[key] = digest((value as Record<string, unknown>)[key]);
  }
  if (out.kizuki === undefined) reject("invalid-schema");
  return out;
}
function sameHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

/** The packaged kizuki-mcp exits 2 from its usage path when invoked with no arguments (packages/mcp/src/bin.ts). */
export const NATIVE_MCP_USAGE_EXIT_CODE = 2;

export function evaluateNativeAttestationReceipt(value: unknown, expected: NativeAttestationExpected): SurfaceEvaluation {
  const row = exact(value, "schema,identity,target,host_platform,host_arch,host_kernel_release,bun_version,execution_class,binary_sha256,package_sha256,argv,exit_code,stdout_sha256,mcp_argv,mcp_exit_code,mcp_stderr_sha256,outcome,failures");
  if (row.schema !== NATIVE_ATTESTATION_PRODUCER) reject("invalid-schema");
  const identity = parseSharedIdentity(row.identity, NATIVE_ATTESTATION_PRODUCER, expected.candidate_source_sha);
  if (identity.source_class !== "native-host-attestation" || identity.actor_class !== "automated-producer") reject("invalid-identity");
  if (!equalJson(identity.producer_files, expected.producer_files)) reject("producer-files-mismatch");
  if (identity.producer_revision !== expected.producer_revision) reject("producer-revision-mismatch");
  const target = releaseTarget(text(row.target, 64));
  if (target.target !== expected.target) reject("mismatched-gate-or-target");
  const host_platform = text(row.host_platform, 16), host_arch = text(row.host_arch, 16);
  const kernel = text(row.host_kernel_release, 256);
  if (kernel.trim() !== kernel || /[^\x20-\x7e]/.test(kernel)) reject("invalid-kernel-release");
  if (text(row.bun_version, 64) !== expected.bun_version) reject("unsupported-bun-version");
  const execution_class = text(row.execution_class, 32);
  if (execution_class === "simulated" || execution_class === "host-label" || execution_class === "cross-compiled") {
    return { status: "FAIL", reason: "cannot-certify-native-execution", creditDigest: true };
  }
  if (execution_class !== "native-host") reject("invalid-schema");
  if (host_platform !== target.platform || host_arch !== target.arch) {
    return { status: "FAIL", reason: "cannot-certify-native-execution", creditDigest: true };
  }
  const argv = stringList(row.argv, 8, 64);
  if (!equalJson(argv, ["kizuki", "--help"])) reject("native-command-substituted");
  if (typeof row.exit_code !== "number" || !Number.isSafeInteger(row.exit_code) || row.exit_code < 0 || row.exit_code > 255) reject("invalid-schema");
  digest(row.stdout_sha256);
  const mcp_argv = stringList(row.mcp_argv, 8, 64);
  if (!equalJson(mcp_argv, ["kizuki-mcp"])) reject("native-command-substituted");
  if (typeof row.mcp_exit_code !== "number" || !Number.isSafeInteger(row.mcp_exit_code) || row.mcp_exit_code < 0 || row.mcp_exit_code > 255) reject("invalid-schema");
  digest(row.mcp_stderr_sha256);
  const package_sha256 = packageHashes(row.package_sha256);
  if (digest(row.binary_sha256) !== package_sha256.kizuki) reject("proof-identity-mismatch");
  if (expected.package_sha256 === null) return { status: "FAIL", reason: "native-package-not-indexed", creditDigest: false };
  if (!sameHashes(package_sha256, expected.package_sha256)) reject("proof-package-mismatch");
  const outcome = text(row.outcome, 16);
  if (outcome !== "pass" && outcome !== "fail" && outcome !== "unresolved") reject("invalid-outcome");
  const failures = failureList(row.failures);
  if (outcome === "pass" && (failures.length !== 0 || row.exit_code !== 0 || row.mcp_exit_code !== NATIVE_MCP_USAGE_EXIT_CODE)) reject("invalid-outcome");
  if (outcome === "fail" && failures.length === 0) reject("invalid-outcome");
  if (host_platform !== expected.evaluator_platform || host_arch !== expected.evaluator_arch) {
    return { status: "UNVERIFIABLE", reason: "evaluator-cannot-certify-native-target", creditDigest: false };
  }
  if (outcome === "pass") return { status: "PASS", reason: "native-host-execution-attested", creditDigest: true };
  if (outcome === "fail") return { status: "FAIL", reason: "native-outcome-fail", creditDigest: true };
  return { status: "UNVERIFIABLE", reason: "native-outcome-unresolved", creditDigest: true };
}

export function consumeNativeAttestationReceipt(
  value: unknown, root: string, candidateSha: string, binding: { target: string; package_sha256: Record<string, string> | null },
): SurfaceEvaluation {
  const producer_files = NATIVE_ATTESTATION_PRODUCER_FILES.map(path => {
    const entry = inspectOptionalVerifier(root, path);
    if (entry.status !== "PRESENT" || entry.sha256 === null) reject("producer-revision-and-native-attestation-unavailable");
    return { path, sha256: entry.sha256 };
  });
  return evaluateNativeAttestationReceipt(value, {
    candidate_source_sha: digest(candidateSha, 40), target: binding.target, producer_files: [...NATIVE_ATTESTATION_PRODUCER_FILES],
    producer_revision: producerRevision(producer_files), package_sha256: binding.package_sha256,
    evaluator_platform: process.platform, evaluator_arch: process.arch,
    bun_version: readFileSync(resolve(root, ".bun-version"), "utf8").trim(),
  });
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

export function evaluateSurfaceReceipt(value: unknown, expected: ExpectedSurfaceInventory): SurfaceEvaluation {
  const row = exact(value, "schema,identity,outcome,failures,head_sha,bun_version,cli_verbs,retired_verbs,mcp_tools,connectors_registered,connectors_c3,docs,disagreements");
  if (row.schema !== SURFACE_PRODUCER) reject("invalid-schema");
  const identity = parseSharedIdentity(row.identity, SURFACE_PRODUCER, expected.head_sha);
  if (identity.source_class !== "candidate-tree-inventory" || identity.actor_class !== "automated-producer") reject("invalid-identity");
  if (!equalJson(identity.producer_files, [...SURFACE_PRODUCER_FILES])) reject("producer-files-mismatch");
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

/* --------------------------------------------------------------------------
 * Shared receipt families.
 *
 * A family receipt records observations only; the evaluator computes the
 * verdict. Every receipt names its producer files and the revision of those
 * files, binds to the exact candidate source SHA, and declares a source and
 * actor class from the lists above. An evaluator that cannot certify returns
 * UNVERIFIABLE with a stated reason; it never returns PASS.
 *
 * The evaluator's own module is not a producer: every operator holds it and can
 * recompute its hash, so a family whose pinned list names that module alone
 * binds a receipt to no executed work. Such a family keeps every denial path and
 * ends in UNVERIFIABLE, never PASS, until its producer entrypoint lands.
 *
 * Receipts carry `stdout_sha256`/`stderr_sha256`. Captured command output is
 * attacker-controlled and may contain secrets, so a receipt that carries raw
 * output instead of a digest is refused rather than read.
 * ------------------------------------------------------------------------ */

export const REQUIRED_CHECKS_PRODUCER = "kizuki.required-checks/v1";
export const P0_DISPOSITION_PRODUCER = "kizuki.p0-disposition/v1";
export const JOURNEY_PRODUCER = "kizuki.journey-proof/v1";
export const CONNECTOR_PRODUCER = "kizuki.connector-evidence/v1";
export const REQUIRED_CHECKS_PRODUCER_FILES = ["scripts/release-evidence.ts", "scripts/required-checks.ts"] as const;
/** No journey or connector producer entrypoint has landed yet, so the shared
 * receipt module is the whole producer surface. A later lane that adds a
 * producer script extends these lists; leaving them unpinned would let a receipt
 * author choose which files the revision is computed over. While a list names
 * this module alone, its evaluator cannot certify that any step ran. */
export const JOURNEY_PRODUCER_FILES = ["scripts/release-evidence.ts"] as const;
export const CONNECTOR_PRODUCER_FILES = ["scripts/release-evidence.ts"] as const;
export const P0_DISPOSITION_PRODUCER_FILES = ["scripts/p0-disposition.ts", "scripts/release-evidence.ts"] as const;
/** The shared receipt module; holding it proves nothing about executed work. */
export const EVALUATOR_MODULE_FILE = "scripts/release-evidence.ts";
/** True once a family's pinned producer files name an entrypoint other than the
 * evaluator's own module, so its revision can bind work the evaluator did not
 * also hand the receipt's author. */
export function producerEntrypointLanded(producer_files: readonly string[]): boolean {
  return producer_files.some(path => path !== EVALUATOR_MODULE_FILE);
}
/** The three branch-protection contexts, in their required order. */
export const REQUIRED_CONTEXTS = ["test", "secrets", "workflows"] as const;
export const CHECK_CONCLUSIONS = ["success", "failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"] as const;
export const P0_LABEL = "severity:p0";
/** A connector's evidence class fixes the operator class that can witness it. */
export const CONNECTOR_SOURCE_CLASSES = { "live-account": "live-account-operator", "file-import": "file-import-operator", "local-source": "local-source-operator" } as const;
export const FAMILY_LIMITS = { issues: 64, steps: 128, command: 16, command_chars: 512, skew_ms: 300_000 } as const;
const RAW_OUTPUT_KEYS = ["stdout", "stderr", "output"] as const;

export interface FamilyBinding {
  candidate_source_sha: string;
  /** The evaluator's own revision for the producer files a receipt names. */
  revision: (files: readonly string[]) => string;
}
export interface JourneyBinding extends FamilyBinding { journey_id: string }
export interface ConnectorBinding extends FamilyBinding { connector_id: string }
export interface P0Binding extends FamilyBinding { now: number }
export interface ReceiptStep {
  id: string; command: string[]; exit_code: number; passed: boolean; stdout_sha256: string; stderr_sha256: string;
}

/** Bind declared producer files to the evaluator's own checkout bytes. */
export function evaluatorRevision(root: string): (files: readonly string[]) => string {
  return files => producerRevision(files.map(path => {
    const entry = inspectOptionalVerifier(root, path);
    if (entry.status !== "PRESENT" || entry.sha256 === null) reject("producer-files-unavailable");
    return { path, sha256: entry.sha256 };
  }));
}

function refuseRawOutput(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of RAW_OUTPUT_KEYS) if (key in value) reject("receipt-carries-raw-output");
}

function familyIdentity(
  value: unknown, producer: string, binding: FamilyBinding,
  source_class: string, actor_class: string, producer_files?: readonly string[],
) {
  const identity = parseSharedIdentity(value, producer, binding.candidate_source_sha);
  if (identity.source_class !== source_class || identity.actor_class !== actor_class) reject("invalid-identity");
  if (producer_files && !equalJson(identity.producer_files, [...producer_files])) reject("producer-files-mismatch");
  if (identity.producer_revision !== binding.revision(identity.producer_files)) reject("producer-revision-mismatch");
  return identity;
}

function commandLine(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > FAMILY_LIMITS.command) reject("invalid-schema");
  return value.map(item => text(item, FAMILY_LIMITS.command_chars));
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) reject("invalid-schema");
  return value;
}

/** Executed evidence for a journey or connector obligation. */
function receiptSteps(value: unknown): ReceiptStep[] {
  if (!Array.isArray(value) || value.length > FAMILY_LIMITS.steps) reject("invalid-schema");
  if (value.length === 0) reject("empty-step-list");
  const steps = value.map(item => {
    refuseRawOutput(item);
    const row = exact(item, "id,command,exit_code,passed,stdout_sha256,stderr_sha256");
    if (typeof row.passed !== "boolean") reject("invalid-schema");
    if (typeof row.exit_code !== "number" || !Number.isSafeInteger(row.exit_code) || row.exit_code < 0 || row.exit_code > 255) reject("invalid-schema");
    return {
      id: kebab(row.id), command: commandLine(row.command), exit_code: row.exit_code, passed: row.passed,
      stdout_sha256: digest(row.stdout_sha256), stderr_sha256: digest(row.stderr_sha256),
    };
  });
  if (new Set(steps.map(step => step.id)).size !== steps.length) reject("invalid-schema");
  if (steps.some(step => !step.passed)) reject("step-not-passed");
  return steps;
}

function acceptanceCredit(value: unknown): void {
  if (value === false) reject("acceptance-credit-withheld");
  if (value !== true) reject("invalid-schema");
}

export function evaluateRequiredChecksReceipt(value: unknown, binding: FamilyBinding): SurfaceEvaluation {
  refuseRawOutput(value);
  const row = exact(value, "schema,identity,contexts");
  if (row.schema !== REQUIRED_CHECKS_PRODUCER) reject("invalid-schema");
  familyIdentity(row.identity, REQUIRED_CHECKS_PRODUCER, binding, "exact-candidate-ci-snapshot", "retained-ci-snapshot", REQUIRED_CHECKS_PRODUCER_FILES);
  if (!Array.isArray(row.contexts) || row.contexts.length !== REQUIRED_CONTEXTS.length) reject("required-contexts-mismatch");
  const contexts = row.contexts.map(item => {
    const entry = exact(item, "context,conclusion,run_id,completed_at");
    const conclusion = text(entry.conclusion, 32);
    if (!(CHECK_CONCLUSIONS as readonly string[]).includes(conclusion)) reject("invalid-schema");
    return { context: text(entry.context, 64), conclusion, run_id: positiveInteger(entry.run_id), completed_at: recordedAt(entry.completed_at) };
  });
  if (!equalJson(contexts.map(item => item.context), [...REQUIRED_CONTEXTS])) reject("required-contexts-mismatch");
  if (!contexts.every(item => item.conclusion === "success")) return { status: "FAIL", reason: "required-context-not-successful", creditDigest: true };
  return { status: "PASS", reason: "exact-candidate-required-checks-passed", creditDigest: true };
}

export function evaluateP0DispositionReceipt(value: unknown, binding: P0Binding): SurfaceEvaluation {
  refuseRawOutput(value);
  const row = exact(value, "schema,identity,label,candidate_committed_at,snapshot_at,open_issues");
  if (row.schema !== P0_DISPOSITION_PRODUCER) reject("invalid-schema");
  familyIdentity(row.identity, P0_DISPOSITION_PRODUCER, binding, "findings-snapshot", "retained-ci-snapshot", P0_DISPOSITION_PRODUCER_FILES);
  if (text(row.label, 64) !== P0_LABEL) reject("p0-label-mismatch");
  const committed = recordedAt(row.candidate_committed_at), snapshot = recordedAt(row.snapshot_at);
  if (!Array.isArray(row.open_issues) || row.open_issues.length > FAMILY_LIMITS.issues) reject("invalid-schema");
  const issues = row.open_issues.map(item => {
    const entry = exact(item, "number,updated_at");
    return { number: positiveInteger(entry.number), updated_at: recordedAt(entry.updated_at) };
  });
  const numbers = issues.map(item => item.number);
  if (new Set(numbers).size !== numbers.length) reject("invalid-schema");
  // A snapshot taken before the candidate existed cannot describe its findings.
  if (Date.parse(snapshot) < Date.parse(committed)) return { status: "UNVERIFIABLE", reason: "p0-snapshot-predates-candidate", creditDigest: false };
  if (Date.parse(snapshot) - binding.now > FAMILY_LIMITS.skew_ms) return { status: "UNVERIFIABLE", reason: "p0-snapshot-after-evaluation", creditDigest: false };
  if (numbers.length > 0) return { status: "FAIL", reason: `current-p0-findings-open:${[...numbers].sort((left, right) => left - right).join(",")}`, creditDigest: true };
  return { status: "PASS", reason: "current-p0-inventory-clear", creditDigest: true };
}

export function evaluateJourneyReceipt(value: unknown, binding: JourneyBinding): SurfaceEvaluation {
  refuseRawOutput(value);
  const row = exact(value, "schema,identity,journey_id,acceptance_credit,steps");
  if (row.schema !== JOURNEY_PRODUCER) reject("invalid-schema");
  const identity = familyIdentity(row.identity, JOURNEY_PRODUCER, binding, "local-operator-custody", "authorized-operator", JOURNEY_PRODUCER_FILES);
  const journey_id = kebab(row.journey_id);
  if (!(JOURNEYS as readonly string[]).includes(journey_id)) reject("unknown-journey");
  if (journey_id !== binding.journey_id) reject("mismatched-gate-or-target");
  acceptanceCredit(row.acceptance_credit);
  receiptSteps(row.steps);
  // Every denial above still holds; what is missing is a producer whose bytes
  // the receipt's author does not also control, so no credit is granted here.
  if (!producerEntrypointLanded(identity.producer_files)) return { status: "UNVERIFIABLE", reason: "journey-producer-not-landed", creditDigest: false };
  return { status: "PASS", reason: "journey-steps-passed", creditDigest: true };
}

export function evaluateConnectorReceipt(value: unknown, binding: ConnectorBinding): SurfaceEvaluation {
  refuseRawOutput(value);
  const row = exact(value, "schema,identity,connector_id,evidence_class,acceptance_credit,steps");
  if (row.schema !== CONNECTOR_PRODUCER) reject("invalid-schema");
  const connector_id = kebab(row.connector_id);
  const entry = CONNECTORS.find(item => item.id === connector_id);
  if (!entry) reject("unknown-connector");
  if (connector_id !== binding.connector_id) reject("mismatched-gate-or-target");
  // A file import can never stand in for a live account, whatever it claims.
  if (kebab(row.evidence_class) !== entry.evidence) reject("connector-evidence-class-mismatch");
  const identity = familyIdentity(row.identity, CONNECTOR_PRODUCER, binding, CONNECTOR_SOURCE_CLASSES[entry.evidence], "authorized-operator", CONNECTOR_PRODUCER_FILES);
  acceptanceCredit(row.acceptance_credit);
  receiptSteps(row.steps);
  if (!producerEntrypointLanded(identity.producer_files)) return { status: "UNVERIFIABLE", reason: "connector-producer-not-landed", creditDigest: false };
  return { status: "PASS", reason: "connector-steps-passed", creditDigest: true };
}

function gateSuffix(gate_id: string, prefix: string): string {
  if (!gate_id.startsWith(prefix)) reject("mismatched-gate-or-target");
  return gate_id.slice(prefix.length);
}
function familyBinding(root: string, candidateSha: string): FamilyBinding {
  return { candidate_source_sha: digest(candidateSha, 40), revision: evaluatorRevision(root) };
}

export function consumeRequiredChecksReceipt(value: unknown, root: string, candidateSha: string): SurfaceEvaluation {
  return evaluateRequiredChecksReceipt(value, familyBinding(root, candidateSha));
}
export function consumeP0DispositionReceipt(value: unknown, root: string, candidateSha: string, now = Date.now()): SurfaceEvaluation {
  return evaluateP0DispositionReceipt(value, { ...familyBinding(root, candidateSha), now });
}
export function consumeJourneyReceipt(value: unknown, root: string, candidateSha: string, gate_id: string): SurfaceEvaluation {
  return evaluateJourneyReceipt(value, { ...familyBinding(root, candidateSha), journey_id: gateSuffix(gate_id, "journey.") });
}
export function consumeConnectorReceipt(value: unknown, root: string, candidateSha: string, gate_id: string): SurfaceEvaluation {
  return evaluateConnectorReceipt(value, { ...familyBinding(root, candidateSha), connector_id: gateSuffix(gate_id, "connector.") });
}

export interface ReceiptFamily {
  limit: number;
  consume: (value: unknown, root: string, candidateSha: string, gate_id: string) => SurfaceEvaluation;
}
/** Families the offline evaluator consumes from an index gate reference. */
export const RECEIPT_FAMILIES: Readonly<Record<string, ReceiptFamily>> = {
  [REQUIRED_CHECKS_PRODUCER]: { limit: EVIDENCE_LIMITS.family_receipt, consume: (value, root, sha) => consumeRequiredChecksReceipt(value, root, sha) },
  [P0_DISPOSITION_PRODUCER]: { limit: EVIDENCE_LIMITS.family_receipt, consume: (value, root, sha) => consumeP0DispositionReceipt(value, root, sha) },
  [JOURNEY_PRODUCER]: { limit: EVIDENCE_LIMITS.journey_connector_receipt, consume: consumeJourneyReceipt },
  [CONNECTOR_PRODUCER]: { limit: EVIDENCE_LIMITS.journey_connector_receipt, consume: consumeConnectorReceipt },
};
