import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createClient} from '@cline-cli-sdk/sdk';
const startup=()=>readFile(new URL('../fixtures/startup/provider-setup.json',import.meta.url)).then(JSON.parse);

test('public API exposes provider onboarding before a conversation exists and clears it on session binding',async()=>{
 const record=await startup();
 record.observations.push({kind:'binding',seq:3,observedAt:record.observations[0].observedAt,sessionId:'configured-session'});
 const c=createClient({mode:'replay'});await c.openReplay(record);
 await c.nextObservation();await c.nextObservation();
 assert.deepEqual(c.snapshot().startup,{state:'provider-setup-required'});
 assert.equal(c.snapshot().sessionId,null);assert.deepEqual(c.snapshot().messages,[]);
 assert.equal(c.snapshot().interaction,null);assert.equal(c.capabilities().responses,false);
 await c.nextObservation();assert.equal(c.snapshot().startup,undefined);c.close();
});

test('provider-like text in an established conversation is not a startup blocker',async()=>{
 const record=await startup();record.observations[0].sessionId='already-bound';
 const c=createClient({mode:'replay'});await c.openReplay(record);await c.replayAll();
 assert.equal(c.snapshot().startup,undefined);c.close();
});
