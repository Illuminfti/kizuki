import { parseWorldCanonReceipt, type ErasedWorldCanonReceipt, type WorldCanonReceiptRecord } from "./world-receipt";
import { ptr } from "bun:ffi";
import type { BigIntStats } from "node:fs";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { loadOwnedDirectoryNative } from "../util/owned-directory-native";
import { snapshotDataRecord } from "../util/validate";
import { isRfc3339 } from "../util/time";
import { isAuthorityTier, isProducer } from "../contracts/proposal";
import { isSensitivity } from "../agents/types";
import { assertCanonFiles } from "../vault/canon-files";
import { serviceAncestorOwner } from "../serve/custody";
import { assertVaultMutationScope, type VaultMutationScope } from "../vault/mutation-scope";
import { requireCanonFiles } from "./io";
import { parseReceiptRecordLine, isErasedReceipt } from "./receipts";
import { RECEIPTS_PATH } from "./receipt-path";
import type { CanonIo } from "./store";

const SOURCE_STREAM_LIMIT = 32n * 1024n * 1024n;
const [CONTROL, DIRECTORY, FILE] = RECEIPTS_PATH.split("/") as [string, string, string];
type Failure = "unsupported" | "native_unavailable" | "unsafe" | "missing" | "conflict" | "changed" | "bounds" | "closed" | "failed" | "io" | "durability" | "checkpoint_invalid" | "receipt_invalid" | "receipt_tail_pending";
export class ReceiptStreamError extends Error {
  constructor(readonly reason: Failure) { super(`canon_receipt_stream_${reason}`); this.name = "ReceiptStreamError"; }
}
function fail(reason: Failure): never { throw new ReceiptStreamError(reason); }
function mapped(error: unknown): ReceiptStreamError { return error instanceof ReceiptStreamError ? error : new ReceiptStreamError("io"); }

