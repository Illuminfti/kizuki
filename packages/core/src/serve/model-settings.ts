import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isPlainObject } from "../util/validate";
import { assertCanonFiles, openCanonFiles, type CanonFiles, type CanonFileSnapshot } from "../vault/canon-files";
import { withMutationFilesSync } from "../vault/mutation-files";
import { assertVaultMutationScope, withVaultMutationSync, type VaultMutationScope, type VaultMutationTarget } from "../vault/mutation-scope";

const CONFIG = ".kizuki/serve.toml";
const PRIVATE = ".kizuki/app-model";
const JOURNAL = `${PRIVATE}/transaction.json`;
const CONFIG_BYTES = 65_536;
const JOURNAL_BYTES = 1_024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const revision = (bytes: Uint8Array | null) => bytes === null ? "absent" : `sha256:${digest(bytes)}`;

export type AppModelSettingsFailure = "configuration_invalid" | "configuration_unsupported" | "revision_conflict" |
  "credential_invalid" | "custody_unavailable" | "transaction_unavailable";
export class AppModelSettingsError extends Error {
  override readonly name = "AppModelSettingsError";
  constructor(readonly code: AppModelSettingsFailure) { super(code); }
}
function fail(code: AppModelSettingsFailure): never { throw new AppModelSettingsError(code); }
export interface AppModelDocument { readonly revision: string; readonly llm: unknown }
export type AppModelCredentialChange = { readonly action: "keep" | "clear" } | { readonly action: "replace"; readonly value: string };
export interface AppModelSettingsUpdate {
  readonly expected_revision: string;
  readonly llm: Readonly<Record<string, unknown>>;
  readonly credential: AppModelCredentialChange;
}
/** Provider validation stays in the registered LLM package; Core owns file custody. */
export type AppModelConfigurationValidator = (llm: unknown) => void;
interface Transaction { schema: "kizuki.app-model-transaction/v1"; id: string; before: string; after: string; credential_sha256: string | null }
type Checkpoint = "journal" | "credential" | "staged" | "published";

