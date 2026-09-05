import { afterEach, expect, test } from 'bun:test';
import { readdirSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionStateStore } from '../src/ledger/connection-state';
import { enrollConnection } from '../src/ledger/enroll';
import { listConnections, disconnect, type Connection } from '../src/ledger/connections';
import { openLedger } from '../src/ledger/db';
import { connector, io, temporaryDirectories } from './connections-helpers';
const dirs=temporaryDirectories('new-enrollment-');afterEach(dirs.cleanup);
const bytes=(text:string)=>new TextEncoder().encode(text);
const text=(value:Uint8Array)=>new TextDecoder().decode(value);
const unique=(candidate:Uint8Array, existing:readonly {connection:Connection;state:Uint8Array|null}[])=>{
 if(existing.some(item=>item.state===null))throw Error('unknown identity');
 if(existing.some(item=>text(item.state!)===text(candidate)))throw Error('duplicate identity');
};
const signed=(value:string)=>connector(async(_io,writer)=>{await writer.write(bytes(value));return{display:'synthetic'};});

test('duplicate new enrollment checks current protected identity before publication and preserves existing source',async()=>{
 const dir=dirs.temporary(),db=openLedger(join(dir,'ledger.sqlite')),store=new ConnectionStateStore(dir);
 try{
  const first=await enrollConnection(db,store,signed('account-A'),io,unique);
  await expect(enrollConnection(db,store,signed('account-A'),io,unique)).rejects.toThrow('duplicate');
  expect(listConnections(db)).toEqual([first]);expect(text(store.read(first)!)).toBe('account-A');
  expect(readdirSync(store.directory)).toEqual([`${first.source_key}.state`]);
  const second=await enrollConnection(db,store,signed('account-B'),io,unique);
  expect(second.source_key).not.toBe(first.source_key);expect(listConnections(db)).toHaveLength(2);
 }finally{db.close();}
});

test('two native database handles race same identity; verification executes under writer exclusion',async()=>{
 const dir=dirs.temporary(),db=openLedger(join(dir,'ledger.sqlite')),other=openLedger(join(dir,'ledger.sqlite'));
 const a=new ConnectionStateStore(dir),b=new ConnectionStateStore(dir);let go!:()=>void;const start=new Promise<void>(r=>{go=r;});
 const delayed=()=>connector(async(_io,writer)=>{await start;await writer.write(bytes('same-account'));return{display:'synthetic'};});
 let locked=false;
 const verify=(candidate:Uint8Array,existing:readonly {connection:Connection;state:Uint8Array|null}[])=>{
  if(!locked){expect(()=>other.exec('BEGIN IMMEDIATE')).toThrow();locked=true;}unique(candidate,existing);
 };
 try{
  const first=enrollConnection(db,a,delayed(),io,verify),second=enrollConnection(other,b,delayed(),io,unique);
  go();const result=await Promise.allSettled([first,second]);
  expect(result.filter(item=>item.status==='fulfilled')).toHaveLength(1);
  expect(result.filter(item=>item.status==='rejected')).toHaveLength(1);expect(locked).toBe(true);
  expect(listConnections(db)).toHaveLength(1);expect(readdirSync(a.directory)).toHaveLength(1);
 }finally{db.close();other.close();}
});

test('tampered staged bytes cannot authorize a different identity',async()=>{
 const dir=dirs.temporary(),db=openLedger(':memory:'),store=new ConnectionStateStore(dir);let verified=false;
 try{
  const altered=connector(async(_io,writer)=>{await writer.write(bytes('original'));const file=readdirSync(store.directory).find(n=>n.endsWith('.tmp'))!;writeFileSync(join(store.directory,file),'modified');return{display:'synthetic'};});
  await expect(enrollConnection(db,store,altered,io,()=>{verified=true;})).rejects.toThrow('digest');
  expect(verified).toBe(false);expect(listConnections(db)).toHaveLength(0);expect(readdirSync(store.directory)).toHaveLength(0);
 }finally{db.close();}
});

test('failed row commit rolls back verified new state and recovery preserves unrelated identity',async()=>{
 const dir=dirs.temporary(),db=openLedger(':memory:'),store=new ConnectionStateStore(dir);
 try{
  const first=await enrollConnection(db,store,signed('A'),io,unique);
  db.exec("CREATE TRIGGER refuse_new BEFORE INSERT ON connections BEGIN SELECT RAISE(ABORT,'synthetic row failure'); END");
  await expect(enrollConnection(db,store,signed('B'),io,unique)).rejects.toThrow('synthetic row failure');
  expect(store.recover(db).unresolved).toEqual([]);expect(listConnections(db)).toEqual([first]);expect(text(store.read(first)!)).toBe('A');
  expect(readdirSync(store.directory)).toEqual([`${first.source_key}.state`]);
  db.exec('DROP TRIGGER refuse_new');await enrollConnection(db,store,signed('B'),io,unique);expect(listConnections(db)).toHaveLength(2);
 }finally{db.close();}
});

for(const mode of ['row-bound','byte-bound','unreadable'] as const)test(`new identity admission fails closed on ${mode}`,async()=>{
 const dir=dirs.temporary(),db=openLedger(':memory:'),store=new ConnectionStateStore(dir);
 try{
  const count=mode==='row-bound'?32:mode==='byte-bound'?9:1;
  for(let i=0;i<count;i++)await enrollConnection(db,store,signed(mode==='byte-bound'?'x'.repeat(1024*1024):`account${i}`),io);
  if(mode==='unreadable'){const file=readdirSync(store.directory)[0]!;unlinkSync(join(store.directory,file));symlinkSync(join(dir,'unavailable-state'),join(store.directory,file));}
  let verified=false;await expect(enrollConnection(db,store,signed('new'),io,()=>{verified=true;})).rejects.toThrow();
  expect(verified).toBe(false);expect(listConnections(db)).toHaveLength(count);
 }finally{db.close();}
});


test('disconnected identities are included; unknown state is never ignored and other connectors remain independent',async()=>{
 const dir=dirs.temporary(),db=openLedger(':memory:'),store=new ConnectionStateStore(dir);
 try{
  const first=await enrollConnection(db,store,signed('A'),io,unique);disconnect(db,'fixture',first.source_key);
  await expect(enrollConnection(db,store,signed('A'),io,unique)).rejects.toThrow('duplicate');
  const separate=signed('A');const manifest=separate.manifest();separate.manifest=()=>({...manifest,connector_id:'other'});
  expect((await enrollConnection(db,store,separate,io,unique)).connector_id).toBe('other');
  expect(listConnections(db,{includeDisconnected:true})).toHaveLength(2);
 }finally{db.close();}
});

test('an asynchronous verifier is rejected before publication and its rejection is handled',async()=>{
 const dir=dirs.temporary(),db=openLedger(':memory:'),store=new ConnectionStateStore(dir);
 try{
  await expect(enrollConnection(db,store,signed('A'),io,async()=>{throw Error('synthetic refusal');})).rejects.toThrow('synchronously');
  await Bun.sleep(1);expect(listConnections(db)).toHaveLength(0);expect(readdirSync(store.directory)).toEqual([]);
 }finally{db.close();}
});
