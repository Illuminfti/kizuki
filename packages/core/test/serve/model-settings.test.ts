import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AppModelSettingsError, editAppModelSection, readAppModelConfiguration, readAppManagedModelCredential, saveAppModelConfiguration,
  classifyAppModelCredential, readAppModelFileCredential, saveAppModelConfigurationOwned, type AppModelSettingsUpdate } from "../../src/serve/model-settings";
import { withVaultMutationSync } from "../../src/vault/mutation-scope";
import { withMutationFilesSync } from "../../src/vault/mutation-files";
import { exportVault, verifyBackup } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const validate = (value: unknown): void => {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || !("id" in value) || !["kizuki.llm.none", "kizuki.llm.openai-compatible"].includes(String(value.id))) throw Error("invalid fixture selection");
};
function fixture(raw?: string) {
  const root = mkdtempSync(join(tmpdir(), "model-settings-")); roots.push(root);
  mkdirSync(join(root, ".kizuki"), { mode: 0o700 });
  if (raw !== undefined) writeFileSync(join(root, ".kizuki/serve.toml"), raw, { mode: 0o600 });
  return root;
}
const model = { id: "kizuki.llm.openai-compatible", base_url: "http://127.0.0.1:12345/v1", model: "synthetic" };
function replacement(root: string, value = "synthetic-token-one"): AppModelSettingsUpdate {
  return { expected_revision: readAppModelConfiguration(root, validate).revision, llm: model, credential: { action: "replace", value } };
}
function interrupted(root: string, stage: string, update = replacement(root), mutate?: () => void) {
  const target = { vault_path: root };
  return withVaultMutationSync(target, scope => withMutationFilesSync(scope, target, files =>
    saveAppModelConfigurationOwned(scope, target, files, update, validate, at => {
      if (at === stage) { mutate?.(); throw Error("synthetic interruption"); }
    })));
}

test("model section editing preserves unrelated bytes and semantics", () => {
  const prefix = '# preserved comment\r\n[serve]\r\nhttp = false\r\n[ports]\r\nretrieval = "none"\r\n';
  const suffix = '[budget]\r\ncanon_writes_per_run = 7\r\n';
  const raw = `${prefix}[ports.llm]\r\nid = "kizuki.llm.none"\r\n${suffix}`;
  const next = editAppModelSection(Buffer.from(raw), model).toString();
  expect(next.startsWith(prefix)).toBe(true); expect(next.endsWith(suffix)).toBe(true);
  expect(Bun.TOML.parse(next)).toMatchObject({ serve: { http: false }, ports: { retrieval: "none", llm: model }, budget: { canon_writes_per_run: 7 } });
  expect(Bun.TOML.parse(editAppModelSection(Buffer.from('[ports]\nllm = "kizuki.llm.none"\nretrieval = "none"\n'), model).toString())).toMatchObject({ ports: { retrieval: "none", llm: model } });
  for (const raw of ['ports.llm = "kizuki.llm.none"\n', '["ports"."llm"]\nid = "kizuki.llm.none"\n', 'description = """multiline\ntext"""\n']) {
    expect(() => editAppModelSection(Buffer.from(raw), model)).toThrow("configuration_unsupported");
  }
  expect(() => editAppModelSection(Buffer.from('invalid = ['), model)).toThrow("configuration_invalid");
  expect(() => editAppModelSection(Buffer.alloc(65537, 32), model)).toThrow("configuration_invalid");
});

test("private model saves bind raw revisions and retain previously committed credentials", () => {
  const root = fixture(), first = saveAppModelConfiguration(root, replacement(root), validate);
  const firstRef = (first.llm as Record<string, string>).secret_ref!;
  expect(readAppManagedModelCredential(root, first.revision, firstRef)).toBe("synthetic-token-one");
  expect(readFileSync(join(root, ".kizuki/serve.toml"), "utf8")).not.toContain("synthetic-token-one");
  const second = saveAppModelConfiguration(root, replacement(root, "synthetic-token-two"), validate);
  expect(first.revision).not.toBe(second.revision);
  expect(readFileSync(firstRef.slice(5), "utf8")).toBe("synthetic-token-one");
  expect(readdirSync(join(root, ".kizuki/app-model")).filter(name => name.endsWith(".key"))).toHaveLength(2);
  expect(() => saveAppModelConfiguration(root, { ...replacement(root), expected_revision: first.revision }, validate)).toThrow("revision_conflict");
  const raw = readFileSync(join(root, ".kizuki/serve.toml"));
  expect(second.revision).toBe(`sha256:${createHash("sha256").update(raw).digest("hex")}`);
  expect(existsSync(join(root, ".kizuki/app-model/transaction.json"))).toBe(false);
});

