import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';
import {history,recording,ended} from './support/content-recording.mjs';
import {remote,pinned} from './support/remote.mjs';
import {createHash} from 'node:crypto';

test('consumer receives a parsed final JSON value only after a confirmed answer boundary',async()=>{
  const input=recording([history(1,[{id:'answer',role:'assistant',content:[{type:'thinking',thinking:'{"wrong":true}'},{type:'text',text:'{"status":"ok","items":[1,2],"note":"한글"}'}]}]),ended(2)]);
  input.resultRequest={type:'json',requestId:'result-1',baselineMessageIds:[]};
  const client=createClient({mode:'replay'});const events=[];client.subscribe(e=>events.push(e));
  await client.openReplay(input);await client.nextObservation();
  assert.equal(client.snapshot().result.state,'pending');
  await client.replayAll();
  assert.equal(client.snapshot().result.state,'ready');
  assert.deepEqual(client.snapshot().result.value,{status:'ok',items:[1,2],note:'한글'});
  assert.equal(events.filter(e=>e.type==='result.changed').at(-1).payload.requestId,'result-1');
  client.close();
});

test('stopping the process after a confirmed answer preserves that final result',async()=>{
  const stopped={...ended(3),exitCode:-15,manifestStatus:'cancelled',stop:{executionId:'content-run',requestId:'stop-1',state:'confirmed',childrenVerified:true,trackedCount:1,remaining:[],reason:null,observedAt:'2026-10-09T10:00:00Z'}};
  const requested={kind:'execution-action',seq:3,observedAt:'2026-10-09T10:00:00Z',action:'stop',operation:'requested',executionId:'content-run',requestId:'stop-1'};
  const input=recording([history(1,[{id:'answer',role:'assistant',content:[{type:'text',text:'{"ok":true}'}]}]),ended(2),requested,{...stopped,seq:4}]);input.resultRequest={type:'json',requestId:'answer-1',baselineMessageIds:[]};
  const client=createClient({mode:'replay'});await client.openReplay(input);await client.replayAll();
  assert.equal(client.snapshot().execution,'stopped');assert.equal(client.snapshot().result.state,'ready');assert.deepEqual(client.snapshot().result.value,{ok:true});client.close();
});

test('tool progress and baseline answers cannot satisfy the current JSON result request',async()=>{
  for(const [content,baselineMessageIds] of [ [[{type:'text',text:'{"old":true}'}],['answer']], [[{type:'text',text:'{"tool":true}'},{type:'tool_use',id:'tool-1',name:'read_file',input:{}}],[]] ]) {
    const input=recording([history(1,[{id:'answer',role:'assistant',content}]),ended(2)]);
    input.resultRequest={type:'json',requestId:'new-request',baselineMessageIds};
    const client=createClient({mode:'replay'});await client.openReplay(input);await client.replayAll();
    assert.notEqual(client.snapshot().result.state,'ready');assert.equal(client.snapshot().result.value,undefined);client.close();
  }
});

test('JSON primitives and syntax failures retain final raw text without coercion or fence stripping',async()=>{
  for(const [text,state,value] of [['null','ready',null],['[1,true,"한글"]','ready',[1,true,'한글']],['```json\n{}\n```','invalid-json',undefined],['{"partial":','invalid-json',undefined]]) {
    const input=recording([history(1,[{id:'answer',role:'assistant',content:[{type:'text',text}]}]),ended(2)]);
    input.resultRequest={type:'json',requestId:'syntax',baselineMessageIds:[]};
    const client=createClient({mode:'replay'});await client.openReplay(input);await client.replayAll();
    assert.equal(client.snapshot().result.state,state);assert.equal(client.snapshot().result.rawText,text);assert.deepEqual(client.snapshot().result.value,value);client.close();
  }
});

test('start exposes JSON result state to the same live public API used by consumers',async t=>{
  remote(t,[pinned,r=>({executionId:r.executionId,remoteRoot:'/control'})]);
  const client=createClient({mode:'live',connection:{host:'fixture'}});await client.connect();
  await client.start({cwd:'/work',prompt:'Return null',resultFormat:{type:'json',requestId:'live-result'}});
  assert.equal(client.snapshot().result.requestId,'live-result');assert.equal(client.snapshot().result.state,'pending');client.close();
});

test('a result bound to its user prompt cannot consume a later run in the same session',async()=>{
  const input=recording([history(1,[{id:'old-user',role:'user',content:[{type:'text',text:'old request'}]},{id:'old-answer',role:'assistant',content:[{type:'text',text:'{"old":true}'}]},{id:'new-user',role:'user',content:[{type:'text',text:'new request'}]},{id:'new-answer',role:'assistant',content:[{type:'text',text:'{"new":true}'}]}]),ended(2)]);
  input.resultRequest={type:'json',requestId:'old-request',baselineMessageIds:[],promptDigest:createHash('sha256').update('old request').digest('hex')};
  const client=createClient({mode:'replay'});await client.openReplay(input);await client.replayAll();assert.equal(client.snapshot().result.state,'unconfirmed');assert.equal(client.snapshot().result.value,undefined);client.close();
});

test('changed partial history waits for fresh process evidence instead of prior completion',async()=>{
  const input=recording([history(1,[{id:'answer',role:'assistant',content:[{type:'text',text:'{}'}]}]),ended(2),history(3,[{id:'answer',role:'assistant',content:[{type:'text',text:'{"partial":'}]}]),{...ended(4),alive:true,exitCode:null,manifestStatus:'running',supervisorAlive:true}]);input.resultRequest={type:'json',requestId:'changed',baselineMessageIds:[]};
  const client=createClient({mode:'replay'});const events=[];client.subscribe(e=>events.push(e));await client.openReplay(input);await client.replayAll();assert.equal(client.snapshot().result.state,'pending');assert.equal(events.filter(e=>e.type==='result.changed').some(e=>e.payload.state==='invalid-json'),false);client.close();
});
