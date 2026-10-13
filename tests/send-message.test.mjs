import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@cline-cli-sdk/sdk';
import {remote,pinned} from './support/remote.mjs';

test('public sendMessage rejects unsupported text before any remote write and replay remains read-only',async t=>{
 remote(t,[pinned]);const c=createClient({mode:'live',connection:{host:'fixture'}});await c.connect();
 for(const text of [' 한글','a\nb','가'.repeat(38),'/help','hello @file'])await assert.rejects(c.sendMessage({sessionId:'s',executionId:'e',revision:0,requestId:'invalid',text}),{code:'invalid-message'});
 c.close();const r=createClient({mode:'replay'});await assert.rejects(r.sendMessage({}),{code:'replay-read-only'});r.close();
});

import cp from 'node:child_process';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {readDiagnostic,compareDiagnostic} from '@cline-cli-sdk/sdk';

async function controlledComposer(t,{lostEcho=false,lostSubmit=false,rejectStep,rejectReservation=false,immediateRejection=false,directory,text='2 한글 😀 café',cursorEcho=false,layout,terminal={rows:40,cols:120}}={}) {
 let eid, seq=0, composer='',submitted=0, writes=[], pending, busy=false, witness, missingLedger=false, brokenHistory=false;
 let size=terminal,missingScreen=false;const calls=[];
 const history=[{id:'old-identical',role:'user',content:[{type:'text',text}]}];
 t.mock.method(cp,'spawn',()=>{const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin=new PassThrough();p.kill=()=>{};let data='';p.stdin.on('data',d=>data+=d);p.stdin.on('finish',()=>{try{const r=JSON.parse(data);let value;
 calls.push(r);
 if(!r.action)value=pinned;
 else if(r.action==='start'){eid=r.executionId;value={executionId:eid,remoteRoot:'/fixture/control',terminalMode:'tui',terminal:r.terminal};}
 else if(r.action==='list')value={executions:[{executionId:eid,remoteRoot:'/fixture/control',sessionId:'composer-session',terminalMode:'tui',terminal:size,cliHash:pinned.cliHash}]};
 else if(r.action==='reserve-message'){if(rejectReservation)value={state:'rejected',fresh:false,notSubmitted:true,reason:'agent-not-idle'};else{pending={...r,baselineMessageCount:history.length,baselineLastMessageId:history.at(-1)?.id};value={state:'reserved',fresh:true};}}
 else if(r.action==='respond'){writes.push(r);const inputText=Buffer.from(r.dataBase64,'base64').toString();if(r.stepIndex!==rejectStep){if(r.inputType==='composer-text'&&!lostEcho)composer+=inputText;if(r.inputType==='composer-submit'){submitted++;composer='';if(!lostSubmit)history.push({id:'new-'+submitted,role:'user',content:[{type:'text',text}]},{id:'reply-'+submitted,role:'assistant',content:[{type:'text',text:'Controlled reply'}]});}}value={state:immediateRejection&&r.stepIndex===rejectStep?'rejected':'queued'};}
 else if(r.action==='settle-message'){value={state:rejectStep===0?'not-submitted':history.some(m=>m.id==='new-'+submitted)?'delivered':'delivery-unknown',executionId:eid,sessionId:'composer-session',messageId:'new-'+submitted,promptDigest:pending.answerDigest};if(['delivered','not-submitted'].includes(value.state))witness=value;}
 else if(r.action==='status'){
  const raw=Buffer.from(brokenHistory?'{':JSON.stringify({version:1,sessionId:'composer-session',messages:history}));
  const row=layout?.cursorY??size.rows-5,footer=layout?.footer??['● Act (Tab)','','Auto-approve all disabled (Shift+Tab)'];
  const frame=`\x1b[2J\x1b[H\x1b[${row};1H`+'─'.repeat(size.cols)+`\x1b[${row+1};1H❯ `+(composer||'Ask anything...')+`\x1b[${row+2};1H`+'─'.repeat(size.cols)+footer.map((line,i)=>`\x1b[${row+3+i};1H${line}`).join('')+`\x1b[${row+1};${cursorEcho?3+composer.length:3}H`;
  value={executionId:eid,sessionId:'composer-session',cursor:++seq,observations:[{kind:'pty',seq,observedAt:new Date().toISOString(),dataBase64:Buffer.from(frame).toString('base64')}],composerHash:'composer-hash',history:{dataBase64:raw.toString('base64'),sha256:createHash('sha256').update(raw).digest('hex')},
   ...(!missingScreen && (r.terminal?.rows!==size.rows || r.terminal?.cols!==size.cols)?{screen:{dataBase64:Buffer.from(frame).toString('base64'),...size,cursorX:cursorEcho?2+composer.length:2,cursorY:row}}:{}),
   process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot-1'},alive:true,identityConfirmed:true,supervisorAlive:true,exitCode:null,manifestStatus:busy?'running':'idle',children:[],trackingError:null},management:{terminal:size,phaseSupported:true,phase:{active:false},responseReservation:true,inputLedgerCurrent:!missingLedger},
   requests:pending&&!missingLedger?[{requestId:pending.requestId,state:rejectStep===0&&writes.length?'rejected':'written',binding:pending,message:true,baselineMessageCount:pending.baselineMessageCount,baselineLastMessageId:pending.baselineLastMessageId,witness,resolution:witness?.state,steps:writes.filter(w=>w.requestId===pending.requestId).map(w=>({index:w.stepIndex,state:w.stepIndex===rejectStep?'rejected':'written'}))}]:[]};
 }else throw Error('unexpected '+r.action);
 p.stdout.end(JSON.stringify(value));queueMicrotask(()=>p.emit('close',0));}catch(error){queueMicrotask(()=>p.emit('error',error));}});return p;});
 const c=createClient({mode:'live',connection:{host:'fixture',responseTimeoutMs:250}});if(directory)await c.startDiagnostics({directory});await c.connect();await c.start({cwd:'/fixture',terminalMode:'tui',terminal,prompt:'first'});await c.refresh();
 return {c,writes,calls,resize:(value,missing=false)=>{size=value;missingScreen=missing;},setBusy:v=>busy=v,setHistoryFault:v=>brokenHistory=v,setLedgerMissing:v=>missingLedger=v,recover:()=>history.push({id:'new-'+submitted,role:'user',content:[{type:'text',text}]},{id:'reply-'+submitted,role:'assistant',content:[{type:'text',text:'Recovered reply'}]}),request:(requestId='message-1')=>({sessionId:c.snapshot().sessionId,executionId:c.snapshot().executionId,revision:c.snapshot().revision,requestId,text})};
}