function parseConfig(bytes: Uint8Array | null): Record<string, unknown> {
  if (bytes === null) return {};
  if (bytes.byteLength > CONFIG_BYTES) fail("configuration_invalid");
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text).equals(bytes)) fail("configuration_invalid");
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    if (!isPlainObject(parsed)) fail("configuration_invalid");
    if (parsed.ports !== undefined && !isPlainObject(parsed.ports)) fail("configuration_invalid");
    return parsed;
  } catch { fail("configuration_invalid"); }
}
function llmOf(parsed: Record<string, unknown>): unknown { return isPlainObject(parsed.ports) ? parsed.ports.llm : undefined; }
function validate(llm: unknown, check: AppModelConfigurationValidator) {
  try { if (check(llm) !== undefined) fail("configuration_invalid"); }
  catch { fail("configuration_invalid"); }
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => isPlainObject(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function unrelated(parsed: Record<string, unknown>) {
  const copy = { ...parsed };
  if (isPlainObject(copy.ports)) {
    const ports = { ...copy.ports }; delete ports.llm;
    if (Object.keys(ports).length === 0) delete copy.ports;
    else copy.ports = ports;
  }
  return stable(copy);
}

/** Edit only ordinary model tables/assignments. Ambiguous TOML is refused. */
export function editAppModelSection(bytes: Uint8Array | null, llm: Readonly<Record<string, unknown>>): Buffer {
  const before = parseConfig(bytes), text = bytes === null ? "" : Buffer.from(bytes).toString("utf8");
  if (text.includes('"""') || text.includes("'''")) fail("configuration_unsupported");
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let section = "", start = -1, end = lines.length, assignment = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!, trimmed = line.trimStart();
    if (trimmed.startsWith("[")) {
      const header = line.match(/^\s*\[([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)\]\s*(?:#.*)?(?:\r?\n)?$/);
      if (!header) fail("configuration_unsupported");
      if (section === "ports.llm" && end === lines.length) end = index;
      section = header[1]!;
      if (section.startsWith("ports.llm.")) fail("configuration_unsupported");
      if (section === "ports.llm") start = index;
    } else if (section === "ports" && /^\s*llm\s*=/.test(line)) {
      if (assignment !== -1) fail("configuration_unsupported");
      assignment = index;
    }
  }
  if (llmOf(before) !== undefined && start === -1 && assignment === -1) fail("configuration_unsupported");
  const values = Object.entries(llm).map(([key, value]) => {
    if (!/^[a-z_]+$/.test(key) || !["string", "number", "boolean"].includes(typeof value)) fail("configuration_invalid");
    return `${key} = ${JSON.stringify(value)}\n`;
  }).join("");
  const block = `[ports.llm]\n${values}`;
  let result: string;
  if (start !== -1) result = [...lines.slice(0, start), block, ...lines.slice(end)].join("");
  else {
    const kept = lines.filter((_line, index) => index !== assignment).join("");
    result = `${kept}${kept.length > 0 && !kept.endsWith("\n") ? "\n" : ""}${block}`;
  }
  const output = Buffer.from(result), after = parseConfig(output);
  if (unrelated(before) !== unrelated(after) || stable(llmOf(after)) !== stable(llm)) fail("configuration_unsupported");
  return output;
}

function document(snapshot: CanonFileSnapshot | null, check: AppModelConfigurationValidator): AppModelDocument {
  const bytes = snapshot?.bytes ?? null, parsed = parseConfig(bytes), llm = llmOf(parsed);
  validate(llm, check);
  return { revision: revision(bytes), llm };
}
function configSnapshot(files: CanonFiles) {
  const snapshot = files.read(CONFIG);
  if (snapshot !== null && snapshot.bytes.byteLength > CONFIG_BYTES) { snapshot.close(); fail("configuration_invalid"); }
  return snapshot;
}
function privateDirectory(files: CanonFiles) { files.ensureDirectory(PRIVATE); files.assertPrivateDirectory(PRIVATE); }
function credentialPath(id: string) { return `${PRIVATE}/${id}.key`; }
function stagePath(id: string) { return `${PRIVATE}/${id}.toml.tmp`; }
function credentialRef(vault: string, id: string) { return `file:${join(vault, credentialPath(id))}`; }
function references(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some(item => references(item, expected));
  if (isPlainObject(value)) return Object.values(value).some(item => references(item, expected));
  return false;
}
function parseTransaction(snapshot: CanonFileSnapshot): Transaction {
  if (snapshot.bytes.byteLength > JOURNAL_BYTES) fail("transaction_unavailable");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(snapshot.bytes).toString("utf8")); } catch { fail("transaction_unavailable"); }
  // Our journal is canonical JSON. This also rejects duplicate keys and extra
  // syntax without introducing a second general-purpose JSON parser.
  if (JSON.stringify(value) !== Buffer.from(snapshot.bytes).toString("utf8")) fail("transaction_unavailable");
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== "after,before,credential_sha256,id,schema" ||
      value.schema !== "kizuki.app-model-transaction/v1" || typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) ||
      typeof value.before !== "string" || !/^(absent|sha256:[0-9a-f]{64})$/.test(value.before) ||
      typeof value.after !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.after) ||
      (value.credential_sha256 !== null && (typeof value.credential_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.credential_sha256)))) fail("transaction_unavailable");
  return value as unknown as Transaction;
}
function matchingFile(files: CanonFiles, path: string, hash: string): CanonFileSnapshot | null {
  const snapshot = files.readPrivate(path);
  if (snapshot !== null && digest(snapshot.bytes) !== hash) { snapshot.close(); fail("transaction_unavailable"); }
  return snapshot;
}
function reconcile(files: CanonFiles, vault: string) {
  const journal = files.readPrivate(JOURNAL);
  if (journal === null) return;
  try {
    files.assertPrivateDirectory(PRIVATE);
    const transaction = parseTransaction(journal), current = configSnapshot(files);
    try {
      const currentBytes = current?.bytes ?? null, currentRevision = revision(currentBytes), parsed = parseConfig(currentBytes);
      if (currentRevision !== transaction.before && currentRevision !== transaction.after) fail("transaction_unavailable");
      const stage = matchingFile(files, stagePath(transaction.id), transaction.after.slice(7));
      const key = transaction.credential_sha256 === null ? null : matchingFile(files, credentialPath(transaction.id), transaction.credential_sha256);
      try {
        const active = references(parsed, credentialRef(vault, transaction.id));
        if (currentRevision === transaction.after && transaction.credential_sha256 !== null && (!active || key === null)) fail("transaction_unavailable");
        // Recheck the config before cleanup; another writer cannot acquire the
        // file-only mutation scope while this callback owns it.
        const check = configSnapshot(files);
        try { if (revision(check?.bytes ?? null) !== currentRevision) fail("transaction_unavailable"); }
        finally { check?.close(); }
        if (stage !== null) files.remove(stage);
        if (key !== null && currentRevision === transaction.before && !active) files.remove(key);
        files.remove(journal);
      } finally { stage?.close(); key?.close(); }
    } finally { current?.close(); }
  } finally { journal.close(); }
}
function owned<T>(vaultPath: string, work: (files: CanonFiles, target: VaultMutationTarget, scope: VaultMutationScope) => T): T {
  const target = Object.freeze({ vault_path: resolve(vaultPath) });
  try { return withVaultMutationSync(target, scope => withMutationFilesSync(scope, target, files => work(files, target, scope))); }
  catch (error) { if (error instanceof AppModelSettingsError) throw error; fail("custody_unavailable"); }
}
function journalPresent(files: CanonFiles): boolean {
  const journal = files.readPrivate(JOURNAL);
  if (journal === null) return false;
  try { files.assertPrivateDirectory(PRIVATE); return true; } finally { journal.close(); }
}
/** Clean snapshots never compete with canon writers. Only an actual journal
 * needs mutation ownership; changed atomic snapshots get one bounded retry. */
