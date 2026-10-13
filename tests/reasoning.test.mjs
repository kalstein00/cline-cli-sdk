import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,readDiagnostic,compareDiagnostic} from '@cline-cli-sdk/sdk';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
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
