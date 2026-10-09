import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createClient } from '@cline-cli-sdk/sdk';

const fixture = () => readFile(new URL('../fixtures/interactions/choice.json', import.meta.url), 'utf8').then(JSON.parse);
const pinned = { platform:'Linux',python:true,pty:true,tmux:'tmux 3.4',cliPath:'/fixture/cline',cliVersion:'3.0.69',cliHash:'8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032',bootId:'boot-1' };
function boundary(t, handler) {
  // Substitute only the external OpenSSH process; SDK parsers and state remain real.
  t.mock.method(childProcess, 'spawn', () => {
    const p = new EventEmitter(); p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin=new PassThrough();p.kill=()=>{};
    let input=''; p.stdin.on('data', data=>input+=data);
    p.stdin.on('finish',()=>{p.stdout.end(JSON.stringify(handler(JSON.parse(input))));queueMicrotask(()=>p.emit('close',0,null));});return p;
  });
}
const rawHistory = dataBase64 => ({dataBase64,sha256:createHash('sha256').update(Buffer.from(dataBase64,'base64')).digest('hex')});

test('partial history retains the last good question and messages, blocks input, and full requery restores its identity', async t => {
  const record=await fixture(); const initial=record.observations.filter(o=>o.seq<=18);
  const baseline=JSON.parse(Buffer.from(initial.filter(o=>o.kind==='history').at(-1).dataBase64,'base64').toString());
  baseline.messages.push({id:'retained-message',role:'assistant',content:[{type:'text',text:'Keep this last good message'}]});
  const good=Buffer.from(JSON.stringify(baseline)).toString('base64');
  let fault=false,writes=0;
  boundary(t, request=>{
    if(!request.action)return pinned;
    if(request.action==='start')return {executionId:request.executionId,remoteRoot:'/fixture/control'};
    if(request.action==='status')return {executionId:request.executionId,sessionId:record.sessionId,cursor:18,
      observations:initial.filter(o=>o.kind==='pty'&&o.seq>request.cursor),
      history:rawHistory(fault?Buffer.from('{"version":1,"messages":[').toString('base64'):good),
      process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot-1'},alive:true,identityConfirmed:true,exitCode:null,manifestStatus:'pending'}};
    if(request.action==='respond'){writes++;return {state:'queued'};}
    throw Error('unexpected action '+request.action);
  });
  const client=createClient({mode:'live',connection:{host:'fixture'}});t.after(()=>client.close());
  await client.connect();await client.start({cwd:'/fixture/work',prompt:'fixture only'});await client.refresh();
  const before=client.snapshot();assert.equal(before.interaction.kind,'question');
  fault=true;const broken=await client.refresh();
  assert.deepEqual(broken.messages,before.messages);assert.equal(broken.interaction.id,before.interaction.id);assert.equal(broken.interaction.prompt,before.interaction.prompt);
  assert.equal(broken.historySync.current,false);assert.match(broken.historySync.warning,/history/i);
  await assert.rejects(client.respond({sessionId:broken.sessionId,executionId:broken.executionId,interactionId:broken.interaction.id,revision:broken.revision,requestId:'blocked-stale',answer:'BLUE'}),{code:'history-unconfirmed'});
  assert.equal(writes,0);
  fault=false;const repaired=await client.refresh();assert.equal(repaired.historySync.current,true);assert.equal(repaired.historySync.warning,null);assert.equal(repaired.interaction.id,before.interaction.id);
  const revision=repaired.revision;assert.equal((await client.refresh()).revision,revision);
});

test('read failures and replaced files preserve visible content despite a completion hint; a notification-free full read updates once', async t => {
  const record=await fixture();const initial=record.observations.filter(o=>o.seq<=18);
  const data=JSON.parse(Buffer.from(initial.filter(o=>o.kind==='history').at(-1).dataBase64,'base64').toString());
  data.messages.push({id:'updated-message',role:'assistant',content:[{type:'text',text:'Last good message'}]});
  let reason=null,updated=false;
  boundary(t, request=>{
    if(!request.action)return pinned;
    if(request.action==='start')return {executionId:request.executionId,remoteRoot:'/fixture/control'};
    if(request.action==='status') {
      const next=structuredClone(data);
      if(updated)next.messages.at(-1).content[0].text='Full read after missed notification';
      return {executionId:request.executionId,sessionId:record.sessionId,cursor:18,
        observations:initial.filter(o=>o.kind==='pty'&&o.seq>request.cursor),
        history:reason?null:rawHistory(Buffer.from(JSON.stringify(next)).toString('base64')),historyError:reason,
        process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot-1'},alive:!reason,identityConfirmed:true,exitCode:reason?0:null,manifestStatus:reason?'completed':'pending'}};
    }
    throw Error('unexpected input action');
  });
  const client=createClient({mode:'live',connection:{host:'fixture'}});t.after(()=>client.close());
  await client.connect();await client.start({cwd:'/fixture/work',prompt:'fixture only'});await client.refresh();const before=client.snapshot();
  for(const fault of ['PermissionError','file-changed','missing']) {
    reason=fault;const stale=await client.refresh();assert.deepEqual(stale.messages,before.messages);assert.equal(stale.interaction.id,before.interaction.id);
    assert.equal(stale.historySync.current,false);assert.equal(stale.execution,'unknown');
    assert.match(stale.historySync.warning,/history/i);
  }
  reason=null;updated=true;const events=[];client.subscribe(event=>events.push(event));
  const repaired=await client.refresh();assert.equal(repaired.historySync.current,true);assert.equal(repaired.messages.at(-1).text,'Full read after missed notification');
  assert.equal(repaired.messages.at(-1).id,before.messages.at(-1).id);assert.equal(repaired.messages.length,before.messages.length);
  assert.equal(repaired.interaction.id,before.interaction.id);const revision=repaired.revision;
  await client.refresh();assert.equal(client.snapshot().revision,revision);
  assert.equal(events.filter(e=>e.type==='message.upsert'&&e.payload.id==='updated-message').length,1);
});

test('reviewed raw history failure replay repairs one message without duplicates and distinguishes a new tool question', async () => {
  const record=JSON.parse(await readFile(new URL('../fixtures/history-sync/recovery.json',import.meta.url),'utf8'));
  const client=createClient({mode:'replay'});await client.openReplay(record);
  while(client.snapshot().replay.position<record.observations.findIndex(o=>o.seq===19))await client.nextObservation();
  const original=client.snapshot();assert.equal(original.messages.at(-1).text,'Last good conversation retained');
  await client.nextObservation();assert.equal(client.snapshot().historySync.current,false);assert.equal(client.snapshot().interaction.id,original.interaction.id);
  await client.nextObservation();assert.equal(client.snapshot().historySync.current,true);assert.equal(client.snapshot().messages.at(-1).id,original.messages.at(-1).id);assert.equal(client.snapshot().messages.at(-1).text,'Full requery updated the same message');
  const repaired=client.snapshot();await client.nextObservation();assert.equal(client.snapshot().revision,repaired.revision);
  await client.replayAll();const next=client.snapshot();assert.equal(next.interaction.prompt,'Choose new color.');assert.deepEqual(next.interaction.choices,['GREEN','ORANGE']);assert.notEqual(next.interaction.id,original.interaction.id);assert.equal(next.messages.filter(m=>m.id==='sync-visible-message').length,1);client.close();
});
