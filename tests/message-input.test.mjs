import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createClient} from '@cline-cli-sdk/sdk';

async function recordedIdle(overrides={},extra=[]) {
  // Actual restored composer bytes; synthetic process/phase witnesses isolate readiness guards.
  const recording=JSON.parse(await readFile(new URL('../fixtures/resume/restored-composer.json',import.meta.url)));
  let seq=recording.observations.at(-1).seq;
  recording.observations.push({kind:'phase',seq:++seq,observedAt:'2026-10-11T09:00:00Z',supported:true,phase:{active:false},
    terminalEvidence:{cursor:0,modalHash:null,composerHash:'controlled-composer',gap:false,fullScreen:false}},
    {kind:'process',seq:++seq,observedAt:'2026-10-11T09:00:01Z',identity:{pid:42,startTime:'100',bootId:'fixture-boot'},
      alive:true,identityConfirmed:true,supervisorAlive:true,exitCode:null,manifestStatus:'idle',children:[],trackingError:null,...overrides});
  for(const row of extra)recording.observations.push({...row,seq:++seq,observedAt:'2026-10-11T09:00:02Z'});
  const client=createClient({mode:'replay'});await client.openReplay(recording);await client.replayAll();return client;
}
test('public snapshot distinguishes a witnessed idle composer from a still-running agent',async()=>{
  const idle=await recordedIdle();
  assert.deepEqual(idle.snapshot().messageInput,{ready:true,reason:'ready',maxBytes:112});
  assert.equal(idle.capabilities().sendMessage,false);idle.close();
  const running=await recordedIdle({manifestStatus:'running'});
  assert.deepEqual(running.snapshot().messageInput,{ready:false,reason:'agent-busy',maxBytes:112});running.close();
});

for(const [label,overrides,extra,reason] of [
 ['tool process',{children:[{pid:43,startTime:'101',bootId:'fixture-boot'}]},[],'agent-busy'],
 ['lost identity',{identityConfirmed:false},[],'process-unconfirmed'],
 ['supervisor missing',{supervisorAlive:false},[],'process-unconfirmed'],
 ['stale history',{},[{kind:'history-failure',reason:'controlled-file-change'}],'history-unavailable'],
 ['disconnect',{},[{kind:'connection',action:'disconnected'}],'not-connected'],
 ['modal',{},[{kind:'phase',supported:true,phase:{active:true},terminalEvidence:{cursor:0,modalHash:'modal',composerHash:null,gap:false,fullScreen:false}}],'interaction-pending'],
 ['terminal gap',{},[{kind:'gap',cursor:10}],'interaction-pending'],
 ['non-TUI profile',{},[{kind:'phase',supported:false,phase:{active:false},terminalEvidence:{cursor:0,modalHash:null,composerHash:'composer',gap:false,fullScreen:false}}],'unsupported-profile'],
]) test(`public readiness blocks ${label}`,async()=>{const c=await recordedIdle(overrides,extra);assert.equal(c.snapshot().messageInput.ready,false);assert.equal(c.snapshot().messageInput.reason,reason);c.close();});

test('actual first-run generation, approval, tool, question and idle observations replay through the public API',async()=>{
 const recording=JSON.parse(await readFile(new URL('../fixtures/chat/readiness.json',import.meta.url)));
 const c=createClient({mode:'replay'});await c.openReplay(recording);const seen=new Set();
 while(c.snapshot().replay.position<c.snapshot().replay.total){const s=await c.nextObservation();if(s.messageInput)seen.add(s.messageInput.reason);if(s.interaction)seen.add(s.interaction.kind);}
 for(const label of ['agent-busy','interaction-pending','approval','question','ready'])assert.ok(seen.has(label),label);
 assert.equal(c.snapshot().messageInput.ready,true);assert.equal(c.snapshot().execution,'running');assert.equal(c.capabilities().sendMessage,false);c.close();
});
