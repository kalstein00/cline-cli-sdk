import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createClient} from '@cline-cli-sdk/sdk';

async function recordedIdle(overrides={},extra=[],screen,size={rows:40,cols:120}) {
  // Actual restored composer bytes; synthetic process/phase witnesses isolate readiness guards.
  const recording=JSON.parse(await readFile(new URL('../fixtures/resume/restored-composer.json',import.meta.url)));
  recording.terminal=size;
  for(const o of recording.observations)if(o.kind==='initialize')o.terminal=size;
  if(screen)recording.observations=recording.observations.filter(o=>o.kind!=='pty');
  let seq=recording.observations.at(-1).seq;
  if(screen)recording.observations.push({kind:'pty',seq:++seq,observedAt:'2026-10-11T08:59:59Z',dataBase64:Buffer.from(screen).toString('base64')});
  recording.observations.push({kind:'phase',seq:++seq,observedAt:'2026-10-11T09:00:00Z',supported:true,phase:{active:false},
    terminalEvidence:{cursor:0,modalHash:null,composerHash:'controlled-composer',gap:false,fullScreen:false}},
    {kind:'process',seq:++seq,observedAt:'2026-10-11T09:00:01Z',identity:{pid:42,startTime:'100',bootId:'fixture-boot'},
      alive:true,identityConfirmed:true,supervisorAlive:true,exitCode:null,manifestStatus:'idle',children:[],trackingError:null,...overrides});
  for(const row of extra)recording.observations.push({...row,seq:++seq,observedAt:'2026-10-11T09:00:02Z'});
  const client=createClient({mode:'replay'});await client.openReplay(recording);await client.replayAll();return client;
}

function composerFrame(row,footer=[],text='Ask anything...',cursorX=2,size={rows:40,cols:120}) {
 const lines=Array(size.rows).fill('');
 lines[row-1]='─'.repeat(size.cols);lines[row]='❯ '+text;lines[row+1]='─'.repeat(size.cols);
 footer.forEach((text,i)=>lines[row+2+i]=text);
 return '\x1b[2J\x1b[H'+lines.map((line,i)=>`\x1b[${i+1};1H${line}`).join('')+`\x1b[${row+1};${cursorX+1}H`;
}

for(const size of [{rows:24,cols:80},{rows:50,cols:160},{rows:5,cols:20},{rows:200,cols:500}])
test(`idle composer supports ${size.cols}x${size.rows} with a safe byte budget`,async()=>{
 const c=await recordedIdle({},[],composerFrame(2,[],'Ask anything...',2,size),size);
 try{assert.deepEqual(c.snapshot().messageInput,{ready:true,reason:'ready',maxBytes:Math.min(112,size.cols-8)});}finally{c.close();}
});

test('mismatched size evidence cannot unlock an old composer screen',async()=>{
 const c=await recordedIdle({},[{kind:'phase',supported:true,phase:{active:false},terminalEvidence:{cursor:0,modalHash:null,composerHash:'new-size',gap:false,fullScreen:false,terminal:{rows:24,cols:80}}}],composerFrame(32));
 try{assert.equal(c.snapshot().messageInput.ready,false);}finally{c.close();}
});

for(const geometry of [{rows:24,cols:501,cursorX:2,cursorY:10},{rows:24,cols:80,cursorX:80,cursorY:10},{rows:4,cols:80,cursorX:2,cursorY:2}])
test(`invalid full-screen geometry is rejected: ${JSON.stringify(geometry)}`,async()=>{
 await assert.rejects(recordedIdle({},[{kind:'pty',source:'screen',geometry,dataBase64:Buffer.from(composerFrame(32)).toString('base64')}],composerFrame(32)),{code:'invalid-terminal-geometry'});
});

test('custom CLI footer and composer position do not block an idle followup',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../fixtures/chat/company-composer-layout.json',import.meta.url)));
 for(const row of [fixture.cursorY,1,10,20,35,38]){
  const c=await recordedIdle({},[],composerFrame(row,row===fixture.cursorY?fixture.footer:[]));
  try{assert.deepEqual(c.snapshot().composer,{mode:'tui',text:''},`row ${row}`);assert.equal(c.snapshot().messageInput.ready,true,`row ${row}`);}finally{c.close();}
 }
});

