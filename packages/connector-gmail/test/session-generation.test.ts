import { expect, test } from "bun:test";
import { createGmailConnector } from "../src/connector";
import { GmailFixture } from "../src/testing";
import { encodeState, parseState, FIELDS, GMAIL_SCOPES } from "../src/state";

for (const replaceAccount of [false,true]) test(`late refresh cannot overwrite newer ${replaceAccount?'account':'token generation'}`,async()=>{
 const f=new GmailFixture(1), old=parseState(f.state);old.oauth.tokens.expires_at='2020-01-01T00:00:00Z';f.state=encodeState(old);
 let release!:(value:any)=>void, writes=0;
 const connector=createGmailConnector({client:{id:'synthetic'},secret_ref:'file:synthetic',fields:FIELDS},{now:f.now,fetch:f.fetch,persist:async bytes=>{writes++;await f.persist(bytes)},oauth:{listen:async()=>{throw Error('unused')},postForm:async()=>new Promise(resolve=>{release=resolve})}});
 await expect(connector.connect(async()=>new TextDecoder().decode(f.state))).rejects.toThrow();
 const newer=parseState(f.state);if(replaceAccount)newer.oauth.account.id='synthetic-second-account';newer.oauth.tokens.access_token='synthetic-new-access';newer.oauth.tokens.refresh_token='synthetic-new-refresh';newer.oauth.tokens.expires_at='2099-01-01T00:00:00Z';f.state=encodeState(newer);f.account=newer.oauth.account.id;
 await connector.connect(async()=>new TextDecoder().decode(f.state));const durable=f.state.slice();
 release({status:200,body:{access_token:'synthetic-old-late-access',refresh_token:'synthetic-old-late-refresh',expires_in:3600,scope:GMAIL_SCOPES.join(' '),token_type:'Bearer'}});
 await Bun.sleep(20);expect(writes).toBe(0);expect(f.state).toEqual(durable);expect((await connector.backfill(null)).events).toHaveLength(1);
},10000);

test('pending state write is bounded and prevents reconnect until settlement',async()=>{
 const f=new GmailFixture(1);let release!:()=>void, calls=0, resolutions=0;
 const connector=await f.connected(async bytes=>{calls++;await new Promise<void>(resolve=>{release=resolve});await f.persist(bytes)});
 const started=Date.now();const pending=connector.backfill(null);
 const result=await Promise.race([pending,Bun.sleep(6500).then(()=>null)]);
 expect(result).not.toBeNull();expect(Date.now()-started).toBeLessThan(6500);
 expect(result!.status).toBe('unavailable');expect(result!.detail).toContain('timeout');expect(result!.events).toEqual([]);expect(result!.cursor).toBeNull();
 await expect(connector.connect(async()=>{resolutions++;return new TextDecoder().decode(f.state)})).rejects.toThrow();expect(resolutions).toBe(0);
 await expect(connector.backfill(null)).rejects.toThrow();expect(calls).toBe(1);
 release();await Bun.sleep(20);
 await connector.connect(async()=>new TextDecoder().decode(f.state));expect(resolutions).toBe(0);
 // The next persisted witness also waits; settle it to avoid abandoning a fixture promise.
 const retry=connector.backfill(null);await Bun.sleep(20);release();expect((await retry).events).toHaveLength(1);
},12000);


test('an OAuth write already in custody fences reconnect until its late settlement',async()=>{
 const f=new GmailFixture(1), old=parseState(f.state);old.oauth.tokens.expires_at='2020-01-01T00:00:00Z';f.state=encodeState(old);
 let release!:()=>void, entered=0, resolutions=0;
 const connector=createGmailConnector({client:{id:'synthetic'},secret_ref:'file:synthetic',fields:FIELDS},{now:f.now,fetch:f.fetch,persist:async bytes=>{entered++;await new Promise<void>(resolve=>{release=resolve});await f.persist(bytes)},oauth:{listen:async()=>{throw Error('unused')},postForm:async()=>({status:200,body:{access_token:'synthetic-late-write',refresh_token:'synthetic-late-refresh',expires_in:3600,scope:GMAIL_SCOPES.join(' '),token_type:'Bearer'}})}});
 await expect(connector.connect(async()=>new TextDecoder().decode(f.state))).rejects.toMatchObject({code:'timeout'});
 expect(entered).toBe(1);
 await expect(connector.connect(async()=>{resolutions++;return new TextDecoder().decode(f.state)})).rejects.toThrow();expect(resolutions).toBe(0);
 release();await Bun.sleep(20);expect(parseState(f.state).oauth.tokens.access_token).toBe('synthetic-late-write');
 await connector.connect(async()=>{resolutions++;return new TextDecoder().decode(f.state)});expect(resolutions).toBe(1);expect(entered).toBe(1);
},10000);
