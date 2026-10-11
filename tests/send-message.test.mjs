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

async function controlledComposer(t,{lostEcho=false,lostSubmit=false,directory}={}) {
 let eid, seq=0, composer='',submitted=0, writes=[], pending, busy=false;
 const history=[{id:'old-identical',role:'user',content:[{type:'text',text:'2 한글 😀 café'}]}];
 t.mock.method(cp,'spawn',()=>{const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin=new PassThrough();p.kill=()=>{};let data='';p.stdin.on('data',d=>data+=d);p.stdin.on('finish',()=>{try{const r=JSON.parse(data);let value;
 if(!r.action)value=pinned;
 else if(r.action==='start'){eid=r.executionId;value={executionId:eid,remoteRoot:'/fixture/control',terminalMode:'tui'};}
 else if(r.action==='reserve-message'){pending=r;value={state:'reserved',fresh:true};}
 else if(r.action==='respond'){writes.push(r);const text=Buffer.from(r.dataBase64,'base64').toString();if(r.inputType==='composer-text'&&!lostEcho)composer+=text;if(r.inputType==='composer-submit'){submitted++;composer='';if(!lostSubmit)history.push({id:'new-'+submitted,role:'user',content:[{type:'text',text:'2 한글 😀 café'}]},{id:'reply-'+submitted,role:'assistant',content:[{type:'text',text:'Controlled reply'}]});}value={state:'queued'};}
 else if(r.action==='settle-message')value={state:lostSubmit?'delivery-unknown':'delivered',executionId:eid,sessionId:'composer-session',messageId:'new-'+submitted,promptDigest:pending.answerDigest};
 else if(r.action==='status'){
  const raw=Buffer.from(JSON.stringify({version:1,sessionId:'composer-session',messages:history}));
  const frame='\x1b[2J\x1b[H\x1b[35;1H'+'─'.repeat(120)+'\x1b[36;1H❯ '+(composer||'Ask anything...')+'\x1b[37;1H'+'─'.repeat(120)+'\x1b[38;1H● Act (Tab)\x1b[40;1HAuto-approve all disabled (Shift+Tab)\x1b[36;3H';
  value={executionId:eid,sessionId:'composer-session',cursor:++seq,observations:[{kind:'pty',seq,observedAt:new Date().toISOString(),dataBase64:Buffer.from(frame).toString('base64')}],composerHash:'composer-hash',history:{dataBase64:raw.toString('base64'),sha256:createHash('sha256').update(raw).digest('hex')},
   process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot-1'},alive:true,identityConfirmed:true,supervisorAlive:true,exitCode:null,manifestStatus:busy?'running':'idle',children:[],trackingError:null},management:{phaseSupported:true,phase:{active:false},responseReservation:true},
   requests:pending?[{requestId:pending.requestId,state:'written',binding:pending,steps:writes.filter(w=>w.requestId===pending.requestId).map(w=>({index:w.stepIndex,state:'written'}))}]:[]};
 }else throw Error('unexpected '+r.action);
 p.stdout.end(JSON.stringify(value));queueMicrotask(()=>p.emit('close',0));}catch(error){queueMicrotask(()=>p.emit('error',error));}});return p;});
 const c=createClient({mode:'live',connection:{host:'fixture',responseTimeoutMs:250}});if(directory)await c.startDiagnostics({directory});await c.connect();await c.start({cwd:'/fixture',terminalMode:'tui',prompt:'first'});await c.refresh();
 return {c,writes,setBusy:v=>busy=v,request:(requestId='message-1')=>({sessionId:c.snapshot().sessionId,executionId:c.snapshot().executionId,revision:c.snapshot().revision,requestId,text:'2 한글 😀 café'})};
}

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