for(const immediateRejection of [false,true])test(`a conclusive first-step rejection (immediate=${immediateRejection}) is unsubmitted and a fresh client recovers without repeating input`,async t=>{
 const control=await controlledComposer(t,{rejectStep:0,immediateRejection});t.after(()=>control.c.close());const req=control.request();
 await assert.rejects(control.c.sendMessage(req),{notSubmitted:true});
 assert.equal(control.c.snapshot().messageDelivery.state,'not-submitted');assert.equal(control.c.capabilities().sendMessage,true);
 assert.equal(control.writes.length,1);control.c.close();
 const c=createClient({mode:'live',connection:{host:'fixture'}});t.after(()=>c.close());await c.connect();await c.attach(req.executionId);
 assert.equal(c.snapshot().messageDelivery.state,'not-submitted');assert.equal(c.capabilities().sendMessage,true);assert.equal(control.writes.length,1);
});

test('a failed reservation is unsubmitted with no composer input',async t=>{
 const control=await controlledComposer(t,{rejectReservation:true});t.after(()=>control.c.close());
 await assert.rejects(control.c.sendMessage(control.request()),{notSubmitted:true});
 assert.equal(control.c.snapshot().messageDelivery.state,'not-submitted');assert.equal(control.writes.length,0);assert.equal(control.c.capabilities().sendMessage,true);
});

test('a rejected Enter after written text remains uncertain and cannot be bypassed',async t=>{
 const control=await controlledComposer(t,{rejectStep:1});t.after(()=>control.c.close());
 await assert.rejects(control.c.sendMessage(control.request()),e=>e.notSubmitted!==true);
 assert.equal(control.c.snapshot().messageDelivery.state,'delivery-unknown');assert.equal(control.c.capabilities().sendMessage,false);
 await assert.rejects(control.c.sendMessage(control.request('bypass')),{code:'message-pending'});
});