for(const [label,change] of [
 ['missing top rule',frame=>frame+'\x1b[32;1H\x1b[2K\x1b[33;3H'],
 ['missing bottom rule',frame=>frame+'\x1b[34;1H\x1b[2K\x1b[33;3H'],
 ['wrong prompt marker',frame=>frame+'\x1b[33;1H> \x1b[33;3H'],
 ['cursor outside input',frame=>frame+'\x1b[31;3H'],
 ['cursor before input',frame=>frame+'\x1b[33;2H'],
])test(`custom layout rejects ${label}`,async()=>{
 const c=await recordedIdle({},[],change(composerFrame(32)));
 try{assert.equal(c.snapshot().composer,null);assert.equal(c.snapshot().messageInput.reason,'composer-unconfirmed');}finally{c.close();}
});

test('custom layout preserves draft text and blocks pending modal evidence',async()=>{
 const draft=await recordedIdle({},[],composerFrame(32,[],'draft',7));
 try{assert.deepEqual(draft.snapshot().composer,{mode:'tui',text:'draft'});assert.equal(draft.snapshot().messageInput.ready,false);assert.equal(draft.snapshot().messageInput.reason,'composer-unconfirmed');}finally{draft.close();}
 const modal=await recordedIdle({},[{kind:'phase',supported:true,phase:{active:true},terminalEvidence:{cursor:0,modalHash:'modal',composerHash:'composer',gap:false,fullScreen:false}}],composerFrame(32));
 try{assert.equal(modal.snapshot().messageInput.reason,'interaction-pending');}finally{modal.close();}
});

for(const title of ['Cline is asking a question','Cline needs permission','Press Enter to open, any other key to close'])
test(`custom composer cannot bypass visible interaction: ${title}`,async()=>{
 const c=await recordedIdle({},[],composerFrame(32)+`\x1b[10;1H${title}\x1b[33;3H`);
 try{assert.equal(c.snapshot().composer,null);assert.equal(c.snapshot().messageInput.ready,false);}finally{c.close();}
});
test('public snapshot distinguishes a witnessed idle composer from a still-running agent',async()=>{
  const idle=await recordedIdle();
  assert.deepEqual(idle.snapshot().messageInput,{ready:true,reason:'ready',maxBytes:112});
  assert.equal(idle.capabilities().sendMessage,false);idle.close();
  const running=await recordedIdle({manifestStatus:'running'});
  assert.deepEqual(running.snapshot().messageInput,{ready:false,reason:'agent-busy',maxBytes:112});running.close();
});

test('a resumed CLI with verified current composer evidence can be idle despite an unchanged manifest owner',async()=>{
 const c=await recordedIdle({manifestStatus:null,composerIdle:true});
 assert.equal(c.snapshot().messageInput.ready,true);c.close();
 const busy=await recordedIdle({manifestStatus:null,composerIdle:true,children:[{pid:43,startTime:'101',bootId:'fixture-boot'}]});
 assert.equal(busy.snapshot().messageInput.ready,false);busy.close();
});

for(const [label,overrides,extra,reason] of [
 ['tool process',{children:[{pid:43,startTime:'101',bootId:'fixture-boot'}]},[],'agent-busy'],
 ['lost identity',{identityConfirmed:false},[],'process-unconfirmed'],
 ['manifest ownership unavailable',{manifestStatus:null},[],'process-unconfirmed'],
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

test('TUI interpretation uses the observed protocol regardless of CLI version',async()=>{
 for(const profile of ['cline-tui','cline-3.0.69-tui']){
  const recording=JSON.parse(await readFile(new URL('../fixtures/chat/readiness.json',import.meta.url)));
  recording.cli={name:'cline',version:'company-build',profile};
  for(const observation of recording.observations)if(observation.kind==='initialize')observation.cli=recording.cli;
  const c=createClient({mode:'replay'});await c.openReplay(recording);const seen=new Set();
  while(c.snapshot().replay.position<c.snapshot().replay.total){const s=await c.nextObservation();if(s.interaction)seen.add(s.interaction.kind);}
  assert.ok(seen.has('question'));assert.ok(seen.has('approval'));
  assert.equal(c.snapshot().messageInput.ready,true);c.close();
 }
});
