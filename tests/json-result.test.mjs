import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';
import {history,recording} from './support/content-recording.mjs';
import {remote,pinned} from './support/remote.mjs';

const ended=seq=>({kind:'process',seq,observedAt:'2026-10-09T10:00:00Z',identity:{pid:42,startTime:'100',bootId:'boot'},alive:false,identityConfirmed:true,exitCode:0,manifestStatus:'completed',children:[],childrenVerified:true,supervisorAlive:false});
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
