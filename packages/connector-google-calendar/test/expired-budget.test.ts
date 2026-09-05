import {expect,test} from 'bun:test';
import {spawnSync} from 'node:child_process';
test('expired budget between provider pages does not queue token work or reject unhandled',()=>{
 const modulePath=new URL('../src/connector.ts',import.meta.url).pathname,fixturePath=new URL('../src/testing.ts',import.meta.url).pathname,statePath=new URL('../src/state.ts',import.meta.url).pathname;
 const script=`import {createGoogleCalendarConnector} from ${JSON.stringify(modulePath)};
 import {CalendarFixture} from ${JSON.stringify(fixturePath)};import{FIELDS}from ${JSON.stringify(statePath)};
 const f=new CalendarFixture(),realNow=Date.now;let shift=0,unhandled=0,providerCalls=0;
 process.on('unhandledRejection',()=>{unhandled++});
 const c=createGoogleCalendarConnector({client:{id:'synthetic'},secret_ref:'file:synthetic',calendar_id:f.calendar,fields:FIELDS},{now:f.now,persist:f.persist,fetch:async req=>{if(new URL(req.url).hostname==='openidconnect.googleapis.com')return f.fetch(req);providerCalls++;shift=46000;return Response.json({items:[],nextPageToken:'synthetic-next'});}});
 await c.connect(async()=>new TextDecoder().decode(f.state));const before=f.state.slice();Date.now=()=>realNow()+shift;
 try{const batch=await c.backfill(null);await Bun.sleep(20);console.log(JSON.stringify({status:batch.status,events:batch.events.length,cursor:batch.cursor,providerCalls,unhandled,unchanged:Buffer.from(before).equals(Buffer.from(f.state))}));}finally{Date.now=realNow;await c.revoke();}`;
 const result=spawnSync(process.execPath,['--eval',script],{encoding:'utf8',timeout:5000});expect(result.status).toBe(0);expect(result.stderr).toBe('');expect(JSON.parse(result.stdout)).toEqual({status:'unavailable',events:0,cursor:null,providerCalls:1,unhandled:0,unchanged:true});
});
