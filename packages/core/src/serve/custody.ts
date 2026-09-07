import { ptr } from "bun:ffi";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, unlinkSync,
  type BigIntStats } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { custodyNative } from "../util/custody-native";
import { loadOwnedDirectoryNative } from "../util/owned-directory-native";
import { openCanonFiles } from "../vault/canon-files";
import { observeAncestorOwner } from "./custody-observation";

/** This channel reports current metadata for held directories. It grants no
 * ledger, page, source, or filesystem mutation authority. */
export class ServiceCustodyError extends Error {
  constructor() { super("service_custody_unavailable"); this.name = "ServiceCustodyError"; }
}
function fail(): never { throw new ServiceCustodyError(); }
function same(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function ownedDirectory(fd: number, privateMode = false): BigIntStats {
  const value = fstatSync(fd, { bigint: true });
  if (!value.isDirectory() || value.uid !== BigInt(process.geteuid!()) ||
      (privateMode ? (value.mode & 0o777n) !== 0o700n : (value.mode & 0o022n) !== 0n)) fail();
  return value;
}
function boundedText(path: string, limit = 4096): string {
  const fd = openSync(path, constants.O_RDONLY | 0x80000 /* O_CLOEXEC */);
  try {
    const bytes = readFileSync(fd);
    if (bytes.length > limit || bytes.includes(0)) fail();
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}
function unifiedGroup(pid: number): string {
  const lines = boundedText(`/proc/${pid}/cgroup`).trim().split("\n");
  if (lines.length !== 1 || !lines[0]!.startsWith("0::/")) fail();
  return lines[0]!.slice(3);
}
function processIdentity(pid: number): { start: string; executable: string; group: string } {
  const stat = boundedText(`/proc/${pid}/stat`);
  const split = stat.lastIndexOf(") ");
  if (split < 1) fail();
  const fields = stat.slice(split + 2).trim().split(/\s+/);
  const start = fields[19];
  if (start === undefined || !/^[0-9]+$/.test(start) || fields[0] === "Z") fail();
  const executable = readlinkSync(`/proc/${pid}/exe`);
  if (!isAbsolute(executable) || executable.endsWith(" (deleted)")) fail();
  return { start, executable, group: unifiedGroup(pid) };
}
function sameProcess(a: ReturnType<typeof processIdentity>, b: ReturnType<typeof processIdentity>): boolean {
  return a.start === b.start && a.executable === b.executable && a.group === b.group;
}
interface Binding { path: string; id: string; invocation: string; bytes: Buffer; group: string; uid: number; }
function binding(vaultPath: string, vaultId: string, env: Readonly<Record<string, string | undefined>>): Binding {
  if (process.platform !== "linux" || process.arch !== "x64" || !process.geteuid ||
      !isAbsolute(vaultPath) || vaultPath !== resolve(vaultPath) || vaultPath === "/" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(vaultId)) fail();
  const invocation = env.INVOCATION_ID;
  if (invocation === undefined || !/^[0-9a-f]{32}$/.test(invocation)) fail();
  const uid = process.geteuid();
  if (uid === 0) fail();
  const group = unifiedGroup(process.pid);
  if (!group.endsWith(`/kizuki@${vaultId}.service`)) fail();
  return { path: vaultPath, id: vaultId, invocation, bytes: Buffer.from(invocation, "hex"), group, uid };
}

/** Bootstrap only traverses nofollow descriptors and connects to an owner-only
 * socket. It admits no ancestor ownership; CanonFiles does that with the live
 * broker before this function's caller may construct any runtime. */
function controlDescriptors(path: string): { vault: number; control: number } {
  const api = loadOwnedDirectoryNative();
  let fd = openSync("/", 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000);
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > 256 || Buffer.byteLength(path) > 4096) { closeSync(fd); fail(); }
  try {
    for (const part of parts) {
      const bytes = Buffer.from(part + "\0");
      if (bytes.length > 256 || part.includes("\0") || part === "." || part === "..") fail();
      const next = api.symbols.openAncestorChild(fd, ptr(bytes));
      if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 0) fail();
      closeSync(fd); fd = next;
      if (!fstatSync(fd).isDirectory()) fail();
    }
    ownedDirectory(fd);
    const name = Buffer.from(".kizuki\0");
    const control = api.symbols.openChild(fd, ptr(name), 1);
    if (typeof control !== "number" || !Number.isSafeInteger(control) || control < 0) fail();
    try { ownedDirectory(control, true); } catch (error) { closeSync(control); throw error; }
    return { vault: fd, control };
  } catch (error) { closeSync(fd); throw error; }
}
function endpointName(value: Binding): string { return `custody-${value.invocation}.sock`; }
function endpointPath(control: number, name: string): string { return `/proc/self/fd/${control}/${name}`; }
function endpointStat(control: number, name: string): BigIntStats {
  const stat = lstatSync(endpointPath(control, name), { bigint: true });
  if (!stat.isSocket() || stat.uid !== BigInt(process.geteuid!()) ||
      (stat.mode & 0o777n) !== 0o600n || stat.nlink !== 1n) fail();
  return stat;
}
function checkControl(value: Binding, descriptors: { vault: number; control: number }): void {
  ownedDirectory(descriptors.vault); ownedDirectory(descriptors.control, true);
  const current = controlDescriptors(value.path);
  try {
    if (!same(fstatSync(current.vault, { bigint: true }), fstatSync(descriptors.vault, { bigint: true })) ||
        !same(fstatSync(current.control, { bigint: true }), fstatSync(descriptors.control, { bigint: true }))) fail();
  } finally { closeSync(current.control); closeSync(current.vault); }
}