test('same-run message echo precedes Enter, new history confirms delivery once, and another identical request uses a new boundary',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'cline-send-diag-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const {c,writes,request,setBusy}=await controlledComposer(t,{directory});t.after(()=>c.close());
 const req=request();const first=c.sendMessage(req);await assert.rejects(c.sendMessage({...req,requestId:"concurrent"}),{code:"message-pending"});const [a,b]=await Promise.all([first,c.sendMessage(req)]);assert.equal(a.state,'delivered');assert.equal(a.messageId,'new-1');assert.deepEqual(a,b);
 assert.deepEqual(writes.map(w=>Buffer.from(w.dataBase64,'base64').toString()),['2 한글 😀 café','\r']);
 await assert.rejects(c.sendMessage({...req,text:'different'}),{code:'request-conflict'});
 await assert.rejects(c.sendMessage({...request('other-run'),executionId:'run-other'}),{code:'message-target-mismatch'});
 await assert.rejects(c.sendMessage({...request('stale'),revision:0}),{code:'message-target-mismatch'});
 const second=await c.sendMessage(request('message-2'));assert.equal(second.messageId,'new-2');assert.equal(second.executionId,req.executionId);assert.equal(writes.length,4);
 setBusy(true);await c.refresh();await assert.rejects(c.sendMessage(request('busy')),{code:'message-not-ready'});assert.equal(writes.length,4);
 const saved=await c.stopDiagnostics(),bundle=await readDiagnostic(saved.path);const replay=createClient({mode:'replay'}),events=[];replay.subscribe(e=>events.push(e));await replay.openReplay(bundle.recording);await replay.replayAll();assert.equal(replay.snapshot().messageDelivery.state,'delivered');assert.deepEqual(compareDiagnostic(bundle,events,replay.snapshot()),{matches:true,eventDifferences:0,snapshotMatches:true});replay.close();
});

for(const fault of ['lostEcho','lostSubmit'])test(`uncertain ${fault} blocks another request and never treats old identical history as delivery`,async t=>{
 const {c,writes,request}=await controlledComposer(t,{[fault]:true});t.after(()=>c.close());const req=request();
 await assert.rejects(c.sendMessage(req),{code:'message-input-uncertain'});assert.equal(c.snapshot().messageDelivery.state,'delivery-unknown');
 await assert.rejects(c.sendMessage(req),{code:'message-input-uncertain'});await assert.rejects(c.sendMessage(request('bypass')),{code:'message-pending'});
 assert.equal(writes.filter(w=>w.inputType==='composer-submit').length,fault==='lostEcho'?0:1);
});

test('actual same-run followup observations replay delivery and preserve repeated requests as distinct user messages',async()=>{
 const r=JSON.parse(await readFile(new URL('../fixtures/chat/followup.json',import.meta.url))),c=createClient({mode:'replay'});await c.openReplay(r);const delivered=[];
 c.subscribe(e=>{const d=e.payload?.messageDelivery;if(d?.state==='delivered')delivered.push(d);});await c.replayAll();
 assert.equal(delivered.length,4);assert.equal(new Set(delivered.map(d=>d.messageId)).size,4);assert.equal(new Set(delivered.map(d=>d.executionId)).size,1);
 assert.equal(c.snapshot().messages.filter(m=>m.role==='user'&&m.text==='Reply exactly API_SAME. No tools.').length,2);
 assert.ok(c.snapshot().messages.some(m=>m.text==='2 한글 😀 café: Reply exactly API_ONE. No tools.'));assert.equal(c.snapshot().execution,'running');c.close();
});

