import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';
import {history,recording} from './support/content-recording.mjs';
import {remote,pinned} from './support/remote.mjs';

test('JSON packets split across UTF-8 bytes reconcile with one canonical history message',async()=>{
  const bytes=Buffer.from(JSON.stringify({type:'agent_event',event:{type:'content_start',contentType:'reasoning',reasoning:'노출 think'}})+'\n'+JSON.stringify({type:'run_result',finishReason:'completed',text:'FINAL'})+'\n');
  const observations=[...bytes].map((byte,index)=>({kind:'json-output',channel:'stdout',seq:index+1,observedAt:'2026-10-09T10:00:00Z',dataBase64:Buffer.from([byte]).toString('base64')}));
  observations.push(history(bytes.length+1,[{id:'answer',role:'assistant',content:[{type:'thinking',thinking:'노출 think'},{type:'text',text:'FINAL'}]}]));
  const input=recording(observations); input.cli.profile='cline-3.0.69-json';
  const client=createClient({mode:'replay'}); await client.openReplay(input); await client.replayAll();
  assert.equal(client.snapshot().messages.length,1);
  assert.equal(client.snapshot().jsonOutput.finalText,'FINAL');
  assert.equal(client.snapshot().jsonOutput.lastContent.thinking,'노출 think');
  assert.equal(client.snapshot().execution,'unknown');
  client.close();
});

test('malformed or truncated JSON records cannot become a successful execution from exit zero',async()=>{
  const process={kind:'process',seq:3,observedAt:'2026-10-09T10:00:00Z',identity:{pid:42,startTime:'100',bootId:'boot'},alive:false,identityConfirmed:true,exitCode:0,manifestStatus:'completed',children:[],childrenVerified:true,supervisorAlive:false};
  for(const stream of ['{broken}\n{"type":"run_result","finishReason":"completed","text":"FINAL"}\n','{"type":"run_result","finishReason":"completed","text":"FINAL"}\n{"type":']) {
    const input=recording([history(1,[{id:'answer',role:'assistant',content:[{type:'text',text:'FINAL'}]}]),{kind:'json-output',channel:'stdout',seq:2,observedAt:process.observedAt,dataBase64:Buffer.from(stream).toString('base64')},process]);
    input.cli.profile='cline-3.0.69-json'; const client=createClient({mode:'replay'});
    await client.openReplay(input); await client.replayAll();
    assert.equal(client.snapshot().jsonOutput.state,'incomplete');
    assert.equal(client.snapshot().execution,'unknown'); client.close();
  }
});

test('consumer starts a JSON managed execution and cannot submit unverified JSON input or resume',async t=>{
  const content=history(1,[{id:'answer',role:'assistant',content:[{type:'text',text:'FINAL'}]}]);
  remote(t,[pinned,r=>({executionId:r.executionId,remoteRoot:'/control',outputMode:'json'}),r=>({executionId:r.executionId,sessionId:'content-session',cursor:1,
    observations:[{kind:'json-output',channel:'stdout',seq:1,observedAt:'2026-10-09T10:00:00Z',dataBase64:Buffer.from('{"type":"run_result","finishReason":"completed","text":"FINAL"}\n').toString('base64')}],
    history:{dataBase64:content.dataBase64,sha256:'history'}})]);
  const client=createClient({mode:'live',connection:{host:'fixture'}}); await client.connect();
  assert.equal(client.capabilities().outputModes.json,true);
  await client.start({cwd:'/work',prompt:'hello',outputMode:'json'}); await client.refresh();
  assert.equal(client.snapshot().messages[0].text,'FINAL');
  assert.equal(client.snapshot().jsonOutput.finalText,'FINAL');
  assert.equal(client.capabilities().responses,false);
  assert.equal(client.capabilities().resume,false);
  await assert.rejects(client.respond({}),{code:'unsupported-json-input'});
  await assert.rejects(client.resume({executionId:client.snapshot().executionId,requestId:'json-resume',prompt:'again'}),{code:'unsupported-json-resume'});
  client.close();
});

test('a terminal agent error cannot be overwritten by a later success record',async()=>{
  const stream=JSON.stringify({type:'agent_event',event:{type:'error',recoverable:false}})+'\n'+JSON.stringify({type:'run_result',finishReason:'completed',text:'FINAL'})+'\n';
  const input=recording([{kind:'json-output',channel:'stdout',seq:1,observedAt:'2026-10-09T10:00:00Z',dataBase64:Buffer.from(stream).toString('base64')}]);input.cli.profile='cline-3.0.69-json';
  const client=createClient({mode:'replay'});await client.openReplay(input);await client.replayAll();assert.equal(client.snapshot().jsonOutput.state,'failed');client.close();
});
