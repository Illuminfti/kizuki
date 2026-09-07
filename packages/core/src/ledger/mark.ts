import type { Database } from "bun:sqlite";
import { ptr } from "bun:ffi";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { serviceAncestorOwner } from "../serve/custody";
import { loadOwnedDirectoryNative } from "../util/owned-directory-native";

/** Accepted rows are live events plus transactional purge receipts. A sibling
 * floor detects a ledger copied without committed WAL evidence. Reads never seal. */
export const LEDGER_MARK_PATH = ".kizuki/ledger-mark";
const NAME = "ledger-mark", LIMIT = 17;
let native: ReturnType<typeof loadOwnedDirectoryNative> | undefined;
function fail(code: string): never { throw new Error(`ledger_mark_${code}`); }
function api() { return native ??= loadOwnedDirectoryNative(); }
function name(value: string) { return Buffer.from(`${value}\0`); }
function status(value: number | bigint): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -4095 || value > 0x7fffffff) fail("io");
  return value;
}
function child(fd: number, component: string, directory: boolean, ancestor = false): number | null {
  const bytes = name(component), result = status(ancestor ? api().symbols.openAncestorChild(fd, ptr(bytes)) : api().symbols.openChild(fd, ptr(bytes), directory ? 1 : 0));
  if (result === -2) return null;
  if (result < 0) fail("unsafe");
  return result;
}
function directory(fd: number, vault: string, ancestor = false, privateControl = false): BigIntStats {
  const s = fstatSync(fd, { bigint: true }), uid = BigInt(process.geteuid!());
  let owner = s.uid;
  if (ancestor && owner !== uid && owner !== 0n) owner = serviceAncestorOwner(vault, fd, s) ?? owner;
  if (!s.isDirectory() || (owner !== uid && (!ancestor || owner !== 0n)) ||
      ((s.mode & 0o022n) !== 0n && !(ancestor && owner === 0n && (s.mode & 0o1000n) !== 0n)) ||
      (privateControl && (s.mode & 0o7777n) !== 0o700n)) fail("unsafe");
  return s;
}
const sameInode = (a: {dev:bigint;ino:bigint}, b: {dev:bigint;ino:bigint}) => a.dev === b.dev && a.ino === b.ino;
function same(a: BigIntStats,b: BigIntStats): boolean {
  return sameInode(a,b)&&a.mode===b.mode&&a.uid===b.uid&&a.gid===b.gid&&a.nlink===b.nlink&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
}
function openControl(vault: string): {fd:number;vault:BigIntStats;control:BigIntStats} | null {
  if (!((process.platform === "linux" && process.arch === "x64") || (process.platform === "darwin" && process.arch === "arm64")) || !process.geteuid) fail("unsupported");
  if (typeof vault !== "string" || !isAbsolute(vault) || resolve(vault)!==vault || vault.includes("\0") || Buffer.byteLength(vault)>4096 || vault.split("/").length>256 || vault==="/") fail("path");
  const parts=vault.split("/").filter(Boolean), cloexec=process.platform==="darwin"?0x1000000:0x80000;
  let fd=openSync("/",(process.platform==="linux"?0x200000:constants.O_RDONLY)|constants.O_DIRECTORY|constants.O_NOFOLLOW|cloexec);
  try {
    directory(fd,vault,true);
    for(const [i,part] of parts.entries()) {
      const ancestor=i<parts.length-1,next=child(fd,part,true,ancestor);
      if(next===null)fail("changed"); closeSync(fd);fd=next;directory(fd,vault,ancestor);
    }
    const root=directory(fd,vault), next=child(fd,".kizuki",true);
    if(next===null){closeSync(fd);return null;}closeSync(fd);fd=next;
    return {fd,vault:root,control:directory(fd,vault,false,true)};
  } catch(error) {closeSync(fd);throw error;}
}
function current(vault:string,held:NonNullable<ReturnType<typeof openControl>>): void {
  const found=openControl(vault);if(found===null)fail("changed");
  try {if(!sameInode(found.vault,held.vault)||!sameInode(found.control,held.control)||!sameInode(directory(held.fd,vault,false,true),held.control))fail("changed");}
  finally{closeSync(found.fd);}
}
function privateStat(fd:number): BigIntStats {
  const s=fstatSync(fd,{bigint:true});
  if(!s.isFile()||s.nlink!==1n||s.uid!==BigInt(process.geteuid!())||(s.mode&0o7777n)!==0o600n)fail("unsafe");
  if(s.size<0n||s.size>BigInt(LIMIT))fail("bounds");return s;
}
function readMark(fd:number): {stat:BigIntStats;bytes:Buffer;value:number|null}|null {
  const opened=child(fd,NAME,false);if(opened===null)return null;
  try {
    const before=privateStat(opened),bytes=Buffer.alloc(Number(before.size));
    for(let offset=0;offset<bytes.length;){const count=readSync(opened,bytes,offset,bytes.length-offset,offset);if(count<=0||count>bytes.length-offset)fail("changed");offset+=count;}
    const after=privateStat(opened);if(!same(before,after))fail("changed");
    const text=bytes.toString("ascii");
    const valid=bytes.every(byte=>byte<128)&&/^(0|[1-9][0-9]{0,15})\n$/.test(text),value=valid?Number(text.slice(0,-1)):NaN;
    return {stat:after,bytes,value:Number.isSafeInteger(value)&&value>=0?value:null};
  }finally{closeSync(opened);}
}
/** Native metadata only: opening/closing SQLite's descriptor could drop its locks. */
function databaseIdentity(fd:number): {dev:bigint;ino:bigint} {
  const bytes=new Uint8Array(144),encoded=name("kizuki.db"),result=status(api().symbols.statChild(fd,ptr(encoded),ptr(bytes)));
  if(result!==0)fail("database_changed");const v=new DataView(bytes.buffer),mode=v.getUint32(24,true);
  if((mode&0o170000)!==0o100000||(mode&0o7777)!==0o600||v.getUint32(28,true)!==process.geteuid!()||v.getBigUint64(16,true)!==1n)fail("unsafe_database");
  return {dev:v.getBigUint64(0,true),ino:v.getBigUint64(8,true)};
}
function publish(vault:string,held:NonNullable<ReturnType<typeof openControl>>,prior:ReturnType<typeof readMark>,accepted:number,checkDatabase:()=>void): void {
  const temporary=`ledger-mark.${crypto.randomUUID()}.tmp`,encoded=name(temporary),destination=name(NAME),bytes=Buffer.from(`${accepted}\n`);
  const fd=status(api().symbols.createCredentialChild(held.fd,ptr(encoded)));if(fd<0)fail("io");
  let staged:BigIntStats|undefined,published=false;
  try {
    privateStat(fd);
    for(let offset=0;offset<bytes.length;){const count=writeSync(fd,bytes,offset,bytes.length-offset,offset);if(count<=0||count>bytes.length-offset)fail("io");offset+=count;}
    staged=privateStat(fd);if(staged.size!==BigInt(bytes.length))fail("changed");fsyncSync(fd);
    current(vault,held);checkDatabase();const now=readMark(held.fd);
    if(prior===null?now!==null:now===null||!same(prior.stat,now.stat)||!prior.bytes.equals(now.bytes))fail("changed");
    // The immediate SQLite transaction excludes cooperating sealers. renameat
    // alone is not CAS against arbitrary same-owner filesystem replacement.
    const renamed=status(prior===null?api().symbols.renameChildNoReplace(held.fd,ptr(encoded),held.fd,ptr(destination)):api().symbols.renameChild(held.fd,ptr(encoded),held.fd,ptr(destination)));
    if(renamed!==0)fail(renamed===-17?"changed":"io");published=true;fsyncSync(held.fd);
    const after=readMark(held.fd);if(after===null||!sameInode(after.stat,staged)||!after.bytes.equals(bytes))fail("changed");current(vault,held);checkDatabase();
  }finally{
    closeSync(fd);
    if(!published&&staged){const leftover=child(held.fd,temporary,false);if(leftover!==null){try{if(same(fstatSync(leftover,{bigint:true}),staged)){if(status(api().symbols.unlinkChild(held.fd,ptr(encoded)))===0)fsyncSync(held.fd);}}finally{closeSync(leftover);}}}
  }
}
export function ledgerAccepted(db:Database): number {
  const row=db.query<{accepted:number},[]>("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM event_purges) AS accepted").get();
  if(!row||!Number.isSafeInteger(row.accepted)||row.accepted<0)throw new TypeError("ledger accepted count must be a non-negative safe integer");return row.accepted;
}
/** Absent or bounded malformed private bytes are legacy unsealed. Unsafe custody
 * and oversized input are refusals, never absence and never a repair. */