function readOnly<T>(vaultPath: string, work: (files: CanonFiles, vault: string, current: CanonFileSnapshot | null) => T): T {
  const vault = resolve(vaultPath);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const files = openCanonFiles(vault); let pending = false;
      try {
        pending = journalPresent(files);
        if (!pending) {
          const before = configSnapshot(files);
          try {
            const result = work(files, vault, before), after = configSnapshot(files);
            try {
              pending = journalPresent(files);
              if (!pending && revision(before?.bytes ?? null) === revision(after?.bytes ?? null)) return result;
            } finally { after?.close(); }
          } finally { before?.close(); }
        }
      } finally { files.close(); }
      if (pending) owned(vault, held => reconcile(held, vault));
    }
    fail("revision_conflict");
  } catch (error) { if (error instanceof AppModelSettingsError) throw error; fail("custody_unavailable"); }
}
export function readAppModelConfiguration(vaultPath: string, check: AppModelConfigurationValidator): AppModelDocument {
  return readOnly(vaultPath, (_files, _vault, snapshot) => document(snapshot, check));
}
/** Resolve only immutable credentials owned by this settings authority. */
export function readAppManagedModelCredential(vaultPath: string, expectedRevision: string, reference: string): string {
  return readOnly(vaultPath, (files, vault, current) => {
    if (revision(current?.bytes ?? null) !== expectedRevision) fail("revision_conflict");
    const prefix = `file:${join(vault, PRIVATE)}/`, llm = llmOf(parseConfig(current?.bytes ?? null));
    const name = reference.startsWith(prefix) ? reference.slice(prefix.length) : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.key$/.test(name) ||
        !isPlainObject(llm) || llm.secret_ref !== reference) fail("credential_invalid");
    files.assertPrivateDirectory(PRIVATE);
    const key = files.readPrivate(`${PRIVATE}/${name}`);
    if (key === null) fail("credential_invalid");
    try {
      const bytes = key.bytes, value = Buffer.from(bytes).toString("utf8");
      if (!value || bytes.byteLength > 1024 || /\s|[\x00-\x1f\x7f]/.test(value) || !Buffer.from(value).equals(bytes)) fail("credential_invalid");
      return value;
    } finally { key.close(); }
  });
}
export function saveAppModelConfiguration(vaultPath: string, update: AppModelSettingsUpdate, check: AppModelConfigurationValidator): AppModelDocument {
  return owned(vaultPath, (files, target, scope) => saveAppModelConfigurationOwned(scope, target, files, update, check));
}

/** Internal interruption seam; no raw file capability is exported by Core. */
export function saveAppModelConfigurationOwned(scope: VaultMutationScope, target: VaultMutationTarget, files: CanonFiles,
  update: AppModelSettingsUpdate, check: AppModelConfigurationValidator, checkpoint: (stage: Checkpoint) => void = () => {}): AppModelDocument {
  assertVaultMutationScope(scope, target); assertCanonFiles(files, target.vault_path);
  reconcile(files, target.vault_path);
  const prior = configSnapshot(files);
  try {
    const current = document(prior, check);
    if (current.revision !== update.expected_revision) fail("revision_conflict");
    if (!isPlainObject(update.llm)) fail("configuration_invalid");
    const llm = { ...update.llm }; delete llm.secret_ref;
    const id = randomUUID(); let key: Buffer | null = null;
    if (update.credential.action === "keep") {
      if (isPlainObject(current.llm) && current.llm.secret_ref !== undefined) llm.secret_ref = current.llm.secret_ref;
    } else if (update.credential.action === "replace") {
      const value = update.credential.value;
      if (typeof value !== "string" || !value || Buffer.byteLength(value) > 1024 || /\s|[\x00-\x1f\x7f]/.test(value) ||
          Buffer.from(value).toString("utf8") !== value || llm.id === "kizuki.llm.none") fail("credential_invalid");
      key = Buffer.from(value); llm.secret_ref = credentialRef(target.vault_path, id);
    } else if (update.credential.action !== "clear") fail("credential_invalid");
    validate(llm, check);
    const bytes = editAppModelSection(prior?.bytes ?? null, llm), after = revision(bytes);
    privateDirectory(files);
    const transaction: Transaction = { schema: "kizuki.app-model-transaction/v1", id, before: current.revision, after, credential_sha256: key === null ? null : digest(key) };
    files.create(JOURNAL, Buffer.from(JSON.stringify(transaction))).close(); checkpoint("journal");
    if (key !== null) { files.create(credentialPath(id), key).close(); key.fill(0); }
    checkpoint("credential");
    const staged = files.create(stagePath(id), bytes);
    try {
      checkpoint("staged");
      const published = prior === null ? files.publish(staged, CONFIG) : files.replace(staged, prior);
      try { if (revision(published.bytes) !== after) fail("transaction_unavailable"); }
      finally { published.close(); }
      checkpoint("published");
    } finally { staged.close(); }
    reconcile(files, target.vault_path);
    const complete = configSnapshot(files);
    try { return document(complete, check); } finally { complete?.close(); }
  } finally { prior?.close(); }
}