test("clean model snapshots and immutable credentials remain readable during an unrelated writer", () => {
  const root = fixture(), saved = saveAppModelConfiguration(root, replacement(root), validate);
  const ref = (saved.llm as Record<string, string>).secret_ref!;
  withVaultMutationSync({ vault_path: root }, () => {
    expect(readAppModelConfiguration(root, validate).revision).toBe(saved.revision);
    expect(readAppManagedModelCredential(root, saved.revision, ref)).toBe("synthetic-token-one");
  });
});

test("managed credential access requires the exact model reference, not unrelated settings", () => {
  const root = fixture(), saved = saveAppModelConfiguration(root, replacement(root), validate);
  const ref = (saved.llm as Record<string, string>).secret_ref!;
  writeFileSync(join(root, ".kizuki/serve.toml"), `[ports.llm]\nid = "kizuki.llm.none"\n[unrelated]\nold_reference = ${JSON.stringify(ref)}\n`);
  const current = readAppModelConfiguration(root, validate);
  expect(() => readAppManagedModelCredential(root, current.revision, ref)).toThrow("credential_invalid");
  expect(readFileSync(ref.slice(5), "utf8")).toBe("synthetic-token-one");
});

test("a journal appearing during a read is reconciled, never mistaken for a clean snapshot", () => {
  const root = fixture(); let first = true;
  const current = readAppModelConfiguration(root, value => {
    validate(value);
    if (first) { first = false; expect(() => interrupted(root, "credential")).toThrow("synthetic interruption"); }
  });
  expect(current.revision).toBe("absent");
  expect(readdirSync(join(root, ".kizuki/app-model"))).toEqual([]);
});

test("portable export omits managed credentials, pending journal and config references", () => {
  const root = fixture(); initVault(root);
  saveAppModelConfiguration(root, replacement(root), validate);
  expect(() => interrupted(root, "credential", replacement(root, "synthetic-pending-key"))).toThrow("synthetic interruption");
  const parent = mkdtempSync(join(tmpdir(), "model-backup-")); roots.push(parent);
  const destination = join(parent, "portable"), db = openLedger(":memory:");
  try {
    const manifest = exportVault(db, root, destination);
    expect(verifyBackup(destination).schema).toBe(manifest.schema);
    const exported = [JSON.stringify(manifest), ...Object.keys(manifest.files).map(path => readFileSync(join(destination, path), "utf8"))].join("\n");
    for (const forbidden of ["app-model", "transaction.json", "synthetic-token-one", "synthetic-pending-key", "secret_ref", "serve.toml"]) expect(exported).not.toContain(forbidden);
    expect(existsSync(join(root, ".kizuki/app-model/transaction.json"))).toBe(true);
  } finally { db.close(); }
});

test.each(["journal", "credential", "staged", "published"])("model settings reconcile interruption at %s", stage => {
  const raw = '[serve]\nhttp = false\n[ports.llm]\nid = "kizuki.llm.none"\n';
  const root = fixture(raw), previous = readAppModelConfiguration(root, validate).revision;
  expect(() => interrupted(root, stage)).toThrow("synthetic interruption");
  const journal = readFileSync(join(root, ".kizuki/app-model/transaction.json"), "utf8");
  expect(journal).not.toContain("synthetic-token-one"); expect(journal).not.toContain("file:");
  const recovered = readAppModelConfiguration(root, validate);
  if (stage === "published") {
    expect(recovered.revision).not.toBe(previous);
    expect(readAppManagedModelCredential(root, recovered.revision, (recovered.llm as Record<string, string>).secret_ref!)).toBe("synthetic-token-one");
  } else {
    expect(recovered.revision).toBe(previous);
    expect(readFileSync(join(root, ".kizuki/serve.toml"), "utf8")).toBe(raw);
  }
  expect(readdirSync(join(root, ".kizuki/app-model"))).toHaveLength(stage === "published" ? 1 : 0);
});