test('a fresh client restores uncertain composer delivery and reconfirms from its original history boundary without input',async t=>{
 const control=await controlledComposer(t,{lostSubmit:true});const req=control.request();await assert.rejects(control.c.sendMessage(req),{code:'message-input-uncertain'});control.c.close();
 const directory=await mkdtemp(join(tmpdir(),'cline-reconfirm-diag-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const c=createClient({mode:'live',connection:{host:'fixture'}});t.after(()=>c.close());await c.startDiagnostics({directory});await c.connect();await c.attach(req.executionId);
 assert.equal(c.snapshot().messageDelivery?.state,'delivery-unknown');assert.equal(c.snapshot().messageDelivery.requestId,req.requestId);assert.equal(c.capabilities().sendMessage,false);
 const writes=control.writes.length;await assert.rejects(c.sendMessage({...req,revision:c.snapshot().revision,requestId:'bypass'}));control.setLedgerMissing(true);await c.reconfirmDelivery();assert.equal(c.snapshot().messageDelivery.state,'delivery-unknown');
 control.setLedgerMissing(false);control.setHistoryFault(true);const preserved=c.snapshot().messages;await c.reconfirmDelivery();assert.equal(c.snapshot().historySync.current,false);assert.deepEqual(c.snapshot().messages,preserved);
 control.setHistoryFault(false);control.recover();await c.reconfirmDelivery();assert.equal(c.snapshot().messageDelivery.state,'delivered');assert.equal(c.snapshot().messageDelivery.messageId,'new-1');assert.equal(control.writes.length,writes);assert.equal(c.capabilities().sendMessage,true);
 assert.equal((await c.sendMessage(req)).messageId,'new-1');assert.equal(control.writes.length,writes);
 const saved=await c.stopDiagnostics(),bundle=await readDiagnostic(saved.path),r=createClient({mode:'replay'}),events=[];r.subscribe(e=>events.push(e));await r.openReplay(bundle.recording);await r.replayAll();assert.deepEqual(compareDiagnostic(bundle,events,r.snapshot()),{matches:true,eventDifferences:0,snapshotMatches:true});r.close();
});

test('the original client returns reconfirmed delivery for its identical previously uncertain request',async t=>{
 const control=await controlledComposer(t,{lostSubmit:true});t.after(()=>control.c.close());const req=control.request();await assert.rejects(control.c.sendMessage(req),{code:'message-input-uncertain'});control.recover();await control.c.reconfirmDelivery();assert.equal(control.c.snapshot().messageDelivery.state,'delivered');const count=control.writes.length;assert.equal((await control.c.sendMessage(req)).messageId,'new-1');assert.equal(control.writes.length,count);
 await assert.rejects(control.c.sendMessage({...req,text:'different'}),{code:'request-conflict'});
});

test('a first fresh attach with a missing ledger blocks composer and question input without claiming an empty delivery history',async t=>{
 const control=await controlledComposer(t,{lostSubmit:true});const req=control.request();await assert.rejects(control.c.sendMessage(req));control.c.close();control.setLedgerMissing(true);
 const c=createClient({mode:'live',connection:{host:'fixture'}});t.after(()=>c.close());await c.connect();await c.attach(req.executionId);assert.deepEqual(c.snapshot().inputControl,{current:false,reason:'ledger-unavailable'});assert.equal(c.capabilities().sendMessage,false);assert.equal(c.capabilities().responses,false);assert.equal(c.snapshot().messageInput.reason,'delivery-pending');const writes=control.writes.length;
 await assert.rejects(c.sendMessage({...req,requestId:'missing-ledger-bypass',revision:c.snapshot().revision}));await c.reconfirmDelivery();assert.equal(c.snapshot().inputControl.current,false);assert.equal(control.writes.length,writes);
 await assert.rejects(c.resume({executionId:req.executionId,requestId:'resume-missing-ledger',prompt:'bypass'}),{code:'input-control-unavailable'});assert.equal(control.writes.length,writes);
});


test('a followup chunk ending in a space confirms its exact cursor-bounded echo and submits once',async t=>{
 const control=await controlledComposer(t,{text:'x'.repeat(63)+' '+'z',cursorEcho:true});t.after(()=>control.c.close());
 const result=await control.c.sendMessage(control.request());assert.equal(result.state,'delivered');
 assert.deepEqual(control.writes.map(w=>Buffer.from(w.dataBase64,'base64').toString()),['x'.repeat(63)+' ','z','\r']);
});

test('custom CLI layout permits consecutive followups with exact chunk echo before Enter',async t=>{
 const layout=JSON.parse(await readFile(new URL('../fixtures/chat/company-composer-layout.json',import.meta.url)));
 const control=await controlledComposer(t,{layout,text:'x'.repeat(63)+' '+'z',cursorEcho:true});t.after(()=>control.c.close());
 for(const id of ['custom-1','custom-2']){
  assert.equal(control.c.snapshot().messageInput.ready,true);
  assert.equal((await control.c.sendMessage(control.request(id))).state,'delivered');
 }
 assert.deepEqual(control.writes.map(w=>Buffer.from(w.dataBase64,'base64').toString()),['x'.repeat(63)+' ','z','\r','x'.repeat(63)+' ','z','\r']);
});

for(const terminal of [{rows:24,cols:80},{rows:50,cols:160}])test(`start and sendMessage use ${terminal.cols}x${terminal.rows}`,async t=>{
 const control=await controlledComposer(t,{terminal,text:'x'.repeat(Math.min(112,terminal.cols-8)),cursorEcho:true});t.after(()=>control.c.close());
 assert.deepEqual(control.calls.find(r=>r.action==='start').terminal,terminal);
 assert.equal(control.c.snapshot().messageInput.maxBytes,Math.min(112,terminal.cols-8));
 assert.equal((await control.c.sendMessage(control.request())).state,'delivered');
});

test('narrow terminal rejects text that would wrap before reserving or writing',async t=>{
 const control=await controlledComposer(t,{terminal:{rows:24,cols:80},text:'x'.repeat(73)});t.after(()=>control.c.close());
 await assert.rejects(control.c.sendMessage(control.request()),{code:'invalid-message',notSubmitted:true});
 assert.equal(control.calls.some(r=>r.action==='reserve-message'),false);assert.equal(control.writes.length,0);
 assert.equal(control.c.snapshot().messageInput.ready,true);
});

test('prewrite refresh catches a terminal shrink before reserving the old-size prompt',async t=>{
 const control=await controlledComposer(t,{text:'x'.repeat(100)});t.after(()=>control.c.close());
 const request=control.request();control.resize({cols:80,rows:24});
 await assert.rejects(control.c.sendMessage(request),{code:'invalid-message',notSubmitted:true});
 assert.equal(control.calls.some(r=>r.action==='reserve-message'),false);assert.equal(control.writes.length,0);
});

test('resize requires a fresh full screen then permits input and replays the new size',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'cline-resize-diag-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const control=await controlledComposer(t,{directory,text:'hello',cursorEcho:true});t.after(()=>control.c.close());
 control.resize({rows:24,cols:80},true);await control.c.refresh();
 assert.equal(control.c.snapshot().messageInput.ready,false);
 await assert.rejects(control.c.sendMessage(control.request()),{code:'message-not-ready'});assert.equal(control.writes.length,0);
 control.resize({rows:24,cols:80});await control.c.refresh();
 assert.equal(control.c.snapshot().messageInput.ready,true);assert.equal(control.c.snapshot().messageInput.maxBytes,72);
 assert.equal((await control.c.sendMessage(control.request('resized'))).state,'delivered');
 control.resize({rows:50,cols:160});await control.c.refresh();
 assert.equal(control.c.snapshot().messageInput.maxBytes,112);
 const saved=await control.c.stopDiagnostics(),bundle=await readDiagnostic(saved.path),replay=createClient({mode:'replay'}),events=[];
 try{replay.subscribe(e=>events.push(e));await replay.openReplay(bundle.recording);await replay.replayAll();assert.deepEqual(compareDiagnostic(bundle,events,replay.snapshot()),{matches:true,eventDifferences:0,snapshotMatches:true});}finally{replay.close();}
});

test('invalid initial terminal sizes are rejected before remote launch',async t=>{
 remote(t,[pinned]);const c=createClient({mode:'live',connection:{host:'fixture'}});t.after(()=>c.close());await c.connect();
 for(const terminal of [{cols:19,rows:24},{cols:501,rows:24},{cols:80,rows:4},{cols:80,rows:201},{cols:80.5,rows:24}])
  await assert.rejects(c.start({cwd:'/fixture',prompt:'first',terminalMode:'tui',terminal}),{code:'invalid-terminal-geometry'});
});