interface ActiveCustody { overflowUid: bigint; assertCurrent(): void; owner(fd: number, observed: BigIntStats): bigint; close(): void; }
const active = new Map<string, ActiveCustody>();

/** Only this module's authenticated service startup can populate the table.
 * A capability for one resolved vault never authorizes a different path. */
export function serviceAncestorOwner(vaultPath: string, fd: number, observed: BigIntStats): bigint | undefined {
  const entry = active.get(vaultPath);
  if (entry === undefined || observed.uid !== entry.overflowUid) return undefined;
  entry.assertCurrent();
  return entry.owner(fd, observed);
}

export interface ServiceCustodyHandle { close(): void; }
export function validateServiceCustodyLaunch(
  vaultPath: string, vaultId: string, env: Readonly<Record<string, string | undefined>>,
): void {
  const value = binding(vaultPath, vaultId, env), mainPid = Number(env.MAINPID);
  if (!Number.isSafeInteger(mainPid) || mainPid < 1 || mainPid === process.pid ||
      lstatSync("/", { bigint: true }).uid !== 0n) fail();
  const main = processIdentity(mainPid);
  if (main.executable !== readlinkSync("/proc/self/exe") || main.group !== value.group) fail();
}
export async function startServiceCustody(
  vaultPath: string,
  vaultId: string,
  env: Readonly<Record<string, string | undefined>>,
  onFailure: () => void,
): Promise<ServiceCustodyHandle> {
  const value = binding(vaultPath, vaultId, env);
  if (active.has(value.path)) fail();
  const overflow = boundedText("/proc/sys/kernel/overflowuid", 32).trim();
  if (!/^[0-9]{1,10}$/.test(overflow) || BigInt(overflow) === 0n || BigInt(overflow) === BigInt(value.uid)) fail();
  const descriptors = controlDescriptors(value.path), name = endpointName(value), api = custodyNative();
  let socket = -1, closed = false, timer: ReturnType<typeof setInterval> | undefined;
  let endpoint: BigIntStats | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    if (active.get(value.path) === capability) active.delete(value.path);
    if (socket >= 0) closeSync(socket);
    closeSync(descriptors.control); closeSync(descriptors.vault);
  };
  const invalidate = (): never => { close(); onFailure(); fail(); };
  const capability: ActiveCustody = {
    overflowUid: BigInt(overflow),
    close,
    assertCurrent() {
      try {
        if (closed || endpoint === undefined || !api.healthy(socket)) fail();
        checkControl(value, descriptors);
        const current = endpointStat(descriptors.control, name);
        if (!same(current, endpoint) || current.mode !== endpoint.mode || current.ctimeNs !== endpoint.ctimeNs) fail();
      } catch { invalidate(); }
    },
    owner(fd, observed): bigint {
      try {
        return observeAncestorOwner(fd, observed, () => api.stat(socket, fd, value.bytes));
      } catch { return invalidate(); }
    },
  };
  try {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      try {
        checkControl(value, descriptors);
        endpoint = endpointStat(descriptors.control, name);
        socket = api.connect(descriptors.control, name);
        break;
      } catch (error) {
        if (endpoint !== undefined) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (socket < 0 || endpoint === undefined) fail();
    const peer = api.peer(socket);
    if (peer.uid !== value.uid || peer.pid === process.pid || unifiedGroup(peer.pid) !== value.group) fail();
    // The first authenticated descriptor exchange also completes the post
    // helper's readiness handshake. UID translation is resolved only here.
    const root = openSync("/", 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x80000);
    try { if (api.stat(socket, root, value.bytes).uid !== 0n) fail(); }
    finally { closeSync(root); }
    active.set(value.path, capability);
    const files = openCanonFiles(value.path);
    try {
      files.assertPrivateDirectory(".kizuki");
      const id = files.readPrivate(".kizuki/vault-id");
      if (id === null) fail();
      try { if (Buffer.from(id.bytes).toString("utf8").trim() !== value.id) fail(); }
      finally { id.close(); }
    } finally { files.close(); }
    capability.assertCurrent();
    timer = setInterval(() => { try { capability.assertCurrent(); } catch { /* invalidate already reported the fatal condition. */ } }, 250);
    return Object.freeze({ close });
  } catch (error) { close(); throw error instanceof ServiceCustodyError ? error : new ServiceCustodyError(); }
}