test("interrupted first publication leaves absence or a complete referenced credential", () => {
  for (const stage of ["staged", "published"]) {
    const root = fixture(); expect(() => interrupted(root, stage)).toThrow("synthetic interruption");
    const current = readAppModelConfiguration(root, validate);
    expect(current.revision === "absent").toBe(stage === "staged");
  }
});

test("unknown transaction bytes and changed stages refuse cleanup", () => {
  const root = fixture(); expect(() => interrupted(root, "staged")).toThrow();
  const directory = join(root, ".kizuki/app-model"), stage = readdirSync(directory).find(name => name.endsWith(".toml.tmp"))!;
  writeFileSync(join(directory, stage), "unknown-stage");
  expect(() => readAppModelConfiguration(root, validate)).toThrow("transaction_unavailable");
  expect(readFileSync(join(directory, stage), "utf8")).toBe("unknown-stage");
  const journal = join(directory, "transaction.json");
  writeFileSync(journal, '{"schema":"duplicate","schema":"kizuki.app-model-transaction/v1"}');
  expect(() => readAppModelConfiguration(root, validate)).toThrow("transaction_unavailable");
  expect(existsSync(join(directory, stage))).toBe(true);
});

test("raw config races and changed credential custody preserve all unknown state", () => {
  const raw = '[ports.llm]\nid = "kizuki.llm.none"\n';
  const root = fixture(raw), update = replacement(root);
  const target = { vault_path: root };
  expect(() => withVaultMutationSync(target, scope => withMutationFilesSync(scope, target, files =>
    saveAppModelConfigurationOwned(scope, target, files, update, validate, stage => {
      if (stage === "staged") writeFileSync(join(root, ".kizuki/serve.toml"), `${raw}# concurrent edit\n`);
    })))).toThrow("canon_files_changed");
  expect(readFileSync(join(root, ".kizuki/serve.toml"), "utf8")).toBe(`${raw}# concurrent edit\n`);
  expect(() => readAppModelConfiguration(root, validate)).toThrow("transaction_unavailable");
  expect(readdirSync(join(root, ".kizuki/app-model")).some(name => name.endsWith(".key"))).toBe(true);
});

test("model settings reject unsafe files, private directory modes and key modes", () => {
  const root = fixture(), current = saveAppModelConfiguration(root, replacement(root), validate);
  const ref = (current.llm as Record<string, string>).secret_ref!;
  chmodSync(ref.slice(5), 0o644);
  expect(() => readAppManagedModelCredential(root, current.revision, ref)).toThrow("custody_unavailable");
  chmodSync(ref.slice(5), 0o600); chmodSync(join(root, ".kizuki/app-model"), 0o755);
  expect(() => readAppManagedModelCredential(root, current.revision, ref)).toThrow("custody_unavailable");
  expect(() => saveAppModelConfiguration(root, replacement(root), validate)).toThrow("custody_unavailable");
  const other = fixture(); symlinkSync(join(root, ".kizuki/serve.toml"), join(other, ".kizuki/serve.toml"));
  expect(() => readAppModelConfiguration(other, validate)).toThrow(AppModelSettingsError);
});

function configuredReference(root: string, reference: string) {
  writeFileSync(join(root, ".kizuki/serve.toml"), `[ports.llm]\nid = "kizuki.llm.openai-compatible"\nbase_url = "http://127.0.0.1"\nmodel = "synthetic"\nsecret_ref = ${JSON.stringify(reference)}\n`, { mode: 0o600 });
  return readAppModelConfiguration(root, validate).revision;
}

