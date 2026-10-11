import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createClient} from '@cline-cli-sdk/sdk';
import {createHash} from 'node:crypto';

test('public replay exposes actual TUI answer increments before final history and replaces the preview once',async()=>{
 const record=JSON.parse(await readFile(new URL('../fixtures/streaming/actual-tui-answer.json',import.meta.url)));
 const client=createClient({mode:'replay'}),previews=[];
 try {
  await client.openReplay(record);
  for(let i=0;i<record.observations.length;i++) {
   await client.nextObservation();const s=client.snapshot();
   if(s.streaming?.text && !s.messages.some(m=>m.role==='assistant'&&m.text))previews.push({text:s.streaming.text,turn:s.streaming.turnId});
  }
  assert.ok(previews.length>=3,'answer must be visible in multiple increments before persisted assistant history');
  assert.ok(previews[0].text.includes('Rain'));
  assert.ok(previews.some(p=>p.text.length>previews[0].text.length));
  assert.equal(new Set(previews.map(p=>p.turn)).size,1);
  const final=client.snapshot();assert.equal(final.streaming,null);
  assert.equal(final.messages.filter(m=>m.role==='assistant'&&m.text).length,1);
  assert.ok(final.messages.at(-1).text.includes('30.'));
 } finally {client.close();}
});

test('a repeated prompt in a later turn streams independently while prior final history remains intact',{timeout:15000},async()=>{
 const record=JSON.parse(await readFile(new URL('../fixtures/streaming/actual-tui-answer.json',import.meta.url)));
 const final=record.observations.find(o=>o.kind==='history'&&JSON.parse(Buffer.from(o.dataBase64,'base64')).messages.length===2);
 const past=JSON.parse(Buffer.from(final.dataBase64,'base64')).messages;
 const first=record.observations.filter(o=>o.seq<=final.seq+1);
 const second=record.observations.filter(o=>['pty','history','process'].includes(o.kind)&&o.seq<=final.seq+1).map((o,index)=>{
  const copy=structuredClone(o);copy.seq=first.at(-1).seq+index+1;
  if(copy.kind==='history'){
   const doc=JSON.parse(Buffer.from(copy.dataBase64,'base64'));
   doc.messages=[...past,...doc.messages.map(m=>({...m,id:`second-${m.id}`}))];
   const bytes=Buffer.from(JSON.stringify(doc));copy.dataBase64=bytes.toString('base64');copy.sha256=createHash('sha256').update(bytes).digest('hex');
  }
  return copy;
 });
 record.observations=[...first,...second];
 record.provenance.source='fault-injection';record.provenance.transformations.push('Replay the same answer frames as a second identical prompt; preserve preceding history and give final messages distinct IDs.');
 const client=createClient({mode:'replay'}),turns=new Set();
 try {
  await client.openReplay(record);
  for(const _ of record.observations){await client.nextObservation();const s=client.snapshot();if(s.streaming?.text)turns.add(s.streaming.turnId);}
  assert.equal(turns.size,2);assert.equal(client.snapshot().streaming,null);
  assert.equal(client.snapshot().messages.filter(m=>m.role==='assistant'&&m.text).length,2);
 }finally{client.close();}
});

test('requesting stop clears a partial preview without promoting it into final history',async()=>{
 const record=JSON.parse(await readFile(new URL('../fixtures/streaming/actual-tui-answer.json',import.meta.url)));
 record.observations=record.observations.filter(o=>o.seq<=98);
 const client=createClient({mode:'replay'});
 try{
  await client.openReplay(record);await client.replayAll();const s=client.snapshot();assert.ok(s.streaming?.text);
  record.observations.push({kind:'execution-action',seq:99,observedAt:new Date().toISOString(),action:'stop',operation:'requested',executionId:s.executionId,requestId:'stop-preview'});
  await client.openReplay(record);await client.replayAll();assert.equal(client.snapshot().streaming,null);assert.equal(client.snapshot().messages.length,0);
 }finally{client.close();}
});
