import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createClient} from '@cline-cli-sdk/sdk';
import {readFile} from 'node:fs/promises';
const pinned={platform:'Linux',pty:true,tmux:'tmux 3.4',cliPath:'/fixture/cline',cliVersion:'3.0.69',cliHash:'8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032',bootId:'boot'};
function boundary(t,answer){t.mock.method(childProcess,'spawn',()=>{const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin=new PassThrough();p.kill=()=>{};let body='';p.stdin.on('data',d=>body+=d);p.stdin.on('finish',()=>{p.stdout.end(JSON.stringify(answer(JSON.parse(body))));queueMicrotask(()=>p.emit('close',0));});return p;});}
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
test('completed managed conversation resumes once under a new run and exact restored-composer echo precedes Enter and new user history',async(t)=>{
 const fixture=async name=>JSON.parse(await readFile(new URL(`../fixtures/resume/${name}.json`,import.meta.url)));
 const restore=await fixture('restored-composer'),echo=await fixture('composer-echo'),submitted=await fixture('submitted-history');
 let oldId,newId,position=0,launches=0;const writes=[];
 const process={kind:'process',identity:{pid:42,startTime:'100',bootId:'boot'},alive:false,identityConfirmed:true,exitCode:0,manifestStatus:'completed',childrenVerified:true,children:[],supervisorAlive:false};
 boundary(t,r=>{if(!r.action)return pinned;if(r.action==='start'){oldId=r.executionId;return {executionId:oldId,remoteRoot:'/fixture/control'};}if(r.action==='resume'){launches++;newId=r.newExecutionId;return {executionId:newId,sessionId:restore.sessionId,remoteRoot:'/fixture/control',terminalMode:'tui'};}if(r.action==='respond'){writes.push(r);position++;return {state:'queued'};}if(r.action==='settle-resume')return {state:'delivered',executionId:newId,sessionId:restore.sessionId};if(r.action==='status'){const record=r.executionId===oldId?restore:position===0?restore:position===1?echo:submitted;return {executionId:r.executionId,sessionId:restore.sessionId,cursor:record.observations.at(-1).seq+(position===2?100:0),composerHash:'composer-hash',observations:record.observations.filter(o=>o.seq>r.cursor||position===2),process:r.executionId===oldId?process:{...process,alive:true,exitCode:null,supervisorAlive:true,manifestStatus:'running'},requests:writes.map(w=>({requestId:w.requestId,state:'written',steps:[{index:w.stepIndex,state:'written'}]}))};}throw Error(r.action);});
 const c=createClient({mode:'live',connection:{host:'fixture'}});await c.connect();await c.start({cwd:'/fixture',prompt:'original'});await c.refresh();const oldMessages=c.snapshot().messages;
 const req={executionId:oldId,requestId:'resume-1',prompt:'Reply exactly RESUMED_CONFIRMED. Do not call any tools.'};
 const [a,b]=await Promise.all([c.resume(req),c.resume(req)]);assert.equal(a.sessionId,restore.sessionId);assert.notEqual(a.executionId,oldId);assert.equal(a.executionId,b.executionId);assert.equal(a.resume.state,'delivered');assert.equal(launches,1);assert.ok(a.messages.some(m=>m.id===oldMessages[0].id));assert.ok(a.messages.some(m=>m.role==='user'&&m.text===req.prompt));assert.deepEqual(writes.map(w=>Buffer.from(w.dataBase64,'base64').toString()),[req.prompt,'\r']);
 await assert.rejects(c.respond({sessionId:a.sessionId,executionId:oldId,interactionId:'old-question',revision:1,requestId:'old-response',answer:'BLUE'}),{code:'response-target-mismatch'});c.close();
});
test('actual stopped-session resume restores a focused empty composer and observes followup echo before separate Enter',async()=>{
 for(const [name,text] of [['restored-composer',''],['composer-echo','Reply exactly RESUMED_CONFIRMED. Do not call any tools.']]){
 const c=createClient({mode:'replay'});await c.openReplay(JSON.parse(await readFile(new URL(`../fixtures/resume/${name}.json`,import.meta.url))));await c.replayAll();
 assert.deepEqual(c.snapshot().composer,{mode:'tui',text});assert.ok(c.snapshot().messages.length);c.close();}
});