type ReceiptIdentity = Readonly<{ dev: string; ino: string; birthtime_ns: string }>;
export interface OrdinaryReceiptCheckpoint {
  readonly version: 1;
  readonly byte_length: number;
  readonly prefix_sha256: string;
  readonly vault: ReceiptIdentity;
  readonly control: ReceiptIdentity;
  readonly directory: ReceiptIdentity;
  readonly file: ReceiptIdentity;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const found = snapshotDataRecord(value, "receipt_checkpoint", [], keys.length);
  if (!found || Object.keys(found).length !== keys.length || keys.some(key => !(key in found))) fail("checkpoint_invalid");
  return found;
}
function identity(value: unknown): ReceiptIdentity {
  const found = record(value, ["dev", "ino", "birthtime_ns"]);
  for (const key of ["dev", "ino", "birthtime_ns"]) {
    if (typeof found[key] !== "string" || /^(0|[1-9][0-9]{0,29})$/.exec(found[key] as string)?.[0] !== found[key]) fail("checkpoint_invalid");
  }
  return Object.freeze({ dev: found.dev as string, ino: found.ino as string, birthtime_ns: found.birthtime_ns as string });
}
/** Closed persistent data, copied without invoking accessors or retaining aliases. */
export function validateOrdinaryReceiptCheckpoint(value: unknown): OrdinaryReceiptCheckpoint {
  const found = record(value, ["version", "byte_length", "prefix_sha256", "vault", "control", "directory", "file"]);
  if (found.version !== 1 || !Number.isSafeInteger(found.byte_length) || (found.byte_length as number) < 0 ||
      (found.byte_length as number) > Number(SOURCE_STREAM_LIMIT) || typeof found.prefix_sha256 !== "string" ||
      found.prefix_sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(found.prefix_sha256)) fail("checkpoint_invalid");
  return Object.freeze({ version: 1, byte_length: found.byte_length as number, prefix_sha256: found.prefix_sha256,
    vault: identity(found.vault), control: identity(found.control), directory: identity(found.directory), file: identity(found.file) });
}
function statIdentity(stat: BigIntStats): ReceiptIdentity {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), birthtime_ns: String(stat.birthtimeNs) });
}
function matchesIdentity(a: ReceiptIdentity, b: BigIntStats): boolean {
  return a.dev === String(b.dev) && a.ino === String(b.ino) && a.birthtime_ns === String(b.birthtimeNs);
}
function digest(bytes: Uint8Array): string { return new Bun.CryptoHasher("sha256").update(bytes).digest("hex"); }
function strictUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("receipt_invalid"); }
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function strings(value: unknown): boolean { return Array.isArray(value) && value.every(nonempty); }
function hash(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function nullableString(value: unknown): boolean { return value === null || nonempty(value); }
function receiptId(line: string): string {
  try {
    const row = parseReceiptRecordLine(line);
    if (isErasedReceipt(row)) return row.receipt_id;
    if (!nonempty(row.receipt_id) || row.receipt_id.length > 128 || /[\u0000-\u001f\u007f]/.test(row.receipt_id) ||
        !["write", "revert", "purge_rewrite"].includes(row.kind) || !["create", "edit", "archive"].includes(row.page_action) ||
        !strings(row.claim_ids) || !strings(row.provenance) || !(row.before_hash === null || hash(row.before_hash)) || !hash(row.after_hash) ||
        !["loop", "correction", "revert", "import"].includes(row.writer) || !isProducer(row.producer) ||
        !nullableString(row.model_ref) || !isAuthorityTier(row.authority) || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1 ||
        !isSensitivity(row.sensitivity) || !["clean", "quoted"].includes(row.taint) || !nullableString(row.reverts) || !nullableString(row.reverted_by) ||
        !isRfc3339(row.at) || !Array.isArray(row.superseded) || !row.superseded.every(item => nonempty(item.claim_id) && nonempty(item.claim_key)) ||
        !Array.isArray(row.candidates) || !row.candidates.every(item => nonempty(item.page_id) && nonempty(item.rel_path) && isAuthorityTier(item.authority) &&
          (item.created_at === "" || isRfc3339(item.created_at))) ||
        !Array.isArray(row.retrieval_ops) || !row.retrieval_ops.every(item => nonempty(item.store) && nonempty(item.doc) && ["upsert", "remove"].includes(item.op))) fail("receipt_invalid");
    return row.receipt_id;
  } catch { fail("receipt_invalid"); }
}
/** Preserve historical receipt formats through the existing path-aware parser. */
function receiptIds(bytes: Uint8Array): Set<string> {
  const text = strictUtf8(bytes), ids = new Set<string>();
  if (text.length === 0) return ids;
  if (!text.endsWith("\n")) fail("receipt_tail_pending");
  for (const line of text.slice(0, -1).split("\n")) {
    const id = receiptId(line);
    if (ids.has(id)) fail("conflict");
    ids.add(id);
  }
  return ids;
}
let native: ReturnType<typeof loadOwnedDirectoryNative> | undefined;
function api() {
  if (!((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64")) || process.geteuid === undefined) fail("unsupported");
  try { return native ??= loadOwnedDirectoryNative(); } catch { fail("native_unavailable"); }
}
function nameBytes(name: string): Buffer {
  const bytes = Buffer.from(name);
  if (!bytes.length || bytes.length > 255 || bytes.includes(0) || name.includes("/") || name.includes("\\") ||
      name === "." || name === ".." || bytes.toString("utf8") !== name) fail("bounds");
  return Buffer.concat([bytes, Buffer.from([0])]);
}
function result(value: number | bigint): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value > 0x7fffffff || value < -4095) fail("io");
  if (value === -38 || value === -95) fail("unsupported");
  if (value === -17) fail("conflict");
  if (value < 0 && value !== -2) fail("unsafe");
  return value;
}
function openDirectory(parent: number, name: string): number | null {
  const bytes = nameBytes(name), fd = result(api().symbols.openChild(parent, ptr(bytes), 1));
  return fd === -2 ? null : fd;
}
function openFile(parent: number, readable: boolean, exclusive = false): number | null {
  const bytes = nameBytes(FILE);
  const open = readable ? api().symbols.openReceiptReadAppendChild : api().symbols.openReceiptAppendChild;
  const fd = result(open(parent, ptr(bytes), exclusive ? 1 : 0));
  return fd === -2 ? null : fd;
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function directoryStat(fd: number, ancestor = false, vaultPath?: string): BigIntStats {
  const stat = fstatSync(fd, { bigint: true }), uid = BigInt(process.geteuid!());
  if (!stat.isDirectory() || stat.nlink < 1n) fail("unsafe");
  let owner = stat.uid;
  if (ancestor && owner !== uid && owner !== 0n && vaultPath !== undefined) {
    owner = serviceAncestorOwner(vaultPath, fd, stat) ?? owner;
  }
  const sticky = ancestor && owner === 0n && (stat.mode & 0o1000n) !== 0n;
  if ((owner !== uid && (!ancestor || owner !== 0n)) ||
      ((stat.mode & 0o022n) !== 0n && !sticky)) fail("unsafe");
  return stat;
}
function openRoot(path: string): number {
  if (path === "/" || path.split("/").length > 257) fail("bounds");
  const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000;
  // Ancestors supply traversal and identity, not directory-listing authority.
  const access = process.platform === "linux" ? 0x200000 /* O_PATH */ : constants.O_RDONLY;
  let fd = openSync("/", access | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec);
  try {
    directoryStat(fd, true, path);
    const parts = path.split("/").filter(Boolean);
    for (const [index, part] of parts.entries()) {
      const ancestor = index < parts.length - 1;
      const bytes = nameBytes(part);
      const next = ancestor ? result(api().symbols.openAncestorChild(fd, ptr(bytes))) : openDirectory(fd, part);
      if (next === null || next === -2) fail("missing");
      closeSync(fd); fd = next;
      // O_PATH|NOFOLLOW must never turn a symlink descriptor into authority.
      directoryStat(fd, ancestor, path);
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function fileStat(fd: number, readable: boolean): BigIntStats {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.geteuid!()) || stat.size < 0n || (stat.mode & 0o200n) === 0n) fail("unsafe");
  if (readable && stat.size > SOURCE_STREAM_LIMIT) fail("bounds");
  return stat;
}
function sync(fd: number): void { try { fsyncSync(fd); } catch { fail("durability"); } }
function closeAll(fds: readonly number[]): void {
  let failed = false;
  for (const fd of [...fds].reverse()) { try { closeSync(fd); } catch { failed = true; } }
  if (failed) fail("io");
}
function verifyDirectories(path: string, fds: readonly number[], expected: readonly BigIntStats[], assertOwner: () => void): void {
  assertOwner();
  const root = openRoot(path);
  try { if (!sameIdentity(directoryStat(root), expected[0]!)) fail("changed"); }
  finally { closeSync(root); }
  for (let index = 1; index < fds.length; index++) {
    const current = openDirectory(fds[index - 1]!, index === 1 ? CONTROL : DIRECTORY);
    if (current === null) fail("changed");
    try {
      if (!sameIdentity(directoryStat(current), expected[index]!) ||
          !sameIdentity(directoryStat(fds[index]!), expected[index]!)) fail("changed");
    } finally { closeSync(current); }
  }
}
function verifyFile(parent: number, fd: number, readable: boolean, expected: BigIntStats): void {
  if (!sameFile(fileStat(fd, readable), expected)) fail("changed");
  const named = openFile(parent, readable); if (named === null) fail("changed");
  try { if (!sameFile(fileStat(named, readable), expected)) fail("changed"); }
  finally { closeSync(named); }
}

export interface ReceiptRedactionPlan {
  readonly checkpoint: OrdinaryReceiptCheckpoint;
  readonly after_hash: string;
  readonly after_length: number;
}
function redactedBytes(before:Buffer,erased:readonly ErasedWorldCanonReceipt[],final:WorldCanonReceiptRecord):Buffer {
  receiptIds(before);
  if(parseWorldCanonReceipt(final)===null)fail("receipt_invalid");
  const replacements=new Map<string,ErasedWorldCanonReceipt>();
  for(const item of erased) {
    if(parseWorldCanonReceipt(item)?.state!=="erased"||replacements.has(item.receipt_id)||item.receipt_id===final.receipt_id)fail("receipt_invalid");
    replacements.set(item.receipt_id,item);
  }
  const lines=before.length===0?[]:strictUtf8(before).slice(0,-1).split("\n");
  for(let index=0;index<lines.length;index++) {
    const record=parseReceiptRecordLine(lines[index]!);
    if(record.receipt_id===final.receipt_id)fail("conflict");
    const replacement=replacements.get(record.receipt_id);
    if(replacement!==undefined) {
      if(!("schema" in record)||record.schema!=="kizuki.canon-receipt/v2")fail("receipt_invalid");
      lines[index]=JSON.stringify(replacement);replacements.delete(record.receipt_id);
    }
  }
  if(replacements.size>0)fail("receipt_invalid");
  const result=Buffer.from([...lines,JSON.stringify(final),""].join("\n"));
  if(result.length>Number(SOURCE_STREAM_LIMIT))fail("bounds");
  return result;
}
function readNamedSnapshot(parent:number,name:string):{fd:number;stat:BigIntStats;bytes:Buffer}|null {
  const fd=result(api().symbols.openChild(parent,ptr(nameBytes(name)),0));if(fd===-2)return null;if(fd<0)fail("unsafe");
  try {
    const stat=fileStat(fd,true),bytes=Buffer.alloc(Number(stat.size));
    for(let offset=0;offset<bytes.length;){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);if(n<=0)fail("io");offset+=n;}
    if(!sameFile(stat,fileStat(fd,true)))fail("changed");
    return {fd,stat,bytes};
  }catch(error){closeSync(fd);throw error;}
}

/** Fixed receipt child only. Byte custody does not confer receipt authority. */
class ReceiptStream {
  #closed = false;
  #failed = false;
  #stat: BigIntStats;
  readonly #directories: readonly BigIntStats[];
  readonly #path: string;
  #fds: [number, number, number, number];
  readonly #readable: boolean;
  readonly #ordinaryRecovery: boolean;
  readonly #assertOwner: () => void;
  constructor(path: string, fds: readonly [number, number, number, number], readable: boolean, assertOwner: () => void, ordinaryRecovery = false) {
    this.#path = path; this.#fds = [...fds]; this.#readable = readable; this.#assertOwner = assertOwner;
    this.#ordinaryRecovery = ordinaryRecovery;
    this.#directories = fds.slice(0, 3).map(fd => directoryStat(fd));
    this.#stat = fileStat(fds[3], readable);
  }
  #guard<T>(work: () => T): T {
    if (this.#closed) fail("closed");
    if (this.#failed) fail("failed");
    try { return work(); }
    catch (error) { this.#failed = true; throw mapped(error); }
  }
  #verify(): void {
    verifyDirectories(this.#path, this.#fds.slice(0, 3), this.#directories, this.#assertOwner);
    verifyFile(this.#fds[2], this.#fds[3], this.#readable, this.#stat);
  }
  verifyBinding(): void { this.#guard(() => this.#verify()); }
  #readBytes(): Buffer {
    if (!this.#readable) fail("unsafe");
    this.#verify();
    const bytes = Buffer.alloc(Number(this.#stat.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(this.#fds[3], bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) fail("io");
      offset += count;
    }
    this.#verify();
    return bytes;
  }
  readUtf8(): string {
    return this.#guard(() => this.#readBytes().toString("utf8"));
  }
  checkpoint(): OrdinaryReceiptCheckpoint {
    return this.#guard(() => {
      if (!this.#ordinaryRecovery) fail("unsafe");
      const bytes = this.#readBytes(); receiptIds(bytes);
      // Admission must persist a checkpoint of a durable prefix, including an
      // empty newly created log, before budget, intent or payload mutations.
      this.sync();
      return validateOrdinaryReceiptCheckpoint({ version: 1, byte_length: bytes.length, prefix_sha256: digest(bytes),
        vault: statIdentity(this.#directories[0]!), control: statIdentity(this.#directories[1]!),
        directory: statIdentity(this.#directories[2]!), file: statIdentity(this.#stat) });
    });
  }
  #admittedTail(input: OrdinaryReceiptCheckpoint, exactReceiptLine: Uint8Array): { prefix: Buffer; line: Buffer; tail: Buffer } {
    if (!this.#ordinaryRecovery) fail("unsafe");
    const checkpoint = validateOrdinaryReceiptCheckpoint(input);
    if (!(exactReceiptLine instanceof Uint8Array) || exactReceiptLine.byteLength > 8 * 1024 * 1024) fail("bounds");
    const line = Buffer.from(exactReceiptLine), ids = receiptIds(line);
    if (ids.size !== 1) fail("receipt_invalid");
    const bytes = this.#readBytes();
    if (![checkpoint.vault, checkpoint.control, checkpoint.directory].every((value, index) => matchesIdentity(value, this.#directories[index]!)) ||
        !matchesIdentity(checkpoint.file, this.#stat) || bytes.length < checkpoint.byte_length) fail("changed");
    const prefix = bytes.subarray(0, checkpoint.byte_length);
    if (digest(prefix) !== checkpoint.prefix_sha256) fail("changed");
    const priorIds = receiptIds(prefix);
    if (priorIds.has(ids.values().next().value!)) fail("conflict");
    const tail = bytes.subarray(checkpoint.byte_length);
    if (tail.length > line.length || !tail.equals(line.subarray(0, tail.length))) fail("receipt_tail_pending");
    return { prefix, line, tail };
  }
  reconcile(input: OrdinaryReceiptCheckpoint, exactReceiptLine: Uint8Array): void {
    this.#guard(() => {
      const { prefix, line, tail } = this.#admittedTail(input, exactReceiptLine);
      if (prefix.length + line.length > Number(SOURCE_STREAM_LIMIT)) fail("bounds");
      this.#verify();
      if (tail.length < line.length) this.append(line.subarray(tail.length));
      this.sync();
      // Re-read under the same descriptor; a receipt is neither inferred from
      // its ID nor considered durable solely because write returned.
      if (!this.#readBytes().equals(Buffer.concat([prefix, line]))) fail("changed");
    });
  }
  planRedaction(erased:readonly ErasedWorldCanonReceipt[],final:WorldCanonReceiptRecord):ReceiptRedactionPlan {
    return this.#guard(()=>{
      const checkpoint=this.checkpoint(),after=redactedBytes(this.#readBytes(),erased,final);
      return {checkpoint,after_hash:digest(after),after_length:after.length};
    });
  }
  /** Atomic, purpose-bound replacement. Recovery accepts only the exact admitted postimage. */
  reconcileRedaction(plan:ReceiptRedactionPlan,erased:readonly ErasedWorldCanonReceipt[],final:WorldCanonReceiptRecord):void {
    this.#guard(()=>{
      if(!this.#ordinaryRecovery||!hash(plan.after_hash)||!Number.isSafeInteger(plan.after_length)||plan.after_length<0||plan.after_length>Number(SOURCE_STREAM_LIMIT))fail("checkpoint_invalid");
      const checkpoint=validateOrdinaryReceiptCheckpoint(plan.checkpoint),bytes=this.#readBytes();
      if(![checkpoint.vault,checkpoint.control,checkpoint.directory].every((value,index)=>matchesIdentity(value,this.#directories[index]!)))fail("changed");
      if(bytes.length===plan.after_length&&digest(bytes)===plan.after_hash){receiptIds(bytes);this.sync();return;}
      if(!matchesIdentity(checkpoint.file,this.#stat)||bytes.length!==checkpoint.byte_length||digest(bytes)!==checkpoint.prefix_sha256)fail("changed");
      const after=redactedBytes(bytes,erased,final);
      if(after.length!==plan.after_length||digest(after)!==plan.after_hash)fail("changed");
      const temporary=`.${FILE}.${final.receipt_id}.erased.tmp`,encoded=nameBytes(temporary),parent=this.#fds[2];
      const created=api().symbols.createCredentialChild(parent,ptr(encoded));
      let fd=created===-17?-17:result(created);
      let offset=0,expectedTemporary:BigIntStats|null=null;
      if(fd===-17) {
        const saved=readNamedSnapshot(parent,temporary);if(saved===null)fail("changed");
        try {if(saved.bytes.length>after.length||!saved.bytes.equals(after.subarray(0,saved.bytes.length)))fail("changed");offset=saved.bytes.length;expectedTemporary=saved.stat;}
        finally{closeSync(saved.fd);}
        fd=result(api().symbols.openReceiptReadAppendChild(parent,ptr(encoded),0));
      }
      if(fd<0)fail("unsafe");
      let transferred=false;
      try {
        const opened=fileStat(fd,true);
        if(expectedTemporary!==null&&!sameFile(expectedTemporary,opened))fail("changed");
        while(offset<after.length){const n=writeSync(fd,after,offset,after.length-offset);if(n<=0)fail("io");offset+=n;}
        fsyncSync(fd);
        const saved=readNamedSnapshot(parent,temporary);if(saved===null)fail("changed");
        try {if(!sameIdentity(saved.stat,fileStat(fd,true))||!saved.bytes.equals(after))fail("changed");}
        finally{closeSync(saved.fd);}
        this.#verify();
        if(result(api().symbols.renameChild(parent,ptr(encoded),parent,ptr(nameBytes(FILE))))!==0)fail("io");
        closeSync(this.#fds[3]);this.#fds[3]=fd;transferred=true;this.#stat=fileStat(fd,true);
        this.sync();if(!this.#readBytes().equals(after))fail("changed");
      }finally{if(!transferred)closeSync(fd);}
    });
  }
  /** Only the source-denial coordinator may authorize withdrawal of its pending receipt. */
  withdrawExact(input: OrdinaryReceiptCheckpoint, exactReceiptLine: Uint8Array): void {
    this.#guard(() => {
      const { prefix, tail } = this.#admittedTail(input, exactReceiptLine);
      this.#verify();
      if (tail.length !== 0) {
        ftruncateSync(this.#fds[3], prefix.length);
        const current = fileStat(this.#fds[3], true);
        if (!sameIdentity(current, this.#stat) || current.size !== BigInt(prefix.length) || current.mode !== this.#stat.mode || current.gid !== this.#stat.gid) fail("changed");
        this.#stat = current;
      }
      this.sync();
      if (!this.#readBytes().equals(prefix)) fail("changed");
    });
  }
  append(input: Uint8Array): void {
    this.#guard(() => {
      if (!(input instanceof Uint8Array)) fail("bounds");
      const bytes = Buffer.from(input);
      this.#verify();
      const expectedSize = this.#stat.size + BigInt(bytes.length);
      if (this.#readable && expectedSize > SOURCE_STREAM_LIMIT) fail("bounds");
      for (let offset = 0; offset < bytes.length;) {
        const count = writeSync(this.#fds[3], bytes, offset, bytes.length - offset);
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) fail("io");
        offset += count;
      }
      const current = fileStat(this.#fds[3], this.#readable);
      if (!sameIdentity(current, this.#stat) || current.size !== expectedSize || current.mode !== this.#stat.mode || current.gid !== this.#stat.gid) fail("changed");
      this.#stat = current;
      this.#verify();
    });
  }
  sync(): void {
    this.#guard(() => { this.#verify(); sync(this.#fds[3]); sync(this.#fds[2]); this.#verify(); });
  }
  close(): void { if (!this.#closed) { this.#closed = true; closeAll(this.#fds); } }
}

export type ReceiptAppendStream = Pick<ReceiptStream, "append" | "sync" | "verifyBinding" | "close">;
export type SourceErasureReceiptFile = ReceiptAppendStream & Pick<ReceiptStream, "readUtf8">;
export type WorldErasureReceiptStream = Pick<ReceiptStream, "planRedaction" | "reconcileRedaction" | "sync" | "verifyBinding" | "close">;
export type OrdinaryRecoveryReceiptStream = Pick<ReceiptStream, "checkpoint" | "reconcile" | "withdrawExact" | "sync" | "verifyBinding" | "close">;

function openStream(scope: VaultMutationScope, io: CanonIo, readable: boolean, ordinaryRecovery = false): ReceiptStream {
  const files = requireCanonFiles(scope, io);
  const target = Object.freeze({ vault_path: resolve(io.vault_path), db: io.db });
  const assertOwner = (): void => { assertVaultMutationScope(scope, target); assertCanonFiles(files, target.vault_path); };
  const fds: number[] = [];
  let stream: ReceiptStream | undefined;
  try {
    api(); assertOwner();
    const root = openRoot(target.vault_path); fds.push(root);
    const control = openDirectory(root, CONTROL); if (control === null) fail("missing");
    fds.push(control); directoryStat(control);
    const directories = fds.map(fd => directoryStat(fd));
    let parent = openDirectory(control, DIRECTORY);
    if (parent === null && (!readable || ordinaryRecovery)) {
      verifyDirectories(target.vault_path, fds, directories, assertOwner);
      const name = nameBytes(DIRECTORY);
      if (result(api().symbols.mkdirChild(control, ptr(name))) !== 0) fail("io");
      sync(control);
      parent = openDirectory(control, DIRECTORY);
    }
    if (parent === null) fail("missing");
    fds.push(parent); directories.push(directoryStat(parent));
    verifyDirectories(target.vault_path, fds, directories, assertOwner);
    let fd = openFile(parent, readable);
    if (fd === null) fd = openFile(parent, readable, true);
    if (fd === null) fail("changed");
    fds.push(fd);
    const stat = fileStat(fd, readable);
    if (ordinaryRecovery) {
      if ((stat.mode & 0o777n) !== 0o600n) fail("unsafe");
    } else if (readable) {
      verifyDirectories(target.vault_path, fds.slice(0, 3), directories, assertOwner);
      verifyFile(parent, fd, readable, stat);
      if ((stat.mode & 0o777n) !== 0o600n) fchmodSync(fd, 0o600);
      if ((fileStat(fd, true).mode & 0o777n) !== 0o600n) fail("unsafe");
      sync(fd);
    }
    else if ((stat.mode & 0o022n) !== 0n) fail("unsafe");
    stream = new ReceiptStream(target.vault_path, [root, control, parent, fd], readable, assertOwner, ordinaryRecovery);
    stream.verifyBinding();
    return stream;
  } catch (error) {
    try { if (stream) stream.close(); else closeAll(fds); } catch { /* Retain the original refusal. */ }
    throw mapped(error);
  }
}

export function openOrdinaryReceiptStream(scope: VaultMutationScope, io: CanonIo): ReceiptAppendStream { return openStream(scope, io, false); }
export function openSourceErasureReceiptStream(scope: VaultMutationScope, io: CanonIo): SourceErasureReceiptFile { return openStream(scope, io, true); }
/** Admission calls checkpoint(); recovery may instead reconcile a known torn tail. */
export function openOrdinaryRecoveryReceiptStream(scope: VaultMutationScope, io: CanonIo): OrdinaryRecoveryReceiptStream {
  const stream = openStream(scope, io, true, true);
  // No generic append/read surface escapes this purpose-bound capability.
  return Object.freeze({ checkpoint: () => stream.checkpoint(), reconcile: (checkpoint: OrdinaryReceiptCheckpoint, line: Uint8Array) => stream.reconcile(checkpoint, line),
    withdrawExact: (checkpoint: OrdinaryReceiptCheckpoint, line: Uint8Array) => stream.withdrawExact(checkpoint, line),
    sync: () => stream.sync(), verifyBinding: () => stream.verifyBinding(), close: () => stream.close() });
}

/** Only the typed erasure intent holder receives whole-stream redaction capability. */
export function openWorldErasureReceiptStream(scope:VaultMutationScope,io:CanonIo):WorldErasureReceiptStream {
  const stream=openStream(scope,io,true,true);
  return Object.freeze({
    planRedaction:(erased:readonly ErasedWorldCanonReceipt[],final:WorldCanonReceiptRecord)=>stream.planRedaction(erased,final),
    reconcileRedaction:(plan:ReceiptRedactionPlan,erased:readonly ErasedWorldCanonReceipt[],final:WorldCanonReceiptRecord)=>stream.reconcileRedaction(plan,erased,final),
    sync:()=>stream.sync(),verifyBinding:()=>stream.verifyBinding(),close:()=>stream.close(),
  });
}