test("model file custody rejects normalized managed aliases and parent symlink aliases", () => {
  const root = fixture(), saved = saveAppModelConfiguration(root, replacement(root), validate);
  const reference = (saved.llm as Record<string, string>).secret_ref!, name = reference.split("/").at(-1)!;
  expect(classifyAppModelCredential(root, reference)).toBe("managed_file");
  for (const alias of [reference.replace("/.kizuki/", "//.kizuki/"), `file:${root}/./.kizuki/app-model/${name}`, `file:${root}/unused/../.kizuki/app-model/${name}`]) {
    const revision = configuredReference(root, alias);
    expect(() => classifyAppModelCredential(root, alias)).toThrow("credential_invalid");
    expect(() => readAppModelFileCredential(root, revision, alias)).toThrow("credential_invalid");
  }
  const outside = fixture(), link = join(outside, "alias");
  symlinkSync(join(root, ".kizuki/app-model"), link);
  const alias = `file:${join(link, name)}`, revision = configuredReference(root, alias);
  expect(classifyAppModelCredential(root, alias)).toBe("external_file");
  expect(() => readAppModelFileCredential(root, revision, alias)).toThrow("custody_unavailable");
  rmSync(link); symlinkSync(root, link);
  const ancestorAlias = `file:${link}/.kizuki/app-model/${name}`;
  expect(() => readAppModelFileCredential(root, configuredReference(root, ancestorAlias), ancestorAlias)).toThrow("custody_unavailable");
  rmSync(link); linkSync(reference.slice(5), link);
  const hardlink = `file:${link}`;
  expect(() => readAppModelFileCredential(root, configuredReference(root, hardlink), hardlink)).toThrow("custody_unavailable");
});

test("direct external model files preserve owner-only modes, bounds and trimming with exact config binding", () => {
  const root = fixture(), outside = fixture(), path = join(outside, "external.key"), reference = `file:${path}`;
  writeFileSync(path, "  synthetic-external-key\n", { mode: 0o600 });
  const revision = configuredReference(root, reference);
  expect(classifyAppModelCredential(root, reference)).toBe("external_file");
  expect(classifyAppModelCredential(root, "env:SYNTHETIC_MODEL_KEY")).toBe("env");
  for (const mode of [0o400, 0o600, 0o700]) {
    chmodSync(path, mode);
    expect(readAppModelFileCredential(root, revision, reference)).toBe("synthetic-external-key");
  }
  expect(() => readAppModelFileCredential(root, "absent", reference)).toThrow("revision_conflict");
  expect(() => readAppModelFileCredential(root, revision, `file:${outside}/different.key`)).toThrow("credential_invalid");
  writeFileSync(path, "x".repeat(16_384));
  expect(readAppModelFileCredential(root, revision, reference)).toHaveLength(16_384);
  writeFileSync(path, "x".repeat(16_385));
  expect(() => readAppModelFileCredential(root, revision, reference)).toThrow("credential_invalid");
  writeFileSync(path, "bad internal whitespace");
  expect(() => readAppModelFileCredential(root, revision, reference)).toThrow("credential_invalid");
  chmodSync(path, 0o644);
  expect(() => readAppModelFileCredential(root, revision, reference)).toThrow("custody_unavailable");
  for (const alias of [`file:${outside}/./external.key`, `${reference}/`]) expect(() => classifyAppModelCredential(root, alias)).toThrow("credential_invalid");
});

test("a parent swapped after classification cannot redirect the model credential read", () => {
  const root = fixture(), saved = saveAppModelConfiguration(root, replacement(root), validate);
  const managed = (saved.llm as Record<string, string>).secret_ref!, name = managed.split("/").at(-1)!;
  const outside = fixture(), parent = join(outside, "parent"), retired = join(outside, "retired");
  mkdirSync(parent, { mode: 0o700 }); writeFileSync(join(parent, name), "synthetic-external-key", { mode: 0o600 });
  const reference = `file:${parent}/${name}`, revision = configuredReference(root, reference);
  expect(classifyAppModelCredential(root, reference)).toBe("external_file");
  renameSync(parent, retired); symlinkSync(join(root, ".kizuki/app-model"), parent);
  expect(() => readAppModelFileCredential(root, revision, reference)).toThrow("custody_unavailable");
  expect(readFileSync(join(retired, name), "utf8")).toBe("synthetic-external-key");
  expect(readFileSync(managed.slice(5), "utf8")).toBe("synthetic-token-one");
});
