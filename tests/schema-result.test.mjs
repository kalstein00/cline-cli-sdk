import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';
import {history,recording,ended} from './support/content-recording.mjs';
import {remote,pinned} from './support/remote.mjs';
import {spawnSync} from 'node:child_process';

const schema={type:'object',properties:{status:{type:'string',enum:['ok']},items:{type:'array',items:{type:'integer'}}},required:['status','items'],additionalProperties:false};
test('only schema-conforming final JSON is a successful SDK result',async()=>{
  for(const [text,state] of [['{"status":"ok","items":[1,2]}','ready'],['{"status":"wrong","items":["1"],"extra":true}','schema-mismatch']]) {
    const input=recording([history(1,[{id:'answer',role:'assistant',content:[{type:'text',text}]}]),ended(2)]);
    input.resultRequest={type:'json',requestId:'schema-1',schema,validation:'sdk',baselineMessageIds:[]};
    const client=createClient({mode:'replay'}); await client.openReplay(input); await client.replayAll();
    assert.equal(client.snapshot().result.state,state); assert.equal(client.snapshot().result.validation,'sdk-schema');
    if(state==='schema-mismatch'){assert.equal(client.snapshot().result.value,undefined);assert.ok(client.snapshot().result.errors.some(e=>e.path==='/items/0' && e.keyword==='type'));}
    client.close();
  }
});

test('SDK passes the requested schema through the CLI prompt while reporting SDK validation',async t=>{
  remote(t,[pinned,r=>{
    assert.ok(r.prompt.includes('"required":["status","items"]'));
    assert.ok(r.prompt.includes('JSON Schema'));
    return {executionId:r.executionId,remoteRoot:'/control'};
  }]);
  const client=createClient({mode:'live',connection:{host:'fixture'}});await client.connect();
  await client.start({cwd:'/work',prompt:'Give a status',resultFormat:{type:'json',requestId:'schema-prompt',schema}});
  assert.equal(client.snapshot().result.validation,'sdk-schema');client.close();
});

test('invalid schemas and native generation demands are rejected before remote task launch',async t=>{
  remote(t,[pinned]);
  const client=createClient({mode:'live',connection:{host:'fixture'}});await client.connect();
  for(const [format,code] of [
    [{schema,validation:'native'},'unsupported-native-schema'],
    [{schema:{$ref:'https://example.test/schema'}},'unsupported-schema'],
    [{schema:{type:'object',unknownKeyword:true}},'invalid-schema'],
    [{schema:{$ref:'#/$defs/missing'}},'invalid-schema'],
    [{schema:{$ref:'#'}},'unsupported-schema'],
    [{schema:{$schema:'http://json-schema.org/draft-07/schema#'}},'unsupported-schema'],
  ]) {
    await assert.rejects(client.start({cwd:'/work',prompt:'hello',resultFormat:{type:'json',requestId:'schema-invalid',...format}}),{code});
    assert.equal(client.snapshot().executionId,null);
  }
  client.close();
});

test('local definitions and nested schema failures report paths without altering input values',async()=>{
  const input=recording([history(1,[{id:'answer',role:'assistant',content:[{type:'text',text:'{"nested":{"enabled":"true"}}'}]}]),ended(2)]);
  input.resultRequest={type:'json',requestId:'nested',baselineMessageIds:[],schema:{type:'object',properties:{nested:{$ref:'#/$defs/detail'}},required:['nested'],$defs:{detail:{type:'object',properties:{enabled:{type:'boolean'}},required:['enabled'],additionalProperties:false}},additionalProperties:false}};
  const client=createClient({mode:'replay'});await client.openReplay(input);await client.replayAll();
  assert.equal(client.snapshot().result.state,'schema-mismatch');assert.equal(client.snapshot().result.errors[0].path,'/nested/enabled');
  assert.equal(client.snapshot().result.rawText,'{"nested":{"enabled":"true"}}');client.close();
});

test('a small repeated-reference schema is rejected within a bounded consumer process',()=>{
  const definitions={s12:{type:'null'}};
  for(let i=11;i>=0;i--) definitions['s'+i]={allOf:Array.from({length:4},()=>({$ref:'#/$defs/s'+(i+1)}))};
  const input=recording([]);input.resultRequest={type:'json',requestId:'bounded',baselineMessageIds:[],schema:{$ref:'#/$defs/s0',$defs:definitions}};
  const script="import {createClient} from '@cline-cli-sdk/sdk';const c=createClient({mode:'replay'});try{await c.openReplay("+JSON.stringify(input)+");console.log('accepted');}catch(e){console.log(e.code);}finally{c.close();}";
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{timeout:3000,encoding:'utf8'});
  assert.equal(result.error,undefined);assert.equal(result.status,0);assert.equal(result.stdout.trim(),'unsupported-schema');
});
