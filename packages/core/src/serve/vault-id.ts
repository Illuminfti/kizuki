import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ulid } from "../util/ulid";
import { VAULT_ID_PATH } from "./types";
import { assertCanonFiles, type CanonFiles } from "../vault/canon-files";
import { withMutationFilesSync } from "../vault/mutation-files";
import { assertVaultMutationScope, withVaultMutationSync, type VaultMutationScope, type VaultMutationTarget } from "../vault/mutation-scope";

/** Machine the vault-id was minted or adopted on. Sibling so vault-id stays one line. */
const VAULT_MACHINE_PATH = ".kizuki/vault-machine";

export function vaultIdPath(vaultPath: string): string {
  return join(vaultPath, VAULT_ID_PATH);
}

function readOwnedLine(path: string): string | null {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").split("\n")[0]?.trim() ?? "";
  return value.length === 0 ? null : value;
}

export function readVaultId(vaultPath: string): string | null {
  return readOwnedLine(vaultIdPath(vaultPath));
}

function bindingOf(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (/[\0\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function readSystemIdent(path: string): string | null {
  try {
    const trimmed = readFileSync(path, "utf8").trim().toLowerCase();
    if (trimmed.length === 0 || trimmed.length > 128) return null;
    if (/[^0-9a-f-]/.test(trimmed)) return null;
    if (/^0+$/.test(trimmed.replace(/-/g, ""))) return null;
    return trimmed;
  } catch {
    return null;
  }
}

function readMachineId(): string | null {
  // Only /etc/machine-id: it is world-readable. DMI uuid is often root-only.
  return readSystemIdent("/etc/machine-id");
}

function readOwnedSnapshot(files: CanonFiles, path: string): string | null {
  const snapshot = files.read(path);
  if (snapshot === null) return null;
  try {
    const value = Buffer.from(snapshot.bytes).toString("utf8").split("\n")[0]?.trim() ?? "";
    return value.length === 0 ? null : value;
  } finally { snapshot.close(); }
}

function writeOwnedFile(files: CanonFiles, path: string, body: string, exclusive: boolean): void {
  files.ensureDirectory(dirname(path));
  const bytes = Buffer.from(body);
  if (exclusive) {
    files.create(path, bytes).close();
    return;
  }
  const prior = files.read(path);
  if (prior === null) { files.create(path, bytes).close(); return; }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const created = files.create(temporary, bytes);
    try { files.replace(created, prior).close(); }
    catch (error) { try { files.remove(created); } catch { /* Preserve a changed temporary and the original failure. */ } throw error; }
    finally { created.close(); }
  } finally { prior.close(); }
}

export function ensureVaultId(vaultPath: string, machineId: string | null = readMachineId()): string {
  const machine = bindingOf(machineId);
  const target = Object.freeze({ vault_path: resolve(vaultPath) });
  // An already bound identity is a read-only lookup; status/open need not wait
  // for a writer unless this host actually needs to mint or adopt an identity.
  const existing = readOwnedLine(vaultIdPath(target.vault_path));
  if (existing !== null) {
    const bound = readOwnedLine(join(target.vault_path, VAULT_MACHINE_PATH));
    if (machine === null || bound === machine) return existing;
  }
  return withVaultMutationSync(target, scope => withMutationFilesSync(scope, target, files =>
    ensureVaultIdOwned(scope, target, files, machine)));
}

/** Nested maintenance validates the enclosing full target, including its DB binding. */
export function ensureVaultIdOwned(scope: VaultMutationScope, target: VaultMutationTarget, files: CanonFiles, machineId: string | null): string {
  assertVaultMutationScope(scope, target);
  assertCanonFiles(files, target.vault_path);
  const machine = bindingOf(machineId);
  const idPath = VAULT_ID_PATH;
  const machinePath = VAULT_MACHINE_PATH;
  const existing = readOwnedSnapshot(files, idPath);

  if (existing === null) {
    const id = ulid().toLowerCase();
    writeOwnedFile(files, idPath, `${id}\n`, true);
    if (machine !== null) writeOwnedFile(files, machinePath, `${machine}\n`, false);
    return readOwnedSnapshot(files, idPath) ?? id;
  }

  const bound = readOwnedSnapshot(files, machinePath);
  if (bound === null) {
    if (machine !== null) writeOwnedFile(files, machinePath, `${machine}\n`, false);
    return existing;
  }
  if (machine === null || bound === machine) return existing;

  // Id first, then binding: a crash remints again instead of keeping a cloned id.
  const id = ulid().toLowerCase();
  writeOwnedFile(files, idPath, `${id}\n`, false);
  writeOwnedFile(files, machinePath, `${machine}\n`, false);
  return readOwnedSnapshot(files, idPath) ?? id;
}
