import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createClient,readDiagnostic,compareDiagnostic} from '@cline-cli-sdk/sdk';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
const pinned={platform:'Linux',pty:true,tmux:'tmux 3.4',cliPath:'/fixture/cline',cliVersion:'3.0.69', cliFlags:['--cwd','--data-dir','--auto-approve','--tui','--id','--json','--retries','--zen'],cliHash:'8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032',bootId:'boot'};
function boundary(t,answer){t.mock.method(childProcess,'spawn',()=>{const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin=new PassThrough();p.kill=()=>{};let body='';p.stdin.on('data',d=>body+=d);p.stdin.on('finish',()=>{p.stdout.end(JSON.stringify(answer(JSON.parse(body))));queueMicrotask(()=>p.emit('close',0));});return p;});}

for(const priorGap of [false,true])test(`confirmed exit after resize preserves resume eligibility (prior gap=${priorGap})`,async t=>{
 let id,alive=priorGap,confirmed=false,launches=0;
 const history=Buffer.from(JSON.stringify({version:1,sessionId:'resize-ended',messages:[{id:'user',role:'user',content:[{type:'text',text:'original'}]},{id:'reply',role:'assistant',content:[{type:'text',text:'done'}]}]}));
 boundary(t,r=>{
  if(!r.action)return pinned;
  if(r.action==='start'){id=r.executionId;return {executionId:id,remoteRoot:'/fixture/control',terminal:{cols:120,rows:40}};}
  if(r.action==='status')return {executionId:id,sessionId:'resize-ended',cursor:0,observations:[],screen:null,
   history:{dataBase64:history.toString('base64'),sha256:createHash('sha256').update(history).digest('hex')},
   management:{terminal:{cols:80,rows:24},phaseSupported:true,inputLedgerCurrent:true},
   process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot'},alive,identityConfirmed:true,exitCode:alive?null:0,manifestStatus:alive?'running':'completed',supervisorAlive:alive,childrenVerified:confirmed,children:[]}};
  if(r.action==='resume'){launches++;return {error:'unexpected-launch'};}
  throw Error(r.action);
 });
 const c=createClient({mode:'live',connection:{host:'fixture'}});t.after(()=>c.close());await c.connect();await c.start({cwd:'/fixture',prompt:'first',terminalMode:'tui'});
 await c.refresh();assert.equal(c.capabilities().resume,false);assert.equal(c.capabilities().sendMessage,false);
 alive=false;confirmed=true;await c.refresh();
 assert.equal(c.snapshot().execution,'completed');assert.equal(c.capabilities().resume,true);assert.equal(c.capabilities().sendMessage,false);
 assert.equal(c.snapshot().messageInput.maxBytes,72);
 await assert.rejects(c.resume({executionId:id,requestId:'too-long',prompt:'x'.repeat(100)}),{code:'invalid-resume',notSubmitted:true});
 assert.equal(launches,0);assert.equal(c.snapshot().resume,null);
});

test('a fresh client exposes the existing successor and never reserves another resume from its ancestor',async t=>{
 const old='run-11111111-1111-4111-8111-111111111111',next='run-22222222-2222-4222-8222-222222222222';let launches=0;
 const history=Buffer.from(JSON.stringify({version:1,sessionId:'existing-chat',messages:[{id:'user',role:'user',content:[{type:'text',text:'original'}]},{id:'reply',role:'assistant',content:[{type:'text',text:'original answer'}]}]}));
 boundary(t,r=>{if(!r.action)return pinned;if(r.action==='list')return {executions:[{executionId:old,sessionId:'existing-chat',remoteRoot:'/fixture/control',terminalMode:'tui',supersededBy:next}]};if(r.action==='status')return {executionId:old,sessionId:'existing-chat',supersededBy:next,cursor:0,observations:[],history:{dataBase64:history.toString('base64'),sha256:createHash('sha256').update(history).digest('hex')},process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot'},alive:false,identityConfirmed:true,exitCode:0,manifestStatus:'completed',supervisorAlive:false,childrenVerified:true,children:[]}};if(r.action==='resume'){launches++;return {error:'ValueError',message:'This execution already has a resume reservation; do not create another run'};}throw Error(r.action);});
 const c=createClient({mode:'live',connection:{host:'fixture'}});t.after(()=>c.close());await c.connect();await c.attach(old);
 assert.equal(c.snapshot().supersededBy,next);assert.equal(c.capabilities().resume,false);
 await assert.rejects(c.resume({executionId:old,requestId:'new-resume',prompt:'followup'}),{code:'execution-superseded',notSubmitted:true});
 assert.equal(c.snapshot().resume,null);assert.equal(c.snapshot().executionId,old);assert.equal(launches,0);
});

test('a concurrent existing resume rejection is conclusively unsubmitted and preserves its successor without a phantom pending launch',async t=>{
 const old='run-11111111-1111-4111-8111-111111111111',next='run-22222222-2222-4222-8222-222222222222';let launches=0,writes=0;
 const history=Buffer.from(JSON.stringify({version:1,sessionId:'existing-chat',messages:[{id:'user',role:'user',content:[{type:'text',text:'original'}]},{id:'reply',role:'assistant',content:[{type:'text',text:'original answer'}]}]}));
 boundary(t,r=>{if(!r.action)return pinned;if(r.action==='list')return {executions:[{executionId:old,sessionId:'existing-chat',remoteRoot:'/fixture/control',terminalMode:'tui'}]};if(r.action==='status')return {executionId:old,sessionId:'existing-chat',cursor:0,observations:[],history:{dataBase64:history.toString('base64'),sha256:createHash('sha256').update(history).digest('hex')},process:{kind:'process',identity:{pid:42,startTime:'100',bootId:'boot'},alive:false,identityConfirmed:true,exitCode:0,manifestStatus:'completed',supervisorAlive:false,childrenVerified:true,children:[]}};if(r.action==='resume'){launches++;return {state:'not-submitted',executionId:r.newExecutionId,sessionId:'existing-chat',promptDigest:createHash('sha256').update(r.prompt).digest('hex'),supersededBy:next};}if(r.action==='respond'){writes++;return {state:'queued'};}throw Error(r.action);});
 const c=createClient({mode:'live',connection:{host:'fixture'}});t.after(()=>c.close());await c.connect();await c.attach(old);
 assert.equal(c.snapshot().execution,'completed',JSON.stringify(c.snapshot()));
 await assert.rejects(c.resume({executionId:old,requestId:'concurrent-resume',prompt:'keep draft'}),{code:'execution-superseded',notSubmitted:true});
 assert.equal(c.snapshot().resume.state,'not-submitted');assert.equal(c.snapshot().supersededBy,next);assert.equal(c.snapshot().executionId,old);assert.equal(c.capabilities().resume,false);assert.equal(launches,1);assert.equal(writes,0);
});
test('resume refuses an alive CLI and a dead CLI with unknown child or stop evidence before any new launch',async(t)=>{
 let evidence={identity:{pid:42,startTime:'100',bootId:'boot'},alive:true,identityConfirmed:true,exitCode:null,manifestStatus:'pending',childrenVerified:false,supervisorAlive:true}, launches=0;
 boundary(t,r=>{if(!r.action)return pinned;if(r.action==='start'){launches++;return {executionId:r.executionId,remoteRoot:'/fixture/control'};}if(r.action==='status')return {executionId:r.executionId,sessionId:'session-1',cursor:0,observations:[],process:evidence};throw Error('unexpected '+r.action);});
 const c=createClient({mode:'live',connection:{host:'fixture'}});await c.connect();await c.start({cwd:'/fixture/work',prompt:'start'});await c.refresh();
 const req={executionId:c.snapshot().executionId,requestId:'resume-1',prompt:'2 Korean followup'};
 await assert.rejects(c.resume(req),{code:'resume-unconfirmed'});
 evidence={...evidence,alive:false,exitCode:0,manifestStatus:'completed',supervisorAlive:false};
 await assert.rejects(c.resume({...req,requestId:'resume-2'}),{code:'resume-unconfirmed'});
 evidence={...evidence,childrenVerified:true,stop:{state:'unknown',childrenVerified:false,remaining:[],requestId:'stop-1',executionId:req.executionId}};
 await assert.rejects(c.resume({...req,requestId:'resume-3'}),{code:'resume-unconfirmed'});
 assert.equal(launches,1);c.close();
});
test('native completed and explicitly stopped resume traces preserve prior conversation, followup user text and numeric/Korean results offline',async()=>{
 for(const [name,answer,prior] of [['native-completed-resume','2 custom identifier','RESUME_INITIAL_DONE'],['native-stopped-resume','한글 응답 가나다 😀 café','STOP_BEFORE_RESUME']]){
 const recording=JSON.parse(await readFile(new URL(`../fixtures/resume/${name}.json`,import.meta.url)));
 const c=createClient({mode:'replay'});await c.openReplay(recording);await c.replayAll();const s=c.snapshot();
 assert.ok(s.messages.some(m=>m.text.includes(prior)));assert.ok(s.messages.some(m=>m.role==='user'&&m.text==='Ask ask_question: RESUME_FOLLOWUP, options RED,BLUE. Print RESUME_RESULT:<answer>. No other tools.'));
 assert.ok(s.messages.some(m=>m.role==='assistant'&&m.text==='RESUME_RESULT:'+answer));assert.equal(s.sessionId,recording.sessionId);assert.equal(s.executionId,recording.executionId);c.close();}
});
test('lost composer echo after a written step keeps resume unknown and does not submit Enter or create a second execution',async(t)=>{
 const restore=JSON.parse(await readFile(new URL('../fixtures/resume/restored-composer.json',import.meta.url)));let oldId,newId,launches=0;const writes=[];
 const process={kind:'process',identity:{pid:42,startTime:'100',bootId:'boot'},alive:false,identityConfirmed:true,exitCode:0,manifestStatus:'completed',childrenVerified:true,children:[],supervisorAlive:false};
 boundary(t,r=>{if(!r.action)return pinned;if(r.action==='start'){oldId=r.executionId;return {executionId:oldId,remoteRoot:'/fixture/control'};}if(r.action==='resume'){launches++;newId=r.newExecutionId;return {executionId:newId,sessionId:restore.sessionId,remoteRoot:'/fixture/control'};}if(r.action==='respond'){writes.push(r);return {state:'queued'};}if(r.action==='status')return {executionId:r.executionId,sessionId:restore.sessionId,cursor:restore.observations.at(-1).seq,composerHash:'composer',observations:restore.observations.filter(o=>o.seq>r.cursor),process:r.executionId===oldId?process:{...process,alive:true,exitCode:null,supervisorAlive:true},requests:writes.map(w=>({requestId:w.requestId,state:'written',steps:[{index:w.stepIndex,state:'written'}]}))};throw Error(r.action);});
 const c=createClient({mode:'live',connection:{host:'fixture',responseTimeoutMs:1000}});await c.connect();await c.start({cwd:'/fixture',prompt:'old'});await c.refresh();const request={executionId:oldId,requestId:'lost-echo',prompt:'controlled'};
 await assert.rejects(c.resume(request),{code:'resume-input-uncertain'});assert.equal(c.snapshot().resume.state,'delivery-unknown');await assert.rejects(c.resume(request),{code:'resume-input-uncertain'});await assert.rejects(c.resume({...request,requestId:'retry'}),{code:'resume-already-requested'});assert.equal(launches,1);assert.equal(writes.length,1);assert.equal(writes[0].inputType,'composer-text');c.close();
});
test('completed managed conversation resumes once under a new run and exact restored-composer echo precedes Enter and new user history',async(t)=>{
 const fixture=async name=>JSON.parse(await readFile(new URL(`../fixtures/resume/${name}.json`,import.meta.url)));
 const restore=await fixture('restored-composer'),echo=await fixture('composer-echo'),submitted=await fixture('submitted-history');
 let oldId,newId,position=0,launches=0;const writes=[];
 const process={kind:'process',identity:{pid:42,startTime:'100',bootId:'boot'},alive:false,identityConfirmed:true,exitCode:0,manifestStatus:'completed',childrenVerified:true,children:[],supervisorAlive:false};
 boundary(t,r=>{if(!r.action)return pinned;if(r.action==='start'){oldId=r.executionId;return {executionId:oldId,remoteRoot:'/fixture/control'};}if(r.action==='resume'){launches++;newId=r.newExecutionId;return {executionId:newId,sessionId:restore.sessionId,remoteRoot:'/fixture/control',terminalMode:'tui'};}if(r.action==='respond'){writes.push(r);position++;return {state:'queued'};}if(r.action==='settle-resume')return {state:'delivered',executionId:newId,sessionId:restore.sessionId,messageId:'message-86d309bc1fee',promptDigest:createHash('sha256').update('Reply exactly RESUMED_CONFIRMED. Do not call any tools.').digest('hex')};if(r.action==='status'){const record=r.executionId===oldId?restore:position===0?restore:position===1?echo:submitted;return {executionId:r.executionId,sessionId:restore.sessionId,cursor:record.observations.at(-1).seq+(position===2?100:0),composerHash:'composer-hash',observations:record.observations.filter(o=>o.seq>r.cursor||position===2),process:r.executionId===oldId?process:{...process,alive:true,exitCode:null,supervisorAlive:true,manifestStatus:'running'},requests:writes.map(w=>({requestId:w.requestId,state:'written',steps:[{index:w.stepIndex,state:'written'}]}))};}throw Error(r.action);});
 const directory=await mkdtemp(join(tmpdir(),'cline-sdk-resume-diag-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const c=createClient({mode:'live',connection:{host:'fixture'}});await c.startDiagnostics({directory});await c.connect();await c.start({cwd:'/fixture',prompt:'original'});await c.refresh();const oldMessages=c.snapshot().messages;
 const req={executionId:oldId,requestId:'resume-1',prompt:'Reply exactly RESUMED_CONFIRMED. Do not call any tools.'};
 const [a,b]=await Promise.all([c.resume(req),c.resume(req)]);assert.equal(a.sessionId,restore.sessionId);assert.notEqual(a.executionId,oldId);assert.equal(a.executionId,b.executionId);assert.equal(a.resume.state,'delivered');assert.equal(launches,1);assert.ok(a.messages.some(m=>m.id===oldMessages[0].id));assert.ok(a.messages.some(m=>m.role==='user'&&m.text===req.prompt));assert.deepEqual(writes.map(w=>Buffer.from(w.dataBase64,'base64').toString()),[req.prompt,'\r']);
 await assert.rejects(c.respond({sessionId:a.sessionId,executionId:oldId,interactionId:'old-question',revision:1,requestId:'old-response',answer:'BLUE'}),{code:'response-target-mismatch'});
 const saved=await c.stopDiagnostics(),bundle=await readDiagnostic(saved.path);
 assert.ok(bundle.recording.observations.some(o=>o.kind==='execution-action'&&o.action==='resume'&&o.operation==='input'));
 assert.ok(bundle.recording.observations.some(o=>o.kind==='initialize'&&o.executionId===newId));
 const offline=createClient({mode:'replay'}),events=[];offline.subscribe(e=>events.push(e));await offline.openReplay(bundle.recording);await offline.replayAll();
 assert.equal(offline.snapshot().resume.state,'delivered');assert.deepEqual(compareDiagnostic(bundle,events,offline.snapshot()),{matches:true,eventDifferences:0,snapshotMatches:true});offline.close();c.close();
});
test('actual stopped-session resume restores a focused empty composer and observes followup echo before separate Enter',async()=>{
 for(const [name,text] of [['restored-composer',''],['composer-echo','Reply exactly RESUMED_CONFIRMED. Do not call any tools.']]){
 const c=createClient({mode:'replay'});await c.openReplay(JSON.parse(await readFile(new URL(`../fixtures/resume/${name}.json`,import.meta.url))));await c.replayAll();
 assert.deepEqual(c.snapshot().composer,{mode:'tui',text});assert.ok(c.snapshot().messages.length);c.close();}
});

test('resume waits for a stable restored composer witness before its first text write',async t=>{
 const restore=JSON.parse(await readFile(new URL('../fixtures/resume/restored-composer.json',import.meta.url)));let oldId,newId,reads=0;const writes=[];
 const ended={kind:'process',identity:{pid:42,startTime:'100',bootId:'boot'},alive:false,identityConfirmed:true,exitCode:0,manifestStatus:'completed',childrenVerified:true,children:[],supervisorAlive:false};
 boundary(t,r=>{if(!r.action)return pinned;if(r.action==='start'){oldId=r.executionId;return {executionId:oldId,remoteRoot:'/fixture/control'};}if(r.action==='resume'){newId=r.newExecutionId;return {executionId:newId,sessionId:restore.sessionId,remoteRoot:'/fixture/control'};}if(r.action==='respond'){assert.ok(reads>=3);assert.equal(r.modalHash,'stable-composer');writes.push(r);return {state:'queued'};}if(r.action==='status'){if(r.executionId===newId)reads++;return {executionId:r.executionId,sessionId:restore.sessionId,cursor:restore.observations.at(-1).seq,composerHash:reads===1?'initial-redraw':'stable-composer',observations:restore.observations.filter(o=>o.seq>r.cursor),process:r.executionId===oldId?ended:{...ended,alive:true,exitCode:null,supervisorAlive:true},requests:writes.map(w=>({requestId:w.requestId,state:'written',steps:[{index:w.stepIndex,state:'written'}]}))};}throw Error(r.action);});
 const c=createClient({mode:'live',connection:{host:'fixture',responseTimeoutMs:1500}});t.after(()=>c.close());await c.connect();await c.start({cwd:'/fixture',prompt:'old'});await c.refresh();await assert.rejects(c.resume({executionId:oldId,requestId:'redraw',prompt:'controlled'}),{code:'resume-input-uncertain'});assert.equal(writes.length,1);assert.equal(writes[0].inputType,'composer-text');
});
