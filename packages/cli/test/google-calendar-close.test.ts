import {afterEach,expect,test} from 'bun:test';
import {join} from 'node:path';
import {ConnectionStateStore,createStatePersister,getConnection,runToCompletion,setSourceGrant} from '@kizuki/core';
import {openLedger} from '@kizuki/core/testing';
import {createGoogleCalendarConnector,GOOGLE_CALENDAR_CONNECTOR_ID,GOOGLE_CALENDAR_SCOPES} from '@kizuki/connector-google-calendar';
import {CalendarFixture} from '../../connector-google-calendar/src/testing';
import {FIELDS,parseState,encodeState} from '../../connector-google-calendar/src/state';
import {closeHostConnector,loadConnector,selectConnection} from '../src/connections';
import {withVault} from '../src/context';
import {createHelpers} from './helpers';
import type{CliIo}from'../src/commands';
const h=createHelpers();afterEach(h.cleanup);
const response={status:200,body:{access_token:'synthetic-drained-access',refresh_token:'synthetic-drained-refresh',expires_in:3600,scope:GOOGLE_CALENDAR_SCOPES.join(' '),token_type:'Bearer'}};
test('native host finalizer keeps Core state writable through late delivered rotation',async()=>{
 const setup=h.tempVault(),f=new CalendarFixture(),database=join(setup.vault,'.kizuki/kizuki.db'),db=openLedger(database),store=new ConnectionStateStore(join(setup.vault,'.kizuki'));const expiring=parseState(f.state);expiring.oauth.tokens.expires_at="2024-01-03T01:00:00Z";f.state=encodeState(expiring);const pending=store.begin();await pending.writer.write(f.state);const connection=store.save(db,GOOGLE_CALENDAR_CONNECTOR_ID,pending.pending);setSourceGrant(db,{source_key:connection.source_key,expected_revision:0,operation_id:'synthetic-close-grant',policy:{purposes:['capture'],allowed_fields:['text','metadata','subjects','attachments'],retention:'persistent_owned_until_revoked',egress:'local_only',sensitivity_floor:'private'}});db.close();
 let release!:(value:any)=>void,entered!:()=>void,finished=false;const started=new Promise<void>(resolve=>{entered=resolve});
 const io:CliIo={env:{...setup.env,KIZUKI_GOOGLE_CALENDAR_CLIENT_ID:'synthetic'},vaultOverride:setup.vault,stdinIsTTY:true,stdoutIsTTY:true,stderrIsTTY:true,out:()=>{},err:()=>{},prompt:async()=>{throw Error('unused')}};
 const operation=withVault(io,async ctx=>{const c=await loadConnector(selectConnection(ctx.db,ctx.store,GOOGLE_CALENDAR_CONNECTOR_ID,connection.source_key),ctx.store,ctx.db,io.env,(_id,config,deps)=>createGoogleCalendarConnector(config as any,{...deps,now:f.now,fetch:f.fetch,oauth:{listen:async()=>{throw Error('unused')},postForm:async()=>new Promise(resolve=>{release=resolve;entered()})}}));f.advance();try{const result=await runToCompletion(ctx.db,c,GOOGLE_CALENDAR_CONNECTOR_ID,connection.source_key,'backfill');expect(result.errors.length).toBeGreaterThan(0);}finally{await closeHostConnector(c);}return 0;},{retrieval:'none'}).finally(()=>{finished=true});const outcome=operation.catch(error=>error);
 try{await started;await Bun.sleep(5200);expect(finished).toBe(false);release(response);expect(await outcome).toBe(0);const reopened=openLedger(database);try{const saved=new ConnectionStateStore(join(setup.vault,'.kizuki')).read(getConnection(reopened,GOOGLE_CALENDAR_CONNECTOR_ID,connection.source_key)!)!;expect(parseState(saved).oauth.tokens.refresh_token).toBe('synthetic-drained-refresh');}finally{reopened.close();}}finally{release?.(response);await outcome;}
},12000);
test('stuck native custody close refuses boundedly and remains terminal',async()=>{
 const f=new CalendarFixture(),state=parseState(f.state);state.oauth.tokens.expires_at='2020-01-01T00:00:00Z';f.state=encodeState(state);let release!:(value:any)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});
 const c=createGoogleCalendarConnector({client:{id:'synthetic'},calendar_id:f.calendar,fields:FIELDS,secret_ref:'file:synthetic'},{fetch:f.fetch,now:f.now,persist:f.persist,oauth:{listen:async()=>{throw Error('unused')},postForm:async()=>new Promise(resolve=>{release=resolve;entered()})}});const connecting=c.connect(async()=>new TextDecoder().decode(f.state)).catch(()=>{});await started;const at=Date.now();
 try{await expect(closeHostConnector(c)).rejects.toThrow('custody_unknown');expect(Date.now()-at).toBeLessThan(6000);await expect(c.backfill(null)).rejects.toThrow();}finally{release(response);await connecting;await closeHostConnector(c);}
},9000);
