import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,readDiagnostic,compareDiagnostic} from '@cline-cli-sdk/sdk';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {remote,pinned} from './support/remote.mjs';
import {history,recording} from './support/content-recording.mjs';

test('consumer receives ordered exposed think parts separately from compatible message text',async()=>{
  const client=createClient({mode:'replay'});
  const events=[]; client.subscribe(event=>events.push(event));
  await client.openReplay(recording([history(1,[{id:'answer',role:'assistant',content:[
    {type:'thinking',thinking:'VISIBLE_SUMMARY'}, {type:'text',text:'FINAL'},
    {type:'redacted_thinking',data:'DO_NOT_EXPOSE'},
  ]}])]));
  await client.replayAll();
  assert.equal(client.snapshot().messages[0].text,'FINAL');
  assert.deepEqual(client.snapshot().messages[0].content,[{type:'thinking',thinking:'VISIBLE_SUMMARY'},{type:'text',text:'FINAL'},{type:'redacted_thinking'}]);
  assert.deepEqual(events.find(e=>e.type==='message.upsert').payload.content,client.snapshot().messages[0].content);
  client.close();
});

test('consumer collects exposed think and reproduces it from the diagnostic raw observations',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cline-sdk-think-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const raw=history(1,[{id:'think',role:'assistant',content:[{type:'thinking',thinking:'COLLECTED'},{type:'redacted_thinking',data:'opaque'}]}]);
  remote(t,[pinned,r=>({executionId:r.executionId,remoteRoot:'/control'}),r=>({executionId:r.executionId,sessionId:'content-session',cursor:0,history:{dataBase64:raw.dataBase64,sha256:'history'},observations:[]})]);
  const live=createClient({mode:'live',connection:{host:'fixture'}});
  await live.startDiagnostics({directory}); await live.connect();
  await live.start({cwd:'/work',prompt:'hello'}); await live.refresh();
  const status=await live.stopDiagnostics(); live.close();
  const bundle=await readDiagnostic(status.path);
  const replay=createClient({mode:'replay'}); const events=[]; replay.subscribe(e=>events.push(e));
  await replay.openReplay(bundle.recording); await replay.replayAll();
  const comparison=compareDiagnostic(bundle,events,replay.snapshot());
  assert.equal(comparison.matches,true);
  assert.equal(replay.snapshot().messages[0].content[0].thinking,'COLLECTED');
  replay.close();
});

test('think-only messages and think-only updates retain identity through incomplete history',async()=>{
  const message=thinking=>({id:'think',role:'assistant',content:[{type:'thinking',thinking}]});
  const client=createClient({mode:'replay'}); const events=[]; client.subscribe(e=>events.push(e));
  await client.openReplay(recording([history(1,[message('FIRST')]),
    {kind:'history',seq:2,observedAt:'2026-10-09T10:00:00Z',dataBase64:Buffer.from('{').toString('base64')},history(3,[message('UPDATED')]),history(4,[message('UPDATED')])]));
  await client.nextObservation();
  assert.equal(client.snapshot().messages[0]?.content[0].thinking,'FIRST');
  await assert.rejects(client.nextObservation(),{code:'invalid-history'});
  assert.equal(client.snapshot().messages[0].content[0].thinking,'FIRST');
  await client.replayAll();
  assert.equal(client.snapshot().messages.length,1);
  assert.equal(client.snapshot().messages[0].content[0].thinking,'UPDATED');
  assert.equal(events.filter(e=>e.type==='message.upsert').length,2);
  client.close();
});