export function readLedgerMark(vault:string): number|null {
  const held=openControl(vault);if(held===null)return null;
  try{const observed=readMark(held.fd);current(vault,held);const again=readMark(held.fd);if(observed===null?again!==null:again===null||!same(observed.stat,again.stat)||!observed.bytes.equals(again.bytes))fail("changed");return observed?.value??null;}
  finally{closeSync(held.fd);}
}
/** Must run outside caller transactions against the canonical writable ledger.
 * Serialization covers sealers of that database, not hostile same-owner swaps
 * of an already-open database inode. No polling, raw writer bypass, or floor drop. */
export function sealLedger(vault:string,db:Database): number {
  if(db.inTransaction)fail("transaction_active");
  if(db.filename!==join(vault,".kizuki/kizuki.db"))fail("invalid_database");
  const held=openControl(vault);if(held===null)fail("invalid_database");
  try{
    const identity=databaseIdentity(held.fd),check=()=>{current(vault,held);if(!sameInode(databaseIdentity(held.fd),identity))fail("database_changed");};
    return db.transaction(()=>{check();const accepted=ledgerAccepted(db),prior=readMark(held.fd),floor=Math.max(accepted,prior?.value??0);if(prior?.value!==floor)publish(vault,held,prior,floor,check);check();return floor;}).immediate();
  }finally{closeSync(held.fd);}
}