/** The '+' post command has an original-user-namespace view. The broker never
 * accepts a path, reads file content for a request, or mutates a requested FD. */
export function runServiceCustodyBroker(
  vaultPath: string, vaultId: string, env: Readonly<Record<string, string | undefined>>,
): number {
  const value = binding(vaultPath, vaultId, env), mainPid = Number(env.MAINPID);
  if (!Number.isSafeInteger(mainPid) || mainPid < 1 || mainPid === process.pid) fail();
  if (lstatSync("/", { bigint: true }).uid !== 0n) fail();
  const original = processIdentity(mainPid);
  if (original.executable !== readlinkSync("/proc/self/exe") || original.group !== value.group) fail();
  const api = custodyNative(), pidfd = api.watchPid(mainPid);
  let descriptors: ReturnType<typeof controlDescriptors> | undefined, listener = -1, endpoint: BigIntStats | undefined;
  const name = endpointName(value);
  try {
    if (!sameProcess(original, processIdentity(mainPid))) fail();
    const files = openCanonFiles(value.path);
    try {
      files.assertPrivateDirectory(".kizuki");
      const id = files.readPrivate(".kizuki/vault-id");
      if (id === null) fail();
      try { if (Buffer.from(id.bytes).toString("utf8").trim() !== value.id) fail(); }
      finally { id.close(); }
    } finally { files.close(); }
    descriptors = controlDescriptors(value.path);
    listener = api.listen(descriptors.control, name);
    endpoint = endpointStat(descriptors.control, name);
    checkControl(value, descriptors);
    if (!sameProcess(original, processIdentity(mainPid))) fail();
    api.restrictBroker();
    return api.serve(listener, mainPid, value.uid, value.bytes, 1, pidfd);
  } finally {
    if (listener >= 0) closeSync(listener);
    closeSync(pidfd);
    if (descriptors !== undefined) {
      try {
        if (endpoint !== undefined) {
          checkControl(value, descriptors);
          const current = endpointStat(descriptors.control, name);
          if (same(endpoint, current) && endpoint.mode === current.mode && endpoint.ctimeNs === current.ctimeNs) {
            unlinkSync(endpointPath(descriptors.control, name));
          }
        }
      } finally { closeSync(descriptors.control); closeSync(descriptors.vault); }
    }
  }
}
