import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "../util/ulid";
import { VAULT_ID_PATH } from "./types";

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
  const parts = [readSystemIdent("/etc/machine-id"), readSystemIdent("/sys/class/dmi/id/product_uuid")].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : bindingOf(parts.join(":"));
}

function writeOwnedFile(path: string, body: string, exclusive: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (exclusive) {
    writeFileSync(path, body, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function ensureVaultId(vaultPath: string, machineId: string | null = readMachineId()): string {
  const machine = bindingOf(machineId);
  const idPath = vaultIdPath(vaultPath);
  const machinePath = join(vaultPath, VAULT_MACHINE_PATH);
  const existing = readOwnedLine(idPath);

  if (existing === null) {
    const id = ulid().toLowerCase();
    writeOwnedFile(idPath, `${id}\n`, true);
    if (machine !== null) writeOwnedFile(machinePath, `${machine}\n`, false);
    return readOwnedLine(idPath) ?? id;
  }

  const bound = readOwnedLine(machinePath);
  if (bound === null) {
    if (machine !== null) writeOwnedFile(machinePath, `${machine}\n`, false);
    return existing;
  }
  if (machine === null || bound === machine) return existing;

  // Id first, then binding: a crash remints again instead of keeping a cloned id.
  const id = ulid().toLowerCase();
  writeOwnedFile(idPath, `${id}\n`, false);
  writeOwnedFile(machinePath, `${machine}\n`, false);
  return readOwnedLine(idPath) ?? id;
}
